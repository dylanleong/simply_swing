import AVFoundation
import AVKit
import ExpoModulesCore

/// Live preview, letterboxed ("contain") so the golfer box maps 1:1 like on Android. Also turns the
/// volume buttons (and Bluetooth camera remotes) into a SAVE on iOS 17.2+.
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

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
    guard let connection = previewLayer.connection else { return }
    if #available(iOS 17.0, *) {
      if connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
  }
}
