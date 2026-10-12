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
import kotlin.math.abs

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
  fun onWristSwing(peakDps: Int)
  /** Every sharp sound the detector hears, accepted or not, for on-screen calibration. */
  fun onSound(levelDb: Double, minLevelDb: Double, accepted: Boolean, reason: String?, motion: MotionGate.Verdict?)
  /** Golfer-box motion level, ~2 Hz, for framing and calibration. */
  fun onMotion(level: Double, threshold: Double)
  /** Shutter time and ISO auto-exposure is using, ~1 Hz. */
  fun onExposure(exposureNs: Long, iso: Int?)
  fun onThermalDowngrade(fromFps: Int, toFps: Int)
  fun onError(code: String, message: String)
}

/** The on-screen preview (SwingCaptureView). Called on the main thread. */
interface PreviewHost {
  /** Size the preview surface's buffer to the camera stream size (landscape sensor orientation). */
  fun setBufferSize(size: Size)

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
 * [encoderHandler]; audio has its own thread; muxing runs on [exportExecutor].
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
  private val motionBitmap = Bitmap.createBitmap(MOTION_W, MOTION_H, Bitmap.Config.ARGB_8888)
  private val motionPixels = IntArray(MOTION_W * MOTION_H)
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
  /** Sound + wrist decisions while the watch is sensing (guarded by itself). */
  private val fusion = TriggerFusion()
  /** Level details of sounds waiting for a wrist verdict, keyed by sound time. */
  private val pendingSounds = HashMap<Long, Pair<Double, Double>>()

  // Owned by the camera thread.
  private var config: CaptureConfig? = null
  private var format: CaptureFormat? = null
  private var fpsRange: Range<Int>? = null
  @Volatile private var previewHost: PreviewHost? = null
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

  private class PendingClip(val source: TriggerSource, val window: ClipWindow, val format: CaptureFormat) {
    @Volatile var exporting = false
  }

