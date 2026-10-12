package app.simpleswing.capture

import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.media.MediaRecorder
import android.util.Range
import android.util.Size

/** The concrete camera mode the engine will run. */
data class CaptureFormat(
  val cameraId: String,
  val size: Size,
  val fps: Int,
  /** true = constrained high-speed session (120/240 fps); false = regular session. */
  val highSpeed: Boolean,
  val sensorOrientation: Int,
  /** Sensor timestamps are SystemClock.elapsedRealtimeNanos (else System.nanoTime). */
  val realtimeClock: Boolean,
)

object CameraFormats {
  private const val MAX_AREA = 1920 * 1080

  fun backCameraId(manager: CameraManager): String? =
    manager.cameraIdList.firstOrNull {
      manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) ==
        CameraCharacteristics.LENS_FACING_BACK
    }

  /** Fixed-rate high-speed modes as (size, fps), largest first, capped at 1080p. */
  fun highSpeedModes(chars: CameraCharacteristics): List<Pair<Size, Int>> {
    val caps = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: return emptyList()
    if (CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_CONSTRAINED_HIGH_SPEED_VIDEO !in caps) return emptyList()
    val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return emptyList()
    return map.highSpeedVideoSizes
      .filter { it.width * it.height <= MAX_AREA }
      .flatMap { size ->
        map.getHighSpeedVideoFpsRangesFor(size)
          .filter { it.lower == it.upper && it.upper >= 120 }
          .map { size to it.upper }
      }
      .distinct()
      .sortedByDescending { it.first.width * it.first.height }
  }

  /** Best regular-session mode: (size, fixed fps range). */
  private fun regularMode(chars: CameraCharacteristics, maxFps: Int): Pair<Size, Range<Int>>? {
    val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return null
    val ranges = chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) ?: return null
    val range = ranges
      .filter { it.upper <= maxFps }
      .sortedWith(compareByDescending<Range<Int>> { it.upper }.thenByDescending { it.lower })
      .firstOrNull() ?: return null
    val size = map.getOutputSizes(MediaRecorder::class.java)
      .filter { it.width * 9 == it.height * 16 && it.width * it.height <= MAX_AREA }
      .filter { map.getOutputMinFrameDuration(MediaRecorder::class.java, it) <= 1_000_000_000L / range.upper }
      .maxByOrNull { it.width * it.height } ?: return null
    return size to range
  }

  fun supportedFps(manager: CameraManager): List<Int> {
    val id = backCameraId(manager) ?: return emptyList()
    val chars = manager.getCameraCharacteristics(id)
    val fps = highSpeedModes(chars).map { it.second }.toMutableSet()
    regularMode(chars, 60)?.let { fps.add(it.second.upper) }
    return fps.sorted()
  }

  /** Picks the highest frame rate <= [requestedFps] the back camera can sustain, preferring the largest size. */
  fun select(manager: CameraManager, requestedFps: Int): Pair<CaptureFormat, Range<Int>> {
    val id = backCameraId(manager) ?: throw CaptureException("E_NO_CAMERA", "No back camera found")
    val chars = manager.getCameraCharacteristics(id)
    val orientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
    val realtime = chars.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE) ==
      CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME

    if (requestedFps > 60) {
      val modes = highSpeedModes(chars).filter { it.second <= requestedFps }
      val bestFps = modes.maxOfOrNull { it.second }
      if (bestFps != null) {
        val size = modes.filter { it.second == bestFps }.maxBy { it.first.width * it.first.height }.first
        return CaptureFormat(id, size, bestFps, true, orientation, realtime) to Range(bestFps, bestFps)
      }
    }
    val (size, range) = regularMode(chars, minOf(requestedFps, 60))
      ?: throw CaptureException("E_NO_FORMAT", "No usable video format on this camera")
    return CaptureFormat(id, size, range.upper, false, orientation, realtime) to range
  }
}

class CaptureException(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause)
