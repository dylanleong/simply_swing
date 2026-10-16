import Foundation
import Network
import UIKit

/// Mirrors `PeerRole` in src/SwingCapture.types.ts.
enum PeerRole: String {
  case solo
  case main
  case camera
}

/// What PeerLink needs from the engine (CaptureEngine implements it). Called on PeerLink's queue.
protocol PeerLinkHost: AnyObject {
  /// Capture-clock now, µs (the clock frame and trigger times use).
  func peerNowUs() -> Int64
  func peerFps() -> Int
  func peerEngineState() -> EngineState
  /// Camera role: save `window` for the main phone as clip `id`. False if not ready.
  func peerTrigger(id: String, window: ClipWindow) -> Bool
  /// Camera role: the main phone's engine state; the camera follows it into and out of standby.
  func peerMainState(_ state: String)
  /// Main role: the second angle of `id` is on disk.
  func peerAngleReady(id: String)
  func peerStatus(_ status: PeerLink.Status)
  func peersFound(_ peers: [PeerLink.PeerInfo])
  func peerError(code: String, message: String)
}

/**
 Two-phone capture over the local network (same Wi-Fi, or one phone's hotspot); port of PeerLink.kt
 on Network.framework. See PeerProtocol for the messages.

 - **Camera** phone: an NWListener on TCP `PeerProtocol.defaultPort`, advertised over Bonjour as
   `_simpleswing._tcp`. Saves whatever window the main phone asks for, then streams the clip back.
   A new connection stays *unauthenticated* (ignored, not replacing the live link) until it sends a
   main-phone HELLO with this phone's 6-digit pairing code; a wrong code locks every HELLO out for 2 s.
 - **Main** phone: an NWBrowser finds camera phones; it connects to one, pings it every second to keep
   a ClockSync, and converts each accepted trigger's window to the camera's clock before sending.
   Received clips become `<id>.b.mp4` + `<id>.b.json` beside the main clip.

 Threads: all state lives on `queue`, which is also where Network.framework delivers callbacks. The
 public methods hop onto it, except `role`, which any thread may read.
 */
final class PeerLink {
  struct Status: Equatable {
    let role: PeerRole
    /// idle | searching | advertising | connected
    let state: String
    let peerName: String?
    let peerState: String?
    let syncMs: Double?
    let address: String?
    /// Camera role: this phone's pairing code, shown on screen; nil otherwise.
    let code: String?
  }

  /// `host` is empty for Bonjour results: Network.framework connects to the service without resolving it.
  struct PeerInfo {
    let id: String
    let name: String
    let host: String
    let port: Int
    fileprivate let endpoint: NWEndpoint
  }

  weak var host: PeerLinkHost?

  var role: PeerRole {
    roleLock.lock()
    defer { roleLock.unlock() }
    return _role
  }

  private let queue = DispatchQueue(label: "app.simpleswing.peer", qos: .userInitiated)
  private let roleLock = NSLock()
  private var _role = PeerRole.solo

  // Queue state.
  /// Camera role: the angle this phone films, told to the main phone.
  private var view = ""
  private var deviceName = "iPhone"
  private var connection: Connection?
  private var listener: NWListener?
  private var browser: NWBrowser?
  private var found: [String: PeerInfo] = [:]
  /// Main role: where to reconnect after the link drops.
  private var target: NWEndpoint?
  /// Main role: an outgoing connection that isn't ready yet.
  private var connecting: NWConnection?
  /// Main role: the user asked to connect; report if it fails (the 1 s retries stay silent).
  private var reportConnectFailure = false
  private var lastStatus: Status?
  /// Main role: the camera phone's pairing code, sent in our HELLO.
  private var targetCode = ""
  /// Main role: ids we sent a TRIGGER for (only their clips are accepted), when, and the sync
  /// uncertainty at that moment (for the angle sidecar). Dropped after `triggerExpiry`, REJECT or DONE.
  private var sentTriggers: [String: SentTrigger] = [:]
  /// Camera role: connections that haven't sent a valid main-phone HELLO yet.
  private var unauthenticated: [Connection] = []
  /// Camera role: after a wrong code every HELLO is refused until this uptime (global, not per connection).
  private var lockoutUntil: TimeInterval = 0
  private var timer: DispatchSourceTimer?

  private struct SentTrigger {
    let at: TimeInterval
    let syncMs: Double?
  }

