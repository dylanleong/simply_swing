package app.simpleswing.capture

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Handler
import android.util.Size
import android.view.PixelCopy
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * Live camera preview. The SurfaceView buffer is fixed to the camera stream size (required by
 * high-speed sessions) and letterboxed to the aspect it's shown at, so the golfer box maps 1:1.
 *
 * The compositor turns a SurfaceView's camera buffers upright for the display, so a landscape
 * sensor stream is a portrait picture on a phone and a landscape one on a tablet turned on its side.
 * The view knows the display's rotation; the engine asks for it to shape the motion thumbnail and to
 * stamp saved clips upright (see [CaptureEngine.clipOrientation]).
 */
class SwingCaptureView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), PreviewHost, SurfaceHolder.Callback {

  override val shouldUseAndroidLayout = true

  private val engine = CaptureEngine.get(context)
  private val surfaceView = SurfaceView(context)
  private var bufferSize: Size? = null
  private var sensorOrientation = 90
  /** Degrees the display is turned counter-clockwise from the device's natural orientation (any thread). */
  @Volatile private var displayRotation = 0

  init {
    setBackgroundColor(Color.BLACK)
    addView(surfaceView)
    surfaceView.holder.addCallback(this)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    readDisplayRotation()
    engine.attachPreview(this)
  }

  override fun onDetachedFromWindow() {
    engine.detachPreview(this)
    super.onDetachedFromWindow()
  }

  override fun onConfigurationChanged(newConfig: Configuration?) {
    super.onConfigurationChanged(newConfig)
    if (readDisplayRotation()) requestLayout()
  }

  override fun setBufferSize(size: Size, sensorOrientation: Int) {
    this.sensorOrientation = sensorOrientation
    if (bufferSize == size) return
    bufferSize = size
    surfaceView.holder.setFixedSize(size.width, size.height)
    requestLayout()
  }

  override fun displayRotationDegrees(): Int = displayRotation

  override fun copyPreview(dest: Bitmap, handler: Handler, done: (Boolean) -> Unit) {
    if (!surfaceView.holder.surface.isValid) {
      done(false)
      return
    }
    try {
      PixelCopy.request(surfaceView, dest, { result -> done(result == PixelCopy.SUCCESS) }, handler)
    } catch (e: IllegalArgumentException) {
      done(false)
    }
  }

  override fun surfaceCreated(holder: SurfaceHolder) = Unit

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    engine.onPreviewSurface(this, holder.surface, Size(width, height))
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    engine.onPreviewSurfaceDestroyed(this)
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    readDisplayRotation()
    val w = r - l
    val h = b - t
    // The stream is in sensor orientation (landscape); it's shown turned upright for the display,
    // so it's a portrait picture when sensor and display are a quarter turn apart.
    val size = bufferSize ?: Size(16, 9)
    val portrait = Orientation.isQuarterTurn(sensorOrientation, displayRotation)
    val aspect = if (portrait) size.height.toFloat() / size.width else size.width.toFloat() / size.height
    var childW = w
    var childH = (w / aspect).toInt()
    if (childH > h) {
      childH = h
      childW = (h * aspect).toInt()
    }
    val x = (w - childW) / 2
    val y = (h - childH) / 2
    surfaceView.measure(
      MeasureSpec.makeMeasureSpec(childW, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(childH, MeasureSpec.EXACTLY),
    )
    surfaceView.layout(x, y, x + childW, y + childH)
  }

  /** Main thread. True if the rotation changed. */
  private fun readDisplayRotation(): Boolean {
    val rotation = when (display?.rotation) {
      Surface.ROTATION_90 -> 90
      Surface.ROTATION_180 -> 180
      Surface.ROTATION_270 -> 270
      else -> 0
    }
    if (rotation == displayRotation) return false
    displayRotation = rotation
    return true
  }
}
