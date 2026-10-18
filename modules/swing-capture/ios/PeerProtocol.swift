import Foundation

/**
 Messages between a main phone and a second "camera" phone (see PeerLink). Same wire format, types
 and fields as PeerProtocol.kt (see there for the message list); keep the two and
 scripts/multicam-peer.py in step.

 Wire format: `u8 type | u32 big-endian length | payload`. Payloads are UTF-8 JSON except DATA, which
 is raw clip bytes. Times are capture-clock microseconds of the phone that receives them.
 */
enum PeerMessage: Equatable {
  /// `view` is the camera's angle on the golfer: "dtl" or "faceOn" ("" from the main phone).
  /// `code` is the camera phone's pairing code, sent by the main phone only ("" from a camera phone).
  case hello(version: Int, role: String, name: String, platform: String, fps: Int, view: String, code: String)
  /// `syncUs` is the main phone's current sync uncertainty, so the camera phone can show it too.
  case ping(t1: Int64, syncUs: Int64?)
  case pong(t1: Int64, t2: Int64, t3: Int64)
  case state(String)
  /// Save `startUs`...`endUs`; `anchorUs` is the impact (or button press) both clips are aligned on.
  case trigger(id: String, startUs: Int64, endUs: Int64, anchorUs: Int64)
  case reject(id: String, reason: String)
  /// `anchorOffsetMs`: where the anchor instant falls in the clip (may lie outside it). `width` x
  /// `height` is the clip's upright size; 0 from an app that didn't send it (assume portrait).
  case clip(id: String, fps: Int, durationMs: Double, anchorOffsetMs: Double, size: Int64, width: Int, height: Int)
  case data(Data)
  case done(id: String)
  case bye
  /// A message type from a newer app version; ignored.
  case unknown(type: UInt8)
}

enum PeerProtocol {
  /// 2: HELLO carries the pairing code, and a camera phone only answers a main phone that sent the right one.
  static let version = 2
  /// Bonjour type, without the trailing dot NsdManager uses.
  static let serviceType = "_simpleswing._tcp"
  static let defaultPort: UInt16 = 47800
  static let chunkBytes = 64 * 1024
  static let headerBytes = 5
  /// Control payloads are tiny and DATA is at most one chunk; anything bigger is a corrupt stream.
  static let maxPayload = 1 << 20
  /// A received clip bigger than this (or bigger than it said it would be) is a broken or hostile peer.
  static let maxClipBytes: Int64 = 256 << 20
  /// Trigger windows the camera accepts (µs, on its own clock): at most this long...
  static let maxWindowUs: Int64 = 60_000_000
  /// ...ending no further ahead than this...
  static let maxAheadUs: Int64 = 15_000_000
  /// ...and starting no further back than this (the camera's ring buffer is far shorter anyway).
  static let maxBehindUs: Int64 = 120_000_000

  private static let hello: UInt8 = 1
  private static let ping: UInt8 = 2
  private static let pong: UInt8 = 3
  private static let state: UInt8 = 4
  private static let trigger: UInt8 = 5
  private static let reject: UInt8 = 6
  private static let clip: UInt8 = 7
  private static let data: UInt8 = 8
  private static let done: UInt8 = 9
  private static let bye: UInt8 = 10

  struct ProtocolError: Error, CustomStringConvertible {
    let description: String
  }

  /// One complete frame, ready to send.
  static func frame(_ message: PeerMessage) throws -> Data {
    let type: UInt8
    let payload: Data
    if case let .data(bytes) = message {
      type = data
      payload = bytes
    } else {
      let (t, json) = try encode(message)
      type = t
      payload = try JSONSerialization.data(withJSONObject: json)
    }
    var out = Data(capacity: headerBytes + payload.count)
    out.append(type)
    var length = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
    out.append(payload)
    return out
  }

  /// Type and payload length from a 5-byte header.
  static func header(_ bytes: Data) throws -> (type: UInt8, length: Int) {
    guard bytes.count == headerBytes else { throw ProtocolError(description: "Short header") }
    let b = [UInt8](bytes)
    let length = Int(b[1]) << 24 | Int(b[2]) << 16 | Int(b[3]) << 8 | Int(b[4])
    guard length <= maxPayload else { throw ProtocolError(description: "Bad frame length \(length)") }
    return (b[0], length)
  }

  static func decode(type: UInt8, payload: Data) throws -> PeerMessage {
    if type == data { return .data(payload) }
    guard let j = try JSONSerialization.jsonObject(with: payload.isEmpty ? Data("{}".utf8) : payload) as? [String: Any] else {
      throw ProtocolError(description: "Payload is not a JSON object")
    }
    return try decode(type: type, json: j)
  }