  private static let tickInterval = 1.0
  private static let silenceTimeout = 6.0
  private static let connectTimeout = 3.0
  private static let helloTimeout = 5.0
  private static let codeLockout = 2.0
  private static let triggerExpiry = 60.0
  /// Camera role: unauthenticated connections kept at once; new ones are refused beyond this.
  private static let maxUnauthenticated = 4
  private static let pairCodeKey = "simpleswing.pairCode"
  /// kDNSServiceErr_PolicyDenied (dns_sd.h): Bonjour blocked by the Local Network permission.
  private static let dnsPolicyDenied: Int32 = -65570

  /// Camera role: this phone's pairing code. Made once and kept, so the main phone can remember it.
  private lazy var pairCode: String = {
    let defaults = UserDefaults.standard
    if let saved = defaults.string(forKey: PeerLink.pairCodeKey), PeerProtocol.isValidPairCode(saved) { return saved }
    let code = PeerProtocol.newPairCode()
    defaults.set(code, forKey: PeerLink.pairCodeKey)
    return code
  }()

  init() {
    // UIDevice is main-actor only. Since iOS 16 this is "iPhone" / "iPad" unless the app has the
    // device-name entitlement, which is still enough to tell the user which phone is which.
    Task { @MainActor [weak self] in
      let name = UIDevice.current.name
      self?.queue.async { self?.deviceName = name }
    }
  }

  // MARK: - Public API (any thread)

  func startMain() {
    queue.async { [self] in
      guard role != .main else { return }
      stopInternal()
      setRole(.main)
      startBrowsing()
      startTimer()
      reportStatus()
    }
  }

  func startCamera(view: String) {
    queue.async { [self] in
      self.view = view
      if role == .camera {
        connection?.send(helloMessage())
        return
      }
      stopInternal()
      setRole(.camera)
      startListening(port: NWEndpoint.Port(rawValue: PeerProtocol.defaultPort))
      startTimer()
      reportStatus()
    }
  }

  func stop() {
    queue.async { [self] in
      stopInternal()
      reportStatus()
    }
  }

  /// Main role: a discovered peer id, or a typed `host[:port]`, with the camera phone's pairing code.
  func connect(_ idOrAddress: String, code: String) {
    queue.async { [self] in
      guard role == .main else { return }
      guard let endpoint = found[idOrAddress]?.endpoint ?? Self.parseAddress(idOrAddress) else {
        host?.peerError(code: "E_PEER_ADDRESS", message: "That doesn't look like an address: \(idOrAddress)")
        return
      }
      target = endpoint
      targetCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
      reportConnectFailure = true
      connection?.close("switching camera")
      connecting?.cancel()
      connecting = nil
      connectTo(endpoint)
    }
  }

  /// Main role: ask the camera phone for the same moment. `window` is on our capture clock (seconds);
  /// it's sent on the camera's (µs). Does nothing if there's no synced camera.
  func sendTrigger(id: String, window: ClipWindow) {
    queue.async { [self] in
      guard role == .main, let c = connection, c.hello != nil, PeerProtocol.isValidClipId(id) else { return }
      let peerUs = { (seconds: Double) in PeerProtocol.micros(fromSeconds: seconds).flatMap { c.sync.toPeer($0) } }
      guard let start = peerUs(window.start), let end = peerUs(window.end), let anchor = peerUs(window.anchor) else { return }
      sentTriggers[id] = SentTrigger(
        at: ProcessInfo.processInfo.systemUptime,
        syncMs: c.sync.errorUs.map { Double($0) / 1000 }
      )
      NSLog("SwingPeerLink: trigger \(id) → camera (window \(start)..\(end))")
      c.send(.trigger(id: id, startUs: start, endUs: end, anchorUs: anchor))
    }
  }

  /// Camera role: stream a saved clip to the main phone, then delete it.
  func sendClip(id: String, file: URL, fps: Int, durationMs: Double, anchorOffsetMs: Double) {
    queue.async { [self] in
      let discard = { try? FileManager.default.removeItem(at: file) }
      guard role == .camera, let c = connection else {
        NSLog("SwingPeerLink: clip \(id) saved but no main phone connected; dropped")
        discard()
        return
      }
      guard let handle = try? FileHandle(forReadingFrom: file),
            let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value
      else {
        discard()
        return
      }
      let finish = { (ok: Bool) in
        try? handle.close()
        discard()
        if ok { NSLog("SwingPeerLink: sent clip \(id) (\(size / 1024) KB)") }
      }
      c.send(.clip(id: id, fps: fps, durationMs: durationMs, anchorOffsetMs: anchorOffsetMs, size: size))
      // One chunk in flight at a time: the clip never sits in memory whole, and pongs interleave.
      func next() {
        let chunk: Data
        do {
          chunk = try handle.read(upToCount: PeerProtocol.chunkBytes) ?? Data()
        } catch {
          NSLog("SwingPeerLink: reading clip \(id) failed: \(error)")
          c.close("send failed")
          finish(false)
          return
        }
        if chunk.isEmpty {
          c.send(.done(id: id)) { finish($0) }
          return
        }
        c.send(.data(chunk)) { ok in
          if ok { next() } else { finish(false) }
        }
      }
      next()
    }
  }

