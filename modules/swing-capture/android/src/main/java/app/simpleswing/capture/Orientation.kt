package app.simpleswing.capture

/**
 * Camera orientation maths (pure, unit-tested). The sensor streams landscape frames; what's upright
 * depends on how the device is held, read as the display's rotation (degrees counter-clockwise from
 * the device's natural orientation, as Android's Display.getRotation reports it).
 */
object Orientation {
  /**
   * Clockwise rotation that shows a back-camera frame upright for a display turned [displayRotation]
   * degrees: Android's JPEG orientation formula with the display rotation in place of the device
   * orientation (they turn opposite ways). Goes in the clip's orientation hint.
   */
  fun clipOrientation(sensorOrientation: Int, displayRotation: Int): Int =
    ((sensorOrientation - displayRotation) % 360 + 360) % 360

  /** True when the upright picture is a quarter turn from the stream, i.e. portrait from a landscape sensor. */
  fun isQuarterTurn(sensorOrientation: Int, displayRotation: Int): Boolean =
    clipOrientation(sensorOrientation, displayRotation) % 180 == 90

  /** The stream's size as shown upright: width and height swap for a quarter turn. */
  fun uprightSize(width: Int, height: Int, orientation: Int): Pair<Int, Int> =
    if (orientation % 180 == 90) height to width else width to height
}
