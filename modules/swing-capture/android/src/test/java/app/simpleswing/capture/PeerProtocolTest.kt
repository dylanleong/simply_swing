package app.simpleswing.capture

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PeerProtocolTest {
  private fun roundTrip(vararg messages: PeerMessage): List<PeerMessage?> {
    val bytes = ByteArrayOutputStream()
    DataOutputStream(bytes).use { out -> messages.forEach { PeerProtocol.write(out, it) } }
    val input = DataInputStream(ByteArrayInputStream(bytes.toByteArray()))
    return List(messages.size + 1) { PeerProtocol.read(input) }
  }

  @Test
  fun controlMessagesSurviveTheWire() {
    val sent = listOf(
      PeerMessage.Hello(1, "camera", "Pixel 8", "android", 240, "faceOn"),
      PeerMessage.Ping(123_456_789_012L),
      PeerMessage.Ping(5, syncUs = 800),
      PeerMessage.Pong(1, 2, 3),
      PeerMessage.State("standby"),
      PeerMessage.Trigger("swing_1760270000000", 7_000_000, 11_500_000, 10_000_000),
      PeerMessage.Reject("swing_1", "busy"),
      PeerMessage.Clip("swing_1", 120, 4500.5, 3000.25, 28_000_000),
      PeerMessage.Clip("swing_2", 120, 4500.5, 3000.25, 28_000_000, 1920, 1080),
      PeerMessage.Done("swing_1"),
      PeerMessage.Bye,
    )
    val received = roundTrip(*sent.toTypedArray())
    assertEquals(sent, received.dropLast(1))
    assertNull("clean end of stream", received.last())
  }

  @Test
  fun dataCarriesRawBytes() {
    val chunk = ByteArray(1000) { it.toByte() }
    val received = roundTrip(PeerMessage.Data(chunk, 600)).first() as PeerMessage.Data
    assertArrayEquals(chunk.copyOf(600), received.bytes)
  }

  @Test
  fun unknownTypesFromNewerVersionsAreSkippable() {
    val bytes = ByteArrayOutputStream()
    DataOutputStream(bytes).use { out ->
      out.writeByte(99)
      out.writeInt(2)
      out.write("{}".toByteArray())
    }
    val m = PeerProtocol.read(DataInputStream(ByteArrayInputStream(bytes.toByteArray())))
    assertTrue(m is PeerMessage.Unknown)
  }
}
