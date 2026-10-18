package app.simpleswing.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class ClockSyncTest {
  /** Peer clock runs 5 s ahead of ours. */
  private val skew = 5_000_000L

  /** One exchange sent at [t1] with the given one-way delays and peer turnaround. */
  private fun ClockSync.ping(t1: Long, outUs: Long, backUs: Long, turnUs: Long = 100) {
    val t2 = t1 + outUs + skew
    val t3 = t2 + turnUs
    val t4 = t3 - skew + backUs
    add(t1, t2, t3, t4)
  }

  @Test
  fun symmetricDelaysGiveTheExactOffset() {
    val s = ClockSync()
    s.ping(1_000_000, outUs = 2_000, backUs = 2_000)
    assertEquals(skew, s.offsetUs)
    assertEquals(2_000L, s.errorUs)
  }

  @Test
  fun theFastestRoundTripWinsOverJitter() {
    val s = ClockSync()
    // Asymmetric, slow exchanges are off by half their asymmetry.
    s.ping(1_000_000, outUs = 30_000, backUs = 2_000)
    s.ping(2_000_000, outUs = 1_000, backUs = 25_000)
    s.ping(3_000_000, outUs = 1_200, backUs = 1_000) // best: error ≤ 1.1 ms
    s.ping(4_000_000, outUs = 8_000, backUs = 9_000)
    val offset = s.offsetUs!!
    assertEquals(skew + 100, offset) // (1200 − 1000) / 2 asymmetry
    assertEquals(1_100L, s.errorUs)
  }

  @Test
  fun oldSamplesAgeOut() {
    val s = ClockSync(maxSamples = 3)
    s.ping(1_000_000, outUs = 100, backUs = 100) // very good, but will be dropped
    repeat(3) { s.ping(2_000_000L + it * 1_000_000, outUs = 3_000, backUs = 3_000) }
    assertEquals(3_000L, s.errorUs)
  }

  @Test
  fun aClockChangingBaseRestartsTheEstimate() {
    val s = ClockSync()
    s.ping(1_000_000, outUs = 100, backUs = 100)
    // The peer's camera restarted on a clock 3 hours away; its first sample is worse but current.
    val t1 = 2_000_000L
    val jump = 3L * 3600 * 1_000_000
    s.add(t1, t1 + 5_000 + skew + jump, t1 + 5_100 + skew + jump, t1 + 10_100)
    assertEquals(skew + jump, s.offsetUs)
    assertEquals(5_000L, s.errorUs)
  }

  @Test
  fun implausibleExchangesAreIgnored() {
    val s = ClockSync()
    assertFalse(s.add(t1 = 1_000, t2 = 2_000, t3 = 3_000, t4 = 1_500)) // negative round trip
    assertFalse(s.add(t1 = 0, t2 = 0, t3 = 0, t4 = 2_000_000)) // stalled link
    assertNull(s.offsetUs)
  }
}
