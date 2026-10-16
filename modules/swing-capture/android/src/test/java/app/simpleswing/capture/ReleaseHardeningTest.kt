package app.simpleswing.capture

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Pairing, the checks on what the other phone sends, atomic clip files and the clock-base fix. */
class ReleaseHardeningTest {
  @Test
  fun clipIdsAreOnlyTheFormTheMainPhoneMakes() {
    assertTrue(PeerProtocol.isValidClipId("swing_1760270000000"))
    assertFalse(PeerProtocol.isValidClipId("../../files/swings/swing_1"))
    assertFalse(PeerProtocol.isValidClipId("swing_1/../x"))
    assertFalse(PeerProtocol.isValidClipId("swing_"))
    assertFalse(PeerProtocol.isValidClipId("swing_12345678901234567"))
    assertFalse(PeerProtocol.isValidClipId("swing_1\n"))
    assertFalse(PeerProtocol.isValidClipId(""))
  }

  @Test
  fun triggerWindowsMustBeSaveable() {
    val now = 50_000_000_000L
    assertTrue(PeerProtocol.isSaneWindow(now - 3_000_000, now + 1_500_000, now))
    assertTrue("a SAVE press looks back", PeerProtocol.isSaneWindow(now - 6_000_000, now, now))
    assertFalse("backwards", PeerProtocol.isSaneWindow(now, now - 1, now))
    assertFalse("far future end", PeerProtocol.isSaneWindow(now, now + 3_600_000_000, now))
    assertFalse("too long", PeerProtocol.isSaneWindow(now - 100_000_000, now, now))
    assertFalse("long gone", PeerProtocol.isSaneWindow(now - 300_000_000, now - 299_000_000, now))
    assertFalse("overflow bait", PeerProtocol.isSaneWindow(Long.MIN_VALUE, Long.MAX_VALUE, now))
    assertFalse("overflow bait", PeerProtocol.isSaneWindow(Long.MAX_VALUE - 1, Long.MAX_VALUE, now))
  }

  @Test
  fun helloCarriesThePairingCode() {
    val bytes = ByteArrayOutputStream()
    DataOutputStream(bytes).use {
      PeerProtocol.write(it, PeerMessage.Hello(PeerProtocol.VERSION, "main", "Pixel", "android", 120, "", "042917"))
      PeerProtocol.write(it, PeerMessage.Hello(PeerProtocol.VERSION, "camera", "OnePlus", "android", 120, "dtl"))
    }
    val input = DataInputStream(ByteArrayInputStream(bytes.toByteArray()))
    assertEquals("042917", (PeerProtocol.read(input) as PeerMessage.Hello).code)
    assertNull((PeerProtocol.read(input) as PeerMessage.Hello).code)
  }

  @Test
  fun codesMatchExactly() {
    assertTrue(PeerLink.codesMatch("042917", "042917"))
    assertFalse(PeerLink.codesMatch("42917", "042917"))
    assertFalse(PeerLink.codesMatch("042918", "042917"))
    assertFalse(PeerLink.codesMatch(null, "042917"))
    assertFalse(PeerLink.codesMatch("0429170", "042917"))
  }

  @Test
  fun atomicWritesLeaveNothingHalfDone() {
    val dir = Files.createTempDirectory("clips").toFile()
    val clip = File(dir, "swing_1.mp4")
    ClipWriter.atomically(clip) { it.writeText("whole clip") }
    assertEquals("whole clip", clip.readText())
    assertFalse(File(dir, "swing_1.mp4.part").exists())

    val broken = File(dir, "swing_2.mp4")
    try {
      ClipWriter.atomically(broken) {
        it.writeText("half")
        throw IOException("No space left on device")
      }
      fail("should rethrow")
    } catch (_: IOException) {
    }
    assertFalse(broken.exists())
    assertEquals(listOf("swing_1.mp4"), dir.list()!!.toList())
    dir.deleteRecursively()
  }

  @Test
  fun videoOffsetMapsAForeignClockBase() {
    val boot = 1_000_000_000_000L // 11.6 days of uptime
    val mono = boot - 1_166_400_000_000L / 1000 // suspended for a while: monotonic lags boottime
    // Encoder stamps on the declared clock (OnePlus): no shift.
    assertEquals(0L, VideoClockOffset.measure(boot - 80_000, boot, boot, mono))
    // HONOR: declares REALTIME (boottime) but stamps CLOCK_MONOTONIC; shift by the exact clock gap.
    assertEquals(boot - mono, VideoClockOffset.measure(mono - 80_000, boot, boot, mono))
    // Anything else: the measured gap.
    assertEquals(boot - 5_000_000_000L, VideoClockOffset.measure(5_000_000_000L, boot, boot, mono))
  }

  @Test
  fun chimeIsShortAndNotHarsh() {
    val pcm = SavedChime.synthesize()
    val seconds = pcm.size / 44_100.0
    assertTrue("length $seconds", seconds in 0.2..0.3)
    val peak = pcm.maxOf { kotlin.math.abs(it.toInt()) }.toDouble() / Short.MAX_VALUE
    assertTrue("peak $peak", peak in 0.15..0.3)
    // Fades out: the last 10 ms are near silence, so it never ends in a click.
    val tail = pcm.takeLast(441).maxOf { kotlin.math.abs(it.toInt()) }.toDouble() / Short.MAX_VALUE
    assertTrue("tail $tail", tail < 0.02)
  }
}
