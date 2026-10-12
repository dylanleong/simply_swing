package app.simpleswing.capture

/**
 * Was the golfer swinging just before an impact sound?
 *
 * Fed ~15 small luma frames per second of the preview. For each frame it measures motion inside
 * the golfer box as the **percentage of box pixels whose brightness changed by at least
 * [pixelDelta]** since the previous frame. (A mean change over the box drowns a swing: arms and a
 * thin club are a small part of the box. Field test: ~0.7 mean for a full swing vs ~0.5 noise.)
 * An impact passes the gate when peak motion in the [lookbackUs] before it clears an adaptive
 * threshold: [thresholdFactor] x the scene's quiet level (25th percentile), never below [minMotion].
 *
 * A neighbour's strike makes sound without motion in our box; a golfer at address then swinging
 * changes a few percent of the box, mostly in the downswing.
 */
class MotionGate(
  roi: NormalizedRoi,
  private val lookbackUs: Long = 1_500_000,
  private val historyUs: Long = 6_000_000,
  /** Percent of box pixels. */
  private val minMotion: Double = 1.0,
  private val thresholdFactor: Double = 3.0,
  /** Luma change (0-255) that counts as a changed pixel; well above sensor noise. */
  private val pixelDelta: Int = 18,
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
      var changed = 0
      for (y in y0 until y1) {
        val row = y * width
        for (x in x0 until x1) {
          if (kotlin.math.abs(luma[row + x] - prev[row + x]) >= pixelDelta) changed++
        }
      }
      times.addLast(tUs)
      energies.addLast(100.0 * changed / ((x1 - x0) * (y1 - y0)))
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

  /** Peak motion over the last [spanUs] (the UI samples twice a second; a downswing lasts ~0.3 s). */
  @Synchronized
  fun peakSince(nowUs: Long, spanUs: Long): Double? {
    var peak: Double? = null
    for (i in times.indices) if (times[i] >= nowUs - spanUs) peak = maxOf(peak ?: 0.0, energies[i])
    return peak
  }

  private companion object {
    /** ~1 s of frames at 15 fps before verdicts mean anything. */
    const val MIN_SAMPLES = 15
    /** Frames just after the detected sound still belong to the strike / follow-through. */
    const val SLACK_US = 150_000L
  }
}
