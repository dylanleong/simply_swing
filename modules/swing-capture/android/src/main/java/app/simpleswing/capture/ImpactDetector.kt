package app.simpleswing.capture

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * Detects club-on-ball impact in mono PCM.
 *
 * An impact is a broadband click with a sub-millisecond attack, unlike voices, wind, or a
 * neighbour's thud through the mat. Per 5 ms hop the detector:
 *  1. high-passes at ~1.5 kHz (drops wind, traffic, footfalls),
 *  2. measures the hop's energy in dB,
 *  3. fires when energy jumps [riseDb] above the level 10 ms earlier AND sits [marginDb] above the
 *     adaptive noise floor (median of the last 2 s) AND reaches [minLevelDb],
 *  4. then ignores everything for [refractoryUs] (echoes, ball landing, the next mat).
 *
 * The reported time is the peak sample inside the hop, on the caller's clock.
 *
 * This class is audio-only. The engine then rejects neighbouring bays with the golfer-box motion
 * gate (MotionGate: movement in the preceding 1.5 s) and, with the watch sensing, TriggerFusion.
 * Mirrored by the iOS implementation.
 */
class ImpactDetector(
  private val sampleRate: Int,
  sensitivity: Double,
  /** [loudEnough] false = a sharp sound below [minLevelDb], reported for calibration only. */
  private val onImpact: (ptsUs: Long, levelDb: Double, marginDb: Double, loudEnough: Boolean) -> Unit,
) {
  private val hop = sampleRate / 200 // 5 ms
  private val marginDb = 30.0 - 15.0 * sensitivity.coerceIn(0.0, 1.0)
  private val riseDb = 12.0
  /**
   * Absolute loudness a strike must reach (dBFS, 5 ms hop energy): -24 / -32 / -40 dB at low /
   * medium / high. In a quiet room the relative margin alone lets screen taps and handling noise
   * through. Kept moderate because the golfer-box motion gate also has to pass (field test: claps at
   * 3 m read -31 to -45 dB; a struck ball is ~15-20 dB louder).
   */
  val minLevelDb = -24.0 - 16.0 * sensitivity.coerceIn(0.0, 1.0)
  private val refractoryUs = 1_000_000L

  private val hpf = Biquad.highPass(sampleRate, cutoffHz = 1500.0)
  private val floorHistory = DoubleArray(400) // 2 s of hops
  private var hopsSeen = 0
  private var floorDb = -90.0
  private var hopsSinceFloorUpdate = 0

  private var prev1Db = -90.0
  private var prev2Db = -90.0
  private var lastImpactUs = Long.MIN_VALUE / 2
  private var lastQuietReportUs = Long.MIN_VALUE / 2

  // Partial hop carried between process() calls.
  private var acc = 0.0
  private var accCount = 0
  private var peakAbs = 0.0
  private var peakIndexInHop = 0
  private var hopStartUs = 0L

  /** [ptsUs] is the capture-clock time of `pcm[0]`. */
  fun process(pcm: ShortArray, count: Int, ptsUs: Long) {
    for (i in 0 until count) {
      if (accCount == 0) hopStartUs = ptsUs + i * 1_000_000L / sampleRate
      val y = hpf.process(pcm[i] / 32768.0)
      acc += y * y
      val a = abs(y)
      if (a > peakAbs) {
        peakAbs = a
        peakIndexInHop = accCount
      }
      if (++accCount == hop) endHop()
    }
  }

  private fun endHop() {
    val levelDb = 10 * log10(acc / hop + 1e-12)
    val tUs = hopStartUs + peakIndexInHop * 1_000_000L / sampleRate
    val margin = levelDb - floorDb
    val sharp = hopsSeen >= WARMUP_HOPS &&
      levelDb - prev2Db >= riseDb &&
      margin >= marginDb &&
      tUs - lastImpactUs >= refractoryUs
    if (sharp && levelDb >= minLevelDb) {
      lastImpactUs = tUs
      onImpact(tUs, levelDb, margin, true)
    } else if (sharp && tUs - lastQuietReportUs >= QUIET_REPORT_INTERVAL_US) {
      lastQuietReportUs = tUs
      onImpact(tUs, levelDb, margin, false)
    }
    prev2Db = prev1Db
    prev1Db = levelDb
    updateFloor(levelDb)
    acc = 0.0
    accCount = 0
    peakAbs = 0.0
    peakIndexInHop = 0
  }

  private fun updateFloor(levelDb: Double) {
    floorHistory[hopsSeen % floorHistory.size] = levelDb
    hopsSeen++
    if (++hopsSinceFloorUpdate >= 10 || hopsSeen <= WARMUP_HOPS) { // every 50 ms once warm
      hopsSinceFloorUpdate = 0
      val filled = minOf(hopsSeen, floorHistory.size)
      floorDb = floorHistory.copyOf(filled).apply { sort() }[filled / 2]
    }
  }

  private companion object {
    /** Don't fire until the noise floor reflects real ambience (0.5 s). */
    const val WARMUP_HOPS = 100
    const val QUIET_REPORT_INTERVAL_US = 300_000L
  }
}

/** Direct-form-I biquad (RBJ cookbook). */
class Biquad(
  private val b0: Double,
  private val b1: Double,
  private val b2: Double,
  private val a1: Double,
  private val a2: Double,
) {
  private var x1 = 0.0
  private var x2 = 0.0
  private var y1 = 0.0
  private var y2 = 0.0

  fun process(x: Double): Double {
    val y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    return y
  }

  companion object {
    fun highPass(sampleRate: Int, cutoffHz: Double, q: Double = 1 / sqrt(2.0)): Biquad {
      val k = tan(PI * cutoffHz / sampleRate)
      val norm = 1 / (1 + k / q + k * k)
      return Biquad(
        b0 = norm,
        b1 = -2 * norm,
        b2 = norm,
        a1 = 2 * (k * k - 1) * norm,
        a2 = (1 - k / q + k * k) * norm,
      )
    }
  }
}
