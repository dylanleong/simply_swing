package app.simpleswing.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ClipWindowsTest {
  private val config = CaptureConfig(
    fps = 120,
    preRollUs = 3_000_000,
    postRollUs = 1_500_000,
    lookbackUs = 6_000_000,
    roi = MotionGate.NormalizedRoi(0.25, 0.1, 0.5, 0.85),
    sensitivity = 0.5,
    sharpMode = true,
    autoTrigger = true,
    impactTrigger = true,
  )

  @Test
  fun impactTriggerCentresClipOnImpact() {
    val w = ClipWindows.forTrigger(TriggerSource.IMPACT, 10_000_000, config)
    assertEquals(7_000_000L, w.startUs)
    assertEquals(11_500_000L, w.endUs)
    assertEquals(10_000_000L, w.impactUs)
    assertEquals(10_000_000L, w.anchorUs)
  }

  @Test
  fun manualTriggersSaveTheLastFewSeconds() {
    for (source in listOf(TriggerSource.MANUAL, TriggerSource.VOLUME_KEY, TriggerSource.WATCH)) {
      val w = ClipWindows.forTrigger(source, 10_000_000, config)
      assertEquals(4_000_000L, w.startUs)
      assertEquals(10_300_000L, w.endUs)
      assertNull(w.impactUs)
      // A second angle still lines up on the button press.
      assertEquals(10_000_000L, w.anchorUs)
    }
  }

  @Test
  fun wristSwingIsCentredLikeAnImpact() {
    val w = ClipWindows.forTrigger(TriggerSource.WRIST, 10_000_000, config)
    assertEquals(7_000_000L, w.startUs)
    assertEquals(10_000_000L, w.impactUs)
  }

  @Test
  fun ringCoversLongestClipPlusMargin() {
    assertEquals(6_300_000L + ClipWindows.RING_MARGIN_US, ClipWindows.ringWindowUs(config))
  }
}
