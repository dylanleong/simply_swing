package app.simpleswing.capture

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraConstrainedHighSpeedCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.util.Range
import android.util.Size
import android.view.Surface
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

enum class EngineState(val jsName: String) {
  IDLE("idle"),
  ARMED("armed"),
  TRIGGERED("triggered"),
  EXPORTING("exporting"),
  /** Low-power watch: 30 fps preview + motion only, no recording. Wakes to ARMED on request. */
  STANDBY("standby"),
}

interface EngineListener {
  /** [format] is the running camera mode (null when idle). */
  fun onStateChange(state: EngineState, format: CaptureFormat?)
  fun onTrigger(source: TriggerSource, tImpactMs: Double)
  fun onClipReady(clip: Map<String, Any?>)
  /** Watch reachable / wrist swing sensing active (auto mode, heartbeats arriving). */
  fun onWatchStatus(connected: Boolean, sensing: Boolean)
  /** A wrist swing from the watch, for the Levels panel. */
  fun onWristSwing(peakDps: Int, tempo: WristTempo?)
  /** Every sharp sound the detector hears, accepted or not, for on-screen calibration. */
  fun onSound(levelDb: Double, minLevelDb: Double, accepted: Boolean, reason: String?, motion: MotionGate.Verdict?)
  /** Golfer-box motion level, ~2 Hz, for framing and calibration. */
  fun onMotion(level: Double, threshold: Double)
  /** Shutter time and ISO auto-exposure is using, ~1 Hz. */
  fun onExposure(exposureNs: Long, iso: Int?)
  fun onThermalDowngrade(fromFps: Int, toFps: Int)
  /** Two-phone link status (see PeerLink). */
  fun onPeerStatus(status: PeerLink.Status)
  fun onPeersFound(peers: List<PeerLink.PeerInfo>)
  /** The second angle of clip [id] has been received. */
  fun onAngleReady(id: String)
  fun onError(code: String, message: String)
}

/** The on-screen preview (SwingCaptureView). Called on the main thread unless said otherwise. */
interface PreviewHost {
  /** Size the preview surface's buffer to the camera stream size (landscape sensor orientation). */
  fun setBufferSize(size: Size, sensorOrientation: Int)

  /** How far the display is turned from the device's natural orientation (0/90/180/270). Any thread. */
  fun displayRotationDegrees(): Int

  /** Copy the current preview frame, upright and scaled to [dest]'s size. Any thread. */
  fun copyPreview(dest: Bitmap, handler: Handler, done: (Boolean) -> Unit)
}

/**
 * Rolling-buffer capture engine.
 *
 * Camera → (preview Surface, H.264 encoder Surface) and mic → AAC run continuously into
 * [EncodedRing]s. A trigger fixes a [ClipWindow]; once video passes the window end the export thread
 * snapshots both rings and muxes an MP4.
 *
 * Threads: all camera/pipeline state is owned by [cameraHandler]; encoder callbacks run on
 * [encoderHandler]; audio has its own thread; the motion gate samples the preview on [motionHandler];
 * muxing runs on [exportExecutor]. Triggers come from any thread (audio, volume keys, watch, peer,
 * JS), so [state], [pending] and every state change are guarded by [triggerLock]; watch and peer
 * callbacks run on the main thread and their own threads respectively.
 */
class CaptureEngine private constructor(private val context: Context) {
  @Volatile var listener: EngineListener? = null
  @Volatile var activityProvider: () -> Activity? = { null }
  /** Quota gate for automatic sources (impact + watch); JS turns it off when the free quota is used. */
  @Volatile var autoTrigger = true
  /** Whether the impact-sound detector may fire. */
  @Volatile var impactTrigger = true

  @Volatile var state = EngineState.IDLE
    private set

  private val cameraManager = context.getSystemService(CameraManager::class.java)
  private val cameraHandler = Handler(HandlerThread("SwingCamera").apply { start() }.looper)
  private val encoderHandler = Handler(HandlerThread("SwingEncoder").apply { start() }.looper)
  private val mainHandler = Handler(Looper.getMainLooper())
  private val exportExecutor = Executors.newSingleThreadExecutor()
  private val clipsDir: File by lazy { File(context.filesDir, "swings").apply { mkdirs() } }
  private val volumeKeys = VolumeKeyInterceptor(
    onPress = { trigger(TriggerSource.VOLUME_KEY) },
    onTouch = { lastTouchUs = clock.nowUs() },
  )
  @Volatile private var lastTouchUs = Long.MIN_VALUE / 2

