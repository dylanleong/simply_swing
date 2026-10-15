package app.simpleswing.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class SwingDetectorTest {
  private val rate = 100 // Hz
  private val stepNs = 1_000_000_000L / rate
  private val degToRad = (PI / 180).toFloat()

  /** Runs a speed profile (deg/s per sample) through the detector; returns peak times in seconds. */
  private fun detect(speeds: List<Double>): List<Pair<Double, Double>> = detectSwings(speeds).map { it.peakTimeNs / 1e9 to it.peakDps }

  private fun detectSwings(speeds: List<Double>): List<SwingDetector.Swing> {
    val hits = mutableListOf<SwingDetector.Swing>()
    val detector = SwingDetector { hits.add(it) }
    speeds.forEachIndexed { i, dps ->
      // Split across axes; the detector only uses the magnitude.
      val v = (dps / sqrt3).toFloat() * degToRad
      detector.onSample(i * stepNs, v, v, v)
    }
    return hits
  }

  private val sqrt3 = Math.sqrt(3.0)

  private fun still(seconds: Double) = List((seconds * rate).toInt()) { 5.0 }

  /** Full swing: ~1 s backswing build, transition dip, downswing to [peak] at impact, follow-through decay. */
  private fun swing(peak: Double = 1600.0): List<Double> {
    val backswing = List(80) { i -> 150 + 200 * sin(PI * i / 80) } // 0.8 s, 150-350 °/s
    val transition = List(10) { 140.0 }
    val downswing = List(25) { i -> 200 + (peak - 200) * (i + 1) / 25.0 } // 0.25 s to the peak
    val followThrough = List(60) { i -> peak * Math.pow(0.9, i + 1.0) + 100 }
    return backswing + transition + downswing + followThrough
  }

  @Test
  fun detectsAFullSwingAtItsPeak() {
    val profile = still(1.0) + swing() + still(1.0)
    val hits = detect(profile)
    assertEquals(1, hits.size)
    // Peak sample: 1.0 s still + 0.8 backswing + 0.1 transition + 0.25 downswing (last sample).
    assertEquals(2.14, hits[0].first, 0.02)
    assertTrue(hits[0].second > 1500)
  }

  @Test
  fun ignoresAQuickWristFlickWithoutBackswing() {
    val flick = List(5) { 200.0 } + List(5) { 1200.0 } + List(5) { 200.0 }
    assertTrue(detect(still(1.0) + flick + still(1.0)).isEmpty())
  }

  @Test
  fun ignoresWalkingArmSwing() {
    val walking = List(600) { i -> 150 + 150 * sin(2 * PI * i / 100) } // 6 s, ±150 °/s at 1 Hz
    assertTrue(detect(walking).isEmpty())
  }

  @Test
  fun ignoresAGentleHalfSwing() {
    assertTrue(detect(still(1.0) + swing(peak = 500.0) + still(1.0)).isEmpty())
  }

  @Test
  fun countsEachOfTwoSwingsOnce() {
    val profile = still(1.0) + swing() + still(2.0) + swing(peak = 1400.0) + still(1.0)
    assertEquals(2, detect(profile).size)
  }

  @Test
  fun measuresTempo() {
    val swing = detectSwings(still(1.0) + swing() + still(1.0)).single()
    // Takeaway at 1.0 s (last still sample 0.99 s), top in the transition dip at 1.80 s, peak 2.14 s.
    assertEquals(0.81, swing.backswingNs!! / 1e9, 0.03)
    assertEquals(0.34, swing.downswingNs!! / 1e9, 0.03)
  }

  @Test
  fun leavesBackswingUnknownWithoutAStillAddress() {
    // Swinging straight out of a waggle: no still moment in the history before the top.
    val waggle = List(150) { i -> 150 + 60 * sin(2 * PI * i / 50) }
    val swing = detectSwings(waggle + swing() + still(1.0)).single()
    assertEquals(null, swing.backswingNs)
    assertEquals(0.34, swing.downswingNs!! / 1e9, 0.03)
  }
}
