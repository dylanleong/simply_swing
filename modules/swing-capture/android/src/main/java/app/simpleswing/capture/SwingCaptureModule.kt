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

    override fun onWristSwing(peakDps: Int, tempo: WristTempo?) = sendEvent(
      "onWristSwing",
      mapOf("peakDps" to peakDps, "backswingMs" to tempo?.backswingMs, "downswingMs" to tempo?.downswingMs),
    )

    override fun onMotion(level: Double, threshold: Double) =
      sendEvent("onMotion", mapOf("level" to level, "threshold" to threshold))

    override fun onExposure(exposureNs: Long, iso: Int?) =
      sendEvent("onExposure", mapOf("shutterSec" to exposureNs / 1e9, "iso" to iso))

    override fun onThermalDowngrade(fromFps: Int, toFps: Int) =
      sendEvent("onThermalDowngrade", mapOf("fromFps" to fromFps, "toFps" to toFps))

    override fun onPeerStatus(status: PeerLink.Status) =
      sendEvent(
        "onPeerStatus",
        mapOf(
          "role" to status.role.jsName,
          "state" to status.state,
          "peerName" to status.peerName,
          "peerState" to status.peerState,
          "syncMs" to status.syncMs,
          "address" to status.address,
          "code" to status.code,
        ),
      )

    override fun onPeersFound(peers: List<PeerLink.PeerInfo>) =
      sendEvent(
        "onPeersFound",
        mapOf("peers" to peers.map { mapOf("id" to it.id, "name" to it.name, "host" to it.host, "port" to it.port) }),
      )

    override fun onAngleReady(id: String) = sendEvent("onAngleReady", mapOf("id" to id))

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
      "onPeerStatus",
      "onPeersFound",
      "onAngleReady",
      "onError",
    )

    OnCreate {
      engine.listener = engineListener
      engine.activityProvider = { appContext.currentActivity }
    }

    OnDestroy {
      engine.stop()
      engine.peers.stop()
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

    AsyncFunction("exportSideBySideAsync") { uri: String, angleUri: String, shiftMs: Double, factor: Int ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val main = File(Uri.parse(uri).path ?: throw IllegalArgumentException("Not a file URI: $uri"))
      val angle = File(Uri.parse(angleUri).path ?: throw IllegalArgumentException("Not a file URI: $angleUri"))
      val shiftUs = Math.round(shiftMs * 1000)
      val dir = File(context.cacheDir, "exports").apply { mkdirs() }
      // Both clips and the alignment are in the name: another pairing or a nudge makes a fresh export.
      val dst = File(dir, "${main.nameWithoutExtension}_${angle.nameWithoutExtension}_sbs_${shiftUs}_x$factor.mp4")
      if (!dst.exists() || dst.lastModified() < maxOf(main.lastModified(), angle.lastModified())) {
        SideBySideExporter.export(main, angle, shiftUs, factor, dst)
      }
      "file://${dst.absolutePath}"
    }

    Function("startMainLink") {
      engine.peers.startMain()
      Unit
    }

    Function("connectPeer") { idOrAddress: String, code: String ->
      engine.peers.connect(idOrAddress, code)
      Unit
    }

    Function("startCameraLink") { view: String ->
      engine.peers.startCamera(view)
      Unit
    }

    Function("stopPeerLink") {
      engine.peers.stop()
      Unit
    }

    View(SwingCaptureView::class) {}
  }

  companion object {
    private val PERMISSIONS = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
  }
}
