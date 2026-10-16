package app.simpleswing.capture

import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import org.json.JSONObject

data class WrittenClip(
  val file: File,
  val thumbnail: File?,
  val durationUs: Long,
  /** Impact position inside the clip, or null when the trigger had no impact time. */
  val impactOffsetUs: Long?,
  /** Trigger-instant position relative to the clip start (not clamped; lines up a second angle). */
  val anchorOffsetUs: Long,
)

/**
 * Muxes ring-buffer snapshots into an MP4 and grabs a thumbnail. Runs on the export thread.
 *
 * Every file is written as `<name>.part` and renamed once complete, so a full disk or a killed app
 * never leaves a half-written clip (or a broken export that later calls would serve from cache).
 */
object ClipWriter {
  fun write(
    file: File,
    videoFormat: MediaFormat,
    video: List<EncodedSample>,
    audioFormat: MediaFormat?,
    audio: List<EncodedSample>,
    orientationDegrees: Int,
    impactUs: Long?,
    anchorUs: Long,
    thumbnail: Boolean = true,
  ): WrittenClip {
    require(video.isNotEmpty()) { "No video in clip window" }
    val startUs = video.first().ptsUs
    val endUs = video.last().ptsUs
    val clipAudio = if (audioFormat == null) emptyList() else audio.filter { it.ptsUs in startUs..endUs }

    atomically(file) { part -> mux(part, videoFormat, video, audioFormat, clipAudio, orientationDegrees, startUs) }

    val impactOffsetUs = impactUs?.let { (it - startUs).coerceIn(0, endUs - startUs) }
    val thumbAtUs = impactOffsetUs ?: ((endUs - startUs) / 2)
    val thumb = if (thumbnail) writeThumbnail(file, thumbAtUs, orientationDegrees) else null
    return WrittenClip(file, thumb, endUs - startUs, impactOffsetUs, anchorUs - startUs)
  }

  private fun mux(
    file: File,
    videoFormat: MediaFormat,
    video: List<EncodedSample>,
    audioFormat: MediaFormat?,
    clipAudio: List<EncodedSample>,
    orientationDegrees: Int,
    startUs: Long,
  ) {
    val muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    try {
      muxer.setOrientationHint(orientationDegrees)
      val videoTrack = muxer.addTrack(videoFormat)
      val audioTrack = if (clipAudio.isNotEmpty()) muxer.addTrack(audioFormat!!) else -1
      muxer.start()

      val info = MediaCodec.BufferInfo()
      var vi = 0
      var ai = 0
      // Interleave by timestamp so players don't have to seek between tracks.
      while (vi < video.size || ai < clipAudio.size) {
        val takeVideo = ai >= clipAudio.size || (vi < video.size && video[vi].ptsUs <= clipAudio[ai].ptsUs)
        if (takeVideo) {
          val s = video[vi++]
          info.set(0, s.data.size, s.ptsUs - startUs, if (s.isKeyFrame) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
          muxer.writeSampleData(videoTrack, ByteBuffer.wrap(s.data), info)
        } else {
          val s = clipAudio[ai++]
          info.set(0, s.data.size, s.ptsUs - startUs, MediaCodec.BUFFER_FLAG_KEY_FRAME)
          muxer.writeSampleData(audioTrack, ByteBuffer.wrap(s.data), info)
        }
      }
      muxer.stop()
    } finally {
      muxer.release()
    }
  }

  /** Runs [write] on `<file>.part`, then moves it into place; on any failure nothing is left behind. */
  fun atomically(file: File, write: (File) -> Unit) {
    val part = File(file.parentFile, file.name + ".part")
    try {
      write(part)
      if (!part.renameTo(file)) throw java.io.IOException("Couldn't move ${part.name} into place")
    } catch (e: Throwable) {
      part.delete()
      throw e
    }
  }

  /** Fails early, with a message people understand, when there's no room for another clip. */
  fun ensureSpace(dir: File) {
    if (dir.usableSpace < MIN_FREE_BYTES) {
      throw CaptureException("E_STORAGE", "Phone storage is full. Free some space (or delete old swings) to keep saving.")
    }
  }

  /**
   * Copies [src]'s video stretched [factor]x in time (audio dropped) so ordinary players, galleries
   * and messaging apps show it in slow motion: 120 fps x4 plays back at 30 fps. No re-encode.
   */
  fun retime(src: File, dst: File, factor: Int) {
    require(factor in 1..16) { "Slow-motion factor $factor out of range" }
    atomically(dst) { part -> retimeInto(src, part, factor) }
  }

  private fun retimeInto(src: File, dst: File, factor: Int) {
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(src.path)
      val track = (0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
      } ?: throw IllegalArgumentException("No video track in ${src.name}")
      val format = extractor.getTrackFormat(track)
      extractor.selectTrack(track)
      val rotation = if (format.containsKey(MediaFormat.KEY_ROTATION)) format.getInteger(MediaFormat.KEY_ROTATION) else 0
      format.setInteger(MediaFormat.KEY_ROTATION, 0) // carried by the orientation hint instead
      val maxSize = if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
        format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
      } else {
        8 * 1024 * 1024
      }

      val muxer = MediaMuxer(dst.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      try {
        muxer.setOrientationHint(rotation)
        val out = muxer.addTrack(format)
        muxer.start()
        val buffer = ByteBuffer.allocate(maxSize)
        val info = MediaCodec.BufferInfo()
        while (true) {
          val size = extractor.readSampleData(buffer, 0)
          if (size < 0) break
          val key = extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0
          info.set(0, size, extractor.sampleTime * factor, if (key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
          muxer.writeSampleData(out, buffer, info)
          extractor.advance()
        }
        muxer.stop()
      } finally {
        muxer.release()
      }
    } finally {
      extractor.release()
    }
  }

  /**
   * `swing_123.json` beside `swing_123.mp4`: what the library needs without opening the video.
   * Keys mirror ClipReadyEvent plus `createdAt` (epoch ms).
   */
  fun writeSidecar(clip: File, info: Map<String, Any?>) {
    val json = JSONObject()
    info.forEach { (k, v) -> json.put(k, v ?: JSONObject.NULL) }
    File(clip.parentFile, clip.nameWithoutExtension + ".json").writeText(json.toString())
  }

  private fun writeThumbnail(clip: File, atUs: Long, orientationDegrees: Int): File? {
    val retriever = MediaMetadataRetriever()
    return try {
      retriever.setDataSource(clip.path)
      var frame = retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC) ?: return null
      // Some decoders return the frame un-rotated; the clip is portrait, so rotate if it isn't.
      if ((orientationDegrees == 90 || orientationDegrees == 270) && frame.width > frame.height) {
        frame = Bitmap.createBitmap(frame, 0, 0, frame.width, frame.height, Matrix().apply { postRotate(orientationDegrees.toFloat()) }, true)
      }
      val scale = THUMB_WIDTH.toFloat() / frame.width
      val scaled = Bitmap.createScaledBitmap(frame, THUMB_WIDTH, (frame.height * scale).toInt(), true)
      val out = File(clip.parentFile, clip.nameWithoutExtension + ".jpg")
      FileOutputStream(out).use { scaled.compress(Bitmap.CompressFormat.JPEG, 80, it) }
      out
    } catch (_: Exception) {
      null
    } finally {
      retriever.release()
    }
  }

  private const val THUMB_WIDTH = 360
  private const val MIN_FREE_BYTES = 100L * 1024 * 1024
}
