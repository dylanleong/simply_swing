package app.simpleswing.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OrientationTest {
  @Test
  fun `a phone held upright stamps clips portrait`() {
    assertEquals(90, Orientation.clipOrientation(90, 0))
    assertTrue(Orientation.isQuarterTurn(90, 0))
  }

  @Test
  fun `a phone or tablet on its side stamps clips landscape either way round`() {
    assertEquals(0, Orientation.clipOrientation(90, 90))
    assertEquals(180, Orientation.clipOrientation(90, 270))
    assertFalse(Orientation.isQuarterTurn(90, 90))
    assertFalse(Orientation.isQuarterTurn(90, 270))
  }

  @Test
  fun `a landscape-natural tablet is the mirror case`() {
    assertEquals(0, Orientation.clipOrientation(0, 0))
    assertEquals(270, Orientation.clipOrientation(0, 90))
    assertTrue(Orientation.isQuarterTurn(0, 90))
    assertEquals(90, Orientation.clipOrientation(270, 180))
  }

  @Test
  fun `upright size swaps for a quarter turn`() {
    assertEquals(1080 to 1920, Orientation.uprightSize(1920, 1080, 90))
    assertEquals(1080 to 1920, Orientation.uprightSize(1920, 1080, 270))
    assertEquals(1920 to 1080, Orientation.uprightSize(1920, 1080, 0))
    assertEquals(1920 to 1080, Orientation.uprightSize(1920, 1080, 180))
  }
}
