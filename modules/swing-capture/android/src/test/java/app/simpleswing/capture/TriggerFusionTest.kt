package app.simpleswing.capture

import app.simpleswing.capture.TriggerFusion.Decision
import app.simpleswing.capture.TriggerFusion.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TriggerFusionTest {
  private val ms = 1_000L

  @Test
  fun soundAndWristTogetherIsAnImpactAtTheSoundTime() {
    val f = TriggerFusion()
    // Sound detected first; the wrist message arrives 300 ms later describing a peak 40 ms earlier.
    assertTrue(f.onSound(10_000 * ms, nowUs = 10_030 * ms).isEmpty())
    val d = f.onWrist(9_960 * ms, nowUs = 10_300 * ms)
    assertEquals(listOf(Decision(Kind.IMPACT, 10_000 * ms)), d)
    assertEquals(null, f.nextDeadlineUs())
  }

  @Test
  fun wristFirstThenSoundAlsoMatches() {
    val f = TriggerFusion()
    assertTrue(f.onWrist(10_000 * ms, nowUs = 10_200 * ms).isEmpty())
    assertEquals(listOf(Decision(Kind.IMPACT, 10_090 * ms)), f.onSound(10_090 * ms, nowUs = 10_250 * ms))
  }

  @Test
  fun soundWithoutWristIsSomeoneElsesShot() {
    val f = TriggerFusion()
    f.onSound(10_000 * ms, nowUs = 10_030 * ms)
    assertEquals(10_500 * ms, f.nextDeadlineUs())
    assertTrue(f.poll(10_400 * ms).isEmpty())
    assertEquals(listOf(Decision(Kind.NO_WRIST, 10_000 * ms)), f.poll(10_500 * ms))
  }

  @Test
  fun lateWristStillClaimsTheRejectedSound() {
    val f = TriggerFusion()
    f.onSound(10_000 * ms, nowUs = 10_030 * ms)
    f.poll(10_600 * ms) // gave up: NO_WRIST
    assertEquals(listOf(Decision(Kind.IMPACT, 10_000 * ms)), f.onWrist(9_980 * ms, nowUs = 11_200 * ms))
  }

  @Test
  fun wristWithoutSoundIsAPracticeSwingOnlyWhenEnabled() {
    val off = TriggerFusion()
    off.onWrist(10_000 * ms, nowUs = 10_200 * ms)
    assertTrue(off.poll(10_600 * ms).isEmpty())

    val on = TriggerFusion().apply { savePracticeSwings = true }
    on.onWrist(10_000 * ms, nowUs = 10_200 * ms)
    assertEquals(listOf(Decision(Kind.PRACTICE, 10_000 * ms)), on.poll(10_600 * ms))
  }

  @Test
  fun aSwingFarFromTheSoundDoesNotMatch() {
    val f = TriggerFusion()
    f.onSound(10_000 * ms, nowUs = 10_030 * ms)
    assertTrue(f.onWrist(10_400 * ms, nowUs = 10_450 * ms).isEmpty())
    val d = f.poll(11_000 * ms)
    assertTrue(Decision(Kind.NO_WRIST, 10_000 * ms) in d)
  }
}
