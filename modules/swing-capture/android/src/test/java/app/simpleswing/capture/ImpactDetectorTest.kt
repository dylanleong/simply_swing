package app.simpleswing.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.pow
import kotlin.math.sin
import kotlin.random.Random

class ImpactDetectorTest {
  private val rate = 48_000

  /** Background noise at [db] dBFS RMS. */
  private fun noise(seconds: Double, db: Double, seed: Int = 1): DoubleArray {
    val r = Random(seed)
    val amp = 10.0.pow(db / 20) * 1.732 // uniform [-a, a] has RMS a/sqrt(3)
    return DoubleArray((seconds * rate).toInt()) { (r.nextDouble() * 2 - 1) * amp }
  }

  /** Club-on-ball click: broadband burst with a ~2 ms decay. */
  private fun addClick(signal: DoubleArray, atSec: Double, peakDb: Double, seed: Int = 7) {
    val r = Random(seed)
    val start = (atSec * rate).toInt()
    val peak = 10.0.pow(peakDb / 20)
    for (i in 0 until rate / 50) { // 20 ms tail
      val env = exp(-i / (0.002 * rate))
      signal[start + i] += (r.nextDouble() * 2 - 1) * peak * env
    }
  }

  private fun addTone(signal: DoubleArray, atSec: Double, durSec: Double, hz: Double, db: Double) {
    val start = (atSec * rate).toInt()
    val amp = 10.0.pow(db / 20)
    for (i in 0 until (durSec * rate).toInt()) signal[start + i] += amp * sin(2 * PI * hz * i / rate)
  }

  /** Feeds the signal in 1024-sample chunks, like AudioPipeline. Returns detected times in seconds. */
  private fun detect(signal: DoubleArray, sensitivity: Double = 0.5): List<Double> {
    val hits = mutableListOf<Double>()
    val detector = ImpactDetector(rate, sensitivity) { pts, _, _, loud -> if (loud) hits.add(pts / 1e6) }
    var offset = 0
    while (offset < signal.size) {
      val n = minOf(1024, signal.size - offset)
      val chunk = ShortArray(n) { (signal[offset + it].coerceIn(-1.0, 1.0) * 32767).toInt().toShort() }
      detector.process(chunk, n, offset * 1_000_000L / rate)
      offset += n
    }
    return hits
  }

  @Test
  fun detectsImpactOverRangeNoiseWithinTwoMilliseconds() {
    val s = noise(3.0, db = -45.0)
    addClick(s, atSec = 2.0, peakDb = -6.0)
    val hits = detect(s)
    assertEquals(1, hits.size)
    assertEquals(2.0, hits[0], 0.002)
  }

  @Test
  fun ignoresLowFrequencyThud() {
    // A neighbour's driver felt through the ground / mat: loud but all low end.
    val s = noise(3.0, db = -45.0)
    addTone(s, atSec = 2.0, durSec = 0.05, hz = 120.0, db = -6.0)
    assertTrue(detect(s).isEmpty())
  }

  @Test
  fun ignoresGradualSwellLikeWindOrVoice() {
    val s = noise(3.0, db = -45.0)
    // 300 ms fade-in of a 3 kHz tone up to -10 dBFS: loud, but no sharp attack.
    val start = (1.5 * rate).toInt()
    val len = (0.3 * rate).toInt()
    for (i in 0 until len) s[start + i] += 10.0.pow(-10.0 / 20) * (i.toDouble() / len) * sin(2 * PI * 3000 * i / rate)
    assertTrue(detect(s).isEmpty())
  }

  @Test
  fun refractoryPeriodSuppressesEchoesButAllowsNextShot() {
    val s = noise(5.0, db = -45.0)
    addClick(s, atSec = 2.0, peakDb = -6.0, seed = 1)
    addClick(s, atSec = 2.4, peakDb = -10.0, seed = 2) // echo / ball landing
    addClick(s, atSec = 4.0, peakDb = -6.0, seed = 3) // next shot
    val hits = detect(s)
    assertEquals(2, hits.size)
    assertEquals(2.0, hits[0], 0.002)
    assertEquals(4.0, hits[1], 0.002)
  }

  @Test
  fun sharpButQuietSoundIsReportedNotTriggered() {
    // A fingertip on the screen: sharp attack, far above a silent room, but not loud.
    val s = noise(3.0, db = -70.0)
    addClick(s, atSec = 2.0, peakDb = -30.0)
    val loud = mutableListOf<Double>()
    val quiet = mutableListOf<Double>()
    val detector = ImpactDetector(rate, 0.5) { pts, _, _, isLoud -> (if (isLoud) loud else quiet).add(pts / 1e6) }
    val pcm = ShortArray(s.size) { (s[it] * 32767).toInt().toShort() }
    detector.process(pcm, pcm.size, 0)
    assertTrue(loud.isEmpty())
    assertEquals(1, quiet.size)
  }

  @Test
  fun quietDistantClickNeedsHigherSensitivity() {
    val s = noise(3.0, db = -45.0)
    // ~17 dB above the floor once spread over a 5 ms hop: between the 15 dB (max) and 30 dB (min) margins.
    addClick(s, atSec = 2.0, peakDb = -16.0)
    assertTrue(detect(s, sensitivity = 0.0).isEmpty())
    assertEquals(1, detect(s, sensitivity = 1.0).size)
  }
}