  /// Camera role: we couldn't save clip `id` after all (export failed, timed out, no frames); the main
  /// phone tells the user straight away rather than wait for nothing.
  func rejectClip(id: String, reason: String) {
    queue.async { [self] in
      guard role == .camera, PeerProtocol.isValidClipId(id) else { return }
      connection?.send(.reject(id: id, reason: reason))
    }
  }

  /// Our engine changed state; the other phone shows it (and a camera phone follows the main's).
  func onEngineState(_ state: EngineState) {
    queue.async { [self] in
      connection?.send(.state(state.rawValue))
    }
  }

  // MARK: - Queue

  private func setRole(_ next: PeerRole) {
    roleLock.lock()
    _role = next
    roleLock.unlock()
  }

  private func helloMessage() -> PeerMessage {
    .hello(
      version: PeerProtocol.version,
      role: role.rawValue,
      name: deviceName,
      platform: "ios",
      fps: host?.peerFps() ?? 0,
      view: view,
      code: role == .main ? targetCode : ""
    )
  }

  private func stopInternal() {
    timer?.cancel()
    timer = nil
    if let c = connection {
      connection = nil
      c.send(.bye) { _ in c.close("stopped") }
    }
    // Connections still waiting to pair would otherwise pair after we've stopped being a camera.
    for c in unauthenticated { c.close("stopped") }
    unauthenticated.removeAll()
    connecting?.cancel()
    connecting = nil
    target = nil
    targetCode = ""
    browser?.cancel()
    browser = nil
    listener?.cancel()
    listener = nil
    found.removeAll()
    sentTriggers.removeAll()
    setRole(.solo)
  }

