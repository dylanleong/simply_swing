import Foundation

/// Direct-form-I biquad (RBJ cookbook). Port of Biquad in ImpactDetector.kt.
final class Biquad {
  private let b0, b1, b2, a1, a2: Double
  private var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0

  init(b0: Double, b1: Double, b2: Double, a1: Double, a2: Double) {
    self.b0 = b0
    self.b1 = b1
    self.b2 = b2
    self.a1 = a1
    self.a2 = a2
  }

  func process(_ x: Double) -> Double {
    let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    return y
  }

  static func highPass(sampleRate: Double, cutoff: Double, q: Double = 1 / 2.0.squareRoot()) -> Biquad {
    let k = tan(Double.pi * cutoff / sampleRate)
    let norm = 1 / (1 + k / q + k * k)
    return Biquad(
      b0: norm,
      b1: -2 * norm,
      b2: norm,
      a1: 2 * (k * k - 1) * norm,
      a2: (1 - k / q + k * k) * norm
    )
  }
}

/// Detects club-on-ball impact in mono PCM. Port of ImpactDetector.kt (same parameters, so both
/// platforms behave alike); see that file for the reasoning behind each threshold.
final class ImpactDetector {
  /// (time in capture-clock seconds, level dB, margin over the noise floor dB, loud enough to count)
  typealias Callback = (_ time: Double, _ levelDb: Double, _ marginDb: Double, _ loudEnough: Bool) -> Void

  private let sampleRate: Double
  private let hop: Int
  private let marginDb: Double
  private let riseDb = 12.0
  let minLevelDb: Double
  private let refractory = 1.0
  private let quietReportInterval = 0.3
  private static let warmupHops = 100

  private let hpf: Biquad
  private var floorHistory = [Double](repeating: 0, count: 400) // 2 s of hops
  private var hopsSeen = 0
  private var floorDb = -90.0
  private var hopsSinceFloorUpdate = 0

  private var prev1Db = -90.0
  private var prev2Db = -90.0
  private var lastImpact = -Double.infinity
  private var lastQuietReport = -Double.infinity

  private var acc = 0.0
  private var accCount = 0
  private var peakAbs = 0.0
  private var peakIndexInHop = 0
  private var hopStart = 0.0

  private let onImpact: Callback

  init(sampleRate: Double, sensitivity: Double, onImpact: @escaping Callback) {
    let s = min(1, max(0, sensitivity))
    self.sampleRate = sampleRate
    self.hop = max(1, Int(sampleRate / 200)) // 5 ms
    self.marginDb = 30 - 15 * s
    self.minLevelDb = -20 - 15 * s
    self.hpf = Biquad.highPass(sampleRate: sampleRate, cutoff: 1500)
    self.onImpact = onImpact
  }

  /// `startTime` is the capture-clock time of samples[0], in seconds.
  func process(_ samples: UnsafeBufferPointer<Float>, startTime: Double) {
    for (i, sample) in samples.enumerated() {
      if accCount == 0 { hopStart = startTime + Double(i) / sampleRate }
      let y = hpf.process(Double(sample))
      acc += y * y
      let a = abs(y)
      if a > peakAbs {
        peakAbs = a
        peakIndexInHop = accCount
      }
      accCount += 1
      if accCount == hop { endHop() }
    }
  }

  private func endHop() {
    let levelDb = 10 * log10(acc / Double(hop) + 1e-12)
    let t = hopStart + Double(peakIndexInHop) / sampleRate
    let margin = levelDb - floorDb
    let sharp = hopsSeen >= Self.warmupHops &&
      levelDb - prev2Db >= riseDb &&
      margin >= marginDb &&
      t - lastImpact >= refractory
    if sharp && levelDb >= minLevelDb {
      lastImpact = t
      onImpact(t, levelDb, margin, true)
    } else if sharp && t - lastQuietReport >= quietReportInterval {
      lastQuietReport = t
      onImpact(t, levelDb, margin, false)
    }
    prev2Db = prev1Db
    prev1Db = levelDb
    updateFloor(levelDb)
    acc = 0
    accCount = 0
    peakAbs = 0
    peakIndexInHop = 0
  }

  private func updateFloor(_ levelDb: Double) {
    floorHistory[hopsSeen % floorHistory.count] = levelDb
    hopsSeen += 1
    hopsSinceFloorUpdate += 1
    if hopsSinceFloorUpdate >= 10 || hopsSeen <= Self.warmupHops {
      hopsSinceFloorUpdate = 0
      let filled = min(hopsSeen, floorHistory.count)
      floorDb = floorHistory[0..<filled].sorted()[filled / 2]
    }
  }
}
