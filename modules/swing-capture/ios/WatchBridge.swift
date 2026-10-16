import Foundation
import WatchConnectivity

/**
 WatchConnectivity link to the SimpleSwing Apple Watch app (targets/watch). Behaviour mirrors
 WearBridge.kt; keep the two in step.

 Every message is a dictionary `["t": <type>, …fields]`, sent with sendMessage while the watch is
 reachable:
   watch → phone  hello                ask for current state (+ we resend the config)
   watch → phone  trigger              tap-to-save
   watch → phone  swing                ageMs, peakDps[, backswingMs, downswingMs]: wrist swing that peaked ageMs ago
   watch → phone  heartbeat            sensing is running (every ~5 s)
   watch → phone  pong                 ns: echo of a ping's ns (clock round trip)
   phone → watch  state                state: engine state name
   phone → watch  saved                clip written
   phone → watch  rejected             trigger ignored (not armed, cooldown, quota); state: engine state
   phone → watch  config               mode: auto | tap | off
   phone → watch  ping                 ns: phone monotonic nanoseconds
 The phone also keeps the application context `["mode": …, "state": …]` current, so a watch app that
 launches while unreachable starts with the right mode and state.

 Threads: WCSession calls its delegate on a background queue; everything here runs on the engine's
 capture `queue`, and the callbacks are made there too. iPad (no watch): `WCSession.isSupported()` is
 false and the bridge does nothing.
 */
// VERIFY: never compiled against the iOS SDK. Type-checked on Linux against a stub written from memory
// of WatchConnectivity's Swift signatures (delegate methods, sendMessage(_:replyHandler:errorHandler:)).
final class WatchBridge: NSObject, WCSessionDelegate {
  static let modeAuto = "auto"
  static let modeTap = "tap"
  static let modeOff = "off"
  static let modes: Set<String> = [modeAuto, modeTap, modeOff]

  private static let tickInterval = 1.0
  private static let connectedTimeout = 15.0
  private static let sensingTimeout = 15.0
  private static let defaultRttMs = 80
  private static let maxRttMs = 2_000
  /// A swing older than this (or a negative age) is a broken message, not a late one.
  private static let maxSwingAgeMs = 60_000
  private static let pingKey = "ns"

  private let queue: DispatchQueue
  private let currentState: () -> EngineState
  private let onTrigger: () -> Bool
  /// Wrist swing that peaked `ageMs` + `oneWayMs` before now, with its tempo if measured.
  private let onWristSwing: (_ ageMs: Int, _ oneWayMs: Int, _ peakDps: Int, _ tempo: WristTempo?) -> Void
  private let onStatus: (_ connected: Bool, _ sensing: Bool) -> Void

  // Capture queue only.
  private var session: WCSession?
  private var mode = WatchBridge.modeAuto
  private var lastState: String
  private var lastHeard = -Double.infinity
  private var lastHeartbeat = -Double.infinity
  private var recentRttMs: [Int] = []
  private var active = false
  private var timer: DispatchSourceTimer?
  private var lastStatus: Status?
  private var lastContext: [String: String]?

  private struct Status: Equatable {
    let connected: Bool
    let sensing: Bool
  }

  init(
    queue: DispatchQueue,
    currentState: @escaping () -> EngineState,
    onTrigger: @escaping () -> Bool,
    onWristSwing: @escaping (_ ageMs: Int, _ oneWayMs: Int, _ peakDps: Int, _ tempo: WristTempo?) -> Void,
    onStatus: @escaping (_ connected: Bool, _ sensing: Bool) -> Void
  ) {
    self.queue = queue
    self.currentState = currentState
    self.onTrigger = onTrigger
    self.onWristSwing = onWristSwing
    self.onStatus = onStatus
    lastState = EngineState.idle.rawValue
    super.init()
  }

  /// Half the best recent round trip: the delay for a watch message to reach us. Capture queue.
  var oneWayMs: Int {
    (recentRttMs.min() ?? Self.defaultRttMs) / 2
  }

  /// The watch is reporting heartbeats from its swing sensor. Capture queue.
  var isSensing: Bool {
    Self.uptime() - lastHeartbeat < Self.sensingTimeout
  }

  // MARK: - Engine API (any thread)

  func start() {
    queue.async {
      guard WCSession.isSupported(), self.session == nil else { return }
      let session = WCSession.default
      session.delegate = self
      self.session = session
      session.activate()
    }
  }

  /// Ping and track the watch while Capture is running (not in the camera role).
  func setActive(_ on: Bool) {
    queue.async {
      guard self.active != on else { return }
      self.active = on
      self.timer?.cancel()
      self.timer = nil
      guard on else { return }
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(deadline: .now(), repeating: Self.tickInterval)
      timer.setEventHandler { [weak self] in self?.tick() }
      timer.resume()
      self.timer = timer
    }
  }

