package app.simpleswing.capture

import kotlin.math.abs

/**
 * Estimates the offset between our capture clock and a peer phone's, NTP style.
 *
 * Each ping gives four timestamps: we send at t1, the peer receives at t2 and replies at t3 (its
 * clock), we receive at t4. offset = ((t2 − t1) + (t3 − t4)) / 2 is exact when the two radio hops
 * take equally long, and its error is at most half the round trip, so the sample with the smallest
 * round trip wins (Google's multi-phone camera sync does the same and reaches well under 1 ms on
 * Wi-Fi). Keeping only recent samples absorbs slow clock drift.
 *
 * Either phone's capture clock can switch time base when its camera restarts (Android picks
 * elapsedRealtime or nanoTime per camera), which moves the offset by hours; a sample that disagrees
 * with the current estimate by more than any round trip could explain starts the estimate afresh.
 * Not thread-safe; callers serialise.
 */
class ClockSync(private val maxSamples: Int = 20) {
  private class Sample(val offsetUs: Long, val rttUs: Long)

  private val samples = ArrayDeque<Sample>()

  /** Adds one ping exchange. Returns false if it was implausible and ignored. */
  fun add(t1: Long, t2: Long, t3: Long, t4: Long): Boolean {
    val rtt = (t4 - t1) - (t3 - t2)
    if (rtt < 0 || rtt > MAX_RTT_US) return false
    val offset = ((t2 - t1) + (t3 - t4)) / 2
    best?.let { if (abs(offset - it.offsetUs) > JUMP_US) samples.clear() }
    samples.addLast(Sample(offset, rtt))
    while (samples.size > maxSamples) samples.removeFirst()
    return true
  }

  fun clear() = samples.clear()

  private val best: Sample?
    get() = samples.minByOrNull { it.rttUs }

  /** Peer clock minus ours, or null before the first sample. */
  val offsetUs: Long?
    get() = best?.offsetUs

  /** Worst-case error of [offsetUs]: half the best round trip. */
  val errorUs: Long?
    get() = best?.let { it.rttUs / 2 }

  /** A time on our clock expressed on the peer's clock. */
  fun toPeer(localUs: Long): Long? = offsetUs?.let { localUs + it }

  /** A time on the peer's clock expressed on ours. */
  fun toLocal(peerUs: Long): Long? = offsetUs?.let { peerUs - it }

  companion object {
    /** Round trips longer than this are a stalled link, not a measurement. */
    const val MAX_RTT_US = 500_000L

    /** Two plausible samples differ by at most MAX_RTT_US; more means a clock changed base. */
    const val JUMP_US = 2 * MAX_RTT_US
  }
}
