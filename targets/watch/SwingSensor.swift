import CoreMotion
import Foundation
import HealthKit
import os

/**
 Reads wrist rotation while a range session is on, even with the watch screen off, and tells the
 phone about each swing. Port of wear/.../SwingSensorService.kt: a golf HKWorkoutSession plays the
 part of the "health" foreground service + wake lock (watchOS keeps a workout app running, motion
 updates included, with the screen off). Nothing is saved to Health: there's no workout builder and
 the session is just ended. It stops itself once the phone has left Capture for a while, has gone
 quiet, or after 3 h; the owner stops it when the phone switches the watch to tap-only / off.

 Without HealthKit access (refused, or no Health on this watch) it still senses, but only while the
 app is on screen: watchOS suspends it when the wrist drops, the heartbeats stop and the phone falls
 back to its camera motion check.

 All state lives on one serial queue; the motion handler runs on it too.
 */
final class SwingSensor: NSObject, HKWorkoutSessionDelegate {
  private static let log = Logger(subsystem: "app.simpleswing.watchkitapp", category: "SwingSensor")
  /// 100 Hz: plenty for a ~0.25 s downswing. Device motion's rotationRate is in rad/s, bias-corrected.
  private static let sampleInterval: TimeInterval = 1.0 / 100
  /// A swing's age is believed only within this; beyond it the two clocks must disagree.
  private static let maxPlausibleAgeMs: Int64 = 5_000

  /// Sends to the phone (PhoneLink.send; any thread).
  var send: (([String: Any]) -> Void)?
  /// Main queue: a swing was detected and sent.
  var onSwing: ((SwingDetector.Swing) -> Void)?
  /// Main queue: sensing started/stopped; screenOff = a workout keeps it going with the screen off.
  var onRunningChange: ((_ running: Bool, _ screenOff: Bool) -> Void)?

  private let queue = DispatchQueue(label: "app.simpleswing.SwingSensor")
  private let motionQueue = OperationQueue()
  private let motion = CMMotionManager()
  private let store = HKHealthStore()

  private var running = false
  private var starting = false
  /// Bumped by stop(), so an authorization prompt answered after a stop doesn't start sensing.
  private var generation = 0
  private var session: HKWorkoutSession?
  private var detector: SwingDetector?
  private var heartbeat: DispatchSourceTimer?
  private var rules = SensingStopRules(now: 0)
  /// The newest sample's timestamp (ns) and when it arrived (systemUptime s), for ageMs.
  private var lastSampleNs: Int64 = 0
  private var lastSampleArrival: TimeInterval = 0

  override init() {
    super.init()
    motionQueue.underlyingQueue = queue
    motionQueue.maxConcurrentOperationCount = 1
  }

  /// Starts sensing if it isn't already: asks for HealthKit access the first time, then runs a golf
  /// workout (or, refused, foreground-only sensing).
  func start() {
    queue.async { [self] in
      guard !running, !starting else { return }
      guard motion.isDeviceMotionAvailable else {
        Self.log.warning("No device motion")
        return
      }
      starting = true
      let started = generation
      authorizeWorkout { allowed in
        self.queue.async {
          guard self.starting, self.generation == started else { return }
          self.starting = false
          self.begin(withWorkout: allowed)
        }
      }
    }
  }

  func stop(reason: String) {
    queue.async { [self] in
      generation += 1
      starting = false
      if running {
        Self.log.info("\(reason, privacy: .public); stopping")
        stopNow()
      }
    }
  }

  /// Any message from the phone; state for state messages (it drives the "left Capture" rule).
  func heardFromPhone(state: String?) {
    let now = ProcessInfo.processInfo.systemUptime
    queue.async { [self] in rules.heardFromPhone(at: now, state: state) }
  }

  /**
   The app was relaunched mid-workout (crash or system restart: WKApplicationDelegate
   handleActiveWorkoutRecovery). Picks the session back up and keeps sensing, or just ends it when
   keep is false (the watch is no longer in auto mode).
   */
  func recoverActiveWorkout(keep: Bool) {
    // VERIFY: signature recoverActiveWorkoutSession(completion: (HKWorkoutSession?, Error?) -> Void).
    store.recoverActiveWorkoutSession { [weak self] recovered, error in
      guard let self else { return }
      guard let recovered else {
        Self.log.info("No workout to recover: \(error?.localizedDescription ?? "none", privacy: .public)")
        return
      }
      self.queue.async {
        guard keep, !self.running else {
          recovered.end()
          return
        }
        recovered.delegate = self
        self.session = recovered
        self.startMotion(screenOff: true)
      }
    }
  }

  // MARK: - Workout

  /// allowed = sharing workouts is authorized, which starting a workout session requires.
  private func authorizeWorkout(_ done: @escaping (Bool) -> Void) {
    guard HKHealthStore.isHealthDataAvailable() else { return done(false) }
    let workouts = HKObjectType.workoutType()
    switch store.authorizationStatus(for: workouts) {
    case .sharingAuthorized:
      done(true)
    case .sharingDenied:
      done(false)
    case .notDetermined:
      // The prompt shows on the watch; success only means it was answered, so check again.
      store.requestAuthorization(toShare: [workouts], read: nil) { _, error in
        if let error { Self.log.error("Health authorization: \(error.localizedDescription, privacy: .public)") }
        done(self.store.authorizationStatus(for: workouts) == .sharingAuthorized)
      }
    @unknown default:
      done(false)
    }
  }

