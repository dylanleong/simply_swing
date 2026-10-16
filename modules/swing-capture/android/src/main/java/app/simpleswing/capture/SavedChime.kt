package app.simpleswing.capture

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.sin

/**
 * The soft two-note chime that says "got that one" to a golfer standing 3 m from the phone.
 * Synthesised once (no asset); plays as a notification sound, so the ringer switch, notification
 * volume and Do Not Disturb all silence it.
 */
class SavedChime(private val context: Context) {
  private val main = Handler(Looper.getMainLooper())
  private val pcm: ShortArray by lazy { synthesize() }

  /** Length of the chime, for muting the impact detector while the phone's own speaker plays it. */
  val durationUs: Long get() = pcm.size * 1_000_000L / RATE

  /** False if the phone is silenced (or the speaker couldn't be opened). */
  fun play(): Boolean {
    val audio = context.getSystemService(AudioManager::class.java) ?: return false
    if (audio.ringerMode != AudioManager.RINGER_MODE_NORMAL) return false
    return try {
      val track = AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build(),
        )
        .setTransferMode(AudioTrack.MODE_STATIC)
        .setBufferSizeInBytes(pcm.size * 2)
        .build()
      track.write(pcm, 0, pcm.size)
      track.play()
      main.postDelayed({ runCatching { track.release() } }, durationUs / 1000 + 300)
      true
    } catch (e: Exception) {
      Log.w(TAG, "Chime failed", e)
      false
    }
  }

  companion object {
    private const val TAG = "SwingChime"
    private const val RATE = 44_100

    /** E6 then A6, each with a 5 ms attack and an exponential decay; peak about -12 dBFS. */
    fun synthesize(): ShortArray {
      val notes = listOf(1318.5 to 0.09, 1760.0 to 0.16)
      val out = ArrayList<Short>()
      for ((hz, seconds) in notes) {
        val n = (seconds * RATE).toInt()
        for (i in 0 until n) {
          val t = i.toDouble() / RATE
          val envelope = min(1.0, t / 0.005) * exp(-t / (seconds / 3.5))
          // A quiet octave above softens the pure sine into a bell-like tone.
          val wave = sin(2 * PI * hz * t) + 0.25 * sin(4 * PI * hz * t)
          out.add((wave / 1.25 * envelope * 0.25 * Short.MAX_VALUE).toInt().toShort())
        }
      }
      return out.toShortArray()
    }
  }
}