  init {
    wear.start()
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
      val clip = PendingClip(source, ClipWindows.forTrigger(source, atUs, cfg), fmt)
      pending = clip
      setState(EngineState.TRIGGERED)
      listener?.onTrigger(source, atUs / 1000.0)
      // Never leave the UI stuck on "Saving" if frames stop arriving or timestamps disagree.
      val waitMs = (clip.window.endUs - clock.nowUs()) / 1000 + EXPORT_WATCHDOG_MS
      cameraHandler.postDelayed({ abandonIfStuck(clip) }, waitMs.coerceAtLeast(EXPORT_WATCHDOG_MS))
      return true
    }
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
    previewHost = host
    format?.let { fmt -> mainHandler.post { host.setBufferSize(fmt.size) } }
  }

  fun detachPreview(host: PreviewHost) = cameraHandler.post {
    if (previewHost !== host) return@post
    stopPipeline()
    previewHost = null
    previewSurface = null
    previewSurfaceSize = null
  }

  fun onPreviewSurface(host: PreviewHost, surface: Surface, size: Size) = cameraHandler.post {
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
      if (previewHost === host) {
        stopPipeline()
        previewSurface = null
        previewSurfaceSize = null
      }
      done.countDown()
    }
    done.await(2, TimeUnit.SECONDS)
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
      wear.setActive(true)
      clock = CaptureClock(fmt.realtimeClock)
      val windowUs = ClipWindows.ringWindowUs(config)
      motionGate.setRoi(config.roi)
      videoRing.setWindow(windowUs)
      audioRing.setWindow(windowUs)
      previewHost?.let { host -> mainHandler.post { host.setBufferSize(fmt.size) } }
      Log.i(TAG, "Selected ${fmt.size.width}x${fmt.size.height}@${fmt.fps} highSpeed=${fmt.highSpeed}")
      // The preview surface can outlive a stop/start (e.g. switching tabs keeps the view alive), and
      // then no new surface callback arrives; if it already has the right size, open straight away.
      maybeOpen()
    } catch (e: Exception) {
      fail(e)
    }
  }

  private fun maybeOpen() {
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
        cameraManager.openCamera(fmt.cameraId, deviceCallback(gen, surface), cameraHandler)
        return
      }
      videoEncoder = VideoEncoder(fmt.size, fmt.fps, encoderHandler, ::onVideoSample, { videoFormat = it }, ::onPipelineError)
      lateinit var detector: ImpactDetector
      detector = ImpactDetector(AudioPipeline.SAMPLE_RATE, cfg.sensitivity) { ptsUs, levelDb, marginDb, loudEnough ->
        // With the watch sensing, the wrist decides instead of the camera (see TriggerFusion).
        if (loudEnough && impactTrigger && ptsUs - lastTouchUs >= TOUCH_MUTE_US && wristDecides()) {
          Log.d(TAG, "Impact at $ptsUs level=%.1f dB → waiting for wrist".format(levelDb))
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
        Log.d(
          TAG,
          "Impact at $ptsUs level=%.1f dB margin=%.1f dB motion=%s accepted=$accepted reason=$reason"
            .format(levelDb, marginDb, motion?.let { "%.1f/%.1f".format(it.peak, it.threshold) } ?: "n/a"),
        )
        listener?.onSound(levelDb, detector.minLevelDb, accepted, reason ?: if (accepted) null else "busy", motion)
      }
      audio = AudioPipeline(clock, audioRing::add, { audioFormat = it }, ::onPipelineError, detector::process)
        .also { it.start() }
      opening = true
      cameraManager.openCamera(fmt.cameraId, deviceCallback(gen, surface), cameraHandler)
    } catch (e: Exception) {
      fail(e)
    }
  }

  private fun deviceCallback(gen: Int, preview: Surface) = object : CameraDevice.StateCallback() {
    override fun onOpened(device: CameraDevice) {
      opening = false
      if (gen != generation) {
        device.close()
        return
      }
      camera = device
      createSession(device, preview, gen)
    }

    override fun onDisconnected(device: CameraDevice) {
      opening = false
      device.close()
      if (gen == generation) stopPipeline()
    }

    override fun onError(device: CameraDevice, error: Int) {
      opening = false
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
          setState(if (standby) EngineState.STANDBY else EngineState.ARMED)
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

  private fun onWristSwing(ageMs: Long, oneWayMs: Long, peakDps: Int) {
    if (state == EngineState.IDLE) return
    listener?.onWristSwing(peakDps)
    // The swing peaked ageMs before the watch sent it, plus the radio hop to us.
    val peakUs = clock.nowUs() - (ageMs + oneWayMs) * 1000
    Log.d(TAG, "Wrist swing peak $peakDps°/s at $peakUs (age $ageMs ms, one-way $oneWayMs ms)")
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
          Log.d(TAG, "Sound + wrist at ${d.atUs}: accepted=$accepted")
          listener?.onSound(levelDb, minLevelDb, accepted, if (accepted) null else "busy", null)
        }
        TriggerFusion.Kind.NO_WRIST -> {
          Log.d(TAG, "Sound at ${d.atUs} without a wrist swing: ignored")
          // Kept for a late wrist message; re-stash the levels in case it arrives, then forget them.
          synchronized(fusion) { pendingSounds[d.atUs] = levelDb to minLevelDb }
          cameraHandler.postDelayed({ synchronized(fusion) { pendingSounds.remove(d.atUs) } }, LATE_WRIST_MS)
          listener?.onSound(levelDb, minLevelDb, false, "wrist", null)
        }
        TriggerFusion.Kind.PRACTICE -> {
          val accepted = trigger(TriggerSource.WRIST, d.atUs)
          Log.d(TAG, "Practice swing at ${d.atUs}: accepted=$accepted")
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
    motionGeneration = -1
    synchronized(triggerLock) { pending = null }
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
    host.copyPreview(motionBitmap, motionHandler) { ok ->
      if (gen != motionGeneration) return@copyPreview
      if (ok) onMotionFrame()
      motionHandler.postDelayed({ sampleMotion(gen) }, MOTION_INTERVAL_MS)
    }
  }

  private fun onMotionFrame() {
    val now = clock.nowUs()
    motionBitmap.getPixels(motionPixels, 0, MOTION_W, 0, 0, MOTION_W, MOTION_H)
    val luma = IntArray(motionPixels.size) {
      val c = motionPixels[it]
      ((c shr 16 and 0xff) * 77 + (c shr 8 and 0xff) * 150 + (c and 0xff) * 29) shr 8
    }
    motionGate.addFrame(now, luma, MOTION_W, MOTION_H)
    if (now - lastMotionReportUs >= MOTION_REPORT_US) {
      lastMotionReportUs = now
      val level = motionGate.peakSince(now, MOTION_REPORT_US)
      val verdict = motionGate.evaluate(now)
      if (level != null && verdict != null) {
        Log.d(TAG, "Motion peak=%.1f%% threshold=%.1f%%".format(level, verdict.threshold))
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

  /**
   * Camera frames should carry timestamps on [clock]'s time base, but some vendor encoders rewrite
   * them. Frames reach us within ~100 ms of capture, so a gap over a second means a different base;
   * map it onto the capture clock (costs A/V sync accuracy of roughly the pipeline latency).
   */
  private fun measureVideoOffset(ptsUs: Long): Long {
    val now = clock.nowUs()
    val boot = SystemClock.elapsedRealtimeNanos() / 1000
    val mono = System.nanoTime() / 1000
    val delta = now - ptsUs
    // Prefer an exact clock-to-clock shift (e.g. HONOR stamps high-speed frames with CLOCK_MONOTONIC
    // while declaring REALTIME); fall back to the measured gap for anything else.
    val offset = when {
      abs(delta) < 1_000_000 -> 0L
      abs(mono - ptsUs) < 1_000_000 -> now - mono
      abs(boot - ptsUs) < 1_000_000 -> now - boot
      else -> delta
    }
    Log.i(TAG, "First video frame pts=$ptsUs clockNow=$now delta=${delta}us -> offset=${offset}us")
    return offset
  }

  // ---- Export thread ----

  private fun export(p: PendingClip) {
    // Let the last AAC frames for the window come out of the audio encoder.
    Thread.sleep(AUDIO_SETTLE_MS)
    synchronized(triggerLock) {
      if (pending !== p) return
      setState(EngineState.EXPORTING)
    }
    try {
      val vf = videoFormat ?: throw CaptureException("E_EXPORT", "Video encoder not ready")
      val video = videoRing.snapshot(p.window.startUs, p.window.endUs)
      val audio = audioRing.snapshot(p.window.startUs, p.window.endUs)
      val file = File(clipsDir, "swing_${System.currentTimeMillis()}.mp4")
      val clip = ClipWriter.write(file, vf, video, audioFormat, audio, p.format.sensorOrientation, p.window.impactUs)
      val info = mapOf(
        "uri" to "file://${clip.file.absolutePath}",
        "thumbUri" to clip.thumbnail?.let { "file://${it.absolutePath}" },
        "fps" to p.format.fps,
        "durationMs" to clip.durationUs / 1000.0,
        "impactOffsetMs" to clip.impactOffsetUs?.let { it / 1000.0 },
        "source" to p.source.jsName,
      )
      ClipWriter.writeSidecar(clip.file, info + ("createdAt" to System.currentTimeMillis()))
      wear.broadcastSaved()
      listener?.onClipReady(info)
    } catch (e: Exception) {
      Log.e(TAG, "Export failed", e)
      listener?.onError((e as? CaptureException)?.code ?: "E_EXPORT", e.message ?: e.toString())
    } finally {
      synchronized(triggerLock) {
        if (pending === p) {
          pending = null
          if (state == EngineState.EXPORTING) setState(EngineState.ARMED)
        }
      }
    }
  }

  private fun abandonIfStuck(clip: PendingClip) {
    synchronized(triggerLock) {
      if (pending !== clip || clip.exporting) return
      pending = null
      if (state == EngineState.TRIGGERED) setState(EngineState.ARMED)
    }
    Log.w(TAG, "Clip window never completed (end=${clip.window.endUs}, now=${clock.nowUs()})")
    listener?.onError("E_EXPORT_TIMEOUT", "Couldn't save that swing — video stopped arriving. Ready again.")
  }

  private fun setState(next: EngineState) {
    if (state == next) return
    state = next
    wear.broadcastState(next)
    listener?.onStateChange(next, if (next == EngineState.IDLE) null else format)
  }

  private fun hasPermission(permission: String) =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  companion object {
    private const val TAG = "SwingCaptureEngine"
    private const val COOLDOWN_US = 3_000_000L
    private const val AUDIO_SETTLE_MS = 150L
    private const val EXPORT_WATCHDOG_MS = 3_000L
    /** Sounds this soon after a screen touch are the phone being handled, not a strike. */
    private const val TOUCH_MUTE_US = 1_500_000L
    private const val SHARP_MODE_EV = -1.0
    /** How long a sound rejected for "no wrist swing" can still be claimed by a late wrist message. */
    private const val LATE_WRIST_MS = 2_500L
    private const val STANDBY_FPS = 30
    /** Upright portrait thumbnail of the preview for motion sensing. */
    private const val MOTION_W = 72
    private const val MOTION_H = 128
    private const val MOTION_INTERVAL_MS = 66L
    private const val MOTION_REPORT_US = 500_000L

    @Volatile private var instance: CaptureEngine? = null

    fun get(context: Context): CaptureEngine =
      instance ?: synchronized(this) {
        instance ?: CaptureEngine(context.applicationContext).also { instance = it }
      }
  }
}
