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
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
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
 * Pairing: the camera phone shows a 6-digit code (kept between sessions) that the main phone sends in
 * its HELLO. Until a connection proves it knows the code it can't do anything, and it never replaces
 * the live link, so another device on the same Wi-Fi can neither take the camera over nor pull clips.
 * Clip ids become file names, so both sides accept only the `swing_<digits>` form (PeerProtocol).
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
    /** Camera role: the pairing code to type on the main phone. */
    val code: String?,
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
  /** Camera role: connections that haven't sent a valid HELLO yet (capped, each has a reader thread). */
  private val waiting: MutableSet<Connection> = ConcurrentHashMap.newKeySet()
  /** Camera role: after a wrong code, every HELLO is refused until then (elapsedRealtime ms). */
  private var pairingLockedUntilMs = 0L
  /** Makes check-code-then-lock atomic, so parallel connections get one guess per lockout between them. */
  private val pairingLock = Any()
  private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  /** Camera role: this phone's pairing code, made once and kept. */
  private val pairCode: String by lazy {
    prefs.getString(PREF_CODE, null)?.takeIf { it.length == 6 && it.all(Char::isDigit) }
      ?: "%06d".format(SecureRandom().nextInt(1_000_000)).also { prefs.edit().putString(PREF_CODE, it).apply() }
  }

  // Handler-thread state.
  private var server: ServerSocket? = null
  /** [localAddress] answer and when it was looked up (elapsedRealtime ms; 0 = look up again). */
  private var cachedAddress: String? = null
  private var cachedAddressAtMs = 0L
  private var registration: NsdManager.RegistrationListener? = null
  private var discovery: NsdManager.DiscoveryListener? = null
  private val found = LinkedHashMap<String, PeerInfo>()
  private val resolveQueue = ArrayDeque<NsdServiceInfo>()
  private var resolving = false
  /** Main role: where to reconnect after the link drops. */
  private var target: InetSocketAddress? = null
  /** Main role: the pairing code for [target]. */
  @Volatile private var targetCode: String? = null
  private var connecting = false
  /** Main role: the user asked to connect; report if it fails (the 1 s retries stay silent). */
  private var reportConnectFailure = false
  private var lastStatus: Status? = null
  /** Main role: sync uncertainty when each pending trigger was sent, for the angle sidecar (any thread). */
  private val triggerSyncMs = ConcurrentHashMap<String, Double>()
  /** Main role: ids we asked the camera for (→ when, elapsedRealtime ms); any other clip is refused. */
  private val expectedClips = ConcurrentHashMap<String, Long>()

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

  /** Main role: a discovered peer id, or a typed `host[:port]`, with the code the camera phone shows. */
  fun connect(idOrAddress: String, code: String) = handler.post {
    if (role != PeerRole.MAIN) return@post
    val address = found[idOrAddress]?.let { InetSocketAddress.createUnresolved(it.host, it.port) } ?: parseAddress(idOrAddress)
    if (address == null) {
      host.onError("E_PEER_ADDRESS", "That doesn't look like an address: $idOrAddress")
      return@post
    }
    target = address
    targetCode = code.filter(Char::isDigit)
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
    expectedClips[id] = SystemClock.elapsedRealtime()
    c.send { converted }
    return true
  }

  /** Camera role: stream a saved clip to the main phone, then delete it. [width] x [height] is its upright size. */
  fun sendClip(id: String, file: File, fps: Int, durationMs: Double, anchorOffsetMs: Double, width: Int, height: Int) {
    val c = connection
    if (c == null || role != PeerRole.CAMERA) {
      Log.w(TAG, "Clip $id saved but no main phone connected; dropped")
      file.delete()
      return
    }
    sender.execute {
      try {
        val size = file.length()
        c.write(PeerMessage.Clip(id, fps, durationMs, anchorOffsetMs, size, width, height))
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

  /** Camera role: we couldn't save clip [id] after all; the main phone tells the user straight away. */
  fun rejectClip(id: String, reason: String) {
    if (role != PeerRole.CAMERA) return
    connection?.send { PeerMessage.Reject(id, reason) }
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
    // Connections still waiting to pair would otherwise pair after we've stopped being a camera.
    waiting.forEach { it.close("stopped") }
    waiting.clear()
    target = null
    targetCode = null
    stopDiscovery()
    stopServer()
    multicastLock?.release()
    found.clear()
    resolveQueue.clear()
    triggerSyncMs.clear()
    expectedClips.clear()
    role = PeerRole.SOLO
  }

  private fun onTick() {
    val c = connection
    if (c != null && SystemClock.elapsedRealtime() - c.lastHeardMs > SILENCE_TIMEOUT_MS) {
      c.close("no reply for ${SILENCE_TIMEOUT_MS / 1000} s")
    }
    when (role) {
      PeerRole.MAIN -> {
        val stale = SystemClock.elapsedRealtime() - CLIP_WAIT_MS
        expectedClips.entries.removeIf { (id, sentMs) -> (sentMs < stale).also { if (it) triggerSyncMs.remove(id) } }
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

  /** Main role: our connection to the camera phone; we introduce ourselves with its code. */
  private fun adopt(socket: Socket) {
    connection?.close("replaced")
    socket.tcpNoDelay = true
    val c = Connection(socket, paired = true)
    connection = c
    val code = targetCode
    c.send { PeerMessage.Hello(PeerProtocol.VERSION, role.jsName, deviceName(), "android", host.fps(), view, code) }
    c.send { PeerMessage.State(host.engineState().jsName) }
    c.start()
    Log.i(TAG, "Connected to ${socket.remoteSocketAddress} as ${role.jsName}")
    reportStatus()
  }

  /** Camera role: someone connected. They get nothing until their HELLO carries our code. */
  private fun accept(socket: Socket) {
    if (waiting.size >= MAX_UNPAIRED) {
      runCatching { socket.close() }
      return
    }
    val c = try {
      socket.tcpNoDelay = true
      Connection(socket, paired = false)
    } catch (e: IOException) {
      runCatching { socket.close() }
      return
    }
    waiting.add(c)
    c.start()
    handler.postDelayed({ if (!c.paired) c.close("no hello") }, PAIRING_TIMEOUT_MS)
  }

  /** Camera role: [c] proved it knows the code. The newest paired main phone wins (a reconnect). */
  private fun promote(c: Connection) = handler.post {
    if (role != PeerRole.CAMERA || c.isClosed) {
      c.close("not a camera any more")
      return@post
    }
    connection?.close("replaced")
    connection = c
    c.send { PeerMessage.Hello(PeerProtocol.VERSION, role.jsName, deviceName(), "android", host.fps(), view) }
    c.send { PeerMessage.State(host.engineState().jsName) }
    Log.i(TAG, "Paired with main phone ${c.remote}")
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
      code = if (role == PeerRole.CAMERA) pairCode else null,
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
    cachedAddressAtMs = 0L
    thread(name = "SwingPeerAccept") {
      while (!socket.isClosed) {
        val client = try {
          socket.accept()
        } catch (_: IOException) {
          break
        }
        handler.post { if (server === socket) accept(client) else client.close() }
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
    cachedAddressAtMs = 0L
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
        c.incoming?.let { dropIncoming(it) }
        c.incoming = null
        // Only clips we asked for, of a believable size; anything else is read and thrown away.
        if (!PeerProtocol.isValidClipId(m.id) || !expectedClips.containsKey(m.id)) {
          Log.w(TAG, "Ignoring clip ${m.id.take(40)} nobody asked for")
          return
        }
        if (m.size !in 1..PeerProtocol.MAX_CLIP_BYTES) {
          Log.w(TAG, "Ignoring clip ${m.id} of ${m.size} bytes")
          expectedClips.remove(m.id)
          host.onError("E_PEER_CLIP", "The second camera's clip didn't arrive in full.")
          return
        }
        c.incoming = Incoming(m)
      }
      is PeerMessage.Data -> {
        val clip = c.incoming ?: return
        if (!clip.write(m)) {
          c.incoming = null
          expectedClips.remove(clip.meta.id)
          host.onError("E_PEER_CLIP", "The second camera's clip didn't arrive in full.")
        }
      }
      is PeerMessage.Done -> {
        val clip = c.incoming ?: return
        c.incoming = null
        if (clip.meta.id != m.id) {
          dropIncoming(clip)
          return
        }
        expectedClips.remove(m.id)
        if (clip.finish(c.hello, triggerSyncMs.remove(m.id))) host.onAngleReady(m.id)
      }
      else -> Unit
    }
  }

  /** A transfer cut short by a muddled stream: tell the user rather than wait 60 s for nothing. */
  private fun dropIncoming(clip: Incoming) {
    clip.abort()
    expectedClips.remove(clip.meta.id)
    triggerSyncMs.remove(clip.meta.id)
    host.onError("E_PEER_CLIP", "The second camera's clip didn't arrive in full.")
  }

  /** A clip arriving from the camera phone, written to `<id>.b.mp4.part` until complete. */
  private inner class Incoming(val meta: PeerMessage.Clip) {
    private val dir = clipsDir()
    private val part = File(dir, "${meta.id}.b.mp4.part")
    private val out = FileOutputStream(part)
    private var received = 0L

    /** False (and the part file deleted) if the camera sends more than it announced. */
    fun write(data: PeerMessage.Data): Boolean {
      if (received + data.length > meta.size) {
        Log.w(TAG, "Clip ${meta.id} longer than its ${meta.size} bytes")
        abort()
        return false
      }
      out.write(data.bytes, 0, data.length)
      received += data.length
      return true
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
        .put("v", ClipWriter.SIDECAR_VERSION)
        .put("fps", meta.fps)
        .put("durationMs", meta.durationMs)
        .put("anchorOffsetMs", meta.anchorOffsetMs)
        .put("view", hello?.view?.ifEmpty { null } ?: JSONObject.NULL)
        .put("deviceName", hello?.name ?: JSONObject.NULL)
        .put("syncMs", syncMs ?: JSONObject.NULL)
        .put("nudgeMs", 0)
        // 0 (an older camera phone) reads as unknown: the library assumes portrait.
        .put("width", meta.width)
        .put("height", meta.height)
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

  /** [paired]: a main phone's link to its camera, or a camera's link once the main sent the right code. */
  private inner class Connection(private val socket: Socket, paired: Boolean) {
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
    private val closed = AtomicBoolean(false)
    @Volatile var paired = paired
      private set
    val isClosed get() = closed.get()
    val remote: String? get() = socket.remoteSocketAddress?.toString()

    fun start() {
      thread(name = "SwingPeerReader") { readLoop() }
    }

    /** Queues a frame; [build] runs just before writing so timestamps in it are fresh. */
    fun send(build: () -> PeerMessage) {
      if (isClosed) return
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
      if (isClosed) throw IOException("closed")
      PeerProtocol.write(out, m)
    }

    fun close(reason: String) {
      if (!closed.compareAndSet(false, true)) return
      runCatching { socket.close() }
      waiting.remove(this)
      onClosed(this, reason)
    }

    private fun readLoop() {
      try {
        while (!isClosed) {
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

    /** Camera role: the main phone's first message must be a HELLO with our code. */
    private fun pair(m: PeerMessage) {
      if (m !is PeerMessage.Hello || m.role != PeerRole.MAIN.jsName) {
        close("not a main phone")
        return
      }
      if (m.version != PeerProtocol.VERSION) {
        // Answer with our HELLO so the main phone can tell the user to update, then hang up.
        runCatching { write(PeerMessage.Hello(PeerProtocol.VERSION, PeerRole.CAMERA.jsName, deviceName(), "android", 0, view)) }
        host.onError("E_PEER_VERSION", "Update SimpleSwing on both phones to use them together.")
        close("version ${m.version}")
        return
      }
      val refusal = synchronized(pairingLock) {
        val now = SystemClock.elapsedRealtime()
        when {
          now < pairingLockedUntilMs -> "wait"
          !codesMatch(m.code, pairCode) -> "code".also { pairingLockedUntilMs = now + PAIRING_LOCKOUT_MS }
          else -> null
        }
      }
      if (refusal != null) {
        Log.w(TAG, "Refused pairing from $remote: $refusal")
        runCatching { write(PeerMessage.Reject("", refusal)) }
        close("pairing refused")
        return
      }
      // Gone from the waiting set means stop() or the pairing timeout closed us meanwhile.
      if (!waiting.remove(this)) return
      hello = m
      paired = true
      promote(this)
    }

    private fun handle(m: PeerMessage, receivedUs: Long) {
      if (!paired) return pair(m)
      when (m) {
        is PeerMessage.Hello -> {
          if (m.version != PeerProtocol.VERSION) {
            // Retrying every second would only repeat the error until one phone is updated.
            if (role == PeerRole.MAIN) {
              handler.post {
                target = null
                targetCode = null
              }
            }
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
          when {
            !PeerProtocol.isValidClipId(m.id) -> send { PeerMessage.Reject(m.id.take(40), "id") }
            !PeerProtocol.isSaneWindow(m.startUs, m.endUs, receivedUs) -> {
              Log.w(TAG, "Main phone trigger ${m.id} has an impossible window ${m.startUs}..${m.endUs}")
              send { PeerMessage.Reject(m.id, "window") }
            }
            else -> {
              val window = ClipWindow(m.startUs, m.endUs, impactUs = null, anchorUs = m.anchorUs)
              Log.i(TAG, "Main phone trigger ${m.id} (window ends in ${(m.endUs - receivedUs) / 1000} ms)")
              if (!host.onPeerTrigger(m.id, window)) send { PeerMessage.Reject(m.id, "busy") }
            }
          }
        }
        is PeerMessage.Reject -> when {
          role == PeerRole.MAIN && m.id.isEmpty() && m.reason == "code" -> {
            Log.i(TAG, "Camera phone refused our pairing code")
            handler.post {
              target = null
              targetCode = null
            }
            host.onError("E_PEER_CODE", WRONG_CODE_MESSAGE)
            close("wrong code")
          }
          m.id.isEmpty() -> close("pairing refused: ${m.reason}")
          else -> {
            Log.i(TAG, "Camera phone missed ${m.id}: ${m.reason}")
            triggerSyncMs.remove(m.id)
            expectedClips.remove(m.id)
            host.onError("E_PEER_MISSED", "The second camera wasn't ready for that swing.")
          }
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

  /**
   * This phone's Wi-Fi / hotspot address, for typing into the main phone when discovery fails.
   * Enumerating interfaces costs a few ms, and the status is rebuilt every tick, so the answer is
   * kept for [ADDRESS_CACHE_MS] (and dropped when the server restarts).
   */
  private fun localAddress(): String? {
    val now = SystemClock.elapsedRealtime()
    if (cachedAddressAtMs != 0L && now - cachedAddressAtMs < ADDRESS_CACHE_MS) return cachedAddress
    cachedAddress = lookUpLocalAddress()
    cachedAddressAtMs = now
    return cachedAddress
  }

  private fun lookUpLocalAddress(): String? {
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
    private const val PREFS = "simpleswing_peer"
    private const val PREF_CODE = "pairCode"
    private const val TICK_MS = 1_000L
    private const val ADDRESS_CACHE_MS = 10_000L
    private const val PAIRING_TIMEOUT_MS = 5_000L
    /**
     * One wrong code shuts pairing for this long: one guess per 2 s means about 12 days on average
     * to guess a 6-digit code (and only while camera mode stays on).
     */
    private const val PAIRING_LOCKOUT_MS = 2_000L
    private const val MAX_UNPAIRED = 4
    /** How long the main phone waits for an angle it asked for. */
    private const val CLIP_WAIT_MS = 60_000L
    private const val WRONG_CODE_MESSAGE = "That code doesn't match. Check the code on the camera phone's screen."
    private const val SILENCE_TIMEOUT_MS = 6_000L
    private const val CONNECT_TIMEOUT_MS = 3_000
    private const val CONNECT_FAILED_MESSAGE =
      "Couldn't reach the camera phone. Check both phones are on the same Wi-Fi and it shows its camera screen."

    /** Constant-time compare, so response timing says nothing about how close a guess was. */
    fun codesMatch(given: String?, expected: String): Boolean {
      if (given == null || given.length != expected.length) return false
      var diff = 0
      for (i in expected.indices) diff = diff or (given[i].code xor expected[i].code)
      return diff == 0
    }

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
