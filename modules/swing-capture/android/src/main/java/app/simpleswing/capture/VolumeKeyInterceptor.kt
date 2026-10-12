package app.simpleswing.capture

import android.app.Activity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Window

/**
 * Turns the hardware volume keys (and cheap Bluetooth camera remotes, which send VOLUME_UP) into a
 * capture trigger while the camera runs, without needing a MainActivity config plugin. Also reports
 * screen touches, during which the impact detector is muted (handling the phone is noisy).
 */
class VolumeKeyInterceptor(private val onPress: () -> Unit, private val onTouch: () -> Unit) {
  private var window: Window? = null
  private var original: Window.Callback? = null
  private var wrapper: Window.Callback? = null

  fun install(activity: Activity) {
    val window = activity.window ?: return
    if (this.window === window) return
    uninstall()
    val original = window.callback ?: return
    val wrapper = object : Window.Callback by original {
      override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        onTouch()
        return original.dispatchTouchEvent(event)
      }

      override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode !in TRIGGER_KEYS) return original.dispatchKeyEvent(event)
        // Consume down and up so the system volume doesn't change while capturing.
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) onPress()
        return true
      }
    }
    window.callback = wrapper
    this.window = window
    this.original = original
    this.wrapper = wrapper
  }

  fun uninstall() {
    val window = window ?: return
    if (window.callback === wrapper) window.callback = original
    this.window = null
    original = null
    wrapper = null
  }

  companion object {
    private val TRIGGER_KEYS = setOf(KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN, KeyEvent.KEYCODE_CAMERA)
  }
}
