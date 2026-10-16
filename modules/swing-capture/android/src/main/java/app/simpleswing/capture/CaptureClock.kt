package app.simpleswing.capture

import android.media.AudioTimestamp
import android.os.SystemClock
import kotlin.math.abs

/**
 * The time base of the camera's sensor timestamps. Video PTS, audio PTS and trigger times are all
 * expressed in it so the clip window, impact time and A/V sync line up.
 */
class CaptureClock(private val realtime: Boolean) {
  fun nowNs(): Long = if (realtime) SystemClock.elapsedRealtimeNanos() else System.nanoTime()

  fun nowUs(): Long = nowNs() / 1000

  val audioTimebase: Int
    get() = if (realtime) AudioTimestamp.TIMEBASE_BOOTTIME else AudioTimestamp.TIMEBASE_MONOTONIC
}

/**
 * Camera frames should carry timestamps on the capture clock's time base, but some vendor encoders
 * rewrite them. Frames reach us within ~100 ms of capture, so a gap over a second means a different
 * base; map it onto the capture clock (costs A/V sync accuracy of roughly the pipeline latency).
 */
object VideoClockOffset {
  private const val SAME_BASE_US = 1_000_000L

  /**
   * µs to add to encoder PTS. Prefers an exact clock-to-clock shift (e.g. HONOR stamps high-speed
   * frames with CLOCK_MONOTONIC while declaring REALTIME); falls back to the measured gap otherwise.
   * All arguments are the same instant read from each clock, except [ptsUs], the first frame's PTS.
   */
  fun measure(ptsUs: Long, captureNowUs: Long, bootNowUs: Long, monoNowUs: Long): Long {
    val delta = captureNowUs - ptsUs
    return when {
      abs(delta) < SAME_BASE_US -> 0L
      abs(monoNowUs - ptsUs) < SAME_BASE_US -> captureNowUs - monoNowUs
      abs(bootNowUs - ptsUs) < SAME_BASE_US -> captureNowUs - bootNowUs
      else -> delta
    }
  }
}
