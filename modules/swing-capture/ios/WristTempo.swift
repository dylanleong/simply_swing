import Foundation

/// A swing's timing from the wrist: takeaway → top, and top → impact. Port of WristTempo.kt.
struct WristTempo: Equatable {
  let backswingMs: Int
  let downswingMs: Int
}

/**
 The watch's swing report. Wear OS sends the text "ageMs,peakDps[,backswingMs,downswingMs]"; the Apple
 Watch sends the same fields as a WatchConnectivity dictionary (`["t": "swing", "ageMs": …]`).
 `ageMs` is measured on the watch's own clock (now − peak), so no cross-device clock is needed.
 */
struct WristSwingMessage: Equatable {
  let ageMs: Int
  let peakDps: Int
  let tempo: WristTempo?

  /// The Wear OS text form (kept for parity with WristTempoTest.kt).
  static func parse(_ payload: String) -> WristSwingMessage? {
    let parts = payload.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
    func field(_ i: Int) -> String? { i < parts.count ? parts[i] : nil }
    guard let ageMs = field(0).flatMap({ Int($0) }) else { return nil }
    return make(
      ageMs: ageMs,
      peakDps: field(1).flatMap { Int($0) },
      backswingMs: field(2).flatMap { Int($0) },
      downswingMs: field(3).flatMap { Int($0) }
    )
  }

  /// The Apple Watch dictionary form: ageMs (required), peakDps, backswingMs?, downswingMs?.
  static func parse(_ message: [String: Any]) -> WristSwingMessage? {
    guard let ageMs = integer(message["ageMs"]) else { return nil }
    return make(
      ageMs: ageMs,
      peakDps: integer(message["peakDps"]),
      backswingMs: integer(message["backswingMs"]),
      downswingMs: integer(message["downswingMs"])
    )
  }

  private static func make(ageMs: Int, peakDps: Int?, backswingMs: Int?, downswingMs: Int?) -> WristSwingMessage {
    var tempo: WristTempo?
    if let backswingMs, let downswingMs, backswingMs > 0, downswingMs > 0 {
      tempo = WristTempo(backswingMs: backswingMs, downswingMs: downswingMs)
    }
    return WristSwingMessage(ageMs: ageMs, peakDps: peakDps ?? 0, tempo: tempo)
  }

  /// A whole number from a property-list value. WatchConnectivity delivers numbers as NSNumber, which
  /// bridges to Int (Darwin); a fractional one is rounded. Out of range, not finite or not a number: nil.
  // VERIFY: NSNumber from WatchConnectivity matches `as Int` / `as Double` on device (tested on Linux only).
  static func integer(_ value: Any?) -> Int? {
    switch value {
    case let v as Int: return v
    case let v as Int64: return Int(exactly: v)
    case let v as Int32: return Int(v)
    case let v as Double: return v.isFinite ? Int(exactly: v.rounded()) : nil
    case let v as String: return Int(v)
    default: return nil
    }
  }
}

/**
 Recent wrist tempos by peak time (capture clock, µs), so a saved clip can carry the tempo of the swing
 that triggered it. Thread-safe: the watch link adds on the capture queue, the export task looks up.
 */
final class TempoLog {
  private let keep: Int
  private var entries: [(peakUs: Int64, tempo: WristTempo)] = []
  private let lock = NSLock()

  init(keep: Int = 8) {
    self.keep = keep
  }

  func add(peakUs: Int64, tempo: WristTempo) {
    lock.lock()
    defer { lock.unlock() }
    entries.append((peakUs, tempo))
    if entries.count > keep { entries.removeFirst(entries.count - keep) }
  }

  /// The tempo of the wrist swing that peaked closest to `atUs`, if within `withinUs`.
  func near(_ atUs: Int64, withinUs: Int64 = 500_000) -> WristTempo? {
    lock.lock()
    defer { lock.unlock() }
    func distance(_ peakUs: Int64) -> UInt64 {
      let (d, overflow) = peakUs.subtractingReportingOverflow(atUs)
      return overflow ? UInt64.max : d.magnitude
    }
    return entries
      .filter { distance($0.peakUs) <= UInt64(max(0, withinUs)) }
      .min { distance($0.peakUs) < distance($1.peakUs) }?
      .tempo
  }

  func clear() {
    lock.lock()
    defer { lock.unlock() }
    entries.removeAll()
  }
}
