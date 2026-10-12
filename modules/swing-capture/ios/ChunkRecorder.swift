import AVFoundation

/**
 iOS rolling buffer: continuous ~1 s MP4 chunks written by hardware encoders, oldest deleted.

 AVFoundation has no "keep the last N seconds" recorder, so each chunk is its own AVAssetWriter.
 At a boundary the next writer starts on the new frame while the previous one stays open briefly
 for audio that belongs to it, then finishes asynchronously. A clip is stitched from the chunks
 covering its window (see ClipExporter). Everything runs on the capture queue except the writers'
 finish callbacks, which hop back to it.
 */
final class ChunkRecorder {
  struct Chunk {
    let url: URL
    /// Capture-clock seconds of the first and last video frame.
    let start: Double
    let end: Double
  }

  private final class Writer {
    let writer: AVAssetWriter
    let video: AVAssetWriterInput
    let audio: AVAssetWriterInput?
    let url: URL
    let start: Double
    var lastVideoTime: Double
    /// Once closing, audio up to this time still goes here; after it the writer finishes.
    var closeAfter = Double.infinity

    init(writer: AVAssetWriter, video: AVAssetWriterInput, audio: AVAssetWriterInput?, url: URL, start: Double) {
      self.writer = writer
      self.video = video
      self.audio = audio
      self.url = url
      self.start = start
      self.lastVideoTime = start
    }
  }

  private let dir: URL
  private let queue: DispatchQueue
  private let videoSettings: [String: Any]
  private let audioSettings: [String: Any]?
  private let transform: CGAffineTransform
  private let chunkDuration: Double
  private let onChunk: (Chunk) -> Void

  private(set) var chunks: [Chunk] = []
  private var current: Writer?
  private var closing: Writer?
  private var counter = 0
  private var rotateRequested = false
  private var stopped = false

  init(
    dir: URL,
    queue: DispatchQueue,
    videoSettings: [String: Any],
    audioSettings: [String: Any]?,
    transform: CGAffineTransform,
    chunkDuration: Double = 1.0,
    onChunk: @escaping (Chunk) -> Void
  ) {
    self.dir = dir
    self.queue = queue
    self.videoSettings = videoSettings
    self.audioSettings = audioSettings
    self.transform = transform
    self.chunkDuration = chunkDuration
    self.onChunk = onChunk
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }

  /// Finish the current chunk at the next frame (a clip's end is inside it).
  func requestRotate() {
    rotateRequested = true
  }

  func appendVideo(_ sample: CMSampleBuffer, time: Double) {
    guard !stopped else { return }
    if current == nil || rotateRequested || time - (current?.start ?? time) >= chunkDuration {
      rotateRequested = false
      rotate(startingAt: sample)
    }
    if let w = current, w.writer.status == .writing, w.video.isReadyForMoreMediaData {
      if w.video.append(sample) { w.lastVideoTime = time }
    }
    if let c = closing, time > c.closeAfter {
      closing = nil
      finish(c)
    }
  }

  func appendAudio(_ sample: CMSampleBuffer, time: Double) {
    guard !stopped else { return }
    // Audio slightly behind the video boundary belongs to the chunk that is closing.
    let target: Writer?
    if let c = closing, let cur = current, time < cur.start {
      target = c
    } else if let cur = current, time >= cur.start {
      target = cur
    } else {
      target = nil
    }
    guard let w = target, w.writer.status == .writing, let input = w.audio, input.isReadyForMoreMediaData else { return }
    input.append(sample)
  }

  /// Deletes chunks that ended before `cutoff` (capture-clock seconds).
  func prune(before cutoff: Double) {
    while let first = chunks.first, first.end < cutoff {
      chunks.removeFirst()
      try? FileManager.default.removeItem(at: first.url)
    }
  }

  /// Chunks overlapping [start, end], oldest first.
  func chunks(overlapping start: Double, _ end: Double) -> [Chunk] {
    chunks.filter { $0.end >= start && $0.start <= end }
  }

  func stop() {
    stopped = true
    for w in [closing, current].compactMap({ $0 }) {
      w.writer.cancelWriting()
    }
    closing = nil
    current = nil
    chunks.removeAll()
    try? FileManager.default.removeItem(at: dir)
  }

  // MARK: - Private

  private func rotate(startingAt sample: CMSampleBuffer) {
    if let c = closing {
      closing = nil
      finish(c)
    }
    if let w = current {
      w.closeAfter = CMSampleBufferGetPresentationTimeStamp(sample).seconds + 0.25
      closing = w
    }
    current = makeWriter(startingAt: sample)
  }

  private func makeWriter(startingAt sample: CMSampleBuffer) -> Writer? {
    counter += 1
    let url = dir.appendingPathComponent("chunk_\(counter).mp4")
    try? FileManager.default.removeItem(at: url)
    do {
      let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
      let video = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
      video.expectsMediaDataInRealTime = true
      video.transform = transform
      guard writer.canAdd(video) else { return nil }
      writer.add(video)

      var audio: AVAssetWriterInput?
      if let settings = audioSettings {
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        if writer.canAdd(input) {
          writer.add(input)
          audio = input
        }
      }

      guard writer.startWriting() else { return nil }
      let pts = CMSampleBufferGetPresentationTimeStamp(sample)
      writer.startSession(atSourceTime: pts)
      return Writer(writer: writer, video: video, audio: audio, url: url, start: pts.seconds)
    } catch {
      return nil
    }
  }

  private func finish(_ w: Writer) {
    guard w.writer.status == .writing else {
      try? FileManager.default.removeItem(at: w.url)
      return
    }
    w.video.markAsFinished()
    w.audio?.markAsFinished()
    w.writer.finishWriting { [weak self] in
      guard let self else { return }
      self.queue.async {
        guard !self.stopped, w.writer.status == .completed else {
          try? FileManager.default.removeItem(at: w.url)
          return
        }
        let chunk = Chunk(url: w.url, start: w.start, end: w.lastVideoTime)
        // Writers can finish out of order; keep the list chronological.
        self.chunks.append(chunk)
        self.chunks.sort { $0.start < $1.start }
        self.onChunk(chunk)
      }
    }
  }
}
