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

  /** Clamped to the frame (and NaN-safe), so a bad value from JS can't break the motion gate. */
  fun toRoi(): MotionGate.NormalizedRoi {
    fun unit(v: Double, fallback: Double) = if (v.isFinite()) v.coerceIn(0.0, 1.0) else fallback
    val left = unit(x, 0.25).coerceAtMost(0.95)
    val top = unit(y, 0.1).coerceAtMost(0.95)
    return MotionGate.NormalizedRoi(
      left, top, unit(width, 0.5).coerceIn(0.05, 1.0 - left), unit(height, 0.85).coerceIn(0.05, 1.0 - top),
    )
  }
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
  @Field val savedSound: Boolean = true

  fun toConfig() = CaptureConfig(
    fps = fps,
    preRollUs = seconds(preRollSec, 3.0),
    postRollUs = seconds(postRollSec, 1.5),
    lookbackUs = seconds(lookbackSec, 6.0),
    roi = roi.toRoi(),
    sensitivity = sensitivity,
    sharpMode = sharpMode,
    autoTrigger = autoTrigger,
    impactTrigger = impactTrigger,
    watchMode = watchMode,
    savePracticeSwings = savePracticeSwings,
    savedSound = savedSound,
  )

  /** Clip lengths are a few seconds; anything else from JS is a bug, so fall back rather than misbehave. */
  private fun seconds(value: Double, fallback: Double): Long =
    ((if (value.isFinite() && value in 0.0..30.0) value else fallback) * 1e6).toLong()
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
  /** Chime when a swing is saved (main / solo phone only). */
  val savedSound: Boolean = false,
)
