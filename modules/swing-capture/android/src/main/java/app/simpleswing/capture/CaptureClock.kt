package app.simpleswing.capture

import android.media.AudioTimestamp
import android.os.SystemClock

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