  // Motion gate: ~15 fps luma thumbnails of the preview, owned by the motion thread.
  private val motionHandler = Handler(HandlerThread("SwingMotion").apply { start() }.looper)
  private val motionGate = MotionGate(MotionGate.NormalizedRoi(0.25, 0.1, 0.5, 0.85))
  /** Thumbnails the shape of the preview as shown: portrait on a phone, landscape on a tablet on its side. */
  private val motionPortrait = Bitmap.createBitmap(MOTION_SHORT, MOTION_LONG, Bitmap.Config.ARGB_8888)
  private val motionLandscape = Bitmap.createBitmap(MOTION_LONG, MOTION_SHORT, Bitmap.Config.ARGB_8888)
  private val motionPixels = IntArray(MOTION_SHORT * MOTION_LONG)
  /** Pipeline generation the sampler runs for; anything else stops it. */
  @Volatile private var motionGeneration = -1
  private var lastMotionReportUs = 0L
  private val wear = WearBridge(
    context,
    currentState = { state },
    onTrigger = { trigger(TriggerSource.WATCH) },
    onWristSwing = ::onWristSwing,
    onStatus = { connected, sensing -> listener?.onWatchStatus(connected, sensing) },
  )
  /** Tempo of recent wrist swings, attached to the clips they trigger. */
  private val tempos = TempoLog()
  /** Link to a second phone: drives it as a camera (main role) or is driven by one (camera role). */
  val peers = PeerLink(context, { clipsDir }, PeerHost())
  private val chime = SavedChime(context)
  /** Sound + wrist decisions while the watch is sensing (guarded by itself). */
  private val fusion = TriggerFusion()
  /** Level details of sounds waiting for a wrist verdict, keyed by sound time. */
  private val pendingSounds = HashMap<Long, Pair<Double, Double>>()

  // Written on the camera thread (also read from trigger and export threads).
  @Volatile private var config: CaptureConfig? = null
  @Volatile private var format: CaptureFormat? = null
  private var fpsRange: Range<Int>? = null
  @Volatile private var previewHost: PreviewHost? = null
  /**
   * Every preview view on screen, oldest first, with its latest surface (camera thread). Two can
   * exist at once: camera mode is pushed over the Capture tab, which stays mounted underneath. The
   * newest is the live one; when it goes, the camera falls back to the one below.
   */
  private val hosts = ArrayList<Pair<PreviewHost, Pair<Surface, Size>?>>()
  /**
   * The view whose surface the running camera session draws into. It can differ from [previewHost]:
   * leaving camera mode, Capture restarts the camera a moment before its own view is back, so the
   * session opens on camera mode's closing view and must move once that view goes.
   */
  private var sessionHost: PreviewHost? = null
  /** The preview's current surface and its buffer size, whatever size it is right now. */
  private var previewSurface: Surface? = null
  private var previewSurfaceSize: Size? = null
  private var camera: CameraDevice? = null
  private var session: CameraCaptureSession? = null
  private var videoEncoder: VideoEncoder? = null
  private var audio: AudioPipeline? = null
  private var opening = false
  /** Low-power mode requested (camera thread). */
  private var standby = false
  /** Bumped on every teardown so callbacks from an old pipeline are ignored. */
  private var generation = 0

  @Volatile private var clock = CaptureClock(false)
  private val videoRing = EncodedRing(0)
  private val audioRing = EncodedRing(0)
  @Volatile private var videoFormat: MediaFormat? = null
  @Volatile private var audioFormat: MediaFormat? = null
  @Volatile private var pending: PendingClip? = null
  /** Correction from encoder PTS to the capture clock; measured on the first frame of each pipeline. */
  @Volatile private var videoPtsOffsetUs: Long? = null
  @Volatile private var lastTriggerUs = Long.MIN_VALUE / 2
  private val triggerLock = Any()

  /**
   * [id] is the file stem, chosen at trigger time so the camera phone's angle can share it.
   * [forPeer] clips were asked for by the main phone: they're streamed to it rather than kept.
   */
  private class PendingClip(
    val source: TriggerSource,
    val window: ClipWindow,
    val format: CaptureFormat,
    val id: String,
    /** Rotation that shows the clip upright, from how the device was held when it was triggered. */
    val orientation: Int,
    val forPeer: Boolean = false,
  ) {
    @Volatile var exporting = false
    /** Under [triggerLock]: export() or a pipeline stop has taken this clip's frames. */
    var claimed = false
  }

  /** A clip's frames, taken out of the rings so a pipeline restart can't clear them mid-save. */
  private class ClipFrames(
    val clip: PendingClip,
    val videoFormat: MediaFormat,
    val video: List<EncodedSample>,
    val audioFormat: MediaFormat?,
    val audio: List<EncodedSample>,
  )

