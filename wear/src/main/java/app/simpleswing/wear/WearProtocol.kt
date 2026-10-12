package app.simpleswing.wear

/** Message paths shared with modules/swing-capture/android/.../WearBridge.kt — keep in sync. */
object WearProtocol {
  const val PATH_HELLO = "/simpleswing/hello"
  const val PATH_TRIGGER = "/simpleswing/trigger"
  const val PATH_STATE = "/simpleswing/state"
  const val PATH_SAVED = "/simpleswing/saved"
  const val PATH_REJECTED = "/simpleswing/rejected"

  /** phone → watch: watch mode, "auto" | "tap" | "off". */
  const val PATH_CONFIG = "/simpleswing/config"
  /** phone → watch → phone: clock round-trip probe; payload echoed unchanged. */
  const val PATH_PING = "/simpleswing/ping"
  const val PATH_PONG = "/simpleswing/pong"
  /** watch → phone: "ageMs,peakDps" — a swing whose peak was ageMs before sending. */
  const val PATH_SWING = "/simpleswing/swing"
  /** watch → phone, every few seconds while sensing: "1". */
  const val PATH_HEARTBEAT = "/simpleswing/heartbeat"

  const val MODE_AUTO = "auto"
  const val MODE_TAP = "tap"
  const val MODE_OFF = "off"
}

/** What the watch knows about the phone. Phone engine states plus watch-only ones. */
enum class PhoneStatus(val label: String) {
  UNKNOWN("Connecting…"),
  NO_PHONE("Phone not connected"),
  IDLE("Open Capture on phone"),
  ARMED("Ready"),
  SAVING("Saving swing…"),
  STANDBY("Phone in standby · tap to wake");

  /** In standby a press wakes the phone rather than saving. */
  val canTrigger get() = this == ARMED || this == STANDBY

  companion object {
    fun fromEngineState(state: String) = when (state) {
      "armed" -> ARMED
      "standby" -> STANDBY
      "triggered", "exporting" -> SAVING
      else -> IDLE
    }
  }
}
