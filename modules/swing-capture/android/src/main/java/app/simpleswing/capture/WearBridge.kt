package app.simpleswing.capture

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable

/**
 * Wear OS Data Layer link to the SimpleSwing watch app (wear/). Same applicationId and signing
 * key on both sides is what lets Google Play services route these messages.
 *
 * Protocol (keep in sync with wear/src/main/java/app/simpleswing/wear/WearProtocol.kt):
 *   watch → phone  /simpleswing/hello      "1": protocol version (empty from older watch apps = 0);
 *                                          asks for current state (+ we resend the config)
 *   watch → phone  /simpleswing/trigger    tap-to-save
 *   watch → phone  /simpleswing/swing      "ageMs,peakDps[,backswingMs,downswingMs]": wrist swing
 *                                          that peaked ageMs ago, with its tempo when measured
 *   watch → phone  /simpleswing/heartbeat  sensing is running (every ~5 s)
 *   watch → phone  /simpleswing/pong       echo of a ping (clock round trip)
 *   phone → watch  /simpleswing/state      engine state name
 *   phone → watch  /simpleswing/saved      clip written
 *   phone → watch  /simpleswing/rejected   trigger ignored (not armed, cooldown, quota)
 *   phone → watch  /simpleswing/config     watch mode: auto | tap | off
 *   phone → watch  /simpleswing/ping       elapsedRealtimeNanos as text
 */
class WearBridge(
  context: Context,
  private val currentState: () -> EngineState,
  private val onTrigger: () -> Boolean,
  /** Wrist swing that peaked [ageMs] + one-way latency before now, with its tempo if measured. */
  private val onWristSwing: (ageMs: Long, oneWayMs: Long, peakDps: Int, tempo: WristTempo?) -> Unit,
  private val onStatus: (connected: Boolean, sensing: Boolean) -> Unit,
) : MessageClient.OnMessageReceivedListener {
  private val messages = Wearable.getMessageClient(context)
  private val nodes = Wearable.getNodeClient(context)
  private val handler = Handler(Looper.getMainLooper())

  @Volatile private var mode = MODE_AUTO
  /** Protocol version the watch app announced in its last hello; -1 until one arrives. */
  @Volatile var watchVersion = -1
    private set
  @Volatile private var lastHeardMs = 0L
  @Volatile private var lastHeartbeatMs = 0L
  private val recentRttMs = ArrayDeque<Long>()
  private var active = false
  private var lastStatus: Pair<Boolean, Boolean>? = null

  /** Half the best recent round trip: the delay for a watch message to reach us. */
  val oneWayMs: Long
    get() = synchronized(recentRttMs) { (recentRttMs.minOrNull() ?: DEFAULT_RTT_MS) / 2 }

  /** The watch is reachable and reporting heartbeats from its swing sensor. */
  val isSensing: Boolean
    get() = SystemClock.elapsedRealtime() - lastHeartbeatMs < SENSING_TIMEOUT_MS

  private val tick = object : Runnable {
    override fun run() {
      broadcast(PATH_PING, SystemClock.elapsedRealtimeNanos().toString())
      reportStatus()
      handler.postDelayed(this, TICK_MS)
    }
  }

  fun start() {
    messages.addListener(this).addOnFailureListener { Log.i(TAG, "Wear Data Layer unavailable: ${it.message}") }
  }

  /** Ping and track the watch while Capture is running. */
  fun setActive(on: Boolean) = handler.post {
    if (active == on) return@post
    active = on
    handler.removeCallbacks(tick)
    if (on) handler.post(tick)
  }

  fun setMode(watchMode: String) {
    mode = watchMode
    broadcast(PATH_CONFIG, watchMode)
  }

  override fun onMessageReceived(event: MessageEvent) {
    val now = SystemClock.elapsedRealtime()
    lastHeardMs = now
    val payload = String(event.data)
    when (event.path) {
      PATH_HELLO -> {
        watchVersion = parseVersion(payload)
        if (watchVersion < PROTOCOL_VERSION) Log.w(TAG, "Watch app speaks protocol v$watchVersion, phone v$PROTOCOL_VERSION: update the watch app")
        send(event.sourceNodeId, PATH_STATE, currentState().jsName)
        send(event.sourceNodeId, PATH_CONFIG, mode)
      }
      PATH_TRIGGER -> if (mode == MODE_OFF || !onTrigger()) send(event.sourceNodeId, PATH_REJECTED, currentState().jsName)
      PATH_HEARTBEAT -> lastHeartbeatMs = now
      PATH_PONG -> payload.toLongOrNull()?.let { sentNs ->
        val rtt = (SystemClock.elapsedRealtimeNanos() - sentNs) / 1_000_000
        if (rtt in 0..MAX_RTT_MS) {
          synchronized(recentRttMs) {
            recentRttMs.addLast(rtt)
            while (recentRttMs.size > 8) recentRttMs.removeFirst()
          }
        }
      }
      PATH_SWING -> {
        lastHeartbeatMs = now
        val swing = WristSwingMessage.parse(payload) ?: return
        if (mode == MODE_AUTO) onWristSwing(swing.ageMs, oneWayMs, swing.peakDps, swing.tempo)
      }
    }
    handler.post(::reportStatus)
  }

  fun broadcastState(state: EngineState) = broadcast(PATH_STATE, state.jsName)

  fun broadcastSaved() = broadcast(PATH_SAVED, "")

  private fun reportStatus() {
    val connected = SystemClock.elapsedRealtime() - lastHeardMs < CONNECTED_TIMEOUT_MS
    val status = connected to (connected && isSensing && mode == MODE_AUTO)
    if (status != lastStatus) {
      lastStatus = status
      onStatus(status.first, status.second)
    }
  }

  private fun broadcast(path: String, payload: String) {
    nodes.connectedNodes
      .addOnSuccessListener { list -> list.forEach { send(it.id, path, payload) } }
      .addOnFailureListener { /* No Play services / no watch: nothing to tell. */ }
  }

  private fun send(nodeId: String, path: String, payload: String) {
    messages.sendMessage(nodeId, path, payload.toByteArray())
  }

  companion object {
    private const val TAG = "SwingWearBridge"
    /** What this phone speaks; the watch sends its own as the hello payload (WearProtocol.VERSION). */
    const val PROTOCOL_VERSION = 1

    /** The hello payload as a version: empty or unparsable (watch apps before versioning) is 0. */
    fun parseVersion(payload: String): Int = payload.trim().toIntOrNull()?.coerceAtLeast(0) ?: 0

    const val PATH_HELLO = "/simpleswing/hello"
    const val PATH_TRIGGER = "/simpleswing/trigger"
    const val PATH_STATE = "/simpleswing/state"
    const val PATH_SAVED = "/simpleswing/saved"
    const val PATH_REJECTED = "/simpleswing/rejected"
    const val PATH_CONFIG = "/simpleswing/config"
    const val PATH_PING = "/simpleswing/ping"
    const val PATH_PONG = "/simpleswing/pong"
    const val PATH_SWING = "/simpleswing/swing"
    const val PATH_HEARTBEAT = "/simpleswing/heartbeat"

    const val MODE_AUTO = "auto"
    const val MODE_TAP = "tap"
    const val MODE_OFF = "off"

    private const val TICK_MS = 5_000L
    private const val CONNECTED_TIMEOUT_MS = 15_000L
    private const val SENSING_TIMEOUT_MS = 15_000L
    private const val DEFAULT_RTT_MS = 80L
    private const val MAX_RTT_MS = 2_000L
  }
}
