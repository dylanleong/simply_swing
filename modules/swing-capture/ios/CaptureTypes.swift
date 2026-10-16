import AVFoundation
import ExpoModulesCore

/// What fired a capture. Auto sources count against the free-tier quota (mirrors TriggerSource in TS).
enum TriggerSource: String {
  case manual
  case volumeKey
  case watch
  case impact
  /// A wrist swing from the watch with no impact sound (practice swing).
  case wrist

  var isAuto: Bool { self == .watch || self == .impact || self == .wrist }
}

/// Mirrors EngineState in src/SwingCapture.types.ts.
enum EngineState: String {
  case idle
  case armed
  case triggered
  case exporting
  /// Low-power watch: 30 fps preview + golfer-box motion only, nothing recorded.
  case standby
}

/// Golfer box, normalised 0..1 in upright (portrait) preview coordinates.
struct NormalizedRoi: Equatable {
  var x: Double
  var y: Double
  var width: Double
  var height: Double

  static let `default` = NormalizedRoi(x: 0.25, y: 0.1, width: 0.5, height: 0.85)
  /// Smallest box side MotionGate measures (fraction of the frame).
  static let minSide = 0.02

  /// Inside the frame and at least `minSide` across; the default box if any value isn't finite.
  /// MotionGate turns these into pixel indices, where NaN or infinity would trap.
  func sanitized() -> NormalizedRoi {
    guard x.isFinite, y.isFinite, width.isFinite, height.isFinite else { return .default }
    let w = min(max(width, Self.minSide), 1)
    let h = min(max(height, Self.minSide), 1)
    return NormalizedRoi(x: min(max(x, 0), 1 - w), y: min(max(y, 0), 1 - h), width: w, height: h)
  }
}

struct RoiRecord: Record {
  @Field var x: Double = 0.25
  @Field var y: Double = 0.1
  @Field var width: Double = 0.5
  @Field var height: Double = 0.85

  func toRoi() -> NormalizedRoi {
    NormalizedRoi(x: x, y: y, width: width, height: height).sanitized()
  }
}

/// Mirrors `CaptureConfig` in src/SwingCapture.types.ts.
struct CaptureConfigRecord: Record {
  @Field var fps: Int = 120
  @Field var preRollSec: Double = 3
  @Field var postRollSec: Double = 1.5
  @Field var lookbackSec: Double = 6
  @Field var roi: RoiRecord = RoiRecord()
  @Field var sensitivity: Double = 0.5
  @Field var sharpMode: Bool = false
  @Field var autoTrigger: Bool = true
  @Field var impactTrigger: Bool = true
  /// Apple Watch: auto = sense wrist swings (sound + wrist fusion), tap = SAVE button only, off = ignore it.
  @Field var watchMode: String = "auto"
  /// With the watch sensing: save wrist swings that had no impact sound (source `wrist`).
  @Field var savePracticeSwings: Bool = false
  /// Chime when a swing is saved (main / solo phone only). Older JS without the field gets it on.
  @Field var savedSound: Bool = true

  /// Times become dispatch deadlines and buffer sizes, which trap or misbehave on NaN / huge values.
  func toConfig() -> CaptureConfig {
    func seconds(_ value: Double, _ fallback: Double, max upper: Double) -> Double {
      value.isFinite ? min(max(value, 0), upper) : fallback
    }
    return CaptureConfig(
      fps: min(max(fps, 1), 480),
      preRoll: seconds(preRollSec, 3, max: 30),
      postRoll: seconds(postRollSec, 1.5, max: 30),
      lookback: seconds(lookbackSec, 6, max: 30),
      roi: roi.toRoi(),
      sensitivity: sensitivity.isFinite ? min(max(sensitivity, 0), 1) : 0.5,
      sharpMode: sharpMode,
      autoTrigger: autoTrigger,
      impactTrigger: impactTrigger,
      watchMode: WatchBridge.modes.contains(watchMode) ? watchMode : WatchBridge.modeAuto,
      savePracticeSwings: savePracticeSwings,
      savedSound: savedSound
    )
  }
}

/// Plain engine config (seconds), free of Expo types.
struct CaptureConfig {
  var fps: Int
  var preRoll: Double
  var postRoll: Double
  var lookback: Double
  var roi: NormalizedRoi
  var sensitivity: Double
  var sharpMode: Bool
  var autoTrigger: Bool
  var impactTrigger: Bool
  /// WatchBridge.modeAuto / modeTap / modeOff.
  var watchMode: String
  var savePracticeSwings: Bool
  var savedSound: Bool
}

/// Which span of the rolling buffer becomes the saved clip. Times are capture-clock seconds.
/// `anchor` is the trigger instant (the impact, or the button press); a paired camera phone gets the
/// same instant on its own clock, so the two angles line up on it.
struct ClipWindow {
  let start: Double
  let end: Double
  let impact: Double?
  let anchor: Double
}

enum ClipWindows {
  /// Kept in the buffer beyond the longest clip, so post-roll and export never race pruning.
  static let ringMargin = 1.5
  private static let manualTail = 0.3

  /// Impacts are centred on the strike. Buttons, remotes and the watch are pressed after the
  /// swing, so they keep the last `lookback` seconds (see ClipWindows.kt).
  static func forTrigger(_ source: TriggerSource, at time: Double, config: CaptureConfig) -> ClipWindow {
    switch source {
    case .impact, .wrist:
      return ClipWindow(start: time - config.preRoll, end: time + config.postRoll, impact: time, anchor: time)
    default:
      return ClipWindow(start: time - config.lookback, end: time + manualTail, impact: nil, anchor: time)
    }
  }

  static func ringWindow(_ config: CaptureConfig) -> Double {
    max(config.preRoll + config.postRoll, config.lookback + manualTail) + ringMargin
  }
}

enum SwingFiles {
  /// `Documents/swings`, where clips, thumbnails, sidecars and second angles live (read by swing-store.ts).
  static let clipsDir: URL = {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let dir = docs.appendingPathComponent("swings", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()

  /// `tmp/exports`: slow-motion and side-by-side copies for Save / Share, reused while up to date.
  static var exportsDir: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("exports", isDirectory: true)
  }
}

enum Storage {
  static let fullCode = "E_STORAGE"
  static let fullMessage = "Phone storage is full. Free some space to keep recording."
  /// Below this much free space a failed write is put down to a full disk.
  private static let lowBytes = 50 * 1024 * 1024

  /// Did [error] (a writer's or export session's) come from running out of space? Checks the usual
  /// codes, then the volume itself, since AVFoundation often reports a full disk as a generic failure.
  static func isFull(_ error: Error?, at url: URL) -> Bool {
    if let error, matches(error as NSError) { return true }
    let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityKey])
    if let free = values?.volumeAvailableCapacity, free < lowBytes { return true }
    return false
  }

  private static func matches(_ e: NSError) -> Bool {
    if e.domain == AVFoundationErrorDomain && e.code == AVError.Code.diskFull.rawValue { return true }
    if e.domain == NSCocoaErrorDomain && e.code == NSFileWriteOutOfSpaceError { return true }
    if e.domain == NSPOSIXErrorDomain && e.code == Int(ENOSPC) { return true }
    if let underlying = e.userInfo[NSUnderlyingErrorKey] as? NSError { return matches(underlying) }
    return false
  }
}

final class StorageFullException: Exception {
  override var reason: String { Storage.fullMessage }
}

final class CaptureException: GenericException<String> {
  override var reason: String { param }
}

final class NotSupportedException: Exception {
  override var reason: String { "This feature is not supported on this device" }
}
