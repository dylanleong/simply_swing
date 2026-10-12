package app.simpleswing.capture

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import java.nio.ByteOrder

/**
 * Microphone capture on its own thread. PCM is AAC-encoded into the audio ring and handed to the
 * impact detector. PTS are mapped onto the camera clock via AudioRecord timestamps.
 */
class AudioPipeline(
  private val clock: CaptureClock,
  private val onSample: (EncodedSample) -> Unit,
  private val onFormat: (MediaFormat) -> Unit,
  private val onError: (Throwable) -> Unit,
  /** Raw PCM for the impact detector: (samples, count, ptsUs of samples[0]). Audio thread. */
  private val onPcm: (ShortArray, Int, Long) -> Unit,
) {
  @Volatile private var running = false
  private var thread: Thread? = null

  fun start() {
    running = true
    thread = Thread(::run, "SwingAudio").apply {
      priority = Thread.MAX_PRIORITY
      start()
    }
  }

  fun stop() {
    running = false
    thread?.join(1000)
    thread = null
  }

  @SuppressLint("MissingPermission") // Checked by the engine before starting.
  private fun run() {
    var record: AudioRecord? = null
    var encoder: MediaCodec? = null
    try {
      val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      record = AudioRecord(
        MediaRecorder.AudioSource.CAMCORDER,
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        maxOf(minBuf, FRAMES_PER_READ * 2) * 4,
      )
      if (record.state != AudioRecord.STATE_INITIALIZED) {
        throw CaptureException("E_AUDIO", "Microphone unavailable")
      }
      encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply {
        configure(
          MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, FRAMES_PER_READ * 2)
          },
          null,
          null,
          MediaCodec.CONFIGURE_FLAG_ENCODE,
        )
        start()
      }
      record.startRecording()

      val pcm = ShortArray(FRAMES_PER_READ)
      val ts = AudioTimestamp()
      val info = MediaCodec.BufferInfo()
      var framesRead = 0L
      var lastPtsUs = Long.MIN_VALUE
      while (running) {
        val n = record.read(pcm, 0, pcm.size)
        if (n <= 0) continue
        val ptsNs = if (record.getTimestamp(ts, clock.audioTimebase) == AudioRecord.SUCCESS) {
          ts.nanoTime + (framesRead - ts.framePosition) * 1_000_000_000L / SAMPLE_RATE
        } else {
          clock.nowNs() - n * 1_000_000_000L / SAMPLE_RATE
        }
        framesRead += n
        // AAC and the muxer need strictly increasing timestamps; timestamp jitter must not reorder.
        val ptsUs = maxOf(ptsNs / 1000, lastPtsUs + 1)
        lastPtsUs = ptsUs
        onPcm(pcm, n, ptsUs)

        val inIndex = encoder.dequeueInputBuffer(10_000)
        if (inIndex >= 0) {
          val input = encoder.getInputBuffer(inIndex)!!
          input.clear()
          input.order(ByteOrder.nativeOrder()).asShortBuffer().put(pcm, 0, n)
          encoder.queueInputBuffer(inIndex, 0, n * 2, ptsUs, 0)
        }
        drain(encoder, info)
      }
    } catch (e: Throwable) {
      if (running) onError(e)
    } finally {
      try {
        record?.stop()
      } catch (_: IllegalStateException) {
      }
      record?.release()
      try {
        encoder?.stop()
      } catch (_: IllegalStateException) {
      }
      encoder?.release()
    }
  }

  private fun drain(encoder: MediaCodec, info: MediaCodec.BufferInfo) {
    while (true) {
      val outIndex = encoder.dequeueOutputBuffer(info, 0)
      when {
        outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> onFormat(encoder.outputFormat)
        outIndex >= 0 -> {
          val out = encoder.getOutputBuffer(outIndex)
          if (out != null && info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
            val bytes = ByteArray(info.size)
            out.position(info.offset)
            out.get(bytes)
            onSample(EncodedSample(bytes, info.presentationTimeUs, true))
          }
          encoder.releaseOutputBuffer(outIndex, false)
        }
        else -> return
      }
    }
  }

  companion object {
    const val SAMPLE_RATE = 48_000
    /** One AAC-LC frame. */
    private const val FRAMES_PER_READ = 1024
  }
}
