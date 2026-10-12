package app.simpleswing.capture

import android.Manifest
import android.net.Uri
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class SwingCaptureModule : Module() {
  private val engine: CaptureEngine
    get() = CaptureEngine.get(appContext.reactContext ?: throw Exceptions.ReactContextLost())

  private val engineListener = object : EngineListener {
    override fun onStateChange(state: EngineState, format: CaptureFormat?) =
      sendEvent(
        "onStateChange",
        mapOf(
          "state" to state.jsName,
          "format" to format?.let {
            mapOf("width" to it.size.width, "height" to it.size.height, "fps" to it.fps, "highSpeed" to it.highSpeed)
          },
        )
      )

    override fun onTrigger(source: TriggerSource, tImpactMs: Double) =
      sendEvent("onTrigger", mapOf("source" to source.jsName, "tImpactMs" to tImpactMs))

    override fun onClipReady(clip: Map<String, Any?>) = sendEvent("onClipReady", clip)

    override fun onSound(
      levelDb: Double,
      minLevelDb: Double,
      accepted: Boolean,
      reason: String?,
      motion: MotionGate.Verdict?,
    ) = sendEvent(
      "onSound",
      mapOf(
        "levelDb" to levelDb,
        "minLevelDb" to minLevelDb,
        "accepted" to accepted,
        "reason" to reason,
        "motionPeak" to motion?.peak,
        "motionThreshold" to motion?.threshold,
      ),
    )

    override fun onWatchStatus(connected: Boolean, sensing: Boolean) =
      sendEvent("onWatchStatus", mapOf("connected" to connected, "sensing" to sensing))

    override fun onWristSwing(peakDps: Int) = sendEvent("onWristSwing", mapOf("peakDps" to peakDps))

    override fun onMotion(level: Double, threshold: Double) =
      sendEvent("onMotion", mapOf("level" to level, "threshold" to threshold))

    override fun onExposure(exposureNs: Long, iso: Int?) =
      sendEvent("onExposure", mapOf("shutterSec" to exposureNs / 1e9, "iso" to iso))

    override fun onThermalDowngrade(fromFps: Int, toFps: Int) =
      sendEvent("onThermalDowngrade", mapOf("fromFps" to fromFps, "toFps" to toFps))

    override fun onError(code: String, message: String) =
      sendEvent("onError", mapOf("code" to code, "message" to message))
  }

  override fun definition() = ModuleDefinition {
    Name("SwingCapture")

    Events(
      "onStateChange",
      "onTrigger",
      "onClipReady",
      "onSound",
      "onMotion",
      "onExposure",
      "onWatchStatus",
      "onWristSwing",
      "onThermalDowngrade",
      "onError",
    )

    OnCreate {
      engine.listener = engineListener
      engine.activityProvider = { appContext.currentActivity }
    }

    OnDestroy {
      engine.stop()
      if (engine.listener === engineListener) engine.listener = null
    }

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, *PERMISSIONS)
    }

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, *PERMISSIONS)
    }

    AsyncFunction("getCapabilitiesAsync") {
      val fps = engine.supportedFps()
      mapOf("supportedFps" to fps, "highSpeed" to fps.any { it >= 120 }, "volumeKeyTrigger" to true)
    }

    AsyncFunction("startAsync") { config: CaptureConfigRecord ->
      engine.start(config.toConfig())
      Unit
    }

    AsyncFunction("stopAsync") {
      engine.stop()
      Unit
    }

    Function("trigger") { source: String ->
      engine.trigger(TriggerSource.fromJs(source))
    }

    Function("setAutoTrigger") { enabled: Boolean ->
      engine.autoTrigger = enabled
    }

    Function("setImpactTrigger") { enabled: Boolean ->
      engine.impactTrigger = enabled
    }

    Function("setStandby") { on: Boolean ->
      engine.setStandby(on)
    }

    Function("setRoi") { roi: RoiRecord ->
      engine.setRoi(roi.toRoi())
    }

    AsyncFunction("exportSlowMotionAsync") { uri: String, factor: Int ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val src = File(Uri.parse(uri).path ?: throw IllegalArgumentException("Not a file URI: $uri"))
      val dir = File(context.cacheDir, "exports").apply { mkdirs() }
      val dst = File(dir, "${src.nameWithoutExtension}_slowmo_x$factor.mp4")
      if (!dst.exists() || dst.lastModified() < src.lastModified()) ClipWriter.retime(src, dst, factor)
      "file://${dst.absolutePath}"
    }

    View(SwingCaptureView::class) {}
  }

  companion object {
    private val PERMISSIONS = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
  }
}
