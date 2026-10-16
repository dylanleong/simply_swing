import AVFoundation
import UIKit

/// Result of saving a clip, in the same shape as Android's WrittenClip.
struct WrittenClip {
  let url: URL
  let thumbnail: URL?
  let duration: Double
  /// Impact position inside the clip (seconds), or nil for non-impact triggers.
  let impactOffset: Double?
  /// Trigger-instant position relative to the clip start (not clamped; lines up a second angle).
  let anchorOffset: Double
}

/// Stitches rolling-buffer chunks into a trimmed clip, makes thumbnails, sidecars and slow-mo copies.
enum ClipExporter {
  /// Stitches [chunks] (chronological) and trims to [window]. Passthrough: no re-encode.
  static func export(
    chunks: [ChunkRecorder.Chunk],
    window: ClipWindow,
    to output: URL,
    thumbnail: Bool = true
  ) async throws -> WrittenClip {
    guard let first = chunks.first else { throw CaptureException("No video in clip window") }
    let composition = AVMutableComposition()
    guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
    else { throw CaptureException("Could not create video track") }
    let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)

    // Chunks follow each other within a frame, so laying them end to end keeps clip time ≈ capture time - first.start.
    var cursor = CMTime.zero
    var transform = CGAffineTransform.identity
    for chunk in chunks {
      let asset = AVURLAsset(url: chunk.url)
      let duration = try await asset.load(.duration)
      guard duration.isNumeric, duration > .zero else { continue }
      let range = CMTimeRange(start: .zero, duration: duration)
      if let src = try await asset.loadTracks(withMediaType: .video).first {
        try videoTrack.insertTimeRange(range, of: src, at: cursor)
        transform = try await src.load(.preferredTransform)
      }
      if let audioTrack, let src = try await asset.loadTracks(withMediaType: .audio).first {
        try? audioTrack.insertTimeRange(range, of: src, at: cursor)
      }
      cursor = cursor + duration
    }
    videoTrack.preferredTransform = transform

    let total = cursor.seconds
    let startOffset = min(max(0, window.start - first.start), total)
    let endOffset = min(max(startOffset, window.end - first.start), total)

    guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
      throw CaptureException("Could not create export session")
    }
    session.outputFileType = .mp4
    session.timeRange = CMTimeRange(
      start: CMTime(seconds: startOffset, preferredTimescale: 600),
      end: CMTime(seconds: endOffset, preferredTimescale: 600)
    )
    try await run(session, to: output)

    let duration = endOffset - startOffset
    let impactOffset = window.impact.map { min(max(0, $0 - first.start - startOffset), duration) }
    var thumb: URL?
    if thumbnail { thumb = await writeThumbnail(for: output, at: impactOffset ?? duration / 2) }
    return WrittenClip(
      url: output,
      thumbnail: thumb,
      duration: duration,
      impactOffset: impactOffset,
      anchorOffset: window.anchor - first.start - startOffset
    )
  }

  /// `swing_123.json` beside `swing_123.mp4`; same keys as Android (ClipReadyEvent + createdAt).
  static func writeSidecar(for clip: URL, info: [String: Any?]) {
    var json: [String: Any] = [:]
    for (key, value) in info {
      json[key] = value ?? NSNull()
    }
    guard let data = try? JSONSerialization.data(withJSONObject: json) else { return }
    try? data.write(to: clip.deletingPathExtension().appendingPathExtension("json"), options: .atomic)
  }

  /// Slow-motion factors the exporters accept. Anything else (0 or negative especially) would make
  /// an invalid or trapping time scale (`Int32(factor)`, a division by it).
  static func checkSlowMotionFactor(_ factor: Int) throws {
    guard (1...32).contains(factor) else { throw CaptureException("Slow-motion factor must be 1 to 32, not \(factor)") }
  }

  /// Copy retimed [factor]x slower (video only) so any player shows it in slow motion.
  static func exportSlowMotion(source: URL, factor: Int, to output: URL) async throws {
    try checkSlowMotionFactor(factor)
    let asset = AVURLAsset(url: source)
    guard let src = try await asset.loadTracks(withMediaType: .video).first else {
      throw CaptureException("No video track in \(source.lastPathComponent)")
    }
    let duration = try await asset.load(.duration)
    let composition = AVMutableComposition()
    guard let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
    else { throw CaptureException("Could not create video track") }
    let range = CMTimeRange(start: .zero, duration: duration)
    try track.insertTimeRange(range, of: src, at: .zero)
    track.scaleTimeRange(range, toDuration: CMTimeMultiply(duration, multiplier: Int32(factor)))
    track.preferredTransform = try await src.load(.preferredTransform)

    // A stale copy must not be served if this export fails.
    try? FileManager.default.removeItem(at: output)
    // Re-encode: a retimed passthrough isn't honoured by every player / messaging app.
    guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
      throw CaptureException("Could not create export session")
    }
    session.outputFileType = .mp4
    try await run(session, to: output)
  }

  /// A two-angle swing as one slow-motion video: [main] on the left, [angle] on the right, the angle
  /// shown at `tA + shiftSec`. Video only, like `exportSlowMotion`. Before the angle starts (or
  /// after it ends) its half is black.
  static func exportSideBySide(main: URL, angle: URL, shiftSec: Double, factor: Int, to output: URL) async throws {
    try checkSlowMotionFactor(factor)
    guard shiftSec.isFinite else { throw CaptureException("Bad angle shift") }
    let mainAsset = AVURLAsset(url: main)
    let angleAsset = AVURLAsset(url: angle)
    guard let srcA = try await mainAsset.loadTracks(withMediaType: .video).first,
          let srcB = try await angleAsset.loadTracks(withMediaType: .video).first
    else { throw CaptureException("No video track to export") }
    let durationA = try await mainAsset.load(.duration)
    let durationB = try await angleAsset.load(.duration)

    let composition = AVMutableComposition()
    guard let trackA = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
          let trackB = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
    else { throw CaptureException("Could not create video tracks") }
    let full = CMTimeRange(start: .zero, duration: durationA)
    try trackA.insertTimeRange(full, of: srcA, at: .zero)

    // Composition time t shows the angle at t + shift: its [max(0, shift), …] goes in at max(0, -shift).
    let shift = CMTime(seconds: shiftSec, preferredTimescale: 600)
    let startB = CMTimeMaximum(shift, .zero)
    let at = CMTimeMaximum(CMTimeSubtract(.zero, shift), .zero)
    let lengthB = CMTimeMinimum(CMTimeSubtract(durationB, startB), CMTimeSubtract(durationA, at))
    if lengthB > .zero {
      try trackB.insertTimeRange(CMTimeRange(start: startB, duration: lengthB), of: srcB, at: at)
    }
    let slow = CMTimeMultiply(durationA, multiplier: Int32(factor))
    composition.scaleTimeRange(full, toDuration: slow)

    let panel = CGSize(width: 720, height: 1280)
    let gap: CGFloat = 16
    let layerA = AVMutableVideoCompositionLayerInstruction(assetTrack: trackA)
    layerA.setTransform(try await fit(srcA, in: CGRect(origin: .zero, size: panel)), at: .zero)
    let layerB = AVMutableVideoCompositionLayerInstruction(assetTrack: trackB)
    layerB.setTransform(try await fit(srcB, in: CGRect(x: panel.width + gap, y: 0, width: panel.width, height: panel.height)), at: .zero)
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: slow)
    instruction.backgroundColor = CGColor(gray: 0, alpha: 1)
    instruction.layerInstructions = [layerA, layerB]

    let fps = try await srcA.load(.nominalFrameRate)
    let videoComposition = AVMutableVideoComposition()
    videoComposition.renderSize = CGSize(width: panel.width * 2 + gap, height: panel.height)
    videoComposition.frameDuration = CMTime(value: 1, timescale: Int32(max(1, (Double(fps) / Double(factor)).rounded())))
    videoComposition.instructions = [instruction]

    try? FileManager.default.removeItem(at: output)
    guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
      throw CaptureException("Could not create export session")
    }
    session.videoComposition = videoComposition
    session.outputFileType = .mp4
    try await run(session, to: output)
  }

  /// Shows [track] upright, scaled to fit inside [rect] and centred in it.
  private static func fit(_ track: AVAssetTrack, in rect: CGRect) async throws -> CGAffineTransform {
    let (size, transform) = try await track.load(.naturalSize, .preferredTransform)
    let shown = CGRect(origin: .zero, size: size).applying(transform)
    let scale = min(rect.width / shown.width, rect.height / shown.height)
    let w = shown.width * scale
    let h = shown.height * scale
    return transform
      .concatenating(CGAffineTransform(translationX: -shown.minX, y: -shown.minY))
      .concatenating(CGAffineTransform(scaleX: scale, y: scale))
      .concatenating(CGAffineTransform(translationX: rect.minX + (rect.width - w) / 2, y: rect.minY + (rect.height - h) / 2))
  }

  /// Where exports are written until they're complete (`tmp/partial`, cleaned at engine start).
  static var partialDir: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("partial", isDirectory: true)
  }

  /// Runs [session] into a temporary file and moves it to [output] only once it's complete, so a
  /// failed or interrupted export never leaves a truncated clip in the library or the export cache.
  private static func run(_ session: AVAssetExportSession, to output: URL) async throws {
    let fm = FileManager.default
    try fm.createDirectory(at: partialDir, withIntermediateDirectories: true)
    try fm.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    // Keeps the real file's extension, which the export session may check against outputFileType.
    let part = partialDir.appendingPathComponent("\(UUID().uuidString).\(output.pathExtension)")
    session.outputURL = part
    do {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        session.exportAsynchronously { continuation.resume() }
      }
      if session.status != .completed {
        let error = session.error
        if Storage.isFull(error, at: partialDir) { throw StorageFullException() }
        throw CaptureException(error?.localizedDescription ?? "Export failed")
      }
      try? fm.removeItem(at: output)
      try fm.moveItem(at: part, to: output)
    } catch {
      try? fm.removeItem(at: part)
      throw error
    }
  }

  private static func writeThumbnail(for clip: URL, at seconds: Double) async -> URL? {
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: clip))
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 360, height: 640)
    let tolerance = CMTime(seconds: 0.05, preferredTimescale: 600)
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance
    do {
      let (image, _) = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
      guard let data = UIImage(cgImage: image).jpegData(compressionQuality: 0.8) else { return nil }
      let url = clip.deletingPathExtension().appendingPathExtension("jpg")
      try data.write(to: url, options: .atomic)
      return url
    } catch {
      return nil
    }
  }
}
