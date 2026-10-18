import CoreGraphics

/// Camera orientation maths; the Swift side of Orientation.kt. `rotation` is the clockwise turn
/// (degrees) that shows the sensor's landscape frames upright for the interface orientation.
enum Orientation {
  /// The stream's size as shown upright: width and height swap for a quarter turn.
  static func uprightSize(width: Int, height: Int, rotation: Int) -> (width: Int, height: Int) {
    rotation % 180 == 90 ? (height, width) : (width, height)
  }

  /// The writer / track transform that shows the stored frames upright.
  static func transform(for rotation: Int) -> CGAffineTransform {
    CGAffineTransform(rotationAngle: CGFloat(rotation) * .pi / 180)
  }

  /// Where upright-picture point (`u`, `v`) (0..1 across and down) lies in the stored frame (0..1).
  static func storedPoint(u: Double, v: Double, rotation: Int) -> (x: Double, y: Double) {
    switch rotation {
    case 90: return (v, 1 - u)
    case 180: return (1 - u, 1 - v)
    case 270: return (1 - v, u)
    default: return (u, v)
    }
  }
}