  private func begin(withWorkout: Bool) {
    if withWorkout {
      let configuration = HKWorkoutConfiguration()
      configuration.activityType = .golf
      configuration.locationType = .outdoor
      do {
        let workout = try HKWorkoutSession(healthStore: store, configuration: configuration)
        workout.delegate = self
        workout.startActivity(with: Date())
        session = workout
      } catch {
        Self.log.error("Couldn't start the workout: \(error.localizedDescription, privacy: .public)")
      }
    } else {
      Self.log.info("No Health access: sensing only while the app is on screen")
    }
    startMotion(screenOff: session != nil)
  }

  func workoutSession(
    _ workoutSession: HKWorkoutSession,
    didChangeTo toState: HKWorkoutSessionState,
    from fromState: HKWorkoutSessionState,
    date: Date
  ) {
    queue.async { [self] in
      // Sessions we ended ourselves were let go already; only an unexpected end matters.
      guard workoutSession === session, toState == .ended || toState == .stopped else { return }
      Self.log.info("Workout ended by the system; stopping")
      stopNow()
    }
  }

  func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
    queue.async { [self] in
      guard workoutSession === session else { return }
      Self.log.error("Workout failed: \(error.localizedDescription, privacy: .public); sensing on screen only")
      session = nil
      notify()
    }
  }

  // MARK: - Motion

  private func startMotion(screenOff: Bool) {
    detector = SwingDetector { [weak self] swing in self?.report(swing) }
    rules = SensingStopRules(now: ProcessInfo.processInfo.systemUptime)
    motion.deviceMotionUpdateInterval = Self.sampleInterval
    motion.startDeviceMotionUpdates(to: motionQueue) { [weak self] data, error in
      guard let self, let data else {
        if let error { Self.log.error("Motion: \(error.localizedDescription, privacy: .public)") }
        return
      }
      self.onMotion(data)
    }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: SensingStopRules.heartbeatInterval)
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.resume()
    heartbeat = timer
    running = true
    Self.log.info("Sensing swings (screen off: \(screenOff, privacy: .public))")
    notify()
  }

  /// On queue (motionQueue runs on it).
  private func onMotion(_ data: CMDeviceMotion) {
    let rate = data.rotationRate
    lastSampleNs = Int64(data.timestamp * 1e9)
    lastSampleArrival = ProcessInfo.processInfo.systemUptime
    detector?.onSample(timeNs: lastSampleNs, x: rate.x, y: rate.y, z: rate.z)
  }

  private func report(_ swing: SwingDetector.Swing) {
    let ageMs = ageMs(peakTimeNs: swing.peakTimeNs)
    Self.log.info(
      "Swing peak \(Int(swing.peakDps)) °/s, \(ageMs) ms ago, backswing \(swing.backswingNs.map { "\($0 / 1_000_000)" } ?? "?", privacy: .public) ms, downswing \(swing.downswingNs.map { "\($0 / 1_000_000)" } ?? "?", privacy: .public) ms"
    )
    send?(WatchProtocol.swingMessage(swing, ageMs: ageMs))
    DispatchQueue.main.async { [self] in onSwing?(swing) }
  }

  /**
   How long ago the swing peaked, on this watch's clock (the phone adds the one-way delay).
   CMLogItem.timestamp counts seconds since boot, like ProcessInfo.systemUptime, so the two compare
   directly. VERIFY on a watch (log both): if they ever disagree, measure from the newest sample's
   arrival instead, which is off only by the delivery delay.
   */
  private func ageMs(peakTimeNs: Int64) -> Int64 {
    let now = ProcessInfo.processInfo.systemUptime
    let direct = Int64((now * 1e9 - Double(peakTimeNs)) / 1e6)
    if (0...Self.maxPlausibleAgeMs).contains(direct) { return direct }
    let fromArrival = Int64(((now - lastSampleArrival) * 1e9 + Double(lastSampleNs - peakTimeNs)) / 1e6)
    Self.log.warning("Motion clock is not uptime (direct age \(direct) ms); using \(fromArrival) ms")
    return max(0, fromArrival)
  }

  private func tick() {
    send?(WatchProtocol.message(WatchProtocol.heartbeat))
    if let reason = rules.stopReason(now: ProcessInfo.processInfo.systemUptime) {
      Self.log.info("\(reason, privacy: .public); stopping")
      stopNow()
    }
  }

  /// On queue.
  private func stopNow() {
    motion.stopDeviceMotionUpdates()
    heartbeat?.cancel()
    heartbeat = nil
    detector = nil
    // No builder and no finishWorkout: ending the session saves nothing to Health.
    let workout = session
    session = nil
    workout?.end()
    running = false
    notify()
  }

  private func notify() {
    let running = running
    let screenOff = session != nil
    DispatchQueue.main.async { [self] in onRunningChange?(running, screenOff) }
  }
}
