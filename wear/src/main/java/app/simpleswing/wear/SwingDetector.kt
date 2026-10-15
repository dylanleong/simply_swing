package app.simpleswing.wear

import kotlin.math.sqrt

/**
 * Spots a golf swing in wrist gyroscope data and reports its peak (≈ impact).
 *
 * The lead wrist's rotation speed builds through the backswing, transitions, then spikes through
 * the downswing to well over 1,000 °/s at impact before falling away in the follow-through. A
 * swing is reported when:
 *  - the burst of rotation (speed ≥ [activeDps]) has lasted ≥ [minBackswingNs] before the peak,
 *    which rules out flicks, waves and taps;
 *  - the peak reaches [peakDps];
 *  - speed has fallen to [releaseFraction] of the peak, so the peak is known (~100-150 ms later).
 * Walking arm swing stays well under [peakDps]. After a swing, the rest of that burst and the next
 * [refractoryNs] are ignored.
 *
 * Tempo: from the last few seconds of speeds it also finds the top of the backswing (the slowest
 * moment in the [topSearchNs] before the peak: the wrist pauses as the club changes direction) and the
 * takeaway (the last moment before the top that the wrist was still, under [stillDps]). Backswing is
 * takeaway → top, downswing top → peak. Either is null if it can't be found.
 *
 * Times are sensor timestamps (SystemClock.elapsedRealtimeNanos on modern Wear OS).
 */
class SwingDetector(
  private val activeDps: Double = 120.0,
  private val peakDps: Double = 700.0,
  private val minBackswingNs: Long = 300_000_000,
  private val releaseFraction: Double = 0.6,
  /** A dip below [activeDps] shorter than this doesn't end the burst (transition at the top). */
  private val gapNs: Long = 250_000_000,
  private val refractoryNs: Long = 1_500_000_000,
  private val stillDps: Double = 40.0,
  private val topSearchNs: Long = 600_000_000,
  /** The top is at least this long before the peak (the downswing can't be quicker). */
  private val minDownswingNs: Long = 100_000_000,
  private val onSwing: (Swing) -> Unit,
) {
  /** A detected swing. [backswingNs] and [downswingNs] make the tempo (typically ~3 : 1). */
  data class Swing(val peakTimeNs: Long, val peakDps: Double, val backswingNs: Long?, val downswingNs: Long?)

  /** Recent (time, speed) samples, oldest overwritten: enough for a slow backswing plus address. */
  private val historyTimes = LongArray(HISTORY)
  private val historyDps = DoubleArray(HISTORY)
  private var historyCount = 0
  private var historyNext = 0

  private var burstStartNs = -1L
  private var lastActiveNs = -1L
  private var peak = 0.0
  private var peakTimeNs = 0L
  private var reportedThisBurst = false
  private var lastSwingNs = Long.MIN_VALUE / 2

  /** Gyroscope sample in rad/s. */
  fun onSample(timeNs: Long, x: Float, y: Float, z: Float) {
    val dps = sqrt((x * x + y * y + z * z).toDouble()) * RAD_TO_DEG
    historyTimes[historyNext] = timeNs
    historyDps[historyNext] = dps
    historyNext = (historyNext + 1) % HISTORY
    historyCount = minOf(historyCount + 1, HISTORY)

    if (dps >= activeDps) {
      if (burstStartNs < 0 || timeNs - lastActiveNs > gapNs) startBurst(timeNs)
      lastActiveNs = timeNs
      if (dps > peak) {
        peak = dps
        peakTimeNs = timeNs
      }
    } else if (burstStartNs >= 0 && timeNs - lastActiveNs > gapNs) {
      burstStartNs = -1 // burst over
    }

    if (
      burstStartNs >= 0 &&
      !reportedThisBurst &&
      peak >= peakDps &&
      dps <= peak * releaseFraction &&
      peakTimeNs - burstStartNs >= minBackswingNs &&
      peakTimeNs - lastSwingNs >= refractoryNs
    ) {
      reportedThisBurst = true
      lastSwingNs = peakTimeNs
      val topNs = findTop()
      val takeawayNs = topNs?.let(::findTakeaway)
      onSwing(
        Swing(
          peakTimeNs,
          peak,
          backswingNs = if (topNs != null && takeawayNs != null) topNs - takeawayNs else null,
          downswingNs = topNs?.let { peakTimeNs - it },
        )
      )
    }
  }

  /** Samples oldest first. */
  private inline fun forEachSample(block: (timeNs: Long, dps: Double) -> Unit) {
    val first = (historyNext - historyCount + HISTORY) % HISTORY
    for (i in 0 until historyCount) {
      val k = (first + i) % HISTORY
      block(historyTimes[k], historyDps[k])
    }
  }

  /** The slowest moment between the backswing and the downswing spike. */
  private fun findTop(): Long? {
    var best: Long? = null
    var bestDps = Double.MAX_VALUE
    forEachSample { t, dps ->
      if (t >= peakTimeNs - topSearchNs && t <= peakTimeNs - minDownswingNs && dps < bestDps) {
        bestDps = dps
        best = t
      }
    }
    return best
  }

  /** The last still moment before [topNs]: when the club started back. */
  private fun findTakeaway(topNs: Long): Long? {
    var last: Long? = null
    forEachSample { t, dps -> if (t < topNs && dps < stillDps) last = t }
    return last
  }

  private fun startBurst(timeNs: Long) {
    burstStartNs = timeNs
    peak = 0.0
    peakTimeNs = timeNs
    reportedThisBurst = false
  }

  private companion object {
    const val RAD_TO_DEG = 180.0 / Math.PI
    /** 4 s at 100 Hz. */
    const val HISTORY = 400
  }
}
