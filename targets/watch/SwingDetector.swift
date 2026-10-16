import Foundation

/**
 Spots a golf swing in wrist rotation data and reports its peak (≈ impact). Line-for-line port of
 wear/.../SwingDetector.kt (same constants, same tempo logic; keep the two in step).

 The lead wrist's rotation speed builds through the backswing, transitions, then spikes through
 the downswing to well over 1,000 °/s at impact before falling away in the follow-through. A
 swing is reported when:
  - the burst of rotation (speed ≥ activeDps) has lasted ≥ minBackswingNs before the peak,
    which rules out flicks, waves and taps;
  - the peak reaches peakDps;
  - speed has fallen to releaseFraction of the peak, so the peak is known (~100-150 ms later).
 Walking arm swing stays well under peakDps. After a swing, the rest of that burst and the next
 refractoryNs are ignored.

 Tempo: from the last few seconds of speeds it also finds the top of the backswing (the slowest
 moment in the topSearchNs before the peak: the wrist pauses as the club changes direction) and the
 takeaway (the last moment before the top that the wrist was still, under stillDps). Backswing is
 takeaway → top, downswing top → peak. Either is nil if it can't be found.

 Times are CMDeviceMotion timestamps (seconds since boot) in nanoseconds. Pure Swift (no Apple
 frameworks) so it's unit-tested on Linux. Not thread-safe: feed it from one queue.
 */
final class SwingDetector {
  /// A detected swing. backswingNs and downswingNs make the tempo (typically ~3 : 1).
  struct Swing: Equatable {
    let peakTimeNs: Int64
    let peakDps: Double
    let backswingNs: Int64?
    let downswingNs: Int64?
  }

  private static let radToDeg = 180.0 / Double.pi
  /// 4 s at 100 Hz.
  private static let history = 400

  private let activeDps: Double
  private let peakDps: Double
  private let minBackswingNs: Int64
  private let releaseFraction: Double
  /// A dip below activeDps shorter than this doesn't end the burst (transition at the top).
  private let gapNs: Int64
  private let refractoryNs: Int64
  private let stillDps: Double
  private let topSearchNs: Int64
  /// The top is at least this long before the peak (the downswing can't be quicker).
  private let minDownswingNs: Int64
  private let onSwing: (Swing) -> Void

  /// Recent (time, speed) samples, oldest overwritten: enough for a slow backswing plus address.
  private var historyTimes = [Int64](repeating: 0, count: SwingDetector.history)
  private var historyDps = [Double](repeating: 0, count: SwingDetector.history)
  private var historyCount = 0
  private var historyNext = 0

  private var burstStartNs: Int64 = -1
  private var lastActiveNs: Int64 = -1
  private var peak = 0.0
  private var peakTimeNs: Int64 = 0
  private var reportedThisBurst = false
  private var lastSwingNs = Int64.min / 2

  init(
    activeDps: Double = 120.0,
    peakDps: Double = 700.0,
    minBackswingNs: Int64 = 300_000_000,
    releaseFraction: Double = 0.6,
    gapNs: Int64 = 250_000_000,
    refractoryNs: Int64 = 1_500_000_000,
    stillDps: Double = 40.0,
    topSearchNs: Int64 = 600_000_000,
    minDownswingNs: Int64 = 100_000_000,
    onSwing: @escaping (Swing) -> Void
  ) {
    self.activeDps = activeDps
    self.peakDps = peakDps
    self.minBackswingNs = minBackswingNs
    self.releaseFraction = releaseFraction
    self.gapNs = gapNs
    self.refractoryNs = refractoryNs
    self.stillDps = stillDps
    self.topSearchNs = topSearchNs
    self.minDownswingNs = minDownswingNs
    self.onSwing = onSwing
  }

  /// Rotation rate sample in rad/s (CMDeviceMotion.rotationRate).
  func onSample(timeNs: Int64, x: Double, y: Double, z: Double) {
    let dps = (x * x + y * y + z * z).squareRoot() * Self.radToDeg
    historyTimes[historyNext] = timeNs
    historyDps[historyNext] = dps
    historyNext = (historyNext + 1) % Self.history
    historyCount = min(historyCount + 1, Self.history)

    if dps >= activeDps {
      if burstStartNs < 0 || timeNs - lastActiveNs > gapNs { startBurst(timeNs) }
      lastActiveNs = timeNs
      if dps > peak {
        peak = dps
        peakTimeNs = timeNs
      }
    } else if burstStartNs >= 0 && timeNs - lastActiveNs > gapNs {
      burstStartNs = -1 // burst over
    }

    if burstStartNs >= 0,
       !reportedThisBurst,
       peak >= peakDps,
       dps <= peak * releaseFraction,
       peakTimeNs - burstStartNs >= minBackswingNs,
       peakTimeNs - lastSwingNs >= refractoryNs {
      reportedThisBurst = true
      lastSwingNs = peakTimeNs
      let topNs = findTop()
      let takeawayNs = topNs.flatMap(findTakeaway)
      var backswingNs: Int64?
      if let topNs, let takeawayNs { backswingNs = topNs - takeawayNs }
      onSwing(
        Swing(
          peakTimeNs: peakTimeNs,
          peakDps: peak,
          backswingNs: backswingNs,
          downswingNs: topNs.map { peakTimeNs - $0 }
        )
      )
    }
  }

  /// Samples oldest first.
  private func forEachSample(_ block: (_ timeNs: Int64, _ dps: Double) -> Void) {
    let first = (historyNext - historyCount + Self.history) % Self.history
    for i in 0..<historyCount {
      let k = (first + i) % Self.history
      block(historyTimes[k], historyDps[k])
    }
  }

  /// The slowest moment between the backswing and the downswing spike.
  private func findTop() -> Int64? {
    var best: Int64?
    var bestDps = Double.greatestFiniteMagnitude
    forEachSample { t, dps in
      if t >= peakTimeNs - topSearchNs && t <= peakTimeNs - minDownswingNs && dps < bestDps {
        bestDps = dps
        best = t
      }
    }
    return best
  }

  /// The last still moment before topNs: when the club started back.
  private func findTakeaway(_ topNs: Int64) -> Int64? {
    var last: Int64?
    forEachSample { t, dps in if t < topNs && dps < stillDps { last = t } }
    return last
  }

  private func startBurst(_ timeNs: Int64) {
    burstStartNs = timeNs
    peak = 0.0
    peakTimeNs = timeNs
    reportedThisBurst = false
  }
}
