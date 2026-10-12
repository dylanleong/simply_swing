package app.simpleswing.capture

/**
 * Was the golfer swinging just before an impact sound?
 *
 * Fed ~15 small luma frames per second of the preview. For each frame it measures motion inside
 * the golfer box (mean absolute luma change vs the previous frame). An impact passes the gate when
 * peak motion in the [lookbackUs] before it clears an adaptive threshold: [thresholdFactor] x the
 * scene's quiet level (25th percentile of recent motion), but never below [minMotion].
 *
 * A neighbour's strike makes sound without motion in our box; a golfer at address then swinging
 * makes a large spike, mostly in the downswing.
 */
class MotionGate(
  roi: NormalizedRoi,
  private val lookbackUs: Long = 1_500_000,
  private val historyUs: Long = 6_000_000,
  private val minMotion: Double = 4.0,
  private val thresholdFactor: Double = 3.0,
) {
  data class NormalizedRoi(val x: Double, val y: Double, val width: Double, val height: Double)

  data class Verdict(val peak: Double, val threshold: Double, val passed: Boolean)

  @Volatile private var roi = roi
  private var previous: IntArray? = null
  private var previousSize = 0 to 0
  private val times = ArrayDeque<Long>()
  private val energies = ArrayDeque<Double>()

  /** Returns true if the box actually changed. */
  fun setRoi(roi: NormalizedRoi): Boolean {
    if (this.roi == roi) return false
    this.roi = roi
    return true
  }

  @Synchronized
  fun reset() {
    previous = null
    times.clear()
    energies.clear()
  }

  /** [luma] is row-major, [width] x [height], values 0..255, in upright preview orientation. */
  @Synchronized
  fun addFrame(tUs: Long, luma: IntArray, width: Int, height: Int) {
    val prev = previous
    if (prev != null && previousSize == (width to height)) {
      val r = roi
      val x0 = (r.x * width).toInt().coerceIn(0, width - 1)
      val y0 = (r.y * height).toInt().coerceIn(0, height - 1)
      val x1 = ((r.x + r.width) * width).toInt().coerceIn(x0 + 1, width)
      val y1 = ((r.y + r.height) * height).toInt().coerceIn(y0 + 1, height)
      var sum = 0L
      for (y in y0 until y1) {
        val row = y * width
        for (x in x0 until x1) sum += kotlin.math.abs(luma[row + x] - prev[row + x])
      }
      times.addLast(tUs)
      energies.addLast(sum.toDouble() / ((x1 - x0) * (y1 - y0)))
      while (times.isNotEmpty() && tUs - times.first() > historyUs) {
        times.removeFirst()
        energies.removeFirst()
      }
    }
    previous = luma.copyOf()
    previousSize = width to height
  }

  /** Null when there is too little motion history to judge (e.g. the preview isn't readable). */
  @Synchronized
  fun evaluate(impactUs: Long): Verdict? {
    if (energies.size < MIN_SAMPLES) return null
    var peak = 0.0
    for (i in times.indices) {
      if (times[i] in (impactUs - lookbackUs)..(impactUs + SLACK_US)) peak = maxOf(peak, energies[i])
    }
    val quiet = energies.sorted()[energies.size / 4]
    val threshold = maxOf(minMotion, quiet * thresholdFactor)
    return Verdict(peak, threshold, peak >= threshold)
  }

  /** Latest motion level, for on-screen calibration. */
  @Synchronized
  fun latest(): Double? = energies.lastOrNull()

  private companion object {
    /** ~1 s of frames at 15 fps before verdicts mean anything. */
    const val MIN_SAMPLES = 15
    /** Frames just after the detected sound still belong to the strike / follow-through. */
    const val SLACK_US = 150_000L
  }
}
