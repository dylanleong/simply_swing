package app.simpleswing.capture

import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import kotlin.concurrent.thread
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Renders a two-angle swing as one slow-motion video, the angles side by side, for Save / Share.
 *
 * Every frame of the main clip becomes one output frame, stretched [factor]x in time like
 * [ClipWriter.retime]; the second angle shows its frame for the same moment, `tB = tA + shiftUs`
 * (the review screen's alignment, nudge included). Both clips decode into SurfaceTextures and GL
 * draws them into the encoder's input surface. Audio is dropped, as in the single-angle export.
 */
object SideBySideExporter {
  private const val PANEL_W = 720
  private const val PANEL_H = 1280
  private const val GAP = 16
  private const val OUT_W = PANEL_W * 2 + GAP
  private const val OUT_H = PANEL_H
  private const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
  private const val TIMEOUT_US = 10_000L
  /** Short waits while the codecs still have work queued; long ones only at end of stream. */
  private const val POLL_US = 1_000L
  private const val STALL_MS = 5_000L
  private const val TAG = "SwingSideBySide"

  fun export(main: File, angle: File, shiftUs: Long, factor: Int, dst: File) {
    // EGL binds to the calling thread; keep it off the module's shared queue.
    var error: Throwable? = null
    thread(name = "SwingSideBySide") {
      try {
        render(main, angle, shiftUs, factor, dst)
      } catch (e: Throwable) {
        error = e
      }
    }.join()
    error?.let { throw it }
  }

  private fun render(main: File, angle: File, shiftUs: Long, factor: Int, dst: File) {
    val part = File(dst.path + ".part")
    val startedMs = SystemClock.elapsedRealtime()
    var frames = 0
    val callbacks = HandlerThread("SwingSideBySideFrames").apply { start() }
    val probe = FrameSource.probe(main)
    val outFps = (probe.fps / factor).roundToInt().coerceAtLeast(1)
    val encoder = MediaCodec.createEncoderByType(MIME)
    var egl: Egl? = null
    var left: FrameSource? = null
    var right: FrameSource? = null
    var muxer: MediaMuxer? = null
    try {
      encoder.configure(
        MediaFormat.createVideoFormat(MIME, OUT_W, OUT_H).apply {
          setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
          setInteger(MediaFormat.KEY_BIT_RATE, bitrate(outFps))
          setInteger(MediaFormat.KEY_FRAME_RATE, outFps)
          setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        },
        null,
        null,
        MediaCodec.CONFIGURE_FLAG_ENCODE
      )
      egl = Egl(encoder.createInputSurface())
      encoder.start()
      val drawer = Drawer()
      left = FrameSource(main, drawer.newTexture(), Handler(callbacks.looper))
      right = FrameSource(angle, drawer.newTexture(), Handler(callbacks.looper))
      val mux = MediaMuxer(part.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4).also { muxer = it }
      val drain = EncoderDrain(encoder, mux)

      while (left.next()) {
        val tA = left.currentUs
        right.showAt(tA + shiftUs)
        GLES20.glViewport(0, 0, OUT_W, OUT_H)
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        drawer.draw(left, 0)
        drawer.draw(right, PANEL_W + GAP)
        egl.swap(tA * factor * 1000)
        drain.drain(endOfStream = false)
        frames++
      }
      drain.drain(endOfStream = true)
      if (!drain.started) throw CaptureException("E_EXPORT", "No frames to export in ${main.name}")
      mux.stop()
      if (!part.renameTo(dst)) throw CaptureException("E_EXPORT", "Couldn't save the side-by-side video")
      Log.i(TAG, "Exported $frames frames side by side in ${SystemClock.elapsedRealtime() - startedMs} ms")
    } finally {
      left?.release()
      right?.release()
      runCatching { encoder.stop() }
      encoder.release()
      egl?.release()
      runCatching { muxer?.release() }
      callbacks.quitSafely()
      part.delete()
    }
  }

  /** ~0.2 bits per pixel: plenty for slow motion, small enough to share. */
  private fun bitrate(fps: Int) = (OUT_W.toLong() * OUT_H * fps / 5).coerceIn(6_000_000, 30_000_000).toInt()

  /** One clip decoding into a SurfaceTexture, a frame at a time, on the export thread. */
  private class FrameSource(file: File, val textureId: Int, callbacks: Handler) {
    class Probe(val fps: Double)

    companion object {
      fun probe(file: File): Probe {
        val extractor = MediaExtractor()
        try {
          extractor.setDataSource(file.path)
          val format = extractor.getTrackFormat(videoTrack(extractor, file))
          val fps = format.getNumber(MediaFormat.KEY_FRAME_RATE)?.toDouble() ?: 120.0
          return Probe(fps)
        } finally {
          extractor.release()
        }
      }

      fun videoTrack(extractor: MediaExtractor, file: File) = (0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
      } ?: throw CaptureException("E_EXPORT", "No video track in ${file.name}")
    }

    private val extractor = MediaExtractor().apply { setDataSource(file.path) }
    private val decoder: MediaCodec
    private val texture = SurfaceTexture(textureId)
    private val surface = Surface(texture)
    private val frameLock = Object()
    private var frameAvailable = false
    private val info = MediaCodec.BufferInfo()
    private var inputDone = false
    private var outputDone = false
    private var heldIndex = -1
    private var heldPtsUs = 0L
    private var firstPtsUs = -1L

    /** Clockwise rotation that shows the stored frame upright, and the upright size. */
    val rotation: Int
    val displayWidth: Int
    val displayHeight: Int
    val stMatrix = FloatArray(16)
    var hasFrame = false
      private set
    /** The shown frame's time from the clip's first frame. */
    var currentUs = 0L
      private set

    init {
      val track = videoTrack(extractor, file)
      val format = extractor.getTrackFormat(track)
      extractor.selectTrack(track)
      rotation = if (format.containsKey(MediaFormat.KEY_ROTATION)) format.getInteger(MediaFormat.KEY_ROTATION) else 0
      val w = format.getInteger(MediaFormat.KEY_WIDTH)
      val h = format.getInteger(MediaFormat.KEY_HEIGHT)
      displayWidth = if (rotation % 180 == 0) w else h
      displayHeight = if (rotation % 180 == 0) h else w
      // Rotation is applied when drawing, so the texture always holds the frame as stored.
      format.setInteger(MediaFormat.KEY_ROTATION, 0)
      texture.setOnFrameAvailableListener({
        synchronized(frameLock) {
          frameAvailable = true
          frameLock.notifyAll()
        }
      }, callbacks)
      decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
      decoder.configure(format, surface, null, 0)
      decoder.start()
    }

    /** Shows the next frame; false at the end of the clip. */
    fun next(): Boolean {
      if (!peek()) return false
      renderHeld()
      return true
    }

    /** Shows the last frame at or before [tUs] (from the first frame), or the first frame if earlier. */
    fun showAt(tUs: Long) {
      while (peek()) {
        if (hasFrame && heldPtsUs - firstPtsUs > tUs) return
        renderHeld()
      }
    }

    /** Decodes until a frame is waiting (held, not yet shown); false at the end of the clip. */
    private fun peek(): Boolean {
      if (heldIndex >= 0) return true
      val stallDeadline = SystemClock.elapsedRealtime() + STALL_MS
      while (!outputDone) {
        feed()
        val index = decoder.dequeueOutputBuffer(info, if (inputDone) TIMEOUT_US else POLL_US)
        if (index < 0) {
          if (SystemClock.elapsedRealtime() > stallDeadline) throw CaptureException("E_EXPORT", "Video decoder stalled")
          continue
        }
        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
          outputDone = true
          if (info.size == 0) {
            decoder.releaseOutputBuffer(index, false)
            return false
          }
        }
        heldIndex = index
        heldPtsUs = info.presentationTimeUs
        if (firstPtsUs < 0) firstPtsUs = heldPtsUs
        return true
      }
      return false
    }

    /** Queues as many compressed frames as the decoder will take: it needs several before it outputs. */
    private fun feed() {
      while (!inputDone) {
        val index = decoder.dequeueInputBuffer(0)
        if (index < 0) return
        val buffer = decoder.getInputBuffer(index)!!
        val size = extractor.readSampleData(buffer, 0)
        if (size < 0) {
          decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
          inputDone = true
        } else {
          decoder.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
          extractor.advance()
        }
      }
    }

    private fun renderHeld() {
      synchronized(frameLock) { frameAvailable = false }
      decoder.releaseOutputBuffer(heldIndex, true)
      heldIndex = -1
      synchronized(frameLock) {
        val deadline = SystemClock.elapsedRealtime() + STALL_MS
        while (!frameAvailable) {
          val left = deadline - SystemClock.elapsedRealtime()
          if (left <= 0) throw CaptureException("E_EXPORT", "Video frame never arrived")
          frameLock.wait(left)
        }
      }
      texture.updateTexImage()
      texture.getTransformMatrix(stMatrix)
      currentUs = heldPtsUs - firstPtsUs
      hasFrame = true
    }

    fun release() {
      runCatching { decoder.stop() }
      decoder.release()
      extractor.release()
      surface.release()
      texture.release()
    }
  }

  /** Draws a source's current frame upright, fitted inside the panel starting at [panelX]. */
  private class Drawer {
    private val program = linkProgram(
      """
      attribute vec4 aPosition;
      attribute vec2 aTexCoord;
      uniform mat4 uSTMatrix;
      varying vec2 vTexCoord;
      void main() {
        gl_Position = aPosition;
        vTexCoord = (uSTMatrix * vec4(aTexCoord, 0.0, 1.0)).xy;
      }
      """,
      """
      #extension GL_OES_EGL_image_external : require
      precision mediump float;
      varying vec2 vTexCoord;
      uniform samplerExternalOES sTexture;
      void main() {
        gl_FragColor = texture2D(sTexture, vTexCoord);
      }
      """
    )
    private val aPosition = GLES20.glGetAttribLocation(program, "aPosition")
    private val aTexCoord = GLES20.glGetAttribLocation(program, "aTexCoord")
    private val uSTMatrix = GLES20.glGetUniformLocation(program, "uSTMatrix")
    private val corners = floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)
    private val positions = floats(*corners)
    private val texCoords = FloatArray(8)
    private val texCoordsBuffer = floats(*texCoords)

    fun newTexture(): Int {
      val ids = IntArray(1)
      GLES20.glGenTextures(1, ids, 0)
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, ids[0])
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
      return ids[0]
    }

    fun draw(source: FrameSource, panelX: Int) {
      if (!source.hasFrame) return
      val scale = min(PANEL_W.toFloat() / source.displayWidth, PANEL_H.toFloat() / source.displayHeight)
      val w = (source.displayWidth * scale).roundToInt()
      val h = (source.displayHeight * scale).roundToInt()
      GLES20.glViewport(panelX + (PANEL_W - w) / 2, (PANEL_H - h) / 2, w, h)

      // Quad corners (u, v) in upright display space, GL convention (v up), mapped back to the
      // stored frame by undoing the clockwise display rotation.
      for (i in 0 until 4) {
        val u = (corners[i * 2] + 1f) / 2f
        val v = (corners[i * 2 + 1] + 1f) / 2f
        val (s, t) = when (source.rotation) {
          90 -> 1f - v to u
          180 -> 1f - u to 1f - v
          270 -> v to 1f - u
          else -> u to v
        }
        texCoords[i * 2] = s
        texCoords[i * 2 + 1] = t
      }
      texCoordsBuffer.clear()
      texCoordsBuffer.put(texCoords).flip()

      GLES20.glUseProgram(program)
      GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, source.textureId)
      GLES20.glUniformMatrix4fv(uSTMatrix, 1, false, source.stMatrix, 0)
      positions.position(0)
      GLES20.glVertexAttribPointer(aPosition, 2, GLES20.GL_FLOAT, false, 0, positions)
      GLES20.glEnableVertexAttribArray(aPosition)
      GLES20.glVertexAttribPointer(aTexCoord, 2, GLES20.GL_FLOAT, false, 0, texCoordsBuffer)
      GLES20.glEnableVertexAttribArray(aTexCoord)
      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    }

    private fun floats(vararg values: Float): FloatBuffer =
      ByteBuffer.allocateDirect(values.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
        put(values)
        flip()
      }

    private fun linkProgram(vertex: String, fragment: String): Int {
      val program = GLES20.glCreateProgram()
      GLES20.glAttachShader(program, compile(GLES20.GL_VERTEX_SHADER, vertex))
      GLES20.glAttachShader(program, compile(GLES20.GL_FRAGMENT_SHADER, fragment))
      GLES20.glLinkProgram(program)
      val status = IntArray(1)
      GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0)
      if (status[0] == 0) throw CaptureException("E_EXPORT", "GL link failed: ${GLES20.glGetProgramInfoLog(program)}")
      return program
    }

    private fun compile(type: Int, source: String): Int {
      val shader = GLES20.glCreateShader(type)
      GLES20.glShaderSource(shader, source)
      GLES20.glCompileShader(shader)
      val status = IntArray(1)
      GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
      if (status[0] == 0) throw CaptureException("E_EXPORT", "GL compile failed: ${GLES20.glGetShaderInfoLog(shader)}")
      return shader
    }
  }

  /** An EGL context drawing into the encoder's input surface. */
  private class Egl(private val surface: Surface) {
    private val display: EGLDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    private val context: EGLContext
    private val eglSurface: EGLSurface

    init {
      val version = IntArray(2)
      if (!EGL14.eglInitialize(display, version, 0, version, 1)) throw CaptureException("E_EXPORT", "EGL init failed")
      val configs = arrayOfNulls<EGLConfig>(1)
      val count = IntArray(1)
      val attributes = intArrayOf(
        EGL14.EGL_RED_SIZE, 8,
        EGL14.EGL_GREEN_SIZE, 8,
        EGL14.EGL_BLUE_SIZE, 8,
        EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
        EGL_RECORDABLE_ANDROID, 1,
        EGL14.EGL_NONE
      )
      if (!EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) || count[0] == 0) {
        throw CaptureException("E_EXPORT", "No recordable EGL config")
      }
      context = EGL14.eglCreateContext(
        display, configs[0], EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0
      )
      eglSurface = EGL14.eglCreateWindowSurface(display, configs[0], surface, intArrayOf(EGL14.EGL_NONE), 0)
      if (!EGL14.eglMakeCurrent(display, eglSurface, eglSurface, context)) throw CaptureException("E_EXPORT", "EGL makeCurrent failed")
    }

    fun swap(ptsNs: Long) {
      EGLExt.eglPresentationTimeANDROID(display, eglSurface, ptsNs)
      EGL14.eglSwapBuffers(display, eglSurface)
    }

    fun release() {
      EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
      EGL14.eglDestroySurface(display, eglSurface)
      EGL14.eglDestroyContext(display, context)
      EGL14.eglReleaseThread()
      EGL14.eglTerminate(display)
      surface.release()
    }

    companion object {
      private const val EGL_RECORDABLE_ANDROID = 0x3142
    }
  }

  /** Moves encoded frames into the muxer, starting it once the encoder reports its format. */
  private class EncoderDrain(private val encoder: MediaCodec, private val muxer: MediaMuxer) {
    private val info = MediaCodec.BufferInfo()
    private var track = -1
    var started = false
      private set

    fun drain(endOfStream: Boolean) {
      if (endOfStream) encoder.signalEndOfInputStream()
      val deadline = SystemClock.elapsedRealtime() + STALL_MS
      while (true) {
        // Mid-stream, take what's ready and get back to drawing; the next frame drains the rest.
        val index = encoder.dequeueOutputBuffer(info, if (endOfStream) TIMEOUT_US else 0)
        when {
          index == MediaCodec.INFO_TRY_AGAIN_LATER -> {
            if (!endOfStream) return
            if (SystemClock.elapsedRealtime() > deadline) throw CaptureException("E_EXPORT", "Video encoder stalled")
          }
          index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            track = muxer.addTrack(encoder.outputFormat)
            muxer.start()
            started = true
          }
          index >= 0 -> {
            val buffer = encoder.getOutputBuffer(index)!!
            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
            if (info.size > 0 && started) {
              buffer.position(info.offset)
              buffer.limit(info.offset + info.size)
              muxer.writeSampleData(track, buffer, info)
            }
            encoder.releaseOutputBuffer(index, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
          }
        }
      }
    }
  }
}
