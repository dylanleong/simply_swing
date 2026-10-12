package app.simpleswing.capture

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

enum class TriggerSource(val jsName: String, val isAuto: Boolean) {
  MANUAL("manual", false),
  VOLUME_KEY("volumeKey", false),
  WATCH("watch", true),
  IMPACT("impact", true),
  /** A wrist swing from the watch with no impact sound (practice swing). */
  WRIST("wrist", true);

  companion object {
    fun fromJs(name: String): TriggerSource =
      entries.firstOrNull { it.jsName == name } ?: throw IllegalArgumentException("Unknown trigger source: $name")
  }
}

class RoiRecord : Record {
  @Field val x: Double = 0.25
  @Field val y: Double = 0.1
  @Field val width: Double = 0.5
  @Field val height: Double = 0.85

  fun toRoi() = MotionGate.NormalizedRoi(x, y, width, height)
}

/** Mirrors `CaptureConfig` in src/SwingCapture.types.ts. */
class CaptureConfigRecord : Record {
  @Field val fps: Int = 120
  @Field val preRollSec: Double = 3.0
  @Field val postRollSec: Double = 1.5
  @Field val lookbackSec: Double = 6.0
  @Field val roi: RoiRecord = RoiRecord()
  @Field val sensitivity: Double = 0.5
  @Field val sharpMode: Boolean = true
  @Field val autoTrigger: Boolean = true
  @Field val impactTrigger: Boolean = true
  @Field val watchMode: String = WearBridge.MODE_AUTO
  @Field val savePracticeSwings: Boolean = false

  fun toConfig() = CaptureConfig(
    fps = fps,
    preRollUs = (preRollSec * 1e6).toLong(),
    postRollUs = (postRollSec * 1e6).toLong(),
    lookbackUs = (lookbackSec * 1e6).toLong(),
    roi = roi.toRoi(),
    sensitivity = sensitivity,
    sharpMode = sharpMode,
    autoTrigger = autoTrigger,
    impactTrigger = impactTrigger,
    watchMode = watchMode,
    savePracticeSwings = savePracticeSwings,
  )
}

/** Plain engine config, free of Expo types so it can be unit-tested. */
data class CaptureConfig(
  val fps: Int,
  val preRollUs: Long,
  val postRollUs: Long,
  val lookbackUs: Long,
  val roi: MotionGate.NormalizedRoi,
  val sensitivity: Double,
  val sharpMode: Boolean,
  val autoTrigger: Boolean,
  val impactTrigger: Boolean,
  /** auto = wrist swing detection, tap = watch SAVE button only, off = ignore the watch. */
  val watchMode: String = WearBridge.MODE_AUTO,
  val savePracticeSwings: Boolean = false,
)
