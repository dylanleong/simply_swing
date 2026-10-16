import Foundation
import WatchConnectivity
import os

/**
 WatchConnectivity link to the SimpleSwing iPhone app (modules/swing-capture/ios/WatchBridge.swift).
 The only WCSession delegate in the app (WCSession.default allows one).
 The Wear OS app's MessageClient + NodeClient in one: messages out, messages and the application
 context in, reachability. Activate it at launch (WCSession needs activating before anything can
 arrive, including a context delivered while the app was launched in the background).

 Callbacks arrive on the main queue, except that pings are answered right here on WCSession's queue
 so the round trip the phone measures isn't stretched by a busy main thread.
 */
final class PhoneLink: NSObject, WCSessionDelegate {
  private static let log = Logger(subsystem: "app.simpleswing.watchkitapp", category: "PhoneLink")
  /// WatchConnectivity background tasks are completed after at most this long, delivered or not.
  private static let idleTimeout: TimeInterval = 15

  /// A message from the phone, ["t": type, ...]. Pings too, after they've been answered.
  var onMessage: (([String: Any]) -> Void)?
  /// The phone's latest application context: ["mode": …, "state": …].
  var onContext: (([String: Any]) -> Void)?
  var onReachableChange: ((Bool) -> Void)?

  private let session: WCSession? = WCSession.isSupported() ? WCSession.default : nil
  private var observations: [NSKeyValueObservation] = []
  private var idleWaiters: [() -> Void] = []

  func activate() {
    guard let session, session.delegate == nil else { return }
    session.delegate = self
    // Completing a WatchConnectivity background task early drops whatever is still in flight.
    // VERIFY: WCSession's activationState / hasContentPending are KVO-observable (Apple's sample does this).
    observations = [
      session.observe(\.activationState) { [weak self] _, _ in self?.flushIdleWaiters() },
      session.observe(\.hasContentPending) { [weak self] _, _ in self?.flushIdleWaiters() },
    ]
    session.activate()
  }

  var isReachable: Bool {
    guard let session else { return false }
    return session.activationState == .activated && session.isReachable
  }

  /**
   Sends now or not at all; onFailure (main queue) if the phone can't be reached. There's no
   transferUserInfo fallback, even for trigger: every message here is about this moment. A queued
   trigger delivered minutes later would save the wrong 6 s, a late swing would be fused with the
   wrong sound, and a stale heartbeat would claim sensing that isn't happening. Callable from any
   thread.
   */
  func send(_ message: [String: Any], onFailure: (() -> Void)? = nil) {
    guard let session, isReachable else {
      if let onFailure { DispatchQueue.main.async(execute: onFailure) }
      return
    }
    session.sendMessage(message, replyHandler: nil) { error in
      Self.log.info("Send \(WatchProtocol.type(of: message) ?? "?", privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
      if let onFailure { DispatchQueue.main.async(execute: onFailure) }
    }
  }

  /// Calls done (main queue) once the session is activated with nothing left to deliver, or after
  /// idleTimeout. For WKWatchConnectivityRefreshBackgroundTask.
  func whenIdle(_ done: @escaping () -> Void) {
    DispatchQueue.main.async { [self] in
      idleWaiters.append(done)
      flushIdleWaiters()
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.idleTimeout) { [weak self] in
        self?.flushIdleWaiters(force: true)
      }
    }
  }

  private func flushIdleWaiters(force: Bool = false) {
    DispatchQueue.main.async { [self] in
      let idle = session.map { $0.activationState == .activated && !$0.hasContentPending } ?? true
      guard force || idle, !idleWaiters.isEmpty else { return }
      let waiters = idleWaiters
      idleWaiters = []
      waiters.forEach { $0() }
    }
  }

  // MARK: WCSessionDelegate (watchOS has no sessionDidBecomeInactive / sessionDidDeactivate)

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    if let error {
      Self.log.error("WCSession activation failed: \(error.localizedDescription, privacy: .public)")
    }
    let context = session.receivedApplicationContext
    let reachable = activationState == .activated && session.isReachable
    DispatchQueue.main.async { [self] in
      if !context.isEmpty { onContext?(context) }
      onReachableChange?(reachable)
    }
    flushIdleWaiters()
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    let reachable = session.activationState == .activated && session.isReachable
    DispatchQueue.main.async { [self] in onReachableChange?(reachable) }
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    if WatchProtocol.type(of: message) == WatchProtocol.ping {
      // Clock probe: echo straight back so the phone can measure the round trip.
      session.sendMessage(WatchProtocol.pong(for: message), replyHandler: nil, errorHandler: nil)
    }
    deliver(message)
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    DispatchQueue.main.async { [self] in onContext?(applicationContext) }
  }

  private func deliver(_ message: [String: Any]) {
    DispatchQueue.main.async { [self] in onMessage?(message) }
  }
}
