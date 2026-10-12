package app.simpleswing.capture

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Handler
import android.util.Size
import android.view.PixelCopy
import android.view.SurfaceHolder
import android.view.SurfaceView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * Live camera preview. The SurfaceView buffer is fixed to the camera stream size (required by
 * high-speed sessions) and letterboxed to its portrait aspect so the golfer box maps 1:1.
 */
class SwingCaptureView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), PreviewHost, SurfaceHolder.Callback {

  override val shouldUseAndroidLayout = true

  private val engine = CaptureEngine.get(context)
  private val surfaceView = SurfaceView(context)
  private var bufferSize: Size? = null

  init {
    setBackgroundColor(Color.BLACK)
    addView(surfaceView)
    surfaceView.holder.addCallback(this)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    engine.attachPreview(this)
  }

  override fun onDetachedFromWindow() {
    engine.detachPreview(this)
    super.onDetachedFromWindow()
  }

  override fun setBufferSize(size: Size) {
    if (bufferSize == size) return
    bufferSize = size
    surfaceView.holder.setFixedSize(size.width, size.height)
    requestLayout()
  }

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
    val w = r - l
    val h = b - t
    // The sensor stream is landscape; the app is portrait, so the displayed aspect is height/width.
    val aspect = bufferSize?.let { it.height.toFloat() / it.width } ?: (9f / 16f)
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
}
