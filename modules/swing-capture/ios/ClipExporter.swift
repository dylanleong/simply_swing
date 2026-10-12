import AVFoundation
import UIKit

/// Result of saving a clip, in the same shape as Android's WrittenClip.
struct WrittenClip {
  let url: URL
  let thumbnail: URL?
  let duration: Double
  /// Impact position inside the clip (seconds), or nil for non-impact triggers.
  let impactOffset: Double?
}

/// Stitches rolling-buffer chunks into a trimmed clip, makes thumbnails, sidecars and slow-mo copies.
enum ClipExporter {
  /// Stitches [chunks] (chronological) and trims to [window]. Passthrough: no re-encode.
  static func export(chunks: [ChunkRecorder.Chunk], window: ClipWindow, to output: URL) async throws -> WrittenClip {
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
    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: output)

    guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
      throw CaptureException("Could not create export session")
    }
    session.outputURL = output
    session.outputFileType = .mp4
    session.timeRange = CMTimeRange(
      start: CMTime(seconds: startOffset, preferredTimescale: 600),
      end: CMTime(seconds: endOffset, preferredTimescale: 600)
    )
    try await run(session)

    let duration = endOffset - startOffset
    let impactOffset = window.impact.map { min(max(0, $0 - first.start - startOffset), duration) }
    let thumb = await writeThumbnail(for: output, at: impactOffset ?? duration / 2)
    return WrittenClip(url: output, thumbnail: thumb, duration: duration, impactOffset: impactOffset)
  }

  /// `swing_123.json` beside `swing_123.mp4`; same keys as Android (ClipReadyEvent + createdAt).
  static func writeSidecar(for clip: URL, info: [String: Any?]) {
    var json: [String: Any] = [:]
    for (key, value) in info {
      json[key] = value ?? NSNull()
    }
    guard let data = try? JSONSerialization.data(withJSONObject: json) else { return }
    try? data.write(to: clip.deletingPathExtension().appendingPathExtension("json"))
  }

  /// Copy retimed [factor]x slower (video only) so any player shows it in slow motion.
  static func exportSlowMotion(source: URL, factor: Int, to output: URL) async throws {
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

    try? FileManager.default.removeItem(at: output)
    // Re-encode: a retimed passthrough isn't honoured by every player / messaging app.
    guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
      throw CaptureException("Could not create export session")
    }
    session.outputURL = output
    session.outputFileType = .mp4
    try await run(session)
  }

  private static func run(_ session: AVAssetExportSession) async throws {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      session.exportAsynchronously { continuation.resume() }
    }
    if session.status != .completed {
      throw CaptureException(session.error?.localizedDescription ?? "Export failed")
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
      try data.write(to: url)
      return url
    } catch {
      return nil
    }
  }
}
