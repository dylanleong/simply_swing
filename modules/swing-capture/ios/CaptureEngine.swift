import AVFoundation
import UIKit

protocol CaptureEngineListener: AnyObject {
  func engineStateChanged(_ state: EngineState, format: [String: Any]?)
  func engineTriggered(_ source: TriggerSource, timeMs: Double)
  func engineClipReady(_ info: [String: Any?])
  func engineHeardSound(levelDb: Double, minLevelDb: Double, accepted: Bool, reason: String?, motion: MotionGate.Verdict?)
  func engineMotion(level: Double, threshold: Double)
  func engineExposure(shutterSec: Double, iso: Double?)
  func engineThermalDowngrade(from: Int, to: Int)
  /// Watch reachable / wrist swing sensing active (auto mode, heartbeats arriving).
  func engineWatchStatus(connected: Bool, sensing: Bool)
  /// A wrist swing from the watch, for the Levels panel.
  func engineWristSwing(peakDps: Int, tempo: WristTempo?)
  /// Two-phone link status (see PeerLink).
  func enginePeerStatus(_ status: PeerLink.Status)
  func enginePeersFound(_ peers: [PeerLink.PeerInfo])
  /// The second angle of clip `id` has been received.
  func engineAngleReady(id: String)
  func engineError(code: String, message: String)
}

/**
 iOS capture engine; behaviour mirrors CaptureEngine.kt.

 Camera + mic → AVCaptureVideoDataOutput / AVCaptureAudioDataOutput on one serial queue →
 ChunkRecorder (rolling ~1 s files). A trigger fixes a ClipWindow; once the chunk containing its end
 is finished, ClipExporter stitches and trims the clip. The same video frames feed the golfer-box
 MotionGate (no extra camera stream needed on iOS) and the same audio feeds the ImpactDetector.

 Apple Watch (WatchBridge): tap-to-save, and in auto mode wrist swings that TriggerFusion matches
 with impact sounds, so only the golfer's own shots are saved.

 Threads: everything except `trigger`, the `state` getter and the published flags runs on `queue`
 (WatchBridge calls back on it too, so TriggerFusion needs no lock).
 */
