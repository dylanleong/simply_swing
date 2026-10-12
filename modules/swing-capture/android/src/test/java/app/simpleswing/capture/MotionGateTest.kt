package app.simpleswing.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class MotionGateTest {
  private val w = 36
  private val h = 64
  private val frameUs = 66_667L // 15 fps
  /** Golfer box: centre half of the frame. */
  private val roi = MotionGate.NormalizedRoi(0.25, 0.1, 0.5, 0.85)

  /** Static scene with sensor noise, plus an optional bright block (the moving club/arms). */
  private fun frame(seed: Int, blockX: Int? = null, blockY: Int = 30): IntArray {
    val r = Random(seed)
    val px = IntArray(w * h) { 100 + r.nextInt(-2, 3) }
    if (blockX != null) {
      for (y in blockY until blockY + 12) for (x in blockX until blockX + 6) px[y * w + x] = 230
    }
    return px
  }

  /** Feeds [seconds] of frames; [blockAt] gives the moving block's x for frame i (null = none). */
  private fun feed(gate: MotionGate, startUs: Long, seconds: Double, blockAt: (Int) -> Int?): Long {
    val n = (seconds * 1_000_000 / frameUs).toInt()
    var t = startUs
    for (i in 0 until n) {
      gate.addFrame(t, frame(seed = i + (startUs / 1000).toInt(), blockX = blockAt(i)), w, h)
      t += frameUs
    }
    return t
  }

  @Test
  fun swingInsideBoxPassesTheGate() {
    val gate = MotionGate(roi)
    var t = feed(gate, 0, 4.0) { null } // golfer at address
    t = feed(gate, t, 1.2) { i -> 10 + (i * 3) % 14 } // swing: block sweeps across the box
    val v = gate.evaluate(impactUs = t)!!
    assertTrue("peak ${v.peak} vs ${v.threshold}", v.passed)
  }

  @Test
  fun stillGolferFailsTheGate() {
    val gate = MotionGate(roi)
    val t = feed(gate, 0, 5.0) { null }
    val v = gate.evaluate(impactUs = t)!!
    assertFalse("peak ${v.peak} vs ${v.threshold}", v.passed)
  }

  @Test
  fun motionOutsideTheBoxIsIgnored() {
    val gate = MotionGate(roi)
    var t = feed(gate, 0, 4.0) { null }
    // Neighbour moving in the left-hand edge of the frame (x 0..5), outside the box (x 9..27).
    t = feed(gate, t, 1.2) { i -> if (i % 2 == 0) 0 else 2 }
    assertFalse(gate.evaluate(impactUs = t)!!.passed)
  }

  @Test
  fun oldSwingDoesNotCountForALaterSound() {
    val gate = MotionGate(roi)
    var t = feed(gate, 0, 3.0) { null }
    t = feed(gate, t, 1.0) { i -> 10 + (i * 3) % 14 }
    t = feed(gate, t, 2.5) { null } // 2.5 s of stillness after the swing
    assertFalse(gate.evaluate(impactUs = t)!!.passed)
  }

  @Test
  fun noVerdictWithoutHistory() {
    val gate = MotionGate(roi)
    gate.addFrame(0, frame(1), w, h)
    assertNull(gate.evaluate(0))
  }

  @Test
  fun latestReportsMostRecentMotion() {
    val gate = MotionGate(roi)
    gate.addFrame(0, frame(1), w, h)
    gate.addFrame(frameUs, frame(1), w, h)
    assertEquals(0.0, gate.latest()!!, 1e-9)
  }
}
