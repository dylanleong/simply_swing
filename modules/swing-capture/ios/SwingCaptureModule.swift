import AVFoundation
import ExpoModulesCore

/// JS bridge for the iOS capture engine; API matches src/SwingCaptureModule.ts and the Android module.
public class SwingCaptureModule: Module, CaptureEngineListener {
  private var engine: CaptureEngine { CaptureEngine.shared }

  public func definition() -> ModuleDefinition {
    Name("SwingCapture")

    Events(
      "onStateChange",
      "onTrigger",
      "onClipReady",
      "onSound",
      "onMotion",
      "onExposure",
      "onWatchStatus",
      "onWristSwing",
      "onThermalDowngrade",
      "onPeerStatus",
      "onPeersFound",
      "onAngleReady",
      "onError"
    )

    OnCreate {
      CaptureEngine.shared.listener = self
    }

    OnDestroy {
      CaptureEngine.shared.stop()
      if CaptureEngine.shared.listener === self { CaptureEngine.shared.listener = nil }
    }

    AsyncFunction("getPermissionsAsync") { () -> [String: Any] in
      Self.permissionResponse()
    }

    AsyncFunction("requestPermissionsAsync") { () async -> [String: Any] in
      if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
        _ = await AVCaptureDevice.requestAccess(for: .video)
      }
      if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        _ = await AVCaptureDevice.requestAccess(for: .audio)
      }
      return Self.permissionResponse()
    }

    AsyncFunction("getCapabilitiesAsync") { () -> [String: Any] in
      let fps = self.engine.supportedFps()
      var volumeKeys = false
      if #available(iOS 17.2, *) { volumeKeys = true }
      return ["supportedFps": fps, "highSpeed": fps.contains { $0 >= 120 }, "volumeKeyTrigger": volumeKeys]
    }

    AsyncFunction("startAsync") { (config: CaptureConfigRecord) in
      self.engine.start(config.toConfig())
    }

    AsyncFunction("stopAsync") {
      self.engine.stop()
    }

    Function("trigger") { (source: String) -> Bool in
      guard let trigger = TriggerSource(rawValue: source) else {
        throw CaptureException("Unknown trigger source: \(source)")
      }
      return self.engine.trigger(trigger)
    }

    Function("setAutoTrigger") { (enabled: Bool) in
      self.engine.autoTrigger = enabled
    }

    Function("setImpactTrigger") { (enabled: Bool) in
      self.engine.impactTrigger = enabled
    }

    Function("setStandby") { (on: Bool) in
      self.engine.setStandby(on)
    }

    Function("setRoi") { (roi: RoiRecord) in
      self.engine.setRoi(roi.toRoi())
    }

    AsyncFunction("exportSlowMotionAsync") { (uri: String, factor: Int) async throws -> String in
      guard let source = URL(string: uri), source.isFileURL else {
        throw CaptureException("Not a file URI: \(uri)")
      }
      let dir = FileManager.default.temporaryDirectory.appendingPathComponent("exports", isDirectory: true)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let output = dir.appendingPathComponent("\(source.deletingPathExtension().lastPathComponent)_slowmo_x\(factor).mp4")
      if !Self.isUpToDate(output, comparedTo: source) {
        try await ClipExporter.exportSlowMotion(source: source, factor: factor, to: output)
      }
      return output.absoluteString
    }

    Function("startMainLink") {
      self.engine.peers.startMain()
    }

    Function("connectPeer") { (idOrAddress: String) in
      self.engine.peers.connect(idOrAddress)
    }

    Function("startCameraLink") { (view: String) in
      self.engine.peers.startCamera(view: view)
    }

    Function("stopPeerLink") {
      self.engine.peers.stop()
    }

    View(SwingCaptureView.self) {}
  }

  // MARK: - CaptureEngineListener

  func engineStateChanged(_ state: EngineState, format: [String: Any]?) {
    sendEvent("onStateChange", ["state": state.rawValue, "format": format])
  }

  func engineTriggered(_ source: TriggerSource, timeMs: Double) {
    sendEvent("onTrigger", ["source": source.rawValue, "tImpactMs": timeMs])
  }

  func engineClipReady(_ info: [String: Any?]) {
    sendEvent("onClipReady", info)
  }

  func engineHeardSound(levelDb: Double, minLevelDb: Double, accepted: Bool, reason: String?, motion: MotionGate.Verdict?) {
    sendEvent("onSound", [
      "levelDb": levelDb,
      "minLevelDb": minLevelDb,
      "accepted": accepted,
      "reason": reason,
      "motionPeak": motion?.peak,
      "motionThreshold": motion?.threshold,
    ])
  }

  func engineMotion(level: Double, threshold: Double) {
    sendEvent("onMotion", ["level": level, "threshold": threshold])
  }

  func engineExposure(shutterSec: Double, iso: Double?) {
    sendEvent("onExposure", ["shutterSec": shutterSec, "iso": iso])
  }

  func engineThermalDowngrade(from: Int, to: Int) {
    sendEvent("onThermalDowngrade", ["fromFps": from, "toFps": to])
  }

  func enginePeerStatus(_ status: PeerLink.Status) {
    sendEvent("onPeerStatus", [
      "role": status.role.rawValue,
      "state": status.state,
      "peerName": status.peerName,
      "peerState": status.peerState,
      "syncMs": status.syncMs,
      "address": status.address,
    ])
  }

  func enginePeersFound(_ peers: [PeerLink.PeerInfo]) {
    sendEvent("onPeersFound", [
      "peers": peers.map { ["id": $0.id, "name": $0.name, "host": $0.host, "port": $0.port] },
    ])
  }

  func engineAngleReady(id: String) {
    sendEvent("onAngleReady", ["id": id])
  }

  func engineError(code: String, message: String) {
    sendEvent("onError", ["code": code, "message": message])
  }

  // MARK: - Helpers

  /// Same shape as expo-modules-core's PermissionResponse, for camera + microphone together.
  private static func permissionResponse() -> [String: Any] {
    let statuses = [AVCaptureDevice.authorizationStatus(for: .video), AVCaptureDevice.authorizationStatus(for: .audio)]
    let granted = statuses.allSatisfy { $0 == .authorized }
    let undetermined = statuses.contains(.notDetermined)
    let status = granted ? "granted" : (undetermined ? "undetermined" : "denied")
    return ["status": status, "granted": granted, "canAskAgain": granted || undetermined, "expires": "never"]
  }

  private static func isUpToDate(_ output: URL, comparedTo source: URL) -> Bool {
    let fm = FileManager.default
    guard let out = try? fm.attributesOfItem(atPath: output.path)[.modificationDate] as? Date,
          let src = try? fm.attributesOfItem(atPath: source.path)[.modificationDate] as? Date
    else { return false }
    return out >= src
  }
}
