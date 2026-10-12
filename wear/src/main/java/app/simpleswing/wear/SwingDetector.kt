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
  private val onSwing: (peakTimeNs: Long, peakDps: Double) -> Unit,
) {
  private var burstStartNs = -1L
  private var lastActiveNs = -1L
  private var peak = 0.0
  private var peakTimeNs = 0L
  private var reportedThisBurst = false
  private var lastSwingNs = Long.MIN_VALUE / 2

  /** Gyroscope sample in rad/s. */
  fun onSample(timeNs: Long, x: Float, y: Float, z: Float) {
    val dps = sqrt((x * x + y * y + z * z).toDouble()) * RAD_TO_DEG

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
      onSwing(peakTimeNs, peak)
    }
  }

  private fun startBurst(timeNs: Long) {
    burstStartNs = timeNs
    peak = 0.0
    peakTimeNs = timeNs
    reportedThisBurst = false
  }

  private companion object {
    const val RAD_TO_DEG = 180.0 / Math.PI
  }
}
