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
  func engineError(code: String, message: String)
}

/**
 iOS capture engine; behaviour mirrors CaptureEngine.kt.

 Camera + mic → AVCaptureVideoDataOutput / AVCaptureAudioDataOutput on one serial queue →
 ChunkRecorder (rolling ~1 s files). A trigger fixes a ClipWindow; once the chunk containing its end
 is finished, ClipExporter stitches and trims the clip. The same video frames feed the golfer-box
 MotionGate (no extra camera stream needed on iOS) and the same audio feeds the ImpactDetector.

 Threads: everything except `trigger`, the `state` getter and the published flags runs on `queue`.
 */
final class CaptureEngine: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
  static let shared = CaptureEngine()

  weak var listener: CaptureEngineListener?
  let session = AVCaptureSession()

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

  private final class PendingClip {
    let source: TriggerSource
    let window: ClipWindow
    let fps: Int
    var rotateRequested = false
    var exporting = false

    init(source: TriggerSource, window: ClipWindow, fps: Int) {
      self.source = source
      self.window = window
      self.fps = fps
    }
  }

  private static let cooldown = 3.0
  private static let exportWatchdog = 3.0
  private static let standbyFps = 30
  private static let motionInterval = 1.0 / 15
  private static let motionW = 36
  private static let motionH = 64
  /// Portrait app, back camera: sensor buffers are landscape and rotated 90° on playback.
  private static let portraitTransform = CGAffineTransform(rotationAngle: .pi / 2)

  private lazy var clipsDir: URL = {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let dir = docs.appendingPathComponent("swings", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()

  private lazy var chunkDir = FileManager.default.temporaryDirectory.appendingPathComponent("swing-chunks", isDirectory: true)

  private override init() {
    super.init()
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
  }

  // MARK: - Public API (any thread)

  func start(_ config: CaptureConfig) {
    queue.async {
      self.standby = false
      self.configure(config)
    }
  }

  func stop() {
    queue.async {
      self.teardown()
      self.config = nil
      self.locked { self._config = nil }
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
    let clip = PendingClip(source: source, window: ClipWindows.forTrigger(source, at: t, config: cfg), fps: _activeFps)
    _state = .triggered
    let format = _format
    lock.unlock()

    listener?.engineStateChanged(.triggered, format: format)
    listener?.engineTriggered(source, timeMs: t * 1000)
    queue.async {
      self.pending = clip
      // Never leave the UI stuck on "Saving" if frames stop or a chunk fails to finish.
      let wait = max(0, clip.window.end - self.now()) + Self.exportWatchdog
      self.queue.asyncAfter(deadline: .now() + wait) { self.abandonIfStuck(clip) }
    }
    return true
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
    recorder?.stop()
    recorder = nil
    pending = nil
    detector = nil
    ringWindow = ClipWindows.ringWindow(cfg)
    motionGate.setRoi(cfg.roi)
    motionGate.reset()
    locked {
      _config = cfg
      _autoTrigger = cfg.autoTrigger
      _impactTrigger = cfg.impactTrigger
    }

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
    if withAudio, audioInput == nil, let mic = AVCaptureDevice.default(for: .audio) {
      let input = try AVCaptureDeviceInput(device: mic)
      if session.canAddInput(input) {
        session.addInput(input)
        audioInput = input
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

    return ChunkRecorder(
      dir: chunkDir,
      queue: queue,
      videoSettings: video,
      audioSettings: audio,
      transform: Self.portraitTransform
    ) { [weak self] chunk in
      self?.onChunkFinished(chunk)
    }
  }

  private func teardown() {
    if session.isRunning { session.stopRunning() }
    recorder?.stop()
    recorder = nil
    pending = nil
    detector = nil
    setState(.idle)
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
    // No verdict (not enough motion history yet) lets the sound through rather than losing a swing.
    let motion = loudEnough ? motionGate.evaluate(impact: time) : nil
    let reason: String?
    if !loudEnough {
      reason = "quiet"
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

  /// Upright 36x64 luma thumbnail from the landscape Y plane (rotated 90° clockwise, 2x2 averaged).
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

    if time - lastMotionReport >= 0.5, let level = motionGate.latest(), let verdict = motionGate.evaluate(impact: time) {
      lastMotionReport = time
      listener?.engineMotion(level: level, threshold: verdict.threshold)
    }
  }

  // MARK: - Clips (queue + async export)

  private func onChunkFinished(_ chunk: ChunkRecorder.Chunk) {
    guard let clip = pending, !clip.exporting, chunk.end >= clip.window.end, let recorder else { return }
    clip.exporting = true
    setState(.exporting)
    let chunks = recorder.chunks(overlapping: clip.window.start, clip.window.end)
    let name = "swing_\(Int64(Date().timeIntervalSince1970 * 1000))"
    let url = clipsDir.appendingPathComponent("\(name).mp4")

    Task {
      do {
        let written = try await ClipExporter.export(chunks: chunks, window: clip.window, to: url)
        let info: [String: Any?] = [
          "uri": written.url.absoluteString,
          "thumbUri": written.thumbnail?.absoluteString,
          "fps": clip.fps,
          "durationMs": written.duration * 1000,
          "impactOffsetMs": written.impactOffset.map { $0 * 1000 },
          "source": clip.source.rawValue,
        ]
        var sidecar = info
        sidecar["createdAt"] = Int64(Date().timeIntervalSince1970 * 1000)
        ClipExporter.writeSidecar(for: written.url, info: sidecar)
        self.listener?.engineClipReady(info)
      } catch {
        self.listener?.engineError(code: "E_EXPORT", message: error.localizedDescription)
      }
      self.queue.async {
        guard self.pending === clip else { return }
        self.pending = nil
        if self.state == .exporting { self.setState(.armed) }
      }
    }
  }

  private func abandonIfStuck(_ clip: PendingClip) {
    guard pending === clip, !clip.exporting else { return }
    pending = nil
    if state == .triggered { setState(.armed) }
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
    // Phone call, Control Centre camera, another app took the camera: drop partial chunks.
    recorder?.stop()
    recorder = nil
    pending = nil
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

  // MARK: - Helpers

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
    listener?.engineStateChanged(next, format: format)
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
