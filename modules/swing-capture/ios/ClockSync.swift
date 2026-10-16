import Foundation

/**
 Estimates the offset between our capture clock and a peer phone's, NTP style. Line-for-line port of
 ClockSync.kt (see there for the reasoning). Times are microseconds. Not thread-safe; callers
 serialise (PeerLink uses it on its own queue only).
 */
final class ClockSync {
  private struct Sample {
    let offsetUs: Int64
    let rttUs: Int64
  }

  /// Round trips longer than this are a stalled link, not a measurement.
  static let maxRttUs: Int64 = 500_000
  /// Two plausible samples differ by at most maxRttUs; more means a clock changed base.
  static let jumpUs: Int64 = 2 * maxRttUs

  private let maxSamples: Int
  private var samples: [Sample] = []

  init(maxSamples: Int = 20) {
    self.maxSamples = maxSamples
  }

  /// Adds one ping exchange. Returns false if it was implausible and ignored. The peer's times are
  /// untrusted, so every step is overflow-checked: a sample whose arithmetic would overflow is
  /// rejected rather than trapping (Swift's `+`/`-` crash on overflow).
  @discardableResult
  func add(t1: Int64, t2: Int64, t3: Int64, t4: Int64) -> Bool {
    guard let there = Self.sub(t4, t1), let away = Self.sub(t3, t2), let rtt = Self.sub(there, away),
          rtt >= 0, rtt <= Self.maxRttUs,
          let out = Self.sub(t2, t1), let back = Self.sub(t3, t4), let twice = Self.add(out, back)
    else { return false }
    let offset = twice / 2
    // Results must stay usable: toPeer/toLocal add the offset to times on our clock.
    guard offset > Int64.min / 2, offset < Int64.max / 2 else { return false }
    if let best, abs(offset - best.offsetUs) > Self.jumpUs { samples.removeAll() }
    samples.append(Sample(offsetUs: offset, rttUs: rtt))
    if samples.count > maxSamples { samples.removeFirst(samples.count - maxSamples) }
    return true
  }

  func clear() {
    samples.removeAll()
  }

  private var best: Sample? { samples.min { $0.rttUs < $1.rttUs } }

  /// Peer clock minus ours, or nil before the first sample.
  var offsetUs: Int64? { best?.offsetUs }

  /// Worst-case error of `offsetUs`: half the best round trip.
  var errorUs: Int64? { best.map { $0.rttUs / 2 } }

  /// A time on our clock expressed on the peer's clock (nil before the first sample, or on overflow).
  func toPeer(_ localUs: Int64) -> Int64? { offsetUs.flatMap { Self.add(localUs, $0) } }

  /// A time on the peer's clock expressed on ours (nil before the first sample, or on overflow).
  func toLocal(_ peerUs: Int64) -> Int64? { offsetUs.flatMap { Self.sub(peerUs, $0) } }

  private static func add(_ a: Int64, _ b: Int64) -> Int64? {
    let (r, overflow) = a.addingReportingOverflow(b)
    return overflow ? nil : r
  }

  private static func sub(_ a: Int64, _ b: Int64) -> Int64? {
    let (r, overflow) = a.subtractingReportingOverflow(b)
    return overflow ? nil : r
  }
}
