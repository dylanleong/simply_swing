package app.simpleswing.capture

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable

/**
 * Wear OS Data Layer link to the SimpleSwing watch app (wear/). Same applicationId and signing
 * key on both sides is what lets Google Play services route these messages.
 *
 * Protocol (keep in sync with wear/src/main/java/app/simpleswing/wear/WearProtocol.kt):
 *   watch → phone  /simpleswing/hello    ask for current state
 *   watch → phone  /simpleswing/trigger  save the last swing
 *   phone → watch  /simpleswing/state    payload: engine state name
 *   phone → watch  /simpleswing/saved    clip written
 *   phone → watch  /simpleswing/rejected trigger ignored (not armed, cooldown, quota)
 */
class WearBridge(
  context: Context,
  private val currentState: () -> EngineState,
  private val onTrigger: () -> Boolean,
) : MessageClient.OnMessageReceivedListener {
  private val messages = Wearable.getMessageClient(context)
  private val nodes = Wearable.getNodeClient(context)

  fun start() {
    messages.addListener(this).addOnFailureListener { Log.i(TAG, "Wear Data Layer unavailable: ${it.message}") }
  }

  override fun onMessageReceived(event: MessageEvent) {
    when (event.path) {
      PATH_HELLO -> send(event.sourceNodeId, PATH_STATE, currentState().jsName)
      PATH_TRIGGER -> if (!onTrigger()) send(event.sourceNodeId, PATH_REJECTED, currentState().jsName)
    }
  }

  fun broadcastState(state: EngineState) = broadcast(PATH_STATE, state.jsName)

  fun broadcastSaved() = broadcast(PATH_SAVED, "")

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
    const val PATH_HELLO = "/simpleswing/hello"
    const val PATH_TRIGGER = "/simpleswing/trigger"
    const val PATH_STATE = "/simpleswing/state"
    const val PATH_SAVED = "/simpleswing/saved"
    const val PATH_REJECTED = "/simpleswing/rejected"
  }
}
