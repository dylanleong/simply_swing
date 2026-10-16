package app.simpleswing.wear

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable

/**
 * Reads the wrist gyroscope while a range session is on, even with the watch screen off, and tells
 * the phone about each swing. Runs as a "health" foreground service with a partial wake lock (the
 * same allowance workout apps use); it stops itself once the phone has left Capture for a while,
 * or when the phone switches the watch to tap-only / off.
 */
class SwingSensorService : Service(), SensorEventListener, MessageClient.OnMessageReceivedListener {
  private val sensorThread = HandlerThread("SwingSensors").apply { start() }
  private val handler = Handler(sensorThread.looper)
  private val messages by lazy { Wearable.getMessageClient(this) }
  private val nodes by lazy { Wearable.getNodeClient(this) }
  private var wakeLock: PowerManager.WakeLock? = null
  private var phoneIdleSinceMs = 0L
  /** Last message of any kind from the phone (it pings every few seconds while Capture runs). */
  @Volatile private var lastPhoneMs = SystemClock.elapsedRealtime()

  private val detector = SwingDetector { swing ->
    val ageMs = (SystemClock.elapsedRealtimeNanos() - swing.peakTimeNs) / 1_000_000
    val backswingMs = swing.backswingNs?.div(1_000_000)
    val downswingMs = swing.downswingNs?.div(1_000_000)
    Log.i(
      TAG,
      "Swing peak %.0f°/s, %d ms ago, backswing %s ms, downswing %s ms".format(swing.peakDps, ageMs, backswingMs, downswingMs),
    )
    lastSwingDps = swing.peakDps
    listener?.invoke()
    // Tempo fields are only sent when both are known; older phones ignore extra fields.
    val tempo = if (backswingMs != null && downswingMs != null) ",$backswingMs,$downswingMs" else ""
    sendToPhone(WearProtocol.PATH_SWING, "$ageMs,${swing.peakDps.toInt()}$tempo")
  }

  private val heartbeat = object : Runnable {
    override fun run() {
      sendToPhone(WearProtocol.PATH_HEARTBEAT, "1")
      val idleFor = if (phoneIdleSinceMs == 0L) 0L else SystemClock.elapsedRealtime() - phoneIdleSinceMs
      if (idleFor > PHONE_IDLE_STOP_MS) {
        Log.i(TAG, "Phone left Capture ${idleFor / 1000} s ago; stopping")
        stopSelf()
        return
      }
      // The phone app was killed, went out of range or never opened: it can't send "idle", so
      // don't keep the gyroscope and the notification going for hours.
      val silentFor = SystemClock.elapsedRealtime() - lastPhoneMs
      if (silentFor > PHONE_IDLE_STOP_MS) {
        Log.i(TAG, "Nothing from the phone for ${silentFor / 1000} s; stopping")
        stopSelf()
        return
      }
      handler.postDelayed(this, HEARTBEAT_MS)
    }
  }

  override fun onCreate() {
    super.onCreate()
    startInForeground()
    running = true
    listener?.invoke()
    wakeLock = getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SimpleSwing:swing-sensing")
      .apply { acquire(MAX_SESSION_MS) }
    val sensors = getSystemService(SensorManager::class.java)
    val gyro = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    if (gyro == null) {
      Log.w(TAG, "No gyroscope")
      stopSelf()
      return
    }
    sensors.registerListener(this, gyro, SAMPLE_PERIOD_US, handler)
    messages.addListener(this)
    handler.post(heartbeat)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

  override fun onDestroy() {
    getSystemService(SensorManager::class.java).unregisterListener(this)
    messages.removeListener(this)
    handler.removeCallbacksAndMessages(null)
    sensorThread.quitSafely()
    wakeLock?.let { if (it.isHeld) it.release() }
    running = false
    listener?.invoke()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onSensorChanged(event: SensorEvent) {
    detector.onSample(event.timestamp, event.values[0], event.values[1], event.values[2])
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  override fun onMessageReceived(event: MessageEvent) {
    val payload = String(event.data)
    lastPhoneMs = SystemClock.elapsedRealtime()
    when (event.path) {
      WearProtocol.PATH_STATE ->
        phoneIdleSinceMs = if (payload == "idle") {
          if (phoneIdleSinceMs == 0L) SystemClock.elapsedRealtime() else phoneIdleSinceMs
        } else {
          0L
        }
      WearProtocol.PATH_CONFIG -> if (payload != WearProtocol.MODE_AUTO) stopSelf()
      WearProtocol.PATH_PING -> messages.sendMessage(event.sourceNodeId, WearProtocol.PATH_PONG, event.data)
      // Mid-session the watch screen is usually off, so the open watch screen can't buzz "saved".
      WearProtocol.PATH_SAVED -> if (listener == null) {
        getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 80, 80, 80), -1))
      }
    }
  }

  private fun sendToPhone(path: String, payload: String) {
    nodes.connectedNodes.addOnSuccessListener { phones ->
      phones.forEach { messages.sendMessage(it.id, path, payload.toByteArray()) }
    }
  }

  private fun startInForeground() {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Swing sensing", NotificationManager.IMPORTANCE_LOW)
    )
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("SimpleSwing")
      .setContentText("Watching for your swings")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentIntent(open)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  companion object {
    private const val TAG = "SwingSensorService"
    private const val CHANNEL_ID = "swing-sensing"
    private const val NOTIFICATION_ID = 1
    /** 100 Hz: plenty for a ~0.25 s downswing, and under the 200 Hz high-rate permission limit. */
    private const val SAMPLE_PERIOD_US = 10_000
    private const val HEARTBEAT_MS = 5_000L
    /** Stop sensing once the phone has been off the Capture screen this long. */
    private const val PHONE_IDLE_STOP_MS = 2 * 60_000L
    /** Hard cap on the wake lock, in case nothing else stops the session. */
    private const val MAX_SESSION_MS = 3 * 60 * 60_000L

    @Volatile var running = false
      private set
    @Volatile var lastSwingDps: Double? = null
      private set
    /** The open watch screen listens for status changes. */
    @Volatile var listener: (() -> Unit)? = null

    fun start(context: Context) {
      context.startForegroundService(Intent(context, SwingSensorService::class.java))
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, SwingSensorService::class.java))
    }
  }
}
