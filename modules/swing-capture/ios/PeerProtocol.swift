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
  case hello(version: Int, role: String, name: String, platform: String, fps: Int, view: String)
  /// `syncUs` is the main phone's current sync uncertainty, so the camera phone can show it too.
  case ping(t1: Int64, syncUs: Int64?)
  case pong(t1: Int64, t2: Int64, t3: Int64)
  case state(String)
  /// Save `startUs`...`endUs`; `anchorUs` is the impact (or button press) both clips are aligned on.
  case trigger(id: String, startUs: Int64, endUs: Int64, anchorUs: Int64)
  case reject(id: String, reason: String)
  /// `anchorOffsetMs`: where the anchor instant falls in the clip (may lie outside it).
  case clip(id: String, fps: Int, durationMs: Double, anchorOffsetMs: Double, size: Int64)
  case data(Data)
  case done(id: String)
  case bye
  /// A message type from a newer app version; ignored.
  case unknown(type: UInt8)
}

enum PeerProtocol {
  static let version = 1
  /// Bonjour type, without the trailing dot NsdManager uses.
  static let serviceType = "_simpleswing._tcp"
  static let defaultPort: UInt16 = 47800
  static let chunkBytes = 64 * 1024
  static let headerBytes = 5
  /// Control payloads are tiny and DATA is at most one chunk; anything bigger is a corrupt stream.
  static let maxPayload = 1 << 20

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
    case let .hello(version, role, name, platform, fps, view):
      return (hello, ["v": version, "role": role, "name": name, "platform": platform, "fps": fps, "view": view])
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
    case let .clip(id, fps, durationMs, anchorOffsetMs, size):
      return (clip, ["id": id, "fps": fps, "durationMs": durationMs, "anchorOffsetMs": anchorOffsetMs, "size": size])
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
        view: optString("view")
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
        size: try int64("size")
      )
    case done:
      return .done(id: try string("id"))
    case bye:
      return .bye
    default:
      return .unknown(type: type)
    }
  }
}