  func setMode(_ watchMode: String) {
    queue.async {
      self.mode = Self.modes.contains(watchMode) ? watchMode : Self.modeAuto
      self.send("config", ["mode": self.mode])
      self.updateContext()
    }
  }

  func broadcastState(_ state: EngineState) {
    queue.async {
      self.lastState = state.rawValue
      self.send("state", ["state": state.rawValue])
      self.updateContext()
    }
  }

  func broadcastSaved() {
    queue.async { self.send("saved") }
  }

  // MARK: - WCSessionDelegate (WatchConnectivity's background queue)

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    if let error { NSLog("SwingCapture: WatchConnectivity activation failed: \(error)") }
    queue.async {
      guard activationState == .activated else { return }
      self.lastContext = nil
      self.updateContext()
      self.sendStateAndConfig()
    }
  }

  func sessionDidBecomeInactive(_ session: WCSession) {}

  /// The user switched to another watch: activate again so the new one can talk to us.
  func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    let reachable = session.isReachable
    queue.async {
      if reachable { self.sendStateAndConfig() }
    }
  }

  /// Paired / app installed changed: the application context may now be deliverable.
  func sessionWatchStateDidChange(_ session: WCSession) {
    queue.async {
      self.lastContext = nil
      self.updateContext()
    }
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    let receivedNs = Self.monotonicNs()
    queue.async { self.handle(message, receivedNs: receivedNs) }
  }

  /// The watch app sends without a reply handler; answer anyway if one ever asks, so it doesn't time out.
  func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    let receivedNs = Self.monotonicNs()
    replyHandler([:])
    queue.async { self.handle(message, receivedNs: receivedNs) }
  }

  // MARK: - Capture queue

  private func handle(_ message: [String: Any], receivedNs: Int64) {
    let now = Self.uptime()
    lastHeard = now
    switch message["t"] as? String {
    case "hello":
      sendStateAndConfig()
    case "trigger":
      if mode == Self.modeOff || !onTrigger() {
        send("rejected", ["state": currentState().rawValue])
      }
    case "heartbeat":
      lastHeartbeat = now
    case "pong":
      if let sentNs = Self.pingTime(message) {
        let (elapsedNs, overflow) = receivedNs.subtractingReportingOverflow(sentNs)
        let rtt = elapsedNs / 1_000_000
        if !overflow, (0...Int64(Self.maxRttMs)).contains(rtt) {
          recentRttMs.append(Int(rtt))
          if recentRttMs.count > 8 { recentRttMs.removeFirst(recentRttMs.count - 8) }
        }
      }
    case "swing":
      lastHeartbeat = now
      if let swing = WristSwingMessage.parse(message),
         (0...Self.maxSwingAgeMs).contains(swing.ageMs),
         mode == Self.modeAuto {
        onWristSwing(swing.ageMs, oneWayMs, swing.peakDps, swing.tempo)
      }
    default:
      break
    }
    reportStatus()
  }

  private func tick() {
    send("ping", [Self.pingKey: Self.monotonicNs()])
    reportStatus()
  }

  private func reportStatus() {
    let connected = Self.uptime() - lastHeard < Self.connectedTimeout
    let status = Status(connected: connected, sensing: connected && isSensing && mode == Self.modeAuto)
    guard status != lastStatus else { return }
    lastStatus = status
    onStatus(status.connected, status.sensing)
  }

  private func sendStateAndConfig() {
    send("state", ["state": currentState().rawValue])
    send("config", ["mode": mode])
  }

  private func send(_ type: String, _ fields: [String: Any] = [:]) {
    guard let session, session.activationState == .activated, session.isReachable else { return }
    var message = fields
    message["t"] = type
    session.sendMessage(message, replyHandler: nil) { _ in
      // Unreachable mid-send or the watch app went away: the next state change or hello catches up.
    }
  }

  /// Keeps `["mode", "state"]` current for a watch app that starts while we can't reach it.
  private func updateContext() {
    guard let session, session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
    let context = ["mode": mode, "state": lastState]
    guard context != lastContext else { return }
    do {
      try session.updateApplicationContext(context)
      lastContext = context
    } catch {
      NSLog("SwingCapture: couldn't update the watch's application context: \(error)")
    }
  }

  /// The ping time a pong echoes: under `ns`, or failing that the message's only other number (so a
  /// watch app that echoes the ping under another key still works).
  private static func pingTime(_ message: [String: Any]) -> Int64? {
    if let ns = WristSwingMessage.integer(message[pingKey]) { return Int64(ns) }
    for (key, value) in message where key != "t" {
      if let ns = WristSwingMessage.integer(value) { return Int64(ns) }
    }
    return nil
  }

  private static func monotonicNs() -> Int64 {
    Int64(clamping: DispatchTime.now().uptimeNanoseconds)
  }

  private static func uptime() -> Double {
    ProcessInfo.processInfo.systemUptime
  }
}
