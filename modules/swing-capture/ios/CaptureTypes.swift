import ExpoModulesCore

/// What fired a capture. Auto sources count against the free-tier quota (mirrors TriggerSource in TS).
enum TriggerSource: String {
  case manual
  case volumeKey
  case watch
  case impact
  /// A wrist swing from the watch with no impact sound (practice swing). Apple Watch: Phase 6.
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
}

struct RoiRecord: Record {
  @Field var x: Double = 0.25
  @Field var y: Double = 0.1
  @Field var width: Double = 0.5
  @Field var height: Double = 0.85

  func toRoi() -> NormalizedRoi {
    NormalizedRoi(x: x, y: y, width: width, height: height)
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
  /// Apple Watch support is Phase 6; accepted so the shared JS config decodes on iOS.
  @Field var watchMode: String = "auto"
  @Field var savePracticeSwings: Bool = false

  func toConfig() -> CaptureConfig {
    CaptureConfig(
      fps: fps,
      preRoll: preRollSec,
      postRoll: postRollSec,
      lookback: lookbackSec,
      roi: roi.toRoi(),
      sensitivity: sensitivity,
      sharpMode: sharpMode,
      autoTrigger: autoTrigger,
      impactTrigger: impactTrigger
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
}

final class CaptureException: GenericException<String> {
  override var reason: String { param }
}

final class NotSupportedException: Exception {
  override var reason: String { "This feature is not supported on this device" }
}
