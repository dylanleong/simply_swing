package app.simpleswing.capture

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.concurrent.thread
import org.json.JSONObject

enum class PeerRole(val jsName: String) { SOLO("solo"), MAIN("main"), CAMERA("camera") }

/**
 * Two-phone capture over the local network (same Wi-Fi, or one phone's hotspot). See PeerProtocol for
 * the messages.
 *
 * - **Camera** phone: listens on TCP [PeerProtocol.DEFAULT_PORT], advertises `_simpleswing._tcp` and
 *   saves whatever window the main phone asks for, then streams the clip back.
 * - **Main** phone: discovers camera phones, connects to one, pings it every second to keep a
 *   [ClockSync], and converts each accepted trigger's window to the camera's clock before sending.
 *   Received clips become `<id>.b.mp4` + `<id>.b.json` beside the main clip.
 *
 * Threads: role, discovery and timers run on [handler]; each connection has a blocking reader thread;
 * all writes go through the single [sender] executor so frames never interleave and slow socket writes
 * never block the camera or trigger paths.
 */
class PeerLink(private val context: Context, private val clipsDir: () -> File, private val host: Host) {
  interface Host {
    /** Capture-clock now, µs (the clock frame and trigger times use). */
    fun nowUs(): Long
    fun fps(): Int
    fun engineState(): EngineState
    /** Camera role: save [window] for the main phone as clip [id]. False if not ready. */
    fun onPeerTrigger(id: String, window: ClipWindow): Boolean
    /** Camera role: the main phone's engine state; the camera follows it into and out of standby. */
    fun onMainState(state: String)
    /** Main role: the second angle of [id] is on disk. */
    fun onAngleReady(id: String)
    fun onStatus(status: Status)
    fun onPeersFound(peers: List<PeerInfo>)
    fun onError(code: String, message: String)
  }

  data class Status(
    val role: PeerRole,
    /** idle | searching | advertising | connected */
    val state: String,
    val peerName: String?,
    val peerState: String?,
    val syncMs: Double?,
    val address: String?,
  )

  data class PeerInfo(val id: String, val name: String, val host: String, val port: Int)

  private val handler = Handler(HandlerThread("SwingPeer").apply { start() }.looper)
  private val sender = Executors.newSingleThreadExecutor()
  private val nsd = context.getSystemService(NsdManager::class.java)
  private val multicastLock = context.applicationContext.getSystemService(WifiManager::class.java)
    ?.createMulticastLock("SimpleSwingPeer")
    ?.apply { setReferenceCounted(false) }

  @Volatile var role = PeerRole.SOLO
    private set
  /** Camera role: the angle this phone films, told to the main phone. */
  @Volatile private var view = ""
  @Volatile private var connection: Connection? = null

  // Handler-thread state.
  private var server: ServerSocket? = null
  private var registration: NsdManager.RegistrationListener? = null
  private var discovery: NsdManager.DiscoveryListener? = null
  private val found = LinkedHashMap<String, PeerInfo>()
  private val resolveQueue = ArrayDeque<NsdServiceInfo>()
  private var resolving = false
  /** Main role: where to reconnect after the link drops. */
  private var target: InetSocketAddress? = null
  private var connecting = false
  /** Main role: the user asked to connect; report if it fails (the 1 s retries stay silent). */
  private var reportConnectFailure = false
  private var lastStatus: Status? = null
  /** Main role: sync uncertainty when each pending trigger was sent, for the angle sidecar (any thread). */
  private val triggerSyncMs = ConcurrentHashMap<String, Double>()

  private val tick = object : Runnable {
    override fun run() {
      onTick()
      handler.postDelayed(this, TICK_MS)
    }
  }

  // ---- Public API (any thread) ----

  fun startMain() = handler.post {
    if (role == PeerRole.MAIN) return@post
    stopInternal()
    role = PeerRole.MAIN
    startDiscovery()
    handler.post(tick)
    reportStatus()
  }

  fun startCamera(view: String) = handler.post {
    this.view = view
    if (role == PeerRole.CAMERA) {
      connection?.send { PeerMessage.Hello(PeerProtocol.VERSION, role.jsName, deviceName(), "android", host.fps(), view) }
      return@post
    }
    stopInternal()
    role = PeerRole.CAMERA
    startServer()
    handler.post(tick)
    reportStatus()
  }

  fun stop() = handler.post {
    stopInternal()
    reportStatus()
  }

