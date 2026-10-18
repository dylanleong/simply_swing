package app.simpleswing.wear

import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.ambient.AmbientLifecycleObserver
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable

/**
 * One-tap remote: tap SAVE after your swing and the phone keeps the last few seconds.
 * Ambient support keeps the app on the wrist between shots instead of returning to the watch face.
 */
class MainActivity : ComponentActivity(), MessageClient.OnMessageReceivedListener {
  private companion object {
    const val KEY_MODE = "watchMode"
  }

  private val messages by lazy { Wearable.getMessageClient(this) }
  private val nodes by lazy { Wearable.getNodeClient(this) }
  private val vibrator by lazy { getSystemService(Vibrator::class.java) }

  private var status by mutableStateOf(PhoneStatus.UNKNOWN)
  private var ambient by mutableStateOf(false)
  private var sensing by mutableStateOf(false)
  private var lastSwingDps by mutableStateOf<Double?>(null)
  private val prefs by lazy { getSharedPreferences("simpleswing", MODE_PRIVATE) }

  /** Watch mode from the phone's Settings; auto = sense swings on the wrist. */
  private var mode: String
    get() = prefs.getString(KEY_MODE, WearProtocol.MODE_AUTO) ?: WearProtocol.MODE_AUTO
    set(value) = prefs.edit().putString(KEY_MODE, value).apply()

  private val ambientObserver = AmbientLifecycleObserver(
    this,
    object : AmbientLifecycleObserver.AmbientLifecycleCallback {
      override fun onEnterAmbient(ambientDetails: AmbientLifecycleObserver.AmbientDetails) {
        ambient = true
      }

      override fun onExitAmbient() {
        ambient = false
        sendToPhone(WearProtocol.PATH_HELLO)
      }

      override fun onUpdateAmbient() = Unit
    },
  )

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    lifecycle.addObserver(ambientObserver)
    setContent { SaveSwingScreen(status, ambient, sensing, lastSwingDps, onSave = ::saveSwing) }
  }

  override fun onResume() {
    super.onResume()
    messages.addListener(this)
    SwingSensorService.listener = { runOnUiThread(::refreshSensing) }
    refreshSensing()
    if (mode == WearProtocol.MODE_AUTO) SwingSensorService.start(this)
    sendToPhone(WearProtocol.PATH_HELLO)
  }

  override fun onPause() {
    messages.removeListener(this)
    SwingSensorService.listener = null
    super.onPause()
  }

  private fun refreshSensing() {
    sensing = SwingSensorService.running
    lastSwingDps = SwingSensorService.lastSwingDps
  }

  override fun onMessageReceived(event: MessageEvent) {
    val payload = String(event.data)
    when (event.path) {
      WearProtocol.PATH_STATE -> status = PhoneStatus.fromEngineState(payload)
      WearProtocol.PATH_SAVED -> buzz(VibrationEffect.createWaveform(longArrayOf(0, 80, 80, 80), -1))
      WearProtocol.PATH_REJECTED -> {
        status = PhoneStatus.fromEngineState(payload)
        buzz(VibrationEffect.createOneShot(400, VibrationEffect.DEFAULT_AMPLITUDE))
      }
      WearProtocol.PATH_CONFIG -> {
        mode = payload
        if (payload == WearProtocol.MODE_AUTO) SwingSensorService.start(this) else SwingSensorService.stop(this)
      }
      // Clock probe: echo straight back so the phone can measure the round trip.
      WearProtocol.PATH_PING -> messages.sendMessage(event.sourceNodeId, WearProtocol.PATH_PONG, event.data)
    }
  }

  private fun saveSwing() {
    buzz(VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK))
    sendToPhone(WearProtocol.PATH_TRIGGER)
  }

  /** Hello carries the protocol version so the phone can tell an old watch app from a new one. */
  private fun sendToPhone(path: String) {
    val payload = if (path == WearProtocol.PATH_HELLO) WearProtocol.VERSION.toString().toByteArray() else ByteArray(0)
    nodes.connectedNodes
      .addOnSuccessListener { phones ->
        if (phones.isEmpty()) {
          status = PhoneStatus.NO_PHONE
        } else {
          phones.forEach { messages.sendMessage(it.id, path, payload) }
        }
      }
      .addOnFailureListener { status = PhoneStatus.NO_PHONE }
  }

  private fun buzz(effect: VibrationEffect) {
    vibrator?.vibrate(effect)
  }
}

@Composable
private fun SaveSwingScreen(
  status: PhoneStatus,
  ambient: Boolean,
  sensing: Boolean,
  lastSwingDps: Double?,
  onSave: () -> Unit,
) {
  MaterialTheme {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
      Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.padding(16.dp),
      ) {
        if (ambient) {
          // Low-power mode: no fills, just enough to show the app is still here.
          Text("SimpleSwing", color = Color.Gray, fontSize = 14.sp)
          Text("Tap to wake", color = Color.Gray, fontSize = 12.sp)
        } else {
          Button(
            onClick = onSave,
            enabled = status.canTrigger,
            colors = ButtonDefaults.primaryButtonColors(backgroundColor = Color(0xFF3DCB7A)),
            modifier = Modifier.size(104.dp),
          ) {
            Text("SAVE", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = Color.Black)
          }
          Text(status.label, textAlign = TextAlign.Center, fontSize = 14.sp)
          if (sensing) {
            Text(
              lastSwingDps?.let { "Watching swings · last ${it.toInt()}°/s" } ?: "Watching for swings",
              textAlign = TextAlign.Center,
              fontSize = 12.sp,
              color = Color(0xFF3DCB7A),
            )
          }
        }
      }
    }
  }
}