  init {
    wear.start()
    exportExecutor.execute(::cleanLeftovers)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      context.getSystemService(PowerManager::class.java)?.addThermalStatusListener(exportExecutor) { status ->
        if (status >= PowerManager.THERMAL_STATUS_SEVERE) cameraHandler.post(::downgradeForHeat)
      }
    }
  }

  // ---- Public API (any thread) ----

  fun start(config: CaptureConfig) = cameraHandler.post {
    standby = false
    startInternal(config)
  }

  /**
   * Standby keeps only a 30 fps preview for the golfer-box motion check (no encoder, no mic), so an
   * idle phone on a tripod stays cool. Waking restarts the full pipeline; a golfer at address fills
   * the pre-roll buffer long before the swing.
   */
  fun setStandby(on: Boolean) = cameraHandler.post {
    val cfg = config ?: return@post
    if (standby == on) return@post
    standby = on
    Log.i(TAG, if (on) "Entering standby" else "Waking from standby")
    startInternal(cfg)
  }

  fun stop() = cameraHandler.post {
    stopPipeline()
    config = null
    format = null
    wear.setActive(false)
    synchronized(fusion) {
      fusion.clear()
      pendingSounds.clear()
    }
  }

  /**
   * Returns true if the trigger was accepted. [atUs] is the capture-clock time of the event: now for
   * button presses, the detected strike time for impacts.
   */
  fun trigger(source: TriggerSource, atUs: Long = clock.nowUs()): Boolean {
    // A camera phone saves only what the main phone asks for (captureForPeer).
    if (peers.role == PeerRole.CAMERA) return false
    // A button, remote or watch press while in standby means "I'm back": wake rather than save
    // (there is nothing recorded to save yet).
    if (state == EngineState.STANDBY && source != TriggerSource.IMPACT) {
      setStandby(false)
      return false
    }
    synchronized(triggerLock) {
      if (state != EngineState.ARMED) return false
      if (source.isAuto && !autoTrigger) return false
      val cfg = config ?: return false
      val fmt = format ?: return false
      if (atUs - lastTriggerUs < COOLDOWN_US) return false
      lastTriggerUs = atUs
      val clip = PendingClip(
        source, ClipWindows.forTrigger(source, atUs, cfg), fmt, "swing_${System.currentTimeMillis()}", clipOrientation(fmt),
      )
      startPending(clip)
      listener?.onTrigger(source, atUs / 1000.0)
      if (peers.role == PeerRole.MAIN) peers.sendTrigger(clip.id, clip.window)
      return true
    }
  }

  /**
   * Camera role: the main phone triggered; save [window] (already on our clock) as clip [id] and send
   * it back. No cooldown or quota here: the main phone applied them. False if we're not recording.
   */
  fun captureForPeer(id: String, window: ClipWindow): Boolean {
    synchronized(triggerLock) {
      if (state != EngineState.ARMED) return false
      val fmt = format ?: return false
      startPending(PendingClip(TriggerSource.MANUAL, window, fmt, id, clipOrientation(fmt), forPeer = true))
      return true
    }
  }

  /** Any thread: the rotation that shows a clip saved now upright (a phone that isn't on screen counts as upright). */
  private fun clipOrientation(fmt: CaptureFormat): Int =
    Orientation.clipOrientation(fmt.sensorOrientation, previewHost?.displayRotationDegrees() ?: 0)

  /** Under [triggerLock]. */
  private fun startPending(clip: PendingClip) {
    pending = clip
    setState(EngineState.TRIGGERED)
    // Never leave the UI stuck on "Saving" if frames stop arriving or timestamps disagree.
    val waitMs = (clip.window.endUs - clock.nowUs()) / 1000 + EXPORT_WATCHDOG_MS
    cameraHandler.postDelayed({ abandonIfStuck(clip) }, waitMs.coerceAtLeast(EXPORT_WATCHDOG_MS))
  }

  /** Moves the golfer box live; the motion history restarts so old frames aren't judged by the new box. */
  fun setRoi(roi: MotionGate.NormalizedRoi) {
    motionHandler.post {
      if (motionGate.setRoi(roi)) motionGate.reset()
    }
  }

  fun supportedFps(): List<Int> = CameraFormats.supportedFps(cameraManager)

  // ---- Preview host hooks (main thread) ----

  fun attachPreview(host: PreviewHost) = cameraHandler.post {
    hosts.removeAll { it.first === host }
    hosts.add(host to null)
    useNewestHost()
    verbose { "Preview view ${host.hashCode()} attached (${hosts.size} on screen)" }
    // A camera running into a view that's now covered moves to this one once its surface is ready.
    if (sessionHost != null && sessionHost !== host) stopPipeline()
  }

  fun detachPreview(host: PreviewHost) = cameraHandler.post {
    val wasLive = previewHost === host
    hosts.removeAll { it.first === host }
    verbose { "Preview view ${host.hashCode()} detached live=$wasLive (${hosts.size} left)" }
    if (sessionHost === host) stopPipeline()
    if (!wasLive) {
      maybeOpen()
      return@post
    }
    stopPipeline()
    // Back to the view underneath (leaving camera mode returns to Capture), whose surface may have
    // been recreated while it was covered.
    useNewestHost()
    Log.i(TAG, "Preview view closed; ${if (previewHost != null) "falling back to the one below" else "none left"}")
    maybeOpen()
  }

  fun onPreviewSurface(host: PreviewHost, surface: Surface, size: Size) = cameraHandler.post {
    val i = hosts.indexOfFirst { it.first === host }
    if (i < 0) return@post
    // Remembered even for a covered view, so it can take over when the one on top goes.
    hosts[i] = host to (surface to size)
    verbose { "Preview view ${host.hashCode()} surface ${size.width}x${size.height} live=${previewHost === host}" }
    if (previewHost !== host) return@post
    // Until setBufferSize lands, the surface may have the view's size; maybeOpen waits for a match.
    previewSurface = surface
    previewSurfaceSize = size
    maybeOpen()
  }

  /** Blocks until the camera has stopped drawing into the surface, as SurfaceHolder requires. */
  fun onPreviewSurfaceDestroyed(host: PreviewHost) {
    val done = CountDownLatch(1)
    cameraHandler.post {
      val i = hosts.indexOfFirst { it.first === host }
      if (i >= 0) hosts[i] = host to null
      verbose { "Preview view ${host.hashCode()} surface destroyed live=${previewHost === host}" }
      if (previewHost === host) {
        stopPipeline()
        previewSurface = null
        previewSurfaceSize = null
      } else if (sessionHost === host) {
        // The camera was drawing into a covered view: move it to the live one.
        stopPipeline()
        maybeOpen()
      }
      done.countDown()
    }
    done.await(2, TimeUnit.SECONDS)
  }

  /** Camera thread: the newest view is the live preview, with whatever surface it last reported. */
  private fun useNewestHost() {
    val (host, surface) = hosts.lastOrNull() ?: (null to null)
    previewHost = host
    previewSurface = surface?.first
    previewSurfaceSize = surface?.second
    if (host != null) format?.let { fmt -> mainHandler.post { host.setBufferSize(fmt.size, fmt.sensorOrientation) } }
  }

  // ---- Camera thread ----

  private fun startInternal(config: CaptureConfig) {
    stopPipeline()
    try {
      val (fmt, range) = CameraFormats.select(cameraManager, if (standby) STANDBY_FPS else config.fps)
      this.config = config
      format = fmt
      fpsRange = range
      autoTrigger = config.autoTrigger
      impactTrigger = config.impactTrigger
      synchronized(fusion) {
        fusion.clear()
        pendingSounds.clear()
        fusion.savePracticeSwings = config.savePracticeSwings
      }
      wear.setMode(config.watchMode)
      wear.setActive(peers.role != PeerRole.CAMERA)
      clock = CaptureClock(fmt.realtimeClock)
      val windowUs = ClipWindows.ringWindowUs(config)
      motionGate.setRoi(config.roi)
      videoRing.setWindow(windowUs)
      audioRing.setWindow(windowUs)
      previewHost?.let { host -> mainHandler.post { host.setBufferSize(fmt.size, fmt.sensorOrientation) } }
      Log.i(TAG, "Selected ${fmt.size.width}x${fmt.size.height}@${fmt.fps} highSpeed=${fmt.highSpeed}")
      // The preview surface can outlive a stop/start (e.g. switching tabs keeps the view alive), and
      // then no new surface callback arrives; if it already has the right size, open straight away.
      maybeOpen()
    } catch (e: Exception) {
      fail(e)
    }
  }

  private fun maybeOpen() {
    verbose { "maybeOpen host=${previewHost?.hashCode()} surface=${previewSurface?.isValid} size=$previewSurfaceSize fmt=${format?.size} camera=${camera != null} opening=$opening" }
    val fmt = format ?: return
    val surface = previewSurface?.takeIf { it.isValid && previewSurfaceSize == fmt.size } ?: return
    val cfg = config ?: return
    if (camera != null || opening) return
    if (!hasPermission(Manifest.permission.CAMERA) || !hasPermission(Manifest.permission.RECORD_AUDIO)) {
      fail(CaptureException("E_PERMISSION", "Camera and microphone permission are required"))
      return
    }
    val gen = generation
    try {
      videoFormat = null
      videoPtsOffsetUs = null
      audioFormat = null
      videoRing.clear()
      audioRing.clear()
      if (standby) {
        opening = true
        sessionHost = previewHost
        cameraManager.openCamera(fmt.cameraId, deviceCallback(gen, surface), cameraHandler)
        return
      }
      videoEncoder = VideoEncoder(fmt.size, fmt.fps, encoderHandler, ::onVideoSample, { videoFormat = it }, ::onPipelineError)
      lateinit var detector: ImpactDetector
      detector = ImpactDetector(AudioPipeline.SAMPLE_RATE, cfg.sensitivity) { ptsUs, levelDb, marginDb, loudEnough ->
        // With the watch sensing, the wrist decides instead of the camera (see TriggerFusion).
        if (loudEnough && impactTrigger && ptsUs - lastTouchUs >= TOUCH_MUTE_US && wristDecides()) {
          verbose { "Impact at $ptsUs level=%.1f dB → waiting for wrist".format(levelDb) }
          onFusionSound(ptsUs, levelDb, detector.minLevelDb)
          return@ImpactDetector
        }
        // No verdict (preview not readable yet) lets the sound through rather than losing a swing.
        val motion = if (loudEnough) motionGate.evaluate(ptsUs) else null
        val reason = when {
          !loudEnough -> "quiet"
          !impactTrigger -> "off"
          ptsUs - lastTouchUs < TOUCH_MUTE_US -> "touch"
          motion != null && !motion.passed -> "still"
          else -> null
        }
        val accepted = reason == null && trigger(TriggerSource.IMPACT, ptsUs)
        verbose {
          "Impact at $ptsUs level=%.1f dB margin=%.1f dB motion=%s accepted=$accepted reason=$reason"
            .format(levelDb, marginDb, motion?.let { "%.1f/%.1f".format(it.peak, it.threshold) } ?: "n/a")
        }
        listener?.onSound(levelDb, detector.minLevelDb, accepted, reason ?: if (accepted) null else "busy", motion)
      }
      audio = AudioPipeline(clock, audioRing::add, { audioFormat = it }, ::onPipelineError, detector::process)
        .also { it.start() }
      opening = true
      sessionHost = previewHost
      cameraManager.openCamera(fmt.cameraId, deviceCallback(gen, surface), cameraHandler)
    } catch (e: Exception) {
      fail(e)
    }
  }

  /**
   * Callbacks for one openCamera call. A stale one (its pipeline was torn down, [generation] moved
   * on) only closes its device: it must not touch [opening], which may belong to a newer open.
   */
  private fun deviceCallback(gen: Int, preview: Surface) = object : CameraDevice.StateCallback() {
    override fun onOpened(device: CameraDevice) {
      if (gen != generation) {
        device.close()
        return
      }
      opening = false
      camera = device
      // The camera can be taken away (another app, the lock-screen camera) between opening and here.
      try {
        createSession(device, preview, gen)
      } catch (e: Exception) {
        fail(e)
      }
    }

    /** Another app (or the lock-screen camera) took the camera: stop, and tell the golfer why. */
    override fun onDisconnected(device: CameraDevice) {
      device.close()
      if (gen != generation) return
      stopPipeline()
      listener?.onError("E_CAMERA_BUSY", "Another app is using the camera. Come back to SimpleSwing to continue.")
    }

    override fun onError(device: CameraDevice, error: Int) {
      device.close()
      if (gen == generation) fail(CaptureException("E_CAMERA", "Camera error $error"))
    }
  }

  @Suppress("DEPRECATION") // List<Surface> overloads keep minSdk 24 support.
  private fun createSession(device: CameraDevice, preview: Surface, gen: Int) {
    val fmt = format ?: return
    val encoderSurface = videoEncoder?.inputSurface
    if (!standby && encoderSurface == null) return
    val targets = listOfNotNull(preview, encoderSurface)
    val callback = object : CameraCaptureSession.StateCallback() {
      override fun onConfigured(s: CameraCaptureSession) {
        if (gen != generation) {
          s.close()
          return
        }
        session = s
        try {
          val evSteps = if (config?.sharpMode == true) sharpEvSteps(fmt.cameraId) else 0
          fun build(withEv: Boolean) = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
            addTarget(preview)
            encoderSurface?.let(::addTarget)
            set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
            set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
            set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange)
            if (withEv && evSteps != 0) set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, evSteps)
          }.build()
          val exposureCallback = ExposureReporter()
          if (s is CameraConstrainedHighSpeedCaptureSession) {
            val burst = try {
              s.createHighSpeedRequestList(build(withEv = true))
            } catch (e: IllegalArgumentException) {
              // Some devices refuse exposure compensation at high speed; record without it.
              Log.w(TAG, "High-speed session rejected exposure compensation", e)
              s.createHighSpeedRequestList(build(withEv = false))
            }
            s.setRepeatingBurst(burst, exposureCallback, cameraHandler)
          } else {
            s.setRepeatingRequest(build(withEv = true), exposureCallback, cameraHandler)
          }
          // Under triggerLock like every other transition: a trigger racing this must see ARMED
          // before or after it, never broadcast ARMED over its TRIGGERED.
          synchronized(triggerLock) { setState(if (standby) EngineState.STANDBY else EngineState.ARMED) }
          mainHandler.post { activityProvider()?.let(volumeKeys::install) }
          startMotionSampling(gen)
        } catch (e: Exception) {
          fail(e)
        }
      }

      override fun onConfigureFailed(s: CameraCaptureSession) {
        if (gen == generation) {
          fail(CaptureException("E_SESSION", "Camera rejected ${fmt.size.width}x${fmt.size.height} at ${fmt.fps} fps"))
        }
      }
    }
    if (fmt.highSpeed) {
      device.createConstrainedHighSpeedCaptureSession(targets, callback, cameraHandler)
    } else {
      device.createCaptureSession(targets, callback, cameraHandler)
    }
  }

  // ---- Watch: wrist swings + sound (any thread; serialised on `fusion`) ----

  /** The watch is the swing evidence when it's in auto mode and its sensor heartbeats are arriving. */
  private fun wristDecides() = config?.watchMode == WearBridge.MODE_AUTO && wear.isSensing

  private fun onFusionSound(atUs: Long, levelDb: Double, minLevelDb: Double) {
    val decisions = synchronized(fusion) {
      pendingSounds[atUs] = levelDb to minLevelDb
      fusion.onSound(atUs, clock.nowUs())
    }
    applyFusion(decisions)
  }

  private fun onWristSwing(ageMs: Long, oneWayMs: Long, peakDps: Int, tempo: WristTempo?) {
    if (state == EngineState.IDLE) return
    listener?.onWristSwing(peakDps, tempo)
    // The swing peaked ageMs before the watch sent it, plus the radio hop to us.
    val peakUs = clock.nowUs() - (ageMs + oneWayMs) * 1000
    tempo?.let { tempos.add(peakUs, it) }
    verbose { "Wrist swing peak $peakDps°/s at $peakUs (age $ageMs ms, one-way $oneWayMs ms, tempo $tempo)" }
    val decisions = synchronized(fusion) { fusion.onWrist(peakUs, clock.nowUs()) }
    applyFusion(decisions)
  }

  private fun pollFusion() {
    val decisions = synchronized(fusion) { fusion.poll(clock.nowUs()) }
    applyFusion(decisions)
  }

  private fun applyFusion(decisions: List<TriggerFusion.Decision>) {
    for (d in decisions) {
      val (levelDb, minLevelDb) = synchronized(fusion) { pendingSounds.remove(d.atUs) } ?: (0.0 to 0.0)
      when (d.kind) {
        TriggerFusion.Kind.IMPACT -> {
          val accepted = trigger(TriggerSource.IMPACT, d.atUs)
          verbose { "Sound + wrist at ${d.atUs}: accepted=$accepted" }
          listener?.onSound(levelDb, minLevelDb, accepted, if (accepted) null else "busy", null)
        }
        TriggerFusion.Kind.NO_WRIST -> {
          verbose { "Sound at ${d.atUs} without a wrist swing: ignored" }
          // Kept for a late wrist message; re-stash the levels in case it arrives, then forget them.
          synchronized(fusion) { pendingSounds[d.atUs] = levelDb to minLevelDb }
          cameraHandler.postDelayed({ synchronized(fusion) { pendingSounds.remove(d.atUs) } }, LATE_WRIST_MS)
          listener?.onSound(levelDb, minLevelDb, false, "wrist", null)
        }
        TriggerFusion.Kind.PRACTICE -> {
          val accepted = trigger(TriggerSource.WRIST, d.atUs)
          verbose { "Practice swing at ${d.atUs}: accepted=$accepted" }
        }
      }
    }
    val deadline = synchronized(fusion) { fusion.nextDeadlineUs() } ?: return
    val delayMs = ((deadline - clock.nowUs()) / 1000).coerceAtLeast(1)
    cameraHandler.postDelayed(::pollFusion, delayMs)
  }

  /**
   * Sharp mode can't set the shutter directly (high-speed sessions only allow auto exposure), so it
   * asks AE for one stop less light, which AE mostly delivers with a faster shutter.
   */
  private fun sharpEvSteps(cameraId: String): Int {
    val chars = cameraManager.getCameraCharacteristics(cameraId)
    val range = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE) ?: return 0
    val step = chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)?.toDouble() ?: return 0
    if (step <= 0) return 0
    return Math.round(SHARP_MODE_EV / step).toInt().coerceIn(range.lower, range.upper)
  }

  /** Reports the shutter speed and ISO auto-exposure picked, about once a second. */
  private inner class ExposureReporter : CameraCaptureSession.CaptureCallback() {
    private var lastReportNs = 0L

    override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
      val now = System.nanoTime()
      if (now - lastReportNs < 1_000_000_000L) return
      val exposureNs = result.get(CaptureResult.SENSOR_EXPOSURE_TIME) ?: return
      lastReportNs = now
      listener?.onExposure(exposureNs, result.get(CaptureResult.SENSOR_SENSITIVITY))
    }
  }

  private fun stopPipeline() {
    generation++
    sessionHost = null
    motionGeneration = -1
    // A swing whose post-roll hasn't finished (the golfer tapped away, standby, the heat downgrade)
    // is saved with what was recorded so far rather than lost with the buffer.
    val flushed = synchronized(triggerLock) {
      // IDLE first: tearing down takes up to a second (the audio thread joins), and a trigger
      // accepted meanwhile would be left pending into the next pipeline.
      setState(EngineState.IDLE)
      val p = pending
      pending = null
      if (p != null && !p.claimed) {
        p.claimed = true
        takeFrames(p)
      } else {
        null
      }
    }
    flushed?.let { frames ->
      Log.i(TAG, "Pipeline stopping with clip ${frames.clip.id} pending: saving ${frames.video.size} frames")
      exportExecutor.execute { save(frames) }
    }
    mainHandler.post { volumeKeys.uninstall() }
    try {
      session?.close()
    } catch (_: Exception) {
    }
    camera?.close()
    session = null
    camera = null
    opening = false
    audio?.stop()
    audio = null
    videoEncoder?.release()
    videoEncoder = null
    videoRing.clear()
    audioRing.clear()
    synchronized(triggerLock) { setState(EngineState.IDLE) }
  }

  private fun downgradeForHeat() {
    val cfg = config ?: return
    val fmt = format ?: return
    if (state == EngineState.IDLE || fmt.fps <= 60) return
    listener?.onThermalDowngrade(fmt.fps, 60)
    startInternal(cfg.copy(fps = 60))
  }

  private fun fail(e: Throwable) {
    Log.e(TAG, "Capture failed", e)
    val code = (e as? CaptureException)?.code ?: "E_CAPTURE"
    listener?.onError(code, e.message ?: e.toString())
    stopPipeline()
  }

  private fun onPipelineError(e: Throwable) {
    cameraHandler.post { fail(e) }
  }

  // ---- Motion thread ----

  private fun startMotionSampling(gen: Int) {
    motionGeneration = gen
    motionHandler.post {
      motionGate.reset()
      sampleMotion(gen)
    }
  }

  private fun sampleMotion(gen: Int) {
    if (gen != motionGeneration) return
    val host = previewHost
    if (host == null) {
      motionHandler.postDelayed({ sampleMotion(gen) }, MOTION_INTERVAL_MS)
      return
    }
    // The copy is scaled to the bitmap, so the bitmap must be the preview's shape or the box would stretch.
    val fmt = format
    val portrait = fmt == null || Orientation.isQuarterTurn(fmt.sensorOrientation, host.displayRotationDegrees())
    val bitmap = if (portrait) motionPortrait else motionLandscape
    host.copyPreview(bitmap, motionHandler) { ok ->
      if (gen != motionGeneration) return@copyPreview
      if (ok) onMotionFrame(bitmap)
      motionHandler.postDelayed({ sampleMotion(gen) }, MOTION_INTERVAL_MS)
    }
  }

  private fun onMotionFrame(bitmap: Bitmap) {
    val now = clock.nowUs()
    val w = bitmap.width
    val h = bitmap.height
    bitmap.getPixels(motionPixels, 0, w, 0, 0, w, h)
    val luma = IntArray(motionPixels.size) {
      val c = motionPixels[it]
      ((c shr 16 and 0xff) * 77 + (c shr 8 and 0xff) * 150 + (c and 0xff) * 29) shr 8
    }
    // A change of shape (the tablet was turned) starts the motion history afresh inside the gate.
    motionGate.addFrame(now, luma, w, h)
    if (now - lastMotionReportUs >= MOTION_REPORT_US) {
      lastMotionReportUs = now
      val level = motionGate.peakSince(now, MOTION_REPORT_US)
      val verdict = motionGate.evaluate(now)
      if (level != null && verdict != null) {
        verbose { "Motion peak=%.1f%% threshold=%.1f%%".format(level, verdict.threshold) }
        listener?.onMotion(level, verdict.threshold)
      }
    }
  }

  // ---- Encoder thread ----

  private fun onVideoSample(raw: EncodedSample) {
    val offset = videoPtsOffsetUs ?: measureVideoOffset(raw.ptsUs).also { videoPtsOffsetUs = it }
    val sample = if (offset == 0L) raw else EncodedSample(raw.data, raw.ptsUs + offset, raw.isKeyFrame)
    videoRing.add(sample)
    val p = pending ?: return
    if (!p.exporting && sample.ptsUs >= p.window.endUs) {
      p.exporting = true
      exportExecutor.execute { export(p) }
    }
  }

  /** See VideoClockOffset. */
  private fun measureVideoOffset(ptsUs: Long): Long {
    val now = clock.nowUs()
    val offset = VideoClockOffset.measure(ptsUs, now, SystemClock.elapsedRealtimeNanos() / 1000, System.nanoTime() / 1000)
    Log.i(TAG, "First video frame pts=$ptsUs clockNow=$now delta=${now - ptsUs}us -> offset=${offset}us")
    return offset
  }

  /** Under [triggerLock]. Null if nothing usable was recorded. */
  private fun takeFrames(p: PendingClip): ClipFrames? {
    val vf = videoFormat ?: return null
    val video = videoRing.snapshot(p.window.startUs, p.window.endUs)
    if (video.isEmpty()) return null
    return ClipFrames(p, vf, video, audioFormat, audioRing.snapshot(p.window.startUs, p.window.endUs))
  }

  // ---- Export thread ----

  private fun export(p: PendingClip) {
    // Let the last AAC frames for the window come out of the audio encoder.
    Thread.sleep(AUDIO_SETTLE_MS)
    val frames = synchronized(triggerLock) {
      if (pending !== p || p.claimed) return
      p.claimed = true
      setState(EngineState.EXPORTING)
      takeFrames(p)
    }
    try {
      if (frames != null) {
        save(frames)
      } else {
        if (p.forPeer) peers.rejectClip(p.id, "export")
        listener?.onError("E_EXPORT", "Couldn't save that swing: no video was recorded.")
      }
    } finally {
      synchronized(triggerLock) {
        if (pending === p) {
          pending = null
          if (state == EngineState.EXPORTING) setState(EngineState.ARMED)
        }
      }
    }
  }

  /** Writes a clip and tells everyone. Export thread. */
  private fun save(frames: ClipFrames) {
    val p = frames.clip
    try {
      if (p.forPeer) {
        val dir = File(context.cacheDir, "peer").apply { mkdirs() }
        ClipWriter.ensureSpace(dir)
        val clip = ClipWriter.write(
          File(dir, "${p.id}.mp4"), frames.videoFormat, frames.video, frames.audioFormat, frames.audio,
          p.orientation, p.window.impactUs, p.window.anchorUs, thumbnail = false,
        )
        val (w, h) = Orientation.uprightSize(p.format.size.width, p.format.size.height, p.orientation)
        peers.sendClip(p.id, clip.file, p.format.fps, clip.durationUs / 1000.0, clip.anchorOffsetUs / 1000.0, w, h)
        return
      }
      ClipWriter.ensureSpace(clipsDir)
      val file = File(clipsDir, "${p.id}.mp4")
      val clip = ClipWriter.write(
        file, frames.videoFormat, frames.video, frames.audioFormat, frames.audio, p.orientation,
        p.window.impactUs, p.window.anchorUs,
      )
      val (width, height) = Orientation.uprightSize(p.format.size.width, p.format.size.height, p.orientation)
      // The wrist swing that set this clip off (sound + wrist, or a practice swing) knows its tempo.
      val tempo = if (p.source == TriggerSource.IMPACT || p.source == TriggerSource.WRIST) {
        tempos.near(p.window.anchorUs)
      } else {
        null
      }
      val info = mapOf(
        "id" to p.id,
        "uri" to "file://${clip.file.absolutePath}",
        "thumbUri" to clip.thumbnail?.let { "file://${it.absolutePath}" },
        "fps" to p.format.fps,
        "durationMs" to clip.durationUs / 1000.0,
        "impactOffsetMs" to clip.impactOffsetUs?.let { it / 1000.0 },
        "anchorOffsetMs" to clip.anchorOffsetUs / 1000.0,
        "source" to p.source.jsName,
        "width" to width,
        "height" to height,
        "orientation" to p.orientation,
        "backswingMs" to tempo?.backswingMs,
        "downswingMs" to tempo?.downswingMs,
      )
      ClipWriter.writeSidecar(clip.file, info + ("createdAt" to System.currentTimeMillis()))
      wear.broadcastSaved()
      if (config?.savedSound == true) playChime()
      listener?.onClipReady(info)
    } catch (e: Exception) {
      Log.e(TAG, "Export failed", e)
      // The main phone is waiting for this angle: say so now rather than let it time out silently.
      if (p.forPeer) peers.rejectClip(p.id, (e as? CaptureException)?.code ?: "export")
      listener?.onError((e as? CaptureException)?.code ?: "E_EXPORT", e.message ?: e.toString())
    }
  }

  /** The phone's own speaker is right next to its mic: mute the impact detector while it chimes. */
  private fun playChime() {
    // The touch mute covers TOUCH_MUTE_US from this instant, comfortably longer than the chime.
    // Never shortens a real touch mute that is still running.
    lastTouchUs = maxOf(lastTouchUs, clock.nowUs() + chime.durationUs + CHIME_MUTE_EXTRA_US - TOUCH_MUTE_US)
    chime.play()
  }

  /** Part files from a crash, camera-phone clips that never went out, and exports nobody used in a week. */
  private fun cleanLeftovers() {
    runCatching {
      clipsDir.listFiles { f -> f.name.endsWith(".part") }?.forEach { it.delete() }
      File(context.cacheDir, "peer").listFiles()?.forEach { it.delete() }
      val weekAgo = System.currentTimeMillis() - 7 * 24 * 3600 * 1000L
      File(context.cacheDir, "exports").listFiles { f -> f.lastModified() < weekAgo || f.name.endsWith(".part") }
        ?.forEach { it.delete() }
    }
  }

  private fun abandonIfStuck(clip: PendingClip) {
    synchronized(triggerLock) {
      if (pending !== clip || clip.exporting) return
      pending = null
      if (state == EngineState.TRIGGERED) setState(EngineState.ARMED)
    }
    Log.w(TAG, "Clip window never completed (end=${clip.window.endUs}, now=${clock.nowUs()})")
    if (clip.forPeer) peers.rejectClip(clip.id, "timeout")
    listener?.onError("E_EXPORT_TIMEOUT", "Couldn't save that swing — video stopped arriving. Ready again.")
  }

  private fun setState(next: EngineState) {
    if (state == next) return
    state = next
    wear.broadcastState(next)
    peers.onEngineState(next)
    listener?.onStateChange(next, if (next == EngineState.IDLE) null else format)
  }

  /** What PeerLink needs from the engine. */
  private inner class PeerHost : PeerLink.Host {
    override fun nowUs() = clock.nowUs()

    override fun fps() = format?.fps ?: config?.fps ?: 0

    override fun engineState() = state

    override fun onPeerTrigger(id: String, window: ClipWindow) = captureForPeer(id, window)

    /** No main phone recording means nothing to save: idle in standby until it is. */
    override fun onMainState(state: String) {
      setStandby(state == EngineState.STANDBY.jsName || state == EngineState.IDLE.jsName)
    }

    override fun onAngleReady(id: String) {
      listener?.onAngleReady(id)
    }

    override fun onStatus(status: PeerLink.Status) {
      listener?.onPeerStatus(status)
    }

    override fun onPeersFound(peers: List<PeerLink.PeerInfo>) {
      listener?.onPeersFound(peers)
    }

    override fun onError(code: String, message: String) {
      listener?.onError(code, message)
    }
  }

  private fun hasPermission(permission: String) =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  /** Per-frame / per-sound tracing, debug builds only (the message isn't even built in release). */
  private inline fun verbose(message: () -> String) {
    if (VERBOSE) Log.d(TAG, message())
  }

  companion object {
    private const val TAG = "SwingCaptureEngine"
    private val VERBOSE = BuildConfig.DEBUG
    private const val COOLDOWN_US = 3_000_000L
    private const val AUDIO_SETTLE_MS = 150L
    private const val EXPORT_WATCHDOG_MS = 3_000L
    /** Sounds this soon after a screen touch are the phone being handled, not a strike. */
    private const val TOUCH_MUTE_US = 1_500_000L
    private const val CHIME_MUTE_EXTRA_US = 400_000L
    private const val SHARP_MODE_EV = -1.0
    /** How long a sound rejected for "no wrist swing" can still be claimed by a late wrist message. */
    private const val LATE_WRIST_MS = 2_500L
    private const val STANDBY_FPS = 30
    /** Upright thumbnail of the preview for motion sensing: 72x128 portrait or 128x72 landscape. */
    private const val MOTION_SHORT = 72
    private const val MOTION_LONG = 128
    private const val MOTION_INTERVAL_MS = 66L
    private const val MOTION_REPORT_US = 500_000L

    @Volatile private var instance: CaptureEngine? = null

    fun get(context: Context): CaptureEngine =
      instance ?: synchronized(this) {
        instance ?: CaptureEngine(context.applicationContext).also { instance = it }
      }
  }
}