  /** Main role: a discovered peer id, or a typed `host[:port]`. */
  fun connect(idOrAddress: String) = handler.post {
    if (role != PeerRole.MAIN) return@post
    val address = found[idOrAddress]?.let { InetSocketAddress.createUnresolved(it.host, it.port) } ?: parseAddress(idOrAddress)
    if (address == null) {
      host.onError("E_PEER_ADDRESS", "That doesn't look like an address: $idOrAddress")
      return@post
    }
    target = address
    reportConnectFailure = true
    connection?.close("switching camera")
    connectTo(address)
  }

  /**
   * Main role: ask the camera phone for the same moment. Returns false if there's no synced camera.
   * [window] is on our capture clock; it's sent on the camera's.
   */
  fun sendTrigger(id: String, window: ClipWindow): Boolean {
    val c = connection ?: return false
    if (role != PeerRole.MAIN || c.hello == null) return false
    val converted = synchronized(c.sync) {
      val offset = c.sync.offsetUs ?: return false
      c.sync.errorUs?.let { triggerSyncMs[id] = it / 1000.0 }
      PeerMessage.Trigger(id, window.startUs + offset, window.endUs + offset, window.anchorUs + offset)
    }
    Log.i(TAG, "Trigger $id → camera (window ${converted.startUs}..${converted.endUs})")
    c.send { converted }
    return true
  }