  static func encode(_ message: PeerMessage) throws -> (UInt8, [String: Any]) {
    switch message {
    case let .hello(version, role, name, platform, fps, view, code):
      var j: [String: Any] = ["v": version, "role": role, "name": name, "platform": platform, "fps": fps, "view": view]
      if !code.isEmpty { j["code"] = code }
      return (hello, j)
    case let .ping(t1, syncUs):
      var j: [String: Any] = ["t1": t1]
      if let syncUs { j["syncUs"] = syncUs }
      return (ping, j)
    case let .pong(t1, t2, t3):
      return (pong, ["t1": t1, "t2": t2, "t3": t3])
    case let .state(s):
      return (state, ["state": s])
    case let .trigger(id, startUs, endUs, anchorUs):
      return (trigger, ["id": id, "startUs": startUs, "endUs": endUs, "anchorUs": anchorUs])
    case let .reject(id, reason):
      return (reject, ["id": id, "reason": reason])
    case let .clip(id, fps, durationMs, anchorOffsetMs, size, width, height):
      return (clip, [
        "id": id, "fps": fps, "durationMs": durationMs, "anchorOffsetMs": anchorOffsetMs, "size": size,
        "width": width, "height": height,
      ])
    case let .done(id):
      return (done, ["id": id])
    case .bye:
      return (bye, [:])
    case .data, .unknown:
      throw ProtocolError(description: "Not a JSON message: \(message)")
    }
  }

  static func decode(type: UInt8, json j: [String: Any]) throws -> PeerMessage {
    func int64(_ key: String) throws -> Int64 {
      guard let n = j[key] as? NSNumber else { throw ProtocolError(description: "Missing \(key)") }
      return n.int64Value
    }
    func double(_ key: String) throws -> Double {
      guard let n = j[key] as? NSNumber else { throw ProtocolError(description: "Missing \(key)") }
      return n.doubleValue
    }
    func string(_ key: String) throws -> String {
      guard let s = j[key] as? String else { throw ProtocolError(description: "Missing \(key)") }
      return s
    }
    func optString(_ key: String) -> String { j[key] as? String ?? "" }

    switch type {
    case hello:
      return .hello(
        version: Int(try int64("v")),
        role: try string("role"),
        name: optString("name"),
        platform: optString("platform"),
        fps: (j["fps"] as? NSNumber)?.intValue ?? 0,
        view: optString("view"),
        code: optString("code")
      )
    case ping:
      return .ping(t1: try int64("t1"), syncUs: (j["syncUs"] as? NSNumber)?.int64Value)
    case pong:
      return .pong(t1: try int64("t1"), t2: try int64("t2"), t3: try int64("t3"))
    case state:
      return .state(try string("state"))
    case trigger:
      return .trigger(id: try string("id"), startUs: try int64("startUs"), endUs: try int64("endUs"), anchorUs: try int64("anchorUs"))
    case reject:
      return .reject(id: try string("id"), reason: optString("reason"))
    case clip:
      return .clip(
        id: try string("id"),
        fps: Int(try int64("fps")),
        durationMs: try double("durationMs"),
        anchorOffsetMs: try double("anchorOffsetMs"),
        size: try int64("size"),
        width: Int((try? int64("width")) ?? 0),
        height: Int((try? int64("height")) ?? 0)
      )
    case done:
      return .done(id: try string("id"))
    case bye:
      return .bye
    default:
      return .unknown(type: type)
    }
  }

  // MARK: - Validation (v2)

  /// `^swing_[0-9]{1,16}$`: the only ids either side builds a file path from.
  static func isValidClipId(_ id: String) -> Bool {
    let prefix = "swing_"
    guard id.hasPrefix(prefix) else { return false }
    let digits = id.utf8.dropFirst(prefix.utf8.count)
    return (1...16).contains(digits.count) && digits.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
  }

  /// Camera side: is `startUs...endUs` (already on our clock) a window we'd plausibly be asked for?
  /// Written so no comparison can overflow, whatever the peer sends (Swift traps on overflow).
  static func isValidWindow(startUs: Int64, endUs: Int64, nowUs: Int64) -> Bool {
    guard startUs < endUs else { return false }
    let (length, lengthOverflow) = endUs.subtractingReportingOverflow(startUs)
    guard !lengthOverflow, length <= maxWindowUs else { return false }
    return endUs <= saturatingAdd(nowUs, maxAheadUs) && startUs >= saturatingAdd(nowUs, -maxBehindUs)
  }

  static func saturatingAdd(_ a: Int64, _ b: Int64) -> Int64 {
    let (sum, overflow) = a.addingReportingOverflow(b)
    guard overflow else { return sum }
    return b > 0 ? .max : .min
  }

  /// Seconds → µs, or nil if it isn't a finite time that fits (Int64(_: Double) traps otherwise).
  static func micros(fromSeconds seconds: Double) -> Int64? {
    let us = (seconds * 1_000_000).rounded()
    guard us.isFinite, us > -9.2e18, us < 9.2e18 else { return nil }
    return Int64(us)
  }

  // MARK: - Pairing code (v2)

  /// A fresh 6-digit code, zero-padded. SystemRandomNumberGenerator is cryptographically secure
  /// (arc4random_buf on Apple platforms, getrandom on Linux).
  static func newPairCode() -> String {
    var rng = SystemRandomNumberGenerator()
    let n = Int.random(in: 0..<1_000_000, using: &rng)
    let digits = String(n)
    return String(repeating: "0", count: 6 - digits.count) + digits
  }

  static func isValidPairCode(_ code: String) -> Bool {
    code.utf8.count == 6 && code.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
  }

  /// Compares in time independent of where the codes differ (a nicety: the 2 s lockout is the real guard).
  static func codesMatch(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8)
    let y = Array(b.utf8)
    guard x.count == y.count else { return false }
    var diff: UInt8 = 0
    for i in 0..<x.count { diff |= x[i] ^ y[i] }
    return diff == 0
  }
}
