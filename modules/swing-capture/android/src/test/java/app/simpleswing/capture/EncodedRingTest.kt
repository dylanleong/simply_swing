package app.simpleswing.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EncodedRingTest {
  /** 100 fps video with a keyframe every 50 frames (0.5 s). */
  private fun frame(i: Int) = EncodedSample(ByteArray(1), i * 10_000L, i % 50 == 0)

  @Test
  fun prunesWholeGopsAndAlwaysStartsOnKeyframe() {
    val ring = EncodedRing(windowUs = 1_000_000)
    for (i in 0 until 400) ring.add(frame(i)) // 4 s of video
    // Newest is 3.99 s; cutoff 2.99 s; last keyframe at or before it is 2.5 s.
    assertEquals(2_500_000L, ring.oldestPtsUs())
    assertEquals(150, ring.size())
  }

  @Test
  fun snapshotStartsAtKeyframeBeforeWindowAndEndsAtWindowEnd() {
    val ring = EncodedRing(windowUs = 10_000_000)
    for (i in 0 until 400) ring.add(frame(i))
    val clip = ring.snapshot(fromUs = 1_230_000, toUs = 2_000_000)
    assertTrue(clip.first().isKeyFrame)
    assertEquals(1_000_000L, clip.first().ptsUs)
    assertEquals(2_000_000L, clip.last().ptsUs)
  }

  @Test
  fun snapshotFallsBackToOldestKeyframeWhenWindowPredatesBuffer() {
    val ring = EncodedRing(windowUs = 1_000_000)
    for (i in 0 until 400) ring.add(frame(i))
    val clip = ring.snapshot(fromUs = 0, toUs = 3_000_000)
    assertEquals(2_500_000L, clip.first().ptsUs)
  }

  @Test
  fun emptyRingGivesEmptySnapshot() {
    assertTrue(EncodedRing(1_000_000).snapshot(0, 1_000_000).isEmpty())
  }
}