  /** Camera role: stream a saved clip to the main phone, then delete it. */
  fun sendClip(id: String, file: File, fps: Int, durationMs: Double, anchorOffsetMs: Double) {
    val c = connection
    if (c == null || role != PeerRole.CAMERA) {
      Log.w(TAG, "Clip $id saved but no main phone connected; dropped")
      file.delete()
      return
    }
    sender.execute {
      try {
        val size = file.length()
        c.write(PeerMessage.Clip(id, fps, durationMs, anchorOffsetMs, size))
        val buffer = ByteArray(PeerProtocol.CHUNK_BYTES)
        FileInputStream(file).use { input ->
          while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            c.write(PeerMessage.Data(buffer, n))
          }
        }
        c.write(PeerMessage.Done(id))
        Log.i(TAG, "Sent clip $id (${size / 1024} KB)")
      } catch (e: IOException) {
        Log.w(TAG, "Sending clip $id failed", e)
        c.close("send failed")
      } finally {
        file.delete()
      }
    }
  }

  /** Our engine changed state; the other phone shows it (and a camera phone follows the main's). */
  fun onEngineState(state: EngineState) {
    connection?.send { PeerMessage.State(state.jsName) }
  }

  // ---- Handler thread ----

  private fun stopInternal() {
    handler.removeCallbacks(tick)
    connection?.let { c ->
      c.send { PeerMessage.Bye }
      sender.execute { c.close("stopped") }
    }
    connection = null
    target = null
    stopDiscovery()
    stopServer()
    multicastLock?.release()
    found.clear()
    resolveQueue.clear()
    triggerSyncMs.clear()
    role = PeerRole.SOLO
  }

  private fun onTick() {
    val c = connection
    if (c != null && SystemClock.elapsedRealtime() - c.lastHeardMs > SILENCE_TIMEOUT_MS) {
      c.close("no reply for ${SILENCE_TIMEOUT_MS / 1000} s")
    }
    when (role) {
      PeerRole.MAIN -> {
        val live = connection
        if (live != null) {
          val syncUs = synchronized(live.sync) { live.sync.errorUs }
          live.send { PeerMessage.Ping(host.nowUs(), syncUs) }
        } else {
          target?.let(::connectTo)
        }
      }
      else -> Unit
    }
    reportStatus()
  }

  private fun connectTo(address: InetSocketAddress) {
    if (connecting || connection != null) return
    connecting = true
    thread(name = "SwingPeerConnect") {
      try {
        val socket = Socket()
        // Targets are kept unresolved so they compare equal; resolve here, off the handler thread.
        socket.connect(InetSocketAddress(address.hostString, address.port), CONNECT_TIMEOUT_MS)
        handler.post {
          connecting = false
          reportConnectFailure = false
          if (role != PeerRole.MAIN || target != address) {
            socket.close()
            return@post
          }
          adopt(socket)
        }
      } catch (e: IOException) {
        handler.post {
          connecting = false
          if (reportConnectFailure && role == PeerRole.MAIN && target == address) {
            reportConnectFailure = false
            host.onError("E_PEER_CONNECT", CONNECT_FAILED_MESSAGE)
          }
        }
        Log.i(TAG, "Connect to $address failed: ${e.message}")
      }
    }
  }

  private fun adopt(socket: Socket) {
    connection?.close("replaced")
    socket.tcpNoDelay = true
    val c = Connection(socket)
    connection = c
    c.send { PeerMessage.Hello(PeerProtocol.VERSION, role.jsName, deviceName(), "android", host.fps(), view) }
    c.send { PeerMessage.State(host.engineState().jsName) }
    c.start()
    Log.i(TAG, "Connected to ${socket.remoteSocketAddress} as ${role.jsName}")
    reportStatus()
  }

  private fun onClosed(c: Connection, reason: String) = handler.post {
    if (connection !== c) return@post
    connection = null
    Log.i(TAG, "Peer link closed: $reason")
    reportStatus()
  }

  private fun reportStatus() {
    val c = connection
    val connected = c?.hello != null
    val syncUs = c?.let { if (role == PeerRole.MAIN) synchronized(it.sync) { it.sync.errorUs } else it.peerSyncUs }
    val status = Status(
      role = role,
      state = when {
        role == PeerRole.SOLO -> "idle"
        connected -> "connected"
        role == PeerRole.MAIN -> "searching"
        else -> "advertising"
      },
      peerName = if (connected) c?.hello?.name else null,
      peerState = if (connected) c?.peerState else null,
      // Whole-ms resolution keeps the status from changing on every ping.
      syncMs = syncUs?.let { Math.round(it / 1000.0).toDouble().coerceAtLeast(1.0) },
      address = if (role == PeerRole.CAMERA) localAddress() else null,
    )
    if (status != lastStatus) {
      lastStatus = status
      host.onStatus(status)
    }
  }

  // ---- Camera role: server + advertising ----

  private fun startServer() {
    val socket = try {
      ServerSocket(PeerProtocol.DEFAULT_PORT)
    } catch (_: IOException) {
      ServerSocket(0) // Port taken (a second app instance?); discovery still finds us.
    }
    server = socket
    thread(name = "SwingPeerAccept") {
      while (!socket.isClosed) {
        val client = try {
          socket.accept()
        } catch (_: IOException) {
          break
        }
        // The newest main phone wins: a dropped link reconnecting replaces its stale socket.
        handler.post { if (server === socket) adopt(client) else client.close() }
      }
    }
    val info = NsdServiceInfo().apply {
      serviceName = deviceName()
      serviceType = PeerProtocol.SERVICE_TYPE
      port = socket.localPort
    }
    val listener = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(info: NsdServiceInfo) {
        Log.i(TAG, "Advertising as ${info.serviceName}")
      }

      override fun onRegistrationFailed(info: NsdServiceInfo, error: Int) {
        Log.w(TAG, "Advertising failed: $error")
      }

      override fun onServiceUnregistered(info: NsdServiceInfo) = Unit
      override fun onUnregistrationFailed(info: NsdServiceInfo, error: Int) = Unit
    }
    registration = listener
    multicastLock?.acquire()
    nsd?.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
  }

  private fun stopServer() {
    registration?.let { runCatching { nsd?.unregisterService(it) } }
    registration = null
    server?.close()
    server = null
  }

  // ---- Main role: discovery ----

  private fun startDiscovery() {
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) = Unit
      override fun onDiscoveryStopped(serviceType: String) = Unit
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit

      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
        Log.w(TAG, "Discovery failed: $errorCode")
      }

      override fun onServiceFound(info: NsdServiceInfo) {
        handler.post {
          resolveQueue.addLast(info)
          resolveNext()
        }
      }

      override fun onServiceLost(info: NsdServiceInfo) {
        handler.post { if (found.remove(info.serviceName) != null) host.onPeersFound(found.values.toList()) }
      }
    }
    discovery = listener
    multicastLock?.acquire()
    nsd?.discoverServices(PeerProtocol.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
  }

  private fun stopDiscovery() {
    discovery?.let { runCatching { nsd?.stopServiceDiscovery(it) } }
    discovery = null
  }

  /** NsdManager resolves one service at a time. */
  @Suppress("DEPRECATION") // resolveService/host still work; the API 34 replacements need 34+.
  private fun resolveNext() {
    if (resolving || discovery == null) return
    val next = resolveQueue.removeFirstOrNull() ?: return
    resolving = true
    nsd?.resolveService(next, object : NsdManager.ResolveListener {
      override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
        handler.post {
          resolving = false
          resolveNext()
        }
      }

      override fun onServiceResolved(info: NsdServiceInfo) {
        handler.post {
          resolving = false
          val address = info.host?.hostAddress
          if (address != null && role == PeerRole.MAIN) {
            found[info.serviceName] = PeerInfo(info.serviceName, info.serviceName, address, info.port)
            host.onPeersFound(found.values.toList())
          }
          resolveNext()
        }
      }
    })
  }

  // ---- Main role: receiving clips ----

  private fun receive(c: Connection, m: PeerMessage) {
    when (m) {
      is PeerMessage.Clip -> {
        c.incoming?.abort()
        c.incoming = Incoming(m)
      }
      is PeerMessage.Data -> c.incoming?.write(m)
      is PeerMessage.Done -> {
        val clip = c.incoming ?: return
        c.incoming = null
        if (clip.finish(c.hello, triggerSyncMs.remove(m.id))) host.onAngleReady(m.id)
      }
      else -> Unit
    }
  }

  /** A clip arriving from the camera phone, written to `<id>.b.mp4.part` until complete. */
  private inner class Incoming(val meta: PeerMessage.Clip) {
    private val dir = clipsDir()
    private val part = File(dir, "${meta.id}.b.mp4.part")
    private val out = FileOutputStream(part)
    private var received = 0L

    fun write(data: PeerMessage.Data) {
      out.write(data.bytes, 0, data.length)
      received += data.length
    }

    fun abort() {
      runCatching { out.close() }
      part.delete()
    }

    fun finish(hello: PeerMessage.Hello?, syncMs: Double?): Boolean {
      out.close()
      if (received != meta.size) {
        Log.w(TAG, "Clip ${meta.id} incomplete: $received of ${meta.size} bytes")
        part.delete()
        host.onError("E_PEER_CLIP", "The second camera's clip didn't arrive in full.")
        return false
      }
      val json = JSONObject()
        .put("fps", meta.fps)
        .put("durationMs", meta.durationMs)
        .put("anchorOffsetMs", meta.anchorOffsetMs)
        .put("view", hello?.view?.ifEmpty { null } ?: JSONObject.NULL)
        .put("deviceName", hello?.name ?: JSONObject.NULL)
        .put("syncMs", syncMs ?: JSONObject.NULL)
        .put("nudgeMs", 0)
      // Sidecar first: the library only lists an angle once its .b.mp4 exists.
      File(dir, "${meta.id}.b.json").writeText(json.toString())
      if (!part.renameTo(File(dir, "${meta.id}.b.mp4"))) {
        part.delete()
        host.onError("E_PEER_CLIP", "Couldn't save the second camera's clip.")
        return false
      }
      Log.i(TAG, "Received angle ${meta.id} (${received / 1024} KB)")
      return true
    }
  }

  // ---- Connection ----

  private inner class Connection(private val socket: Socket) {
    private val out = DataOutputStream(BufferedOutputStream(socket.getOutputStream(), PeerProtocol.CHUNK_BYTES + 16))
    private val input = DataInputStream(BufferedInputStream(socket.getInputStream(), PeerProtocol.CHUNK_BYTES + 16))
    val sync = ClockSync()
    @Volatile var lastHeardMs = SystemClock.elapsedRealtime()
    @Volatile var hello: PeerMessage.Hello? = null
    @Volatile var peerState: String? = null
    /** Camera role: the main phone's sync uncertainty, from its pings. */
    @Volatile var peerSyncUs: Long? = null
    /** Reader thread only. */
    var incoming: Incoming? = null
    @Volatile private var closed = false

    fun start() {
      thread(name = "SwingPeerReader") { readLoop() }
    }

    /** Queues a frame; [build] runs just before writing so timestamps in it are fresh. */
    fun send(build: () -> PeerMessage) {
      if (closed) return
      sender.execute {
        try {
          write(build())
        } catch (e: IOException) {
          close("write failed: ${e.message}")
        }
      }
    }

    /** Sender thread only. */
    fun write(m: PeerMessage) {
      if (closed) throw IOException("closed")
      PeerProtocol.write(out, m)
    }

    fun close(reason: String) {
      if (closed) return
      closed = true
      runCatching { socket.close() }
      onClosed(this, reason)
    }

    private fun readLoop() {
      try {
        while (!closed) {
          val m = PeerProtocol.read(input) ?: break
          val now = host.nowUs()
          lastHeardMs = SystemClock.elapsedRealtime()
          handle(m, now)
        }
        close("peer closed the link")
      } catch (e: Exception) {
        close("read failed: ${e.message}")
      } finally {
        incoming?.abort()
      }
    }

    private fun handle(m: PeerMessage, receivedUs: Long) {
      when (m) {
        is PeerMessage.Hello -> {
          if (m.version != PeerProtocol.VERSION) {
            host.onError("E_PEER_VERSION", "Update SimpleSwing on both phones to use them together.")
            close("version ${m.version}")
            return
          }
          hello = m
          handler.post(::reportStatus)
        }
        is PeerMessage.Ping -> {
          peerSyncUs = m.syncUs
          send { PeerMessage.Pong(m.t1, receivedUs, host.nowUs()) }
        }
        is PeerMessage.Pong -> synchronized(sync) { sync.add(m.t1, m.t2, m.t3, receivedUs) }
        is PeerMessage.State -> {
          peerState = m.state
          if (role == PeerRole.CAMERA) host.onMainState(m.state)
          handler.post(::reportStatus)
        }
        is PeerMessage.Trigger -> if (role == PeerRole.CAMERA) {
          val window = ClipWindow(m.startUs, m.endUs, impactUs = null, anchorUs = m.anchorUs)
          Log.i(TAG, "Main phone trigger ${m.id} (window ends in ${(m.endUs - receivedUs) / 1000} ms)")
          if (!host.onPeerTrigger(m.id, window)) send { PeerMessage.Reject(m.id, "busy") }
        }
        is PeerMessage.Reject -> {
          Log.i(TAG, "Camera phone missed ${m.id}: ${m.reason}")
          triggerSyncMs.remove(m.id)
          host.onError("E_PEER_MISSED", "The second camera wasn't ready for that swing.")
        }
        is PeerMessage.Bye -> close("peer left")
        is PeerMessage.Clip, is PeerMessage.Data, is PeerMessage.Done -> if (role == PeerRole.MAIN) receive(this, m)
        is PeerMessage.Unknown -> Unit
      }
    }
  }

  // ---- Helpers ----

  private fun deviceName(): String =
    Settings.Global.getString(context.contentResolver, "device_name")?.takeIf { it.isNotBlank() } ?: Build.MODEL

  /** This phone's Wi-Fi / hotspot address, for typing into the main phone when discovery fails. */
  private fun localAddress(): String? {
    val port = server?.localPort ?: return null
    val ip = runCatching {
      NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .sortedBy { if (it.name.startsWith("wlan") || it.name.startsWith("ap") || it.name.startsWith("swlan")) 0 else 1 }
        .flatMap { it.inetAddresses.toList() }
        .firstOrNull { it is Inet4Address && it.isSiteLocalAddress }
        ?.hostAddress
    }.getOrNull() ?: return null
    return if (port == PeerProtocol.DEFAULT_PORT) ip else "$ip:$port"
  }

  companion object {
    private const val TAG = "SwingPeerLink"
    private const val TICK_MS = 1_000L
    private const val SILENCE_TIMEOUT_MS = 6_000L
    private const val CONNECT_TIMEOUT_MS = 3_000
    private const val CONNECT_FAILED_MESSAGE =
      "Couldn't reach the camera phone. Check both phones are on the same Wi-Fi and it shows its camera screen."

    /** `host`, `host:port` or `[v6]:port`; null if it isn't one. */
    fun parseAddress(text: String): InetSocketAddress? {
      val t = text.trim()
      if (t.isEmpty() || t.contains(' ')) return null
      val (hostPart, port) = when {
        t.startsWith("[") -> {
          val end = t.indexOf(']')
          if (end < 0) return null
          t.substring(1, end) to t.substring(end + 1).removePrefix(":").ifEmpty { null }
        }
        t.count { it == ':' } == 1 -> t.substringBefore(':') to t.substringAfter(':')
        else -> t to null
      }
      val portNumber = port?.toIntOrNull() ?: if (port == null) PeerProtocol.DEFAULT_PORT else return null
      if (hostPart.isEmpty() || portNumber !in 1..65535) return null
      return InetSocketAddress.createUnresolved(hostPart, portNumber)
    }
  }
}