final class CaptureEngine: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
  static let shared = CaptureEngine()

  weak var listener: CaptureEngineListener?
  let session = AVCaptureSession()
  /// Link to a second phone: drives it as a camera (main role) or is driven by one (camera role).
  let peers = PeerLink()

  /// Quota gate for automatic sources (impact + watch).
  var autoTrigger: Bool {
    get { locked { _autoTrigger } }
    set { locked { _autoTrigger = newValue } }
  }

  /// Whether the impact-sound detector may fire.
  var impactTrigger: Bool {
    get { locked { _impactTrigger } }
    set { locked { _impactTrigger = newValue } }
  }

  var state: EngineState { locked { _state } }

  // MARK: Shared state (guarded by `lock`)

  private let lock = NSLock()
  private var _state: EngineState = .idle
  private var _autoTrigger = true
  private var _impactTrigger = true
  private var _config: CaptureConfig?
  private var _format: [String: Any]?
  private var _activeFps = 0
  private var lastTrigger = -Double.infinity

  // MARK: Capture-queue state

  private let queue = DispatchQueue(label: "app.simpleswing.capture", qos: .userInitiated)
  private var config: CaptureConfig?
  private var standby = false
  private var device: AVCaptureDevice?
  private var videoInput: AVCaptureDeviceInput?
  private var audioInput: AVCaptureDeviceInput?
  private let videoOutput = AVCaptureVideoDataOutput()
  private let audioOutput = AVCaptureAudioDataOutput()
  private var outputsAdded = false
  private var activeDims = CMVideoDimensions(width: 0, height: 0)
  private var recorder: ChunkRecorder?
  private var detector: ImpactDetector?
  private var detectorRate = 0.0
  private var ringWindow = 8.0
  private let motionGate = MotionGate(roi: .default)
  private var lastMotionFrame = -Double.infinity
  private var lastMotionReport = -Double.infinity
  private var lastExposureReport = -Double.infinity
  private var pending: PendingClip?
  /// Capture-clock time until which impact sounds are ignored (our own saved chime is playing).
  private var muteImpactUntil = -Double.infinity
  private var cleanedLeftovers = false

  // MARK: Watch (queue, except `tempos` which is thread-safe)

  private lazy var watch = WatchBridge(
    queue: queue,
    nowUs: { [weak self] in self?.nowUs() ?? 0 },
    currentState: { [weak self] in self?.state ?? .idle },
    onTrigger: { [weak self] in self?.trigger(.watch) ?? false },
    onWristSwing: { [weak self] receivedUs, ageMs, oneWayMs, peakDps, tempo in
      self?.onWristSwing(receivedUs: receivedUs, ageMs: ageMs, oneWayMs: oneWayMs, peakDps: peakDps, tempo: tempo)
    },
    onStatus: { [weak self] connected, sensing in
      self?.listener?.engineWatchStatus(connected: connected, sensing: sensing)
    }
  )
  /// Tempo of recent wrist swings, attached to the clips they trigger.
  private let tempos = TempoLog()
  /// Sound + wrist decisions while the watch is sensing.
  private let fusion = TriggerFusion()
  /// Level details of sounds waiting for a wrist verdict, keyed by sound time (µs).
  private var pendingSounds: [Int64: (levelDb: Double, minLevelDb: Double)] = [:]

  /// `id` is the file stem, chosen at trigger time so the camera phone's angle can share it.
  /// `forPeer` clips were asked for by the main phone: they're streamed to it rather than kept.
  private final class PendingClip {
    let source: TriggerSource
    let window: ClipWindow
    let fps: Int
    let id: String
    let forPeer: Bool
    /// Play the saved chime (config.savedSound when triggered; never for a camera phone's clips).
    let chime: Bool
    var rotateRequested = false
    var exporting = false

    init(source: TriggerSource, window: ClipWindow, fps: Int, id: String, forPeer: Bool = false, chime: Bool = false) {
      self.source = source
      self.window = window
      self.fps = fps
      self.id = id
      self.forPeer = forPeer
      self.chime = chime && !forPeer
    }
  }

  private static let cooldown = 3.0
  /// Impact detection stays off this long after the chime ends (room echo, the phone's own speaker).
  private static let chimeMuteMargin = 0.4
  /// How long a sound the wrist didn't claim keeps its level details for a late wrist message.
  private static let lateWrist = 2.5
  private static let exportWatchdog = 3.0
  private static let standbyFps = 30
  private static let motionInterval = 1.0 / 15
  private static let motionW = 72
  private static let motionH = 128
  /// Portrait app, back camera: sensor buffers are landscape and rotated 90° on playback.
  private static let portraitTransform = CGAffineTransform(rotationAngle: .pi / 2)

  private var clipsDir: URL { SwingFiles.clipsDir }
  /// Camera role: clips for the main phone, deleted once sent.
  private lazy var peerDir = FileManager.default.temporaryDirectory.appendingPathComponent("peer", isDirectory: true)

  private lazy var chunkDir = FileManager.default.temporaryDirectory.appendingPathComponent("swing-chunks", isDirectory: true)

  private override init() {
    super.init()
    peers.host = self
    // We run the app's audio session ourselves (see applyAudioSession).
    session.automaticallyConfiguresApplicationAudioSession = false
    let center = NotificationCenter.default
    center.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil) { [weak self] _ in
      self?.queue.async { self?.handleThermal() }
    }
    center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil) { [weak self] _ in
      self?.queue.async { self?.handleInterruption() }
    }
    center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: nil) { [weak self] _ in
      self?.queue.async { self?.resumeAfterInterruption() }
    }
    center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
      let error = note.userInfo?[AVCaptureSessionErrorKey] as? Error
      self?.queue.async { self?.handleRuntimeError(error) }
    }
    // Something else may have changed the shared audio session (expo-video, a call, Siri): put ours back.
    center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in
      self?.reapplyAudioSession(force: true)
    }
    center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
      guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: raw) == .ended
      else { return }
      self?.reapplyAudioSession(force: true)
    }
    center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] note in
      guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            AVAudioSession.RouteChangeReason(rawValue: raw) == .categoryChange
      else { return }
      // e.g. expo-video switched to .playback for a replay on the Capture screen.
      self?.reapplyAudioSession(force: false)
    }
    watch.start()
  }

  // MARK: - Public API (any thread)

  func start(_ config: CaptureConfig) {
    queue.async {
      self.cleanLeftovers()
      self.standby = false
      self.configure(config)
    }
  }

  func stop() {
    queue.async {
      self.teardown()
      self.config = nil
      self.locked { self._config = nil }
      self.watch.setActive(false)
      self.fusion.clear()
      self.pendingSounds.removeAll()
    }
  }

  /// Standby: 30 fps preview + motion only (no recording, no mic). Waking restarts full capture.
  func setStandby(_ on: Bool) {
    queue.async {
      guard let cfg = self.config, self.standby != on else { return }
      self.standby = on
      self.configure(cfg)
    }
  }

  func setRoi(_ roi: NormalizedRoi) {
    queue.async {
      if self.motionGate.setRoi(roi) { self.motionGate.reset() }
    }
  }

  /// Returns true if the trigger was accepted. `time` defaults to now (button presses).
  @discardableResult
  func trigger(_ source: TriggerSource, at time: Double? = nil) -> Bool {
    // A camera phone saves only what the main phone asks for (captureForPeer).
    if peers.role == .camera { return false }
    lock.lock()
    let current = _state
    // A button / remote / watch press in standby means "I'm back": wake rather than save.
    if current == .standby && source != .impact {
      lock.unlock()
      setStandby(false)
      return false
    }
    guard current == .armed, let cfg = _config, !(source.isAuto && !_autoTrigger) else {
      lock.unlock()
      return false
    }
    let t = time ?? now()
    guard t - lastTrigger >= Self.cooldown else {
      lock.unlock()
      return false
    }
    lastTrigger = t
    let clip = PendingClip(
      source: source,
      window: ClipWindows.forTrigger(source, at: t, config: cfg),
      fps: _activeFps,
      id: "swing_\(Int64(Date().timeIntervalSince1970 * 1000))",
      chime: cfg.savedSound
    )
    _state = .triggered
    let format = _format
    lock.unlock()

    announce(.triggered, format: format)
    listener?.engineTriggered(source, timeMs: t * 1000)
    startPending(clip)
    if peers.role == .main { peers.sendTrigger(id: clip.id, window: clip.window) }
    return true
  }

  /// Camera role: the main phone triggered; save `window` (already on our clock) as clip `id` and send
  /// it back. No cooldown or quota here: the main phone applied them. False if we're not recording.
  func captureForPeer(id: String, window: ClipWindow) -> Bool {
    lock.lock()
    guard _state == .armed, _config != nil else {
      lock.unlock()
      return false
    }
    let clip = PendingClip(source: .manual, window: window, fps: _activeFps, id: id, forPeer: true)
    _state = .triggered
    let format = _format
    lock.unlock()

    announce(.triggered, format: format)
    startPending(clip)
    return true
  }

  private func startPending(_ clip: PendingClip) {
    queue.async {
      // Stopped between the trigger and here: no recorder to save it from, and it mustn't stay
      // pending into the next pipeline.
      guard self.recorder != nil else {
        if self.state == .triggered { self.setState(.armed) }
        if clip.forPeer { self.peers.rejectClip(id: clip.id, reason: "export") }
        return
      }
      self.pending = clip
      // Never leave the UI stuck on "Saving" if frames stop or a chunk fails to finish.
      let wait = max(0, clip.window.end - self.now()) + Self.exportWatchdog
      self.queue.asyncAfter(deadline: .now() + wait) { self.abandonIfStuck(clip) }
    }
  }

  /// Frame rates the back camera offers (≤ 1080p), for the Settings screen.
  func supportedFps() -> [Int] {
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else { return [] }
    let best = Self.candidateFormats(device).map(Self.maxFps).max() ?? 0
    return [60, 120, 240].filter { $0 <= best }
  }

  // MARK: - Configuration (queue)

  private func configure(_ cfg: CaptureConfig) {
    config = cfg
    stopRecorder()
    detector = nil
    ringWindow = ClipWindows.ringWindow(cfg)
    motionGate.setRoi(cfg.roi)
    motionGate.reset()
    locked {
      _config = cfg
      _autoTrigger = cfg.autoTrigger
      _impactTrigger = cfg.impactTrigger
    }
    fusion.clear()
    pendingSounds.removeAll()
    fusion.savePracticeSwings = cfg.savePracticeSwings
    watch.setMode(cfg.watchMode)
    watch.setActive(peers.role != .camera)

    if !standby && Self.micAllowed { Self.applyAudioSession(force: true) }
    do {
      try setUpSession(fps: standby ? Self.standbyFps : cfg.fps, sharp: cfg.sharpMode, withAudio: !standby)
    } catch {
      fail(code: "E_CAMERA", message: error.localizedDescription)
      return
    }
    if !standby { recorder = makeRecorder() }
    if !session.isRunning { session.startRunning() }

    let fps = locked { _activeFps }
    let format: [String: Any] = [
      "width": Int(activeDims.width),
      "height": Int(activeDims.height),
      "fps": fps,
      "highSpeed": fps > 60,
    ]
    locked { _format = format }
    setState(standby ? .standby : .armed)
  }

  private func setUpSession(fps requested: Int, sharp: Bool, withAudio: Bool) throws {
    guard let device = device ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
      throw CaptureException("No back camera found")
    }
    self.device = device

    session.beginConfiguration()
    defer { session.commitConfiguration() }
    session.sessionPreset = .inputPriority

    if videoInput == nil {
      let input = try AVCaptureDeviceInput(device: device)
      guard session.canAddInput(input) else { throw CaptureException("Camera unavailable") }
      session.addInput(input)
      videoInput = input
    }
    if withAudio, audioInput == nil, Self.micAllowed, let mic = AVCaptureDevice.default(for: .audio) {
      // No usable mic (permission refused, or in use) must not stop the camera: record video only,
      // and impact detection simply never hears anything.
      do {
        let input = try AVCaptureDeviceInput(device: mic)
        if session.canAddInput(input) {
          session.addInput(input)
          audioInput = input
        }
      } catch {
        NSLog("SwingCapture: no microphone, recording video only: \(error)")
      }
    } else if !withAudio, let input = audioInput {
      session.removeInput(input)
      audioInput = nil
    }
    if !outputsAdded {
      videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
      videoOutput.alwaysDiscardsLateVideoFrames = true
      videoOutput.setSampleBufferDelegate(self, queue: queue)
      audioOutput.setSampleBufferDelegate(self, queue: queue)
      if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }
      if session.canAddOutput(audioOutput) { session.addOutput(audioOutput) }
      outputsAdded = true
    }

    let (format, fps) = try Self.bestFormat(device, requestedFps: requested)
    try device.lockForConfiguration()
    defer { device.unlockForConfiguration() }
    device.activeFormat = format
    let frame = CMTime(value: 1, timescale: CMTimeScale(fps))
    device.activeVideoMinFrameDuration = frame
    device.activeVideoMaxFrameDuration = frame
    if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
    if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
    // Sharp mode: keep auto-exposure but never let the shutter go slower than 1/1000 s (ISO rises instead).
    if sharp {
      let cap = CMTime(value: 1, timescale: 1000)
      device.activeMaxExposureDuration = CMTimeClampToRange(
        cap,
        range: CMTimeRange(start: format.minExposureDuration, end: format.maxExposureDuration)
      )
    } else {
      device.activeMaxExposureDuration = .invalid
    }

    activeDims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
    locked { _activeFps = fps }
  }

  private func makeRecorder() -> ChunkRecorder? {
    let fps = locked { _activeFps }
    var video = videoOutput.recommendedVideoSettingsForAssetWriter(writingTo: .mp4) ?? [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: Int(activeDims.width),
      AVVideoHeightKey: Int(activeDims.height),
    ]
    var compression = video[AVVideoCompressionPropertiesKey] as? [String: Any] ?? [:]
    // Short keyframe interval keeps clip starts precise and chunks small.
    compression[AVVideoMaxKeyFrameIntervalDurationKey] = 0.5
    compression[AVVideoExpectedSourceFrameRateKey] = fps
    video[AVVideoCompressionPropertiesKey] = compression
    let audio = audioInput == nil ? nil : audioOutput.recommendedAudioSettingsForAssetWriter(writingTo: .mp4) as? [String: Any]

    // Each recorder has its own folder: one that's stopping may still be saving a clip from its chunks.
    return ChunkRecorder(
      dir: chunkDir.appendingPathComponent(UUID().uuidString, isDirectory: true),
      queue: queue,
      videoSettings: video,
      audioSettings: audio,
      transform: Self.portraitTransform,
      onChunk: { [weak self] chunk in self?.onChunkFinished(chunk) },
      onError: { [weak self] code, message in self?.listener?.engineError(code: code, message: message) }
    )
  }

  /// Stops the rolling buffer. A clip that was triggered but isn't exported yet (standby, stop, an
  /// interruption or a reconfigure mid-swing) is not dropped: it's saved from what was recorded so
  /// far, its end clamped to the last recorded frame. An export already running keeps its chunks.
  private func stopRecorder() {
    let clip = pending
    pending = nil
    guard let r = recorder else { return }
    recorder = nil
    guard let clip, !clip.exporting else {
      r.stop()
      return
    }
    clip.exporting = true
    r.stop(keeping: { [weak self] chunks in
      guard let self else {
        r.release()
        return
      }
      guard let last = chunks.map(\.end).max(), last > clip.window.start else {
        r.release()
        if clip.forPeer {
          self.peers.rejectClip(id: clip.id, reason: "export")
        } else {
          self.listener?.engineError(code: "E_EXPORT", message: "Couldn't save that swing: recording stopped.")
        }
        return
      }
      let window = ClipWindow(
        start: clip.window.start,
        end: min(clip.window.end, last),
        impact: clip.window.impact,
        anchor: clip.window.anchor
      )
      NSLog("SwingCapture: recording stopped mid-clip; saving \(clip.id) up to \(window.end - window.start) s")
      self.export(clip, window: window, chunks: chunks.filter { $0.end >= window.start && $0.start <= window.end }, from: r)
    })
  }

  private func teardown() {
    // Idle first: stopRunning() can take a while, and a trigger accepted meanwhile would be left
    // pending into the next pipeline.
    setState(.idle)
    if session.isRunning { session.stopRunning() }
    stopRecorder()
    detector = nil
  }

  // MARK: - Sample buffers (queue)

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
    if output === videoOutput {
      handleVideo(sampleBuffer, time: time)
    } else if output === audioOutput {
      handleAudio(sampleBuffer, time: time)
    }
  }

  private func handleVideo(_ sample: CMSampleBuffer, time: Double) {
    if let recorder {
      // Close the chunk just after the clip's end so the clip can be exported from finished files.
      if let clip = pending, !clip.rotateRequested, time >= clip.window.end + 0.05 {
        clip.rotateRequested = true
        recorder.requestRotate()
      }
      recorder.appendVideo(sample, time: time)
      // Keep every chunk while a clip is being saved; prune otherwise.
      if pending == nil { recorder.prune(before: time - ringWindow) }
    }

    if time - lastMotionFrame >= Self.motionInterval {
      lastMotionFrame = time
      sampleMotion(sample, time: time)
    }

    if time - lastExposureReport >= 1, let device {
      lastExposureReport = time
      listener?.engineExposure(shutterSec: device.exposureDuration.seconds, iso: Double(device.iso))
    }
  }

  private func handleAudio(_ sample: CMSampleBuffer, time: Double) {
    recorder?.appendAudio(sample, time: time)
    guard !standby, let decoded = Self.monoSamples(sample) else { return }
    let (samples, rate) = decoded
    if detector == nil || detectorRate != rate {
      detectorRate = rate
      detector = ImpactDetector(sampleRate: rate, sensitivity: config?.sensitivity ?? 0.5) { [weak self] t, level, margin, loud in
        self?.onImpactCandidate(time: t, levelDb: level, marginDb: margin, loudEnough: loud)
      }
    }
    samples.withUnsafeBufferPointer { detector?.process($0, startTime: time) }
  }

  private func onImpactCandidate(time: Double, levelDb: Double, marginDb: Double, loudEnough: Bool) {
    // With the watch sensing, the wrist decides instead of the camera (see TriggerFusion).
    if loudEnough && time >= muteImpactUntil && impactTrigger && wristDecides() {
      onFusionSound(time: time, levelDb: levelDb, minLevelDb: detector?.minLevelDb ?? 0)
      return
    }
    // No verdict (not enough motion history yet) lets the sound through rather than losing a swing.
    let motion = loudEnough ? motionGate.evaluate(impact: time) : nil
    let reason: String?
    if !loudEnough {
      reason = "quiet"
    } else if time < muteImpactUntil {
      // Our own saved chime (or its echo).
      reason = "touch"
    } else if !impactTrigger {
      reason = "off"
    } else if let motion, !motion.passed {
      reason = "still"
    } else {
      reason = nil
    }
    let accepted = reason == nil && trigger(.impact, at: time)
    listener?.engineHeardSound(
      levelDb: levelDb,
      minLevelDb: detector?.minLevelDb ?? 0,
      accepted: accepted,
      reason: reason ?? (accepted ? nil : "busy"),
      motion: motion
    )
  }

  // MARK: - Watch: wrist swings + sound (queue)

  /// The watch is the swing evidence when it's in auto mode and its sensor heartbeats are arriving.
  private func wristDecides() -> Bool {
    config?.watchMode == WatchBridge.modeAuto && watch.isSensing
  }

  private func onFusionSound(time: Double, levelDb: Double, minLevelDb: Double) {
    guard let atUs = PeerProtocol.micros(fromSeconds: time) else { return }
    pendingSounds[atUs] = (levelDb, minLevelDb)
    applyFusion(fusion.onSound(atUs: atUs, nowUs: nowUs()))
  }

  private func onWristSwing(receivedUs: Int64, ageMs: Int, oneWayMs: Int, peakDps: Int, tempo: WristTempo?) {
    guard state != .idle else { return }
    listener?.engineWristSwing(peakDps: peakDps, tempo: tempo)
    // The swing peaked ageMs before the watch sent it, plus the radio hop to us, counted back from
    // when the message arrived (not from now: the capture queue may have been busy). WatchBridge
    // bounds ageMs (0...60 s) and oneWayMs (≤ 1 s), so this can't overflow.
    let peakUs = receivedUs - Int64(ageMs + oneWayMs) * 1000
    if let tempo { tempos.add(peakUs: peakUs, tempo: tempo) }
    applyFusion(fusion.onWrist(atUs: peakUs, nowUs: nowUs()))
  }

  private func pollFusion() {
    applyFusion(fusion.poll(nowUs: nowUs()))
  }

  private func applyFusion(_ decisions: [TriggerFusion.Decision]) {
    for d in decisions {
      let levels = pendingSounds.removeValue(forKey: d.atUs) ?? (0, 0)
      let at = Double(d.atUs) / 1_000_000
      switch d.kind {
      case .impact:
        let accepted = trigger(.impact, at: at)
        listener?.engineHeardSound(
          levelDb: levels.levelDb, minLevelDb: levels.minLevelDb, accepted: accepted,
          reason: accepted ? nil : "busy", motion: nil
        )
      case .noWrist:
        // Kept for a late wrist message; re-stash the levels in case it arrives, then forget them.
        pendingSounds[d.atUs] = levels
        queue.asyncAfter(deadline: .now() + Self.lateWrist) { self.pendingSounds.removeValue(forKey: d.atUs) }
        listener?.engineHeardSound(
          levelDb: levels.levelDb, minLevelDb: levels.minLevelDb, accepted: false, reason: "wrist", motion: nil
        )
      case .practice:
        let accepted = trigger(.wrist, at: at)
        NSLog("SwingCapture: practice swing at \(at): accepted=\(accepted)")
      }
    }
    guard let deadline = fusion.nextDeadlineUs() else { return }
    let delayMs = max(1, (deadline - nowUs()) / 1000)
    queue.asyncAfter(deadline: .now() + .milliseconds(Int(min(delayMs, 10_000)))) { self.pollFusion() }
  }

  private func nowUs() -> Int64 {
    PeerProtocol.micros(fromSeconds: now()) ?? 0
  }

  /// Upright 72x128 luma thumbnail from the landscape Y plane (rotated 90° clockwise, 2x2 averaged).
  private func sampleMotion(_ sample: CMSampleBuffer, time: Double) {
    guard let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddressOfPlane(pixels, 0) else { return }
    let w = CVPixelBufferGetWidthOfPlane(pixels, 0)
    let h = CVPixelBufferGetHeightOfPlane(pixels, 0)
    let stride = CVPixelBufferGetBytesPerRowOfPlane(pixels, 0)
    guard w > 2, h > 2 else { return }
    let y = base.assumingMemoryBound(to: UInt8.self)

    let mw = Self.motionW
    let mh = Self.motionH
    var luma = [UInt8](repeating: 0, count: mw * mh)
    for j in 0..<mh {
      for i in 0..<mw {
        // Portrait x runs along the buffer's height (reversed), portrait y along its width.
        let px = (Double(i) + 0.5) * Double(h) / Double(mw)
        let py = (Double(j) + 0.5) * Double(w) / Double(mh)
        let bx = min(w - 2, max(0, Int(py)))
        let by = min(h - 2, max(0, h - 1 - Int(px)))
        let o = by * stride + bx
        let sum = Int(y[o]) + Int(y[o + 1]) + Int(y[o + stride]) + Int(y[o + stride + 1])
        luma[j * mw + i] = UInt8(sum / 4)
      }
    }
    motionGate.addFrame(time: time, luma: luma, width: mw, height: mh)

    if time - lastMotionReport >= 0.5, let level = motionGate.peak(since: time, span: 0.5),
       let verdict = motionGate.evaluate(impact: time) {
      lastMotionReport = time
      listener?.engineMotion(level: level, threshold: verdict.threshold)
    }
  }

  // MARK: - Clips (queue + async export)

  private func onChunkFinished(_ chunk: ChunkRecorder.Chunk) {
    guard let clip = pending, !clip.exporting, chunk.end >= clip.window.end, let recorder else { return }
    clip.exporting = true
    setState(.exporting)
    // Hold the chunk files even if the recorder is stopped (standby, reconfigure) mid-export.
    recorder.hold()
    export(clip, window: clip.window, chunks: recorder.chunks(overlapping: clip.window.start, clip.window.end), from: recorder)
  }

  /// Saves `clip` from `chunks` (held in `recorder` until this calls release()).
  private func export(_ clip: PendingClip, window: ClipWindow, chunks: [ChunkRecorder.Chunk], from recorder: ChunkRecorder) {
    let url = (clip.forPeer ? peerDir : clipsDir).appendingPathComponent("\(clip.id).mp4")
    Task {
      do {
        let written = try await ClipExporter.export(chunks: chunks, window: window, to: url, thumbnail: !clip.forPeer)
        if clip.forPeer {
          self.peers.sendClip(
            id: clip.id,
            file: written.url,
            fps: clip.fps,
            durationMs: written.duration * 1000,
            anchorOffsetMs: written.anchorOffset * 1000
          )
        } else {
          self.clipSaved(written, clip: clip)
        }
      } catch is StorageFullException {
        // The main phone is waiting for this angle: say so now rather than let it time out silently.
        if clip.forPeer { self.peers.rejectClip(id: clip.id, reason: Storage.fullCode) }
        self.listener?.engineError(code: Storage.fullCode, message: Storage.fullMessage)
      } catch {
        if clip.forPeer { self.peers.rejectClip(id: clip.id, reason: "export") }
        self.listener?.engineError(code: "E_EXPORT", message: error.localizedDescription)
      }
      self.queue.async {
        recorder.release()
        guard self.pending === clip else { return }
        self.pending = nil
        if self.state == .exporting { self.setState(.armed) }
      }
    }
  }

  private func clipSaved(_ written: WrittenClip, clip: PendingClip) {
    // The wrist swing that set this clip off (sound + wrist, or a practice swing) knows its tempo.
    var tempo: WristTempo?
    if clip.source == .impact || clip.source == .wrist, let anchorUs = PeerProtocol.micros(fromSeconds: clip.window.anchor) {
      tempo = tempos.near(anchorUs)
    }
    let info: [String: Any?] = [
      "id": clip.id,
      "uri": written.url.absoluteString,
      "thumbUri": written.thumbnail?.absoluteString,
      "fps": clip.fps,
      "durationMs": written.duration * 1000,
      "impactOffsetMs": written.impactOffset.map { $0 * 1000 },
      "anchorOffsetMs": written.anchorOffset * 1000,
      "source": clip.source.rawValue,
      "backswingMs": tempo?.backswingMs,
      "downswingMs": tempo?.downswingMs,
    ]
    var sidecar = info
    sidecar["createdAt"] = Int64(Date().timeIntervalSince1970 * 1000)
    ClipExporter.writeSidecar(for: written.url, info: sidecar)
    watch.broadcastSaved()
    listener?.engineClipReady(info)
    if clip.chime && peers.role != .camera {
      queue.async {
        // Mute first: the chime reaches the mic within milliseconds of play(). Never shortens a mute
        // that is still running.
        self.muteImpactUntil = max(self.muteImpactUntil, self.now() + SavedChime.duration + Self.chimeMuteMargin)
        SavedChime.play()
      }
    }
  }

  private func abandonIfStuck(_ clip: PendingClip) {
    guard pending === clip, !clip.exporting else { return }
    pending = nil
    if state == .triggered { setState(.armed) }
    if clip.forPeer { peers.rejectClip(id: clip.id, reason: "timeout") }
    listener?.engineError(code: "E_EXPORT_TIMEOUT", message: "Couldn't save that swing. Ready again.")
  }

  // MARK: - System events (queue)

  private func handleThermal() {
    let thermal = ProcessInfo.processInfo.thermalState
    guard thermal == .serious || thermal == .critical, var cfg = config, !standby else { return }
    let fps = locked { _activeFps }
    guard fps > 60 else { return }
    listener?.engineThermalDowngrade(from: fps, to: 60)
    cfg.fps = 60
    configure(cfg)
  }

  private func handleInterruption() {
    // Phone call, Control Centre camera, another app took the camera: stop recording (a clip in
    // progress is still saved from what was recorded).
    stopRecorder()
    setState(.idle)
  }

  private func resumeAfterInterruption() {
    if let cfg = config { configure(cfg) }
  }

  private func handleRuntimeError(_ error: Error?) {
    guard let cfg = config else { return }
    // Media services can reset; restart the session once with the same settings.
    if !session.isRunning { session.startRunning() }
    if session.isRunning {
      configure(cfg)
    } else {
      fail(code: "E_CAMERA", message: error?.localizedDescription ?? "Camera stopped unexpectedly")
    }
  }

  // MARK: - Audio session

  private static var micAllowed: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }

  /// The capture session's automatic audio setup is off (automaticallyConfiguresApplicationAudioSession):
  /// it would stop other apps' music, and the session is shared with expo-video, which switches it to
  /// .playback for a replay. That silently cuts the mic (no impact detection, silent clips) until
  /// someone sets it back. So we set playAndRecord ourselves: mixing with music, out of the speaker
  /// rather than the earpiece, and re-applied whenever something may have changed it.
  ///
  /// `force` false (after a category change): only if someone else switched the category away, so
  /// the notification our own change posts can't start a loop.
  private static func applyAudioSession(force: Bool) {
    let audio = AVAudioSession.sharedInstance()
    if !force && audio.category == .playAndRecord { return }
    let options: AVAudioSession.CategoryOptions = [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP]
    do {
      if audio.category != .playAndRecord || audio.mode != .videoRecording || audio.categoryOptions != options {
        do {
          try audio.setCategory(.playAndRecord, mode: .videoRecording, options: options)
        } catch {
          try audio.setCategory(.playAndRecord, mode: .default, options: options)
        }
      }
      // System sounds (the saved chime) are otherwise muted while the mic records.
      if !audio.allowHapticsAndSystemSoundsDuringRecording {
        try audio.setAllowHapticsAndSystemSoundsDuringRecording(true)
      }
      try audio.setActive(true)
    } catch {
      NSLog("SwingCapture: couldn't set up the audio session: \(error)")
    }
  }

  /// Off the capture queue (activation can take a while); only while we're recording with the mic.
  private func reapplyAudioSession(force: Bool) {
    queue.async {
      guard self.config != nil, !self.standby, self.audioInput != nil else { return }
      DispatchQueue.global(qos: .userInitiated).async { Self.applyAudioSession(force: force) }
    }
  }

  // MARK: - Helpers

  /// Once per launch, before the first recorder: files a killed or crashed run left behind.
  private func cleanLeftovers() {
    guard !cleanedLeftovers else { return }
    cleanedLeftovers = true
    let fm = FileManager.default
    // Rolling-buffer chunks, and camera-role clips that were never sent.
    try? fm.removeItem(at: chunkDir)
    try? fm.removeItem(at: peerDir)
    let now = Date()
    func removeOld(in dir: URL, olderThan age: TimeInterval, where match: (URL) -> Bool = { _ in true }) {
      let key = URLResourceKey.contentModificationDateKey
      guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [key]) else { return }
      for file in files where match(file) {
        let modified = (try? file.resourceValues(forKeys: [key]))?.contentModificationDate ?? .distantPast
        if now.timeIntervalSince(modified) > age { try? fm.removeItem(at: file) }
      }
    }
    // Unfinished exports and half-received second angles (an hour old: never one still being written).
    removeOld(in: ClipExporter.partialDir, olderThan: 3600)
    removeOld(in: clipsDir, olderThan: 3600) { $0.pathExtension == "part" }
    // Slow-motion / side-by-side copies for Save and Share.
    removeOld(in: SwingFiles.exportsDir, olderThan: 86_400)
  }

  private func fail(code: String, message: String) {
    listener?.engineError(code: code, message: message)
    teardown()
  }

  private func setState(_ next: EngineState) {
    lock.lock()
    guard _state != next else {
      lock.unlock()
      return
    }
    _state = next
    let format = next == .idle ? nil : _format
    lock.unlock()
    announce(next, format: format)
  }

  /// Tells JS, the watch and the paired phone (which shows it, and as a camera phone follows the main's standby).
  private func announce(_ state: EngineState, format: [String: Any]?) {
    watch.broadcastState(state)
    peers.onEngineState(state)
    listener?.engineStateChanged(state, format: format)
  }

  private func now() -> Double {
    CMClockGetTime(session.synchronizationClock ?? CMClockGetHostTimeClock()).seconds
  }

  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  /// 16:9 bi-planar video-range formats up to 1080p.
  private static func candidateFormats(_ device: AVCaptureDevice) -> [AVCaptureDevice.Format] {
    device.formats.filter { format in
      let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
      let subtype = CMFormatDescriptionGetMediaSubType(format.formatDescription)
      return dims.width <= 1920 && dims.height <= 1080 && Int(dims.width) * 9 == Int(dims.height) * 16 &&
        subtype == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    }
  }

  private static func maxFps(_ format: AVCaptureDevice.Format) -> Int {
    Int(format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0)
  }

  /// Highest fps ≤ requested the camera sustains; among those formats the largest, least power-hungry.
  private static func bestFormat(_ device: AVCaptureDevice, requestedFps: Int) throws -> (AVCaptureDevice.Format, Int) {
    let formats = candidateFormats(device)
    guard let fps = formats.map({ min(maxFps($0), requestedFps) }).max(), fps > 0 else {
      throw CaptureException("No usable video format on this camera")
    }
    let usable = formats.filter { maxFps($0) >= fps }
    let best = usable.max { a, b in
      let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
      let db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
      let areaA = Int(da.width) * Int(da.height)
      let areaB = Int(db.width) * Int(db.height)
      if areaA != areaB { return areaA < areaB }
      return maxFps(a) > maxFps(b) // prefer the format that doesn't overshoot (less power)
    }
    guard let best else { throw CaptureException("No usable video format on this camera") }
    return (best, fps)
  }

  /// First channel of a PCM audio buffer as floats in -1...1, with its sample rate.
  private static func monoSamples(_ sample: CMSampleBuffer) -> ([Float], Double)? {
    guard let description = CMSampleBufferGetFormatDescription(sample),
          let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(description),
          let block = CMSampleBufferGetDataBuffer(sample)
    else { return nil }
    let asbd = asbdPointer.pointee
    let frames = CMSampleBufferGetNumSamples(sample)
    let channels = max(1, Int(asbd.mChannelsPerFrame))
    let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
    let interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    let length = CMBlockBufferGetDataLength(block)
    guard frames > 0, length > 0 else { return nil }

    var bytes = [UInt8](repeating: 0, count: length)
    let status = bytes.withUnsafeMutableBytes { raw in
      CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
    }
    guard status == kCMBlockBufferNoErr else { return nil }

    var out = [Float](repeating: 0, count: frames)
    let ok: Bool = bytes.withUnsafeBytes { raw in
      if isFloat && asbd.mBitsPerChannel == 32 {
        let p = raw.bindMemory(to: Float.self)
        guard p.count >= frames * (interleaved ? channels : 1) else { return false }
        for f in 0..<frames { out[f] = p[interleaved ? f * channels : f] }
        return true
      }
      if !isFloat && asbd.mBitsPerChannel == 16 {
        let p = raw.bindMemory(to: Int16.self)
        guard p.count >= frames * (interleaved ? channels : 1) else { return false }
        for f in 0..<frames { out[f] = Float(p[interleaved ? f * channels : f]) / 32768 }
        return true
      }
      return false
    }
    return ok ? (out, asbd.mSampleRate) : nil
  }
}

// MARK: - PeerLinkHost (PeerLink's queue)

extension CaptureEngine: PeerLinkHost {
  func peerNowUs() -> Int64 {
    PeerProtocol.micros(fromSeconds: now()) ?? 0
  }

  func peerFps() -> Int {
    locked { _activeFps > 0 ? _activeFps : (_config?.fps ?? 0) }
  }

  func peerEngineState() -> EngineState {
    state
  }

  func peerTrigger(id: String, window: ClipWindow) -> Bool {
    captureForPeer(id: id, window: window)
  }

  /// No main phone recording means nothing to save: idle in standby until it is.
  func peerMainState(_ state: String) {
    setStandby(state == EngineState.standby.rawValue || state == EngineState.idle.rawValue)
  }

  func peerAngleReady(id: String) {
    listener?.engineAngleReady(id: id)
  }

  func peerStatus(_ status: PeerLink.Status) {
    listener?.enginePeerStatus(status)
  }

  func peersFound(_ peers: [PeerLink.PeerInfo]) {
    listener?.enginePeersFound(peers)
  }

  func peerError(code: String, message: String) {
    listener?.engineError(code: code, message: message)
  }
}
