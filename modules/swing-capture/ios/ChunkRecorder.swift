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
    var frames = 0
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
  private let onError: (_ code: String, _ message: String) -> Void

  private(set) var chunks: [Chunk] = []
  private var current: Writer?
  private var closing: Writer?
  private var counter = 0
  private var rotateRequested = false
  private var stopped = false
  /// Out of storage: nothing more is written until the engine makes a new recorder.
  private var storageFull = false
  /// After a writer fails for another reason, the next one is tried no sooner than this (not every frame).
  private var retryAfter = -Double.infinity
  /// Writers whose finishWriting hasn't called back yet.
  private var finishing = 0
  /// Exports reading our chunk files (see hold()); the directory outlives stop() until they're done.
  private var holds = 0
  private var discarded = false
  /// stop(keeping:)'s callback, delivered once every open chunk has finished.
  private var flushed: (([Chunk]) -> Void)?

  init(
    dir: URL,
    queue: DispatchQueue,
    videoSettings: [String: Any],
    audioSettings: [String: Any]?,
    transform: CGAffineTransform,
    chunkDuration: Double = 1.0,
    onChunk: @escaping (Chunk) -> Void,
    onError: @escaping (_ code: String, _ message: String) -> Void
  ) {
    self.dir = dir
    self.queue = queue
    self.videoSettings = videoSettings
    self.audioSettings = audioSettings
    self.transform = transform
    self.chunkDuration = chunkDuration
    self.onChunk = onChunk
    self.onError = onError
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }

  /// Finish the current chunk at the next frame (a clip's end is inside it).
  func requestRotate() {
    rotateRequested = true
  }

  func appendVideo(_ sample: CMSampleBuffer, time: Double) {
    guard !stopped, !storageFull else { return }
    if let w = current, w.writer.status == .failed {
      current = nil
      try? FileManager.default.removeItem(at: w.url)
      writerFailed(w.writer.error, at: time)
      if storageFull { return }
    }
    let due: Bool
    if let w = current {
      due = rotateRequested || time - w.start >= chunkDuration
    } else {
      due = time >= retryAfter
    }
    if due {
      rotateRequested = false
      rotate(startingAt: sample, time: time)
    }
    if let w = current, w.writer.status == .writing, w.video.isReadyForMoreMediaData {
      if w.video.append(sample) {
        w.lastVideoTime = time
        w.frames += 1
      }
    }
    if let c = closing, time > c.closeAfter {
      closing = nil
      finish(c)
    }
  }

  func appendAudio(_ sample: CMSampleBuffer, time: Double) {
    guard !stopped, !storageFull else { return }
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

  /// An export is reading chunk files: keep them (and the directory) until the matching release().
  func hold() {
    holds += 1
  }

  func release() {
    holds = max(0, holds - 1)
    discardIfDone()
  }

  /// Stops recording and deletes the chunks (once no export holds them).
  func stop() {
    guard !stopped else { return }
    stopped = true
    for w in [closing, current].compactMap({ $0 }) {
      w.writer.cancelWriting()
      try? FileManager.default.removeItem(at: w.url)
    }
    closing = nil
    current = nil
    discardIfDone()
  }

  /// Stops recording but finishes the open chunks rather than discarding them, then calls `done`
  /// (on the queue) with every chunk. Holds the files for the caller, who calls release() when done.
  func stop(keeping done: @escaping ([Chunk]) -> Void) {
    guard !stopped else {
      queue.async { done([]) }
      return
    }
    stopped = true
    holds += 1
    flushed = done
    let open = [closing, current].compactMap { $0 }
    closing = nil
    current = nil
    for w in open { finish(w) }
    deliverFlushIfDone()
  }

  // MARK: - Private

  private func rotate(startingAt sample: CMSampleBuffer, time: Double) {
    if let c = closing {
      closing = nil
      finish(c)
    }
    if let w = current {
      w.closeAfter = CMSampleBufferGetPresentationTimeStamp(sample).seconds + 0.25
      closing = w
    }
    current = makeWriter(startingAt: sample, time: time)
  }

  private func makeWriter(startingAt sample: CMSampleBuffer, time: Double) -> Writer? {
    counter += 1
    let url = dir.appendingPathComponent("chunk_\(counter).mp4")
    try? FileManager.default.removeItem(at: url)
    do {
      let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
      let video = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
      video.expectsMediaDataInRealTime = true
      video.transform = transform
      guard writer.canAdd(video) else {
        writerFailed(nil, at: time)
        return nil
      }
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

      guard writer.startWriting() else {
        try? FileManager.default.removeItem(at: url)
        writerFailed(writer.error, at: time)
        return nil
      }
      let pts = CMSampleBufferGetPresentationTimeStamp(sample)
      writer.startSession(atSourceTime: pts)
      return Writer(writer: writer, video: video, audio: audio, url: url, start: pts.seconds)
    } catch {
      writerFailed(error, at: time)
      return nil
    }
  }

  /// A full disk is reported once and stops recording until the engine restarts it; anything else
  /// is retried a second later rather than on every frame.
  private func writerFailed(_ error: Error?, at time: Double) {
    if Storage.isFull(error, at: dir) {
      guard !storageFull else { return }
      storageFull = true
      NSLog("SwingCapture: storage full, recording paused: \(String(describing: error))")
      onError(Storage.fullCode, Storage.fullMessage)
    } else {
      NSLog("SwingCapture: chunk writer failed: \(String(describing: error))")
      retryAfter = time + 1
    }
  }

  private func finish(_ w: Writer) {
    // A writer with no frames makes an empty (or failed) file that would only trip up the export.
    guard w.writer.status == .writing, w.frames > 0 else {
      if w.writer.status == .writing { w.writer.cancelWriting() }
      try? FileManager.default.removeItem(at: w.url)
      return
    }
    w.video.markAsFinished()
    w.audio?.markAsFinished()
    finishing += 1
    // Strong self: a recorder the engine has let go of must still collect its last chunks.
    w.writer.finishWriting {
      self.queue.async {
        self.finishing -= 1
        if w.writer.status == .completed, !self.discarded {
          let chunk = Chunk(url: w.url, start: w.start, end: w.lastVideoTime)
          // Writers can finish out of order; keep the list chronological.
          self.chunks.append(chunk)
          self.chunks.sort { $0.start < $1.start }
          if !self.stopped { self.onChunk(chunk) }
        } else {
          try? FileManager.default.removeItem(at: w.url)
          if w.writer.status == .failed, !self.stopped { self.writerFailed(w.writer.error, at: w.lastVideoTime) }
        }
        self.deliverFlushIfDone()
        self.discardIfDone()
      }
    }
  }

  private func deliverFlushIfDone() {
    guard finishing == 0, let done = flushed else { return }
    flushed = nil
    let list = chunks
    queue.async { done(list) }
  }

  /// After stop(): delete the chunks once no writer is finishing and no export holds them.
  private func discardIfDone() {
    guard stopped, !discarded, finishing == 0, holds == 0, flushed == nil else { return }
    discarded = true
    chunks.removeAll()
    try? FileManager.default.removeItem(at: dir)
  }
}
