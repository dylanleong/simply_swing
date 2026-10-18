package app.simpleswing.capture

import org.junit.Assert.assertEquals
import org.junit.Test

class SideBySidePanelsTest {
  private fun fit(aW: Int, aH: Int, bW: Int, bH: Int) =
    SideBySideExporter.Panels.fit(aW, aH, bW, bH).let { listOf(it.panelW, it.panelH, it.outW, it.outH) }

  @Test
  fun `two portrait clips keep the phone layout`() {
    assertEquals(listOf(720, 1280, 1456, 1280), fit(1080, 1920, 1080, 1920))
  }

  @Test
  fun `two landscape clips sit side by side at 720p`() {
    assertEquals(listOf(1280, 720, 2576, 720), fit(1920, 1080, 1920, 1080))
  }

  @Test
  fun `a portrait and a landscape clip share the taller panel, shrunk to the 4K limit`() {
    val (panelW, panelH, outW, _) = fit(1080, 1920, 1920, 1080)
    assertEquals(2032, panelW)
    assertEquals(1136, panelH)
    assert(outW <= 4096) { "frame $outW wider than 4096" }
    assertEquals(0, panelW % 16)
    assertEquals(0, panelH % 16)
  }

  @Test
  fun `an unreadable size counts as portrait`() {
    assertEquals(listOf(720, 1280, 1456, 1280), fit(0, 0, 1080, 1920))
  }
}
