package app.simpleswing.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PeerAddressTest {
  private fun parse(text: String) = PeerLink.parseAddress(text)?.let { it.hostString to it.port }

  @Test
  fun typedAddressesDefaultToTheSimpleSwingPort() {
    assertEquals("192.168.1.20" to PeerProtocol.DEFAULT_PORT, parse("192.168.1.20"))
    assertEquals("192.168.1.20" to 5000, parse(" 192.168.1.20:5000 "))
    assertEquals("fe80::1" to 5000, parse("[fe80::1]:5000"))
  }

  @Test
  fun nonsenseIsRejected() {
    assertNull(parse(""))
    assertNull(parse("192.168.1.20:port"))
    assertNull(parse("192.168.1.20:70000"))
    assertNull(parse("two words"))
  }
}