  private func startTimer() {
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now(), repeating: Self.tickInterval)
    t.setEventHandler { [weak self] in self?.onTick() }
    t.resume()
    timer = t
  }

  private func onTick() {
    if let c = connection, ProcessInfo.processInfo.systemUptime - c.lastHeard > Self.silenceTimeout {
      c.close("no reply for \(Int(Self.silenceTimeout)) s")
    }
    let now = ProcessInfo.processInfo.systemUptime
    sentTriggers = sentTriggers.filter { now - $0.value.at < Self.triggerExpiry }
    if role == .main {
      if let live = connection {
        live.send(.ping(t1: host?.peerNowUs() ?? 0, syncUs: live.sync.errorUs))
      } else if let target {
        connectTo(target)
      }
    }
    reportStatus()
  }

  private static func parameters() -> NWParameters {
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.connectionTimeout = Int(connectTimeout)
    let params = NWParameters(tls: nil, tcp: tcp)
    // Lets two iPhones find each other over AWDL even without a shared Wi-Fi network.
    params.includePeerToPeer = true
    return params
  }

  private func connectTo(_ endpoint: NWEndpoint) {
    guard connecting == nil, connection == nil else { return }
    let nw = NWConnection(to: endpoint, using: Self.parameters())
    connecting = nw
    nw.stateUpdateHandler = { [weak self, weak nw] state in
      guard let self, let nw, self.connecting === nw else { return }
      switch state {
      case .ready:
        self.connecting = nil
        self.reportConnectFailure = false
        guard self.role == .main, self.target == endpoint else {
          nw.cancel()
          return
        }
        self.adopt(nw)
      case let .failed(error), let .waiting(error):
        // .waiting covers "refused" and "no route"; the tick retries rather than Network.framework.
        NSLog("SwingPeerLink: connect to \(endpoint) failed: \(error)")
        self.connecting = nil
        nw.cancel()
        self.connectFailed(endpoint)
      default:
        break
      }
    }
    nw.start(queue: queue)
    queue.asyncAfter(deadline: .now() + Self.connectTimeout) { [weak self, weak nw] in
      guard let self, let nw, self.connecting === nw else { return }
      self.connecting = nil
      nw.cancel()
      self.connectFailed(endpoint)
    }
  }

  private func connectFailed(_ endpoint: NWEndpoint) {
    guard reportConnectFailure, role == .main, target == endpoint else { return }
    reportConnectFailure = false
    host?.peerError(
      code: "E_PEER_CONNECT",
      message: "Couldn't reach the camera phone. Check both phones are on the same Wi-Fi and it shows its camera screen."
    )
  }

  /// Main role: our own outgoing connection is trusted; say HELLO (with the camera's code) at once.
  private func adopt(_ nw: NWConnection) {
    connection?.close("replaced")
    let c = Connection(nw, link: self)
    c.authenticated = true
    connection = c
    c.start(started: true)
    c.send(helloMessage())
    c.send(.state((host?.peerEngineState() ?? .idle).rawValue))
    NSLog("SwingPeerLink: connected to \(nw.endpoint) as \(role.rawValue)")
    reportStatus()
  }

  /// Camera role: an incoming connection waits, unauthenticated, for the main phone's HELLO. It
  /// doesn't touch the live link, and is closed if no valid HELLO arrives within `helloTimeout`.
  private func accept(_ nw: NWConnection) {
    // Refuse the newcomer rather than evict one already waiting: a flood can't push the main phone out.
    guard unauthenticated.count < Self.maxUnauthenticated else {
      NSLog("SwingPeerLink: \(Self.maxUnauthenticated) connections already waiting to pair; refused another")
      nw.cancel()
      return
    }
    let c = Connection(nw, link: self)
    unauthenticated.append(c)
    c.start(started: false)
    queue.asyncAfter(deadline: .now() + Self.helloTimeout) { [weak c] in
      guard let c, !c.authenticated, !c.closed else { return }
      c.close("no hello within \(Int(Self.helloTimeout)) s")
    }
  }

  /// Camera role: the HELLO of an unauthenticated connection. Accepts it (replacing any older link:
  /// the newest authenticated main phone wins) or refuses it.
  private func authenticate(_ c: Connection, version: Int, role peerRole: String, name: String, view: String, code: String) {
    let now = ProcessInfo.processInfo.systemUptime
    let refuse = { (reason: String) in
      c.refused = true
      c.send(.reject(id: "", reason: reason)) { _ in c.close("refused: \(reason)") }
    }
    // stop() closed us, or the role changed, while this HELLO was on its way: never pair now.
    guard role == .camera, unauthenticated.contains(where: { $0 === c }) else {
      c.close("not a camera any more")
      return
    }
    // Same order as PeerLink.kt: role, version, lockout, code.
    guard peerRole == PeerRole.main.rawValue else {
      c.close("hello from a \(peerRole), not a main phone")
      return
    }
    guard version == PeerProtocol.version else {
      // Our HELLO tells an older or newer main phone about the mismatch too, so both phones say so.
      host?.peerError(code: "E_PEER_VERSION", message: "Update SimpleSwing on both phones to use them together.")
      c.refused = true
      c.send(helloMessage()) { _ in c.close("version \(version)") }
      return
    }
    // Lockout check, code compare and lockout set happen together on `queue`, which every
    // connection shares: parallel connections get one guess per lockout between them.
    if now < lockoutUntil {
      refuse("wait")
      return
    }
    guard PeerProtocol.codesMatch(code, pairCode) else {
      lockoutUntil = now + Self.codeLockout
      NSLog("SwingPeerLink: main phone sent the wrong pairing code")
      refuse("code")
      return
    }
    unauthenticated.removeAll { $0 === c }
    c.authenticated = true
    c.lastHeard = now
    c.hello = Connection.Hello(name: name, view: view)
    connection?.close("replaced")
    connection = c
    c.send(helloMessage())
    c.send(.state((host?.peerEngineState() ?? .idle).rawValue))
    NSLog("SwingPeerLink: main phone \(name) connected")
    reportStatus()
  }

  fileprivate func closed(_ c: Connection, reason: String) {
    if let i = unauthenticated.firstIndex(where: { $0 === c }) {
      unauthenticated.remove(at: i)
      return
    }
    guard connection === c else { return }
    connection = nil
    NSLog("SwingPeerLink: link closed: \(reason)")
    reportStatus()
  }

  private func reportStatus() {
    let c = connection
    let connected = c?.hello != nil
    let syncUs: Int64? = c.flatMap { role == .main ? $0.sync.errorUs : $0.peerSyncUs }
    let state: String
    if role == .solo {
      state = "idle"
    } else if connected {
      state = "connected"
    } else {
      state = role == .main ? "searching" : "advertising"
    }
    let status = Status(
      role: role,
      state: state,
      peerName: connected ? c?.hello?.name : nil,
      peerState: connected ? c?.peerState : nil,
      // Whole-ms resolution keeps the status from changing on every ping.
      syncMs: syncUs.map { max(1, (Double($0) / 1000).rounded()) },
      address: role == .camera ? localAddress() : nil,
      code: role == .camera ? pairCode : nil
    )
    if status != lastStatus {
      lastStatus = status
      host?.peerStatus(status)
    }
  }

  // MARK: - Camera role: listener + Bonjour

  /// `port` nil means any free port (47800 is taken, e.g. by a second app instance); Bonjour still finds us.
  private func startListening(port: NWEndpoint.Port?) {
    let l: NWListener
    do {
      l = try NWListener(using: Self.parameters(), on: port ?? .any)
    } catch {
      if port != nil {
        startListening(port: nil)
      } else {
        host?.peerError(code: "E_PEER_LISTEN", message: "Couldn't open the link for the main phone: \(error.localizedDescription)")
      }
      return
    }
    l.service = NWListener.Service(name: deviceName, type: PeerProtocol.serviceType)
    l.stateUpdateHandler = { [weak self, weak l] state in
      guard let self, let l, self.listener === l else { return }
      switch state {
      case .ready:
        NSLog("SwingPeerLink: advertising as \(self.deviceName) on port \(l.port?.rawValue ?? 0)")
        self.reportStatus()
      case let .failed(error):
        NSLog("SwingPeerLink: listener failed: \(error)")
        l.cancel()
        self.listener = nil
        if port != nil {
          self.startListening(port: nil)
        } else {
          self.host?.peerError(code: "E_PEER_LISTEN", message: "Couldn't open the link for the main phone.")
        }
      default:
        break
      }
    }
    l.newConnectionHandler = { [weak self, weak l] nw in
      guard let self, let l, self.listener === l else {
        nw.cancel()
        return
      }
      // Once authenticated, the newest main phone wins: a dropped link reconnecting replaces its stale socket.
      self.accept(nw)
    }
    listener = l
    l.start(queue: queue)
  }

  // MARK: - Main role: discovery

  private func startBrowsing() {
    let b = NWBrowser(for: .bonjour(type: PeerProtocol.serviceType, domain: nil), using: Self.parameters())
    b.browseResultsChangedHandler = { [weak self, weak b] results, _ in
      guard let self, let b, self.browser === b, self.role == .main else { return }
      var next: [String: PeerInfo] = [:]
      for result in results {
        if case let .service(name, _, _, _) = result.endpoint {
          next[name] = PeerInfo(id: name, name: name, host: "", port: 0, endpoint: result.endpoint)
        }
      }
      self.found = next
      self.host?.peersFound(next.values.sorted { $0.name < $1.name })
    }
    b.stateUpdateHandler = { [weak self, weak b] state in
      guard let self, let b, self.browser === b else { return }
      switch state {
      case let .waiting(error), let .failed(error):
        NSLog("SwingPeerLink: discovery failed: \(error)")
        // The Local Network permission was refused: Bonjour fails with "policy denied".
        if case let .dns(code) = error, code == Self.dnsPolicyDenied {
          self.host?.peerError(
            code: "E_PEER_PERMISSION",
            message: "Allow Local Network for SimpleSwing in Settings to find your other phone."
          )
        }
      default:
        break
      }
    }
    browser = b
    b.start(queue: queue)
  }

  // MARK: - Messages

  fileprivate func handle(_ c: Connection, _ m: PeerMessage, receivedUs: Int64) {
    if !c.authenticated {
      // Camera role, unauthenticated: the first message must be the main phone's HELLO; anything else
      // hangs up. A refused connection is closing already.
      guard !c.refused else { return }
      if case let .hello(version, peerRole, name, _, _, view, code) = m {
        authenticate(c, version: version, role: peerRole, name: name, view: view, code: code)
      } else {
        c.close("message before HELLO")
      }
      return
    }
    guard connection === c else { return }
    c.lastHeard = ProcessInfo.processInfo.systemUptime
    switch m {
    case let .hello(version, _, name, _, _, view, _):
      guard version == PeerProtocol.version else {
        if role == .main {
          // Retrying every second would only repeat the error until one phone is updated.
          target = nil
          targetCode = ""
          reportConnectFailure = false
        }
        host?.peerError(code: "E_PEER_VERSION", message: "Update SimpleSwing on both phones to use them together.")
        c.close("version \(version)")
        return
      }
      c.hello = Connection.Hello(name: name, view: view)
      reportStatus()
    case let .ping(t1, syncUs):
      c.peerSyncUs = syncUs
      c.send(.pong(t1: t1, t2: receivedUs, t3: host?.peerNowUs() ?? 0))
    case let .pong(t1, t2, t3):
      c.sync.add(t1: t1, t2: t2, t3: t3, t4: receivedUs)
    case let .state(state):
      c.peerState = state
      if role == .camera { host?.peerMainState(state) }
      reportStatus()
    case let .trigger(id, startUs, endUs, anchorUs):
      guard role == .camera else { return }
      // The id becomes a file name: never build a path from anything else.
      guard PeerProtocol.isValidClipId(id) else {
        c.send(.reject(id: String(id.prefix(64)), reason: "id"))
        return
      }
      guard PeerProtocol.isValidWindow(startUs: startUs, endUs: endUs, nowUs: receivedUs) else {
        NSLog("SwingPeerLink: main phone trigger \(id) has an implausible window; rejected")
        c.send(.reject(id: id, reason: "window"))
        return
      }
      let window = ClipWindow(
        start: Double(startUs) / 1_000_000,
        end: Double(endUs) / 1_000_000,
        impact: nil,
        anchor: Double(anchorUs) / 1_000_000
      )
      // Safe: isValidWindow bounds endUs to within 2 min of receivedUs.
      NSLog("SwingPeerLink: main phone trigger \(id) (window ends in \((endUs - receivedUs) / 1000) ms)")
      if host?.peerTrigger(id: id, window: window) != true { c.send(.reject(id: id, reason: "busy")) }
    case let .reject(id, reason):
      guard role == .main else { return }
      if id.isEmpty {
        // The camera refused the link itself.
        if reason == "code" {
          NSLog("SwingPeerLink: camera phone refused the pairing code")
          target = nil
          targetCode = ""
          reportConnectFailure = false
          host?.peerError(code: "E_PEER_CODE", message: "That code doesn't match. Check the code on the camera phone's screen.")
        }
        // "wait" (a wrong code was tried moments ago): drop the link; the tick retries as usual.
        c.close("refused: \(reason)")
        return
      }
      NSLog("SwingPeerLink: camera phone missed \(id): \(reason)")
      sentTriggers[id] = nil
      host?.peerError(code: "E_PEER_MISSED", message: "The second camera wasn't ready for that swing.")
    case .bye:
      c.close("peer left")
    case .clip, .data, .done:
      if role == .main { receive(c, m) }
    case .unknown:
      break
    }
  }

  // MARK: - Main role: receiving clips

  private func receive(_ c: Connection, _ m: PeerMessage) {
    switch m {
    case let .clip(id, fps, durationMs, anchorOffsetMs, size):
      if let cut = c.incoming {
        c.incoming = nil
        dropIncoming(cut)
      }
      // Only clips we asked for; DATA and DONE that follow an ignored CLIP are dropped (no incoming).
      guard PeerProtocol.isValidClipId(id), sentTriggers[id] != nil else {
        NSLog("SwingPeerLink: ignoring clip \(id.prefix(64)): not one we triggered")
        return
      }
      guard size > 0, size <= PeerProtocol.maxClipBytes else {
        NSLog("SwingPeerLink: clip \(id) refused: \(size) bytes")
        sentTriggers[id] = nil
        host?.peerError(code: "E_PEER_CLIP", message: "Couldn't save the second camera's clip.")
        return
      }
      c.incoming = Incoming(id: id, fps: fps, durationMs: durationMs, anchorOffsetMs: anchorOffsetMs, size: size)
    case let .data(bytes):
      guard let clip = c.incoming else { return }
      // write() also refuses bytes beyond the size the CLIP announced.
      if !clip.write(bytes) {
        clip.abort()
        c.incoming = nil
        sentTriggers[clip.id] = nil
        host?.peerError(code: "E_PEER_CLIP", message: "Couldn't save the second camera's clip.")
      }
    case let .done(id):
      guard let clip = c.incoming else { return }
      c.incoming = nil
      guard id == clip.id else {
        dropIncoming(clip)
        return
      }
      switch clip.finish(hello: c.hello, syncMs: sentTriggers.removeValue(forKey: id)?.syncMs) {
      case .saved:
        host?.peerAngleReady(id: id)
      case .incomplete:
        host?.peerError(code: "E_PEER_CLIP", message: "The second camera's clip didn't arrive in full.")
      case .failed:
        host?.peerError(code: "E_PEER_CLIP", message: "Couldn't save the second camera's clip.")
      }
    default:
      break
    }
  }

  /// A transfer cut short by a muddled stream (a new CLIP mid-transfer, DONE for another id): tell
  /// the user now rather than wait for nothing, and stop expecting that clip.
  private func dropIncoming(_ clip: Incoming) {
    clip.abort()
    sentTriggers[clip.id] = nil
    host?.peerError(code: "E_PEER_CLIP", message: "The second camera's clip didn't arrive in full.")
  }

  /// A clip arriving from the camera phone, written to `<id>.b.mp4.part` until complete.
  fileprivate final class Incoming {
    enum Result { case saved, incomplete, failed }

    let id: String
    let fps: Int
    let durationMs: Double
    let anchorOffsetMs: Double
    let size: Int64
    private let part: URL
    private let handle: FileHandle?
    private var received: Int64 = 0

    init(id: String, fps: Int, durationMs: Double, anchorOffsetMs: Double, size: Int64) {
      self.id = id
      self.fps = fps
      self.durationMs = durationMs
      self.anchorOffsetMs = anchorOffsetMs
      self.size = size
      part = SwingFiles.clipsDir.appendingPathComponent("\(id).b.mp4.part")
      FileManager.default.createFile(atPath: part.path, contents: nil)
      handle = try? FileHandle(forWritingTo: part)
    }

    func write(_ data: Data) -> Bool {
      guard let handle else { return false }
      // More than announced: a broken or hostile peer. Stop before it fills the disk.
      guard Int64(data.count) <= size - received else {
        NSLog("SwingPeerLink: clip \(id) is bigger than its \(size) bytes; aborted")
        return false
      }
      do {
        try handle.write(contentsOf: data)
      } catch {
        return false
      }
      received += Int64(data.count)
      return true
    }

    func abort() {
      try? handle?.close()
      try? FileManager.default.removeItem(at: part)
    }

    func finish(hello: Connection.Hello?, syncMs: Double?) -> Result {
      try? handle?.close()
      let fm = FileManager.default
      guard received == size else {
        NSLog("SwingPeerLink: clip \(id) incomplete: \(received) of \(size) bytes")
        try? fm.removeItem(at: part)
        return .incomplete
      }
      let json: [String: Any] = [
        "fps": fps,
        "durationMs": durationMs,
        "anchorOffsetMs": anchorOffsetMs,
        "view": hello.flatMap { $0.view.isEmpty ? nil : $0.view } ?? NSNull(),
        "deviceName": hello?.name ?? NSNull(),
        "syncMs": syncMs ?? NSNull(),
        "nudgeMs": 0,
      ]
      let dir = SwingFiles.clipsDir
      // Sidecar first: the library only lists an angle once its .b.mp4 exists.
      guard let data = try? JSONSerialization.data(withJSONObject: json),
            (try? data.write(to: dir.appendingPathComponent("\(id).b.json"))) != nil
      else {
        try? fm.removeItem(at: part)
        return .failed
      }
      let dest = dir.appendingPathComponent("\(id).b.mp4")
      try? fm.removeItem(at: dest)
      do {
        try fm.moveItem(at: part, to: dest)
      } catch {
        try? fm.removeItem(at: part)
        return .failed
      }
      NSLog("SwingPeerLink: received angle \(id) (\(received / 1024) KB)")
      return .saved
    }
  }

  // MARK: - Connection

  fileprivate final class Connection {
    struct Hello {
      let name: String
      let view: String
    }

    let nw: NWConnection
    let sync = ClockSync()
    var lastHeard = ProcessInfo.processInfo.systemUptime
    /// Outgoing (main role) connections are; incoming ones once their HELLO had the right code.
    var authenticated = false
    /// A REJECT is on its way and the connection closes after it: ignore anything more it sends.
    var refused = false
    var hello: Hello?
    var peerState: String?
    /// Camera role: the main phone's sync uncertainty, from its pings.
    var peerSyncUs: Int64?
    var incoming: Incoming?
    private(set) var closed = false
    private weak var link: PeerLink?

    init(_ nw: NWConnection, link: PeerLink) {
      self.nw = nw
      self.link = link
    }

    /// `started`: outgoing connections are already running (and ready); incoming ones aren't yet.
    func start(started: Bool) {
      nw.stateUpdateHandler = { [weak self] state in
        switch state {
        case let .failed(error):
          self?.close("failed: \(error)")
        case let .waiting(error):
          self?.close("lost: \(error)")
        case .cancelled:
          self?.close("cancelled")
        default:
          break
        }
      }
      if !started, let queue = link?.queue { nw.start(queue: queue) }
      receiveHeader()
    }

    /// Queues a frame; Network.framework sends them in order. `completion` runs on the link's queue.
    func send(_ message: PeerMessage, completion: ((Bool) -> Void)? = nil) {
      guard !closed, let frame = try? PeerProtocol.frame(message) else {
        completion?(false)
        return
      }
      nw.send(content: frame, completion: .contentProcessed { [weak self] error in
        if let error {
          self?.close("write failed: \(error)")
          completion?(false)
        } else {
          completion?(true)
        }
      })
    }

    func close(_ reason: String) {
      guard !closed else { return }
      closed = true
      incoming?.abort()
      incoming = nil
      nw.cancel()
      link?.closed(self, reason: reason)
    }

    private func receiveHeader() {
      nw.receive(minimumIncompleteLength: PeerProtocol.headerBytes, maximumLength: PeerProtocol.headerBytes) {
        [weak self] data, _, isComplete, error in
        guard let self, !self.closed else { return }
        if let error {
          self.close("read failed: \(error)")
          return
        }
        guard let data, data.count == PeerProtocol.headerBytes else {
          self.close(isComplete ? "peer closed the link" : "short read")
          return
        }
        do {
          let (type, length) = try PeerProtocol.header(data)
          if length == 0 {
            self.deliver(type: type, payload: Data())
          } else {
            self.receivePayload(type: type, length: length)
          }
        } catch {
          self.close("read failed: \(error)")
        }
      }
    }

    private func receivePayload(type: UInt8, length: Int) {
      nw.receive(minimumIncompleteLength: length, maximumLength: length) { [weak self] data, _, _, error in
        guard let self, !self.closed else { return }
        if let error {
          self.close("read failed: \(error)")
          return
        }
        guard let data, data.count == length else {
          self.close("short read")
          return
        }
        self.deliver(type: type, payload: data)
      }
    }

    private func deliver(type: UInt8, payload: Data) {
      let receivedUs = link?.host?.peerNowUs() ?? 0
      do {
        let message = try PeerProtocol.decode(type: type, payload: payload)
        link?.handle(self, message, receivedUs: receivedUs)
      } catch {
        close("bad message: \(error)")
        return
      }
      if !closed { receiveHeader() }
    }
  }

  // MARK: - Helpers

  /// This phone's Wi-Fi / hotspot address, for typing into the main phone when discovery fails.
  private func localAddress() -> String? {
    guard let port = listener?.port?.rawValue else { return nil }
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return nil }
    defer { freeifaddrs(list) }
    var best: (rank: Int, ip: String)?
    for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let ifa = ptr.pointee
      guard let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }
      let flags = Int32(ifa.ifa_flags)
      guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
      // en0 is Wi-Fi; bridge100 is this phone's own hotspot. Cellular (pdp_ip*) can't be reached.
      let name = String(cString: ifa.ifa_name)
      let rank: Int
      if name == "en0" {
        rank = 0
      } else if name.hasPrefix("bridge") {
        rank = 1
      } else if name.hasPrefix("en") {
        rank = 2
      } else {
        continue
      }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0
      else { continue }
      let ip = String(cString: host)
      guard Self.isSiteLocal(ip) else { continue }
      if best == nil || rank < best!.rank { best = (rank, ip) }
    }
    guard let ip = best?.ip else { return nil }
    return port == PeerProtocol.defaultPort ? ip : "\(ip):\(port)"
  }

  /// 10/8, 172.16/12, 192.168/16 (Java's isSiteLocalAddress, for IPv4).
  private static func isSiteLocal(_ ip: String) -> Bool {
    let parts = ip.split(separator: ".").compactMap { Int($0) }
    guard parts.count == 4 else { return false }
    return parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 192 && parts[1] == 168)
  }

  /// `host`, `host:port` or `[v6]:port`; nil if it isn't one. Same rules as PeerLink.parseAddress (Kotlin).
  static func parseAddress(_ text: String) -> NWEndpoint? {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty || t.contains(" ") { return nil }
    let hostPart: String
    let portText: String?
    if t.hasPrefix("[") {
      guard let end = t.firstIndex(of: "]") else { return nil }
      hostPart = String(t[t.index(after: t.startIndex)..<end])
      var rest = String(t[t.index(after: end)...])
      if rest.hasPrefix(":") { rest.removeFirst() }
      portText = rest.isEmpty ? nil : rest
    } else if t.filter({ $0 == ":" }).count == 1, let colon = t.firstIndex(of: ":") {
      hostPart = String(t[..<colon])
      portText = String(t[t.index(after: colon)...])
    } else {
      hostPart = t
      portText = nil
    }
    let portNumber: Int
    if let portText {
      guard let n = Int(portText) else { return nil }
      portNumber = n
    } else {
      portNumber = Int(PeerProtocol.defaultPort)
    }
    guard !hostPart.isEmpty, (1...65535).contains(portNumber),
          let port = NWEndpoint.Port(rawValue: UInt16(portNumber))
    else { return nil }
    return .hostPort(host: NWEndpoint.Host(hostPart), port: port)
  }
}
