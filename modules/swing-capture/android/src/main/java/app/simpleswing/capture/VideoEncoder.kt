package app.simpleswing.capture

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.util.Log
import android.util.Size
import android.view.Surface

/**
 * Hardware H.264 encoder fed directly by the camera through an input Surface. Frames keep the
 * camera sensor timestamp as their PTS. Short keyframe intervals keep clip starts precise.
 */
class VideoEncoder(
  size: Size,
  fps: Int,
  handler: Handler,
  private val onSample: (EncodedSample) -> Unit,
  private val onFormat: (MediaFormat) -> Unit,
  private val onError: (Throwable) -> Unit,
) {
  private val codec = MediaCodec.createEncoderByType(MIME)

  private val callback = object : MediaCodec.Callback() {
    override fun onInputBufferAvailable(codec: MediaCodec, index: Int) = Unit

    override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
      try {
        val buffer = codec.getOutputBuffer(index)
        if (buffer != null && info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
          val bytes = ByteArray(info.size)
          buffer.position(info.offset)
          buffer.get(bytes)
          onSample(EncodedSample(bytes, info.presentationTimeUs, info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0))
        }
        codec.releaseOutputBuffer(index, false)
      } catch (e: IllegalStateException) {
        // Codec stopped while this callback was in flight.
      }
    }

    override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) = onFormat(format)

    override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) = this@VideoEncoder.onError(e)
  }

  val inputSurface: Surface
  val bitrate: Int

  init {
    val caps = codec.codecInfo.getCapabilitiesForType(MIME).videoCapabilities
    bitrate = caps.bitrateRange.clamp(
      (size.width.toLong() * size.height * fps * BITS_PER_PIXEL).toLong().coerceAtMost(MAX_BITRATE.toLong()).toInt()
    )
    codec.setCallback(callback, handler)
    try {
      codec.configure(format(size, fps, withOperatingRate = true), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    } catch (e: Exception) {
      Log.w(TAG, "Encoder rejected operating rate, retrying without it", e)
      codec.reset()
      codec.setCallback(callback, handler)
      codec.configure(format(size, fps, withOperatingRate = false), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    }
    inputSurface = codec.createInputSurface()
    codec.start()
  }

  private fun format(size: Size, fps: Int, withOperatingRate: Boolean) =
    MediaFormat.createVideoFormat(MIME, size.width, size.height).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
      setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
      setInteger(MediaFormat.KEY_FRAME_RATE, fps)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
        setFloat(MediaFormat.KEY_I_FRAME_INTERVAL, KEYFRAME_INTERVAL_SEC)
      } else {
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
      }
      if (withOperatingRate) setInteger(MediaFormat.KEY_OPERATING_RATE, fps)
    }

  fun release() {
    try {
      codec.stop()
    } catch (_: IllegalStateException) {
    }
    codec.release()
    inputSurface.release()
  }

  companion object {
    private const val TAG = "SwingVideoEncoder"
    private const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
    private const val KEYFRAME_INTERVAL_SEC = 0.5f
    private const val BITS_PER_PIXEL = 0.12
    private const val MAX_BITRATE = 50_000_000
  }
}
