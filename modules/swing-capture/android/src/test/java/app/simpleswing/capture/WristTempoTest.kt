package app.simpleswing.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WristTempoTest {
  @Test
  fun parsesTheOldTwoFieldMessage() {
    assertEquals(WristSwingMessage(120, 1500, null), WristSwingMessage.parse("120,1500"))
  }

  @Test
  fun parsesTempoWhenSent() {
    assertEquals(WristSwingMessage(80, 1420, WristTempo(810, 270)), WristSwingMessage.parse("80,1420,810,270"))
  }

  @Test
  fun ignoresBrokenTempo() {
    assertNull(WristSwingMessage.parse("80,1420,810,0")?.tempo)
    assertNull(WristSwingMessage.parse("80,1420,x,270")?.tempo)
    assertNull(WristSwingMessage.parse("nope"))
  }

  @Test
  fun findsTheSwingNearestTheClipAnchor() {
    val log = TempoLog(keep = 3)
    log.add(1_000_000, WristTempo(800, 260))
    log.add(5_000_000, WristTempo(900, 300))
    assertEquals(WristTempo(900, 300), log.near(5_120_000))
    assertNull(log.near(3_000_000))
  }

  @Test
  fun keepsOnlyTheMostRecent() {
    val log = TempoLog(keep = 2)
    log.add(1_000_000, WristTempo(1, 1))
    log.add(2_000_000, WristTempo(2, 2))
    log.add(3_000_000, WristTempo(3, 3))
    assertNull(log.near(1_000_000, withinUs = 100))
  }
}
