import AVFoundation
import AVKit
import ExpoModulesCore
import UIKit

/// Live preview, letterboxed ("contain") so the golfer box maps 1:1 like on Android. Also turns the
/// volume buttons (and Bluetooth camera remotes) into a SAVE on iOS 17.2+.
///
/// The preview turns with the interface: phones are locked portrait by the JS, iPads rotate freely
/// (an iPad on a tripod is often mounted landscape). The engine is told the same rotation so clips,
/// thumbnails and the golfer-box motion thumbnail come out upright for how the device is held.
class SwingCaptureView: ExpoView {
  private let previewLayer = AVCaptureVideoPreviewLayer(session: CaptureEngine.shared.session)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    clipsToBounds = true
    previewLayer.videoGravity = .resizeAspect
    layer.addSublayer(previewLayer)

    if #available(iOS 17.2, *) {
      let volumeKeys = AVCaptureEventInteraction { event in
        if event.phase == .began {
          CaptureEngine.shared.trigger(.volumeKey)
        }
      }
      addInteraction(volumeKeys)
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    applyRotation()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
    // A rotation changes the bounds, so this runs for every turn of the device.
    applyRotation()
  }

  /// Degrees the camera frames turn clockwise to be upright on screen, from the interface orientation.
  private func applyRotation() {
    // VERIFY: the scene's interfaceOrientation is already the new one when layoutSubviews runs after
    // a rotation (it is for full-screen apps; iOS 17's AVCaptureDevice.RotationCoordinator follows
    // the device instead, which is wrong for a portrait-locked phone on its side).
    let orientation = window?.windowScene?.interfaceOrientation ?? .portrait
    let angle: Int
    switch orientation {
    case .landscapeRight: angle = 0
    case .landscapeLeft: angle = 180
    case .portraitUpsideDown: angle = 270
    default: angle = 90
    }
    CaptureEngine.shared.setPreviewRotation(angle)
    guard let connection = previewLayer.connection else { return }
    if #available(iOS 17.0, *) {
      if connection.isVideoRotationAngleSupported(CGFloat(angle)) { connection.videoRotationAngle = CGFloat(angle) }
    } else if connection.isVideoOrientationSupported {
      // VERIFY: landscapeRight (home button on the right) is the 0° case for the back camera.
      switch angle {
      case 0: connection.videoOrientation = .landscapeRight
      case 180: connection.videoOrientation = .landscapeLeft
      case 270: connection.videoOrientation = .portraitUpsideDown
      default: connection.videoOrientation = .portrait
      }
    }
  }
}
