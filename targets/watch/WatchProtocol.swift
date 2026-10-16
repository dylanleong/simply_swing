import Foundation

/**
 WatchConnectivity messages shared with modules/swing-capture/ios/WatchBridge.swift — keep in sync.
 The same conversation as the Wear OS paths (wear/.../WearProtocol.kt, WearBridge.kt), but each
 message is a dictionary ["t": type, ...fields] instead of a path + text payload:

   watch → phone  hello                 ask for current state (the phone answers with state + config)
   watch → phone  trigger               tap-to-save
   watch → phone  swing                 ageMs, peakDps[, backswingMs, downswingMs]: a wrist swing that
                                        peaked ageMs before sending (watch clock), with its tempo
   watch → phone  heartbeat             sensing is running (every 5 s); sent with a reply handler, and
                                        the phone answers ["t": state, state, mode]
   watch → phone  pong                  the ping echoed back
   phone → watch  state {state}         engine state jsName
   phone → watch  saved                 clip written
   phone → watch  rejected [{state}]    trigger ignored (not armed, cooldown, quota, watch off)
   phone → watch  config {mode}         auto | tap | off
   phone → watch  ping {ns}             clock round-trip probe (phone monotonic ns), echoed in pong

 The phone also keeps the application context ["mode", "state"] current, for a watch app that starts
 while the phone is out of reach.

 Pure Swift (Foundation only) so it's unit-tested on Linux alongside SwingDetector.
 */
enum WatchProtocol {
  static let typeKey = "t"

  static let hello = "hello"
  static let trigger = "trigger"
  static let swing = "swing"
  static let heartbeat = "heartbeat"
  static let pong = "pong"

  static let state = "state"
  static let saved = "saved"
  static let rejected = "rejected"
  static let config = "config"
  static let ping = "ping"

  /// Field names.
  static let stateKey = "state"
  static let modeKey = "mode"
  static let ageMsKey = "ageMs"
  static let peakDpsKey = "peakDps"
  static let backswingMsKey = "backswingMs"
  static let downswingMsKey = "downswingMs"
  static let pingNsKey = "ns"

  static let modeAuto = "auto"
  static let modeTap = "tap"
  static let modeOff = "off"
  static let modes: Set<String> = [modeAuto, modeTap, modeOff]

  static func message(_ type: String) -> [String: Any] {
    [typeKey: type]
  }

  static func type(of message: [String: Any]) -> String? {
    message[typeKey] as? String
  }

  /// A swing that peaked ageMs ago, all integers (the phone drops ageMs outside 0...60 000). Tempo
  /// fields are only sent when both are known; older phones ignore extra fields.
  static func swingMessage(_ swing: SwingDetector.Swing, ageMs: Int64) -> [String: Any] {
    var message: [String: Any] = [
      typeKey: Self.swing,
      ageMsKey: Int(ageMs),
      peakDpsKey: Int(swing.peakDps),
    ]
    if let backswingNs = swing.backswingNs, let downswingNs = swing.downswingNs {
      message[backswingMsKey] = Int(backswingNs / 1_000_000)
      message[downswingMsKey] = Int(downswingNs / 1_000_000)
    }
    return message
  }

  /// The ping with every other field ("ns") echoed unchanged, like the Wear OS payload echo.
  static func pong(for ping: [String: Any]) -> [String: Any] {
    var reply = ping
    reply[typeKey] = pong
    return reply
  }

  /// A known watch mode from a message or the application context, else nil.
  static func mode(in message: [String: Any]) -> String? {
    guard let mode = message[modeKey] as? String, modes.contains(mode) else { return nil }
    return mode
  }

  static func engineState(in message: [String: Any]) -> String? {
    message[stateKey] as? String
  }

  /// "3.1 : 1" — backswing over downswing, as the phone shows it (formatTempoRatio).
  static func tempoRatio(backswingNs: Int64?, downswingNs: Int64?) -> String? {
    guard let backswingNs, let downswingNs, backswingNs > 0, downswingNs > 0 else { return nil }
    return String(format: "%.1f : 1", Double(backswingNs) / Double(downswingNs))
  }
}

/// What the watch knows about the phone. Phone engine states plus watch-only ones.
enum PhoneStatus: Equatable {
  case unknown
  case noPhone
  case idle
  case armed
  case saving
  case standby

  var label: String {
    switch self {
    case .unknown: return "Connecting…"
    case .noPhone: return "Phone not connected"
    case .idle: return "Open Capture on phone"
    case .armed: return "Ready"
    case .saving: return "Saving swing…"
    case .standby: return "Phone in standby · tap to wake"
    }
  }

  /// In standby a press wakes the phone rather than saving.
  var canTrigger: Bool { self == .armed || self == .standby }

  static func fromEngineState(_ state: String) -> PhoneStatus {
    switch state {
    case "armed": return .armed
    case "standby": return .standby
    case "triggered", "exporting": return .saving
    default: return .idle
    }
  }
}

/**
 When wrist sensing stops by itself, as in SwingSensorService: the phone has been off Capture
 ("idle") for 2 min, nothing at all has come from the phone for 2 min (app killed, out of range,
 never opened: it can't send "idle"), or the 3 h cap. Times are seconds on one monotonic clock.
 */
struct SensingStopRules {
  static let heartbeatInterval: TimeInterval = 5
  /// Stop sensing once the phone has been off the Capture screen (or silent) this long.
  static let phoneIdleStop: TimeInterval = 2 * 60
  /// Hard cap, in case nothing else stops the session.
  static let maxSession: TimeInterval = 3 * 60 * 60

  private let startedAt: TimeInterval
  /// Last message of any kind from the phone (it pings every few seconds while Capture runs).
  private(set) var lastPhoneAt: TimeInterval
  private(set) var phoneIdleSince: TimeInterval?

  init(now: TimeInterval) {
    startedAt = now
    lastPhoneAt = now
  }

  /// Any phone message; state is set for state messages (and the application context).
  mutating func heardFromPhone(at now: TimeInterval, state: String? = nil) {
    lastPhoneAt = now
    guard let state else { return }
    phoneIdleSince = state == "idle" ? (phoneIdleSince ?? now) : nil
  }

  /// Why sensing should stop now, for the log, or nil to keep going.
  func stopReason(now: TimeInterval) -> String? {
    if let phoneIdleSince, now - phoneIdleSince > Self.phoneIdleStop {
      return "Phone left Capture \(Int(now - phoneIdleSince)) s ago"
    }
    if now - lastPhoneAt > Self.phoneIdleStop {
      return "Nothing from the phone for \(Int(now - lastPhoneAt)) s"
    }
    if now - startedAt > Self.maxSession {
      return "Session hit the \(Int(Self.maxSession / 3600)) h cap"
    }
    return nil
  }
}
