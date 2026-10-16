import Combine
import Foundation
import WatchKit

/**
 The watch app's state and the glue between the phone link, the swing sensor and the screen: what
 MainActivity and SwingSensorService each do with phone messages on Wear OS, in one place because a
 watchOS app is one process with one WCSession delegate. Main thread only.
 */
final class WatchModel: ObservableObject {
  static let shared = WatchModel()
  private static let modeKey = "watchMode"

  @Published private(set) var status = PhoneStatus.unknown
  @Published private(set) var sensing = false
  /// False while sensing without a workout (no Health access): it stops when the screen goes off.
  @Published private(set) var screenOffSensing = true
  @Published private(set) var lastSwingDps: Int?
  @Published private(set) var lastTempo: String?

  /// Watch mode from the phone's Settings; auto = sense swings on the wrist.
  private(set) var mode: String {
    get { UserDefaults.standard.string(forKey: Self.modeKey) ?? WatchProtocol.modeAuto }
    set { UserDefaults.standard.set(newValue, forKey: Self.modeKey) }
  }

  let link = PhoneLink()
  let sensor = SwingSensor()
  private var launched = false

  /// From applicationDidFinishLaunching: WCSession must be activated as early as possible.
  func launch() {
    guard !launched else { return }
    launched = true
    sensor.send = { [link] message in link.send(message) }
    sensor.sendHeartbeat = { [link] in
      link.request(WatchProtocol.message(WatchProtocol.heartbeat)) { [weak self] reply in self?.heartbeatAnswered(reply) }
    }
    sensor.onSwing = { [weak self] swing in
      self?.lastSwingDps = Int(swing.peakDps)
      self?.lastTempo = WatchProtocol.tempoRatio(backswingNs: swing.backswingNs, downswingNs: swing.downswingNs)
    }
    sensor.onRunningChange = { [weak self] running, screenOff in
      self?.sensing = running
      self?.screenOffSensing = screenOff
    }
    link.onMessage = { [weak self] message in self?.handle(message) }
    link.onContext = { [weak self] context in self?.apply(context) }
    link.onReachableChange = { [weak self] reachable in self?.reachabilityChanged(reachable) }
    link.activate()
  }

  /// The app came on screen (launch, wrist raise, back from the watch face): like onResume.
  func becameActive() {
    launch()
    if mode == WatchProtocol.modeAuto { sensor.start() }
    sayHello()
  }

  /// The phone launched us with a workout configuration (HKHealthStore.startWatchApp).
  func startedByPhone() {
    if mode == WatchProtocol.modeAuto { sensor.start() }
  }

  /// handleActiveWorkoutRecovery: keep sensing only if we still should.
  func recoverWorkout() {
    sensor.recoverActiveWorkout(keep: mode == WatchProtocol.modeAuto)
  }

  func saveSwing() {
    WKInterfaceDevice.current().play(.click)
    link.send(WatchProtocol.message(WatchProtocol.trigger)) { [weak self] in
      self?.status = .noPhone
      WKInterfaceDevice.current().play(.failure)
    }
  }

  private func sayHello() {
    link.send(WatchProtocol.message(WatchProtocol.hello)) { [weak self] in self?.status = .noPhone }
  }

  private func reachabilityChanged(_ reachable: Bool) {
    if reachable {
      if status == .noPhone { status = .unknown }
      sayHello() // The phone answers with state + config.
    } else {
      status = .noPhone
    }
  }

  private func handle(_ message: [String: Any]) {
    let type = WatchProtocol.type(of: message)
    let state = WatchProtocol.engineState(in: message)
    sensor.heardFromPhone(state: type == WatchProtocol.state ? state : nil)
    switch type {
    case WatchProtocol.state:
      if let state { status = .fromEngineState(state) }
    case WatchProtocol.saved:
      // Plays with the screen off too: the workout keeps us running.
      WKInterfaceDevice.current().play(.success)
    case WatchProtocol.rejected:
      if let state { status = .fromEngineState(state) }
      WKInterfaceDevice.current().play(.failure)
    case WatchProtocol.config:
      guard let newMode = WatchProtocol.mode(in: message) else { return }
      mode = newMode
      if newMode == WatchProtocol.modeAuto {
        sensor.start()
      } else {
        sensor.stop(reason: "Watch mode \(newMode)")
      }
    default:
      break // ping: already answered by PhoneLink, and counted above as hearing from the phone.
    }
  }

  /**
   The phone's answer to a heartbeat, ["t": "state", "state", "mode"] (an older phone answers [:]).
   Any answer counts as hearing from the phone, which keeps the 2 min silence rule from stopping a
   workout the phone's own messages can't reach in the background.
   */
  private func heartbeatAnswered(_ reply: [String: Any]) {
    handle(reply)
    guard let newMode = WatchProtocol.mode(in: reply), newMode != mode else { return }
    mode = newMode
    if newMode != WatchProtocol.modeAuto { sensor.stop(reason: "Watch mode \(newMode)") }
  }

  /**
   The context the phone last set, delivered at activation or while we run. It may be old (the phone
   app could be gone), so it never starts sensing by itself (that waits for the screen or a live
   config message), and the state only shows until the phone answers hello.
   */
  private func apply(_ context: [String: Any]) {
    if let newMode = WatchProtocol.mode(in: context) {
      mode = newMode
      if newMode != WatchProtocol.modeAuto { sensor.stop(reason: "Watch mode \(newMode)") }
    }
    if let state = WatchProtocol.engineState(in: context), status != .noPhone {
      status = .fromEngineState(state)
    }
  }
}
