import Foundation

/// Was the golfer swinging just before an impact sound? Port of MotionGate.kt (same thresholds).
/// Fed ~15 small upright luma frames per second; measures the percentage of golfer-box pixels whose
/// brightness changed by at least `pixelDelta` (a mean change drowns a thin club and arms).
final class MotionGate {
  struct Verdict {
    let peak: Double
    let threshold: Double
    let passed: Bool
  }

  private let lookback: Double
  private let history: Double
  /// Percent of box pixels.
  private let minMotion: Double
  private let thresholdFactor: Double
  private let pixelDelta: Int
  private static let minSamples = 15
  private static let slack = 0.15

  private var roi: NormalizedRoi
  private var previous: [UInt8]?
  private var previousSize = (0, 0)
  private var times: [Double] = []
  private var energies: [Double] = []
  private let lock = NSLock()

  init(
    roi: NormalizedRoi,
    lookback: Double = 1.5,
    history: Double = 6.0,
    minMotion: Double = 1.0,
    thresholdFactor: Double = 3.0,
    pixelDelta: Int = 18
  ) {
    self.roi = roi.sanitized()
    self.lookback = lookback
    self.history = history
    self.minMotion = minMotion
    self.thresholdFactor = thresholdFactor
    self.pixelDelta = pixelDelta
  }

  /// Returns true if the box actually changed. Out-of-range or non-finite boxes are clamped (or
  /// replaced by the default) first: `addFrame` turns them into pixel indices.
  @discardableResult
  func setRoi(_ newRoi: NormalizedRoi) -> Bool {
    let roi = newRoi.sanitized()
    lock.lock()
    defer { lock.unlock() }
    if self.roi == roi { return false }
    self.roi = roi
    return true
  }

  func reset() {
    lock.lock()
    defer { lock.unlock() }
    previous = nil
    times.removeAll()
    energies.removeAll()
  }

  /// `luma` is row-major width x height, upright (portrait) orientation.
  func addFrame(time: Double, luma: [UInt8], width: Int, height: Int) {
    lock.lock()
    defer { lock.unlock() }
    if let prev = previous, previousSize == (width, height) {
      let x0 = min(max(Int(roi.x * Double(width)), 0), width - 1)
      let y0 = min(max(Int(roi.y * Double(height)), 0), height - 1)
      let x1 = min(max(Int((roi.x + roi.width) * Double(width)), x0 + 1), width)
      let y1 = min(max(Int((roi.y + roi.height) * Double(height)), y0 + 1), height)
      var changed = 0
      for y in y0..<y1 {
        let row = y * width
        for x in x0..<x1 where abs(Int(luma[row + x]) - Int(prev[row + x])) >= pixelDelta {
          changed += 1
        }
      }
      times.append(time)
      energies.append(100 * Double(changed) / Double((x1 - x0) * (y1 - y0)))
      while let first = times.first, time - first > history {
        times.removeFirst()
        energies.removeFirst()
      }
    }
    previous = luma
    previousSize = (width, height)
  }

  /// nil when there is too little history to judge.
  func evaluate(impact: Double) -> Verdict? {
    lock.lock()
    defer { lock.unlock() }
    guard energies.count >= Self.minSamples else { return nil }
    var peak = 0.0
    for (t, e) in zip(times, energies) where t >= impact - lookback && t <= impact + Self.slack {
      peak = max(peak, e)
    }
    let quiet = energies.sorted()[energies.count / 4]
    let threshold = max(minMotion, quiet * thresholdFactor)
    return Verdict(peak: peak, threshold: threshold, passed: peak >= threshold)
  }

  func latest() -> Double? {
    lock.lock()
    defer { lock.unlock() }
    return energies.last
  }

  /// Peak motion over the last `span` seconds (the UI samples twice a second; a downswing is ~0.3 s).
  func peak(since time: Double, span: Double) -> Double? {
    lock.lock()
    defer { lock.unlock() }
    var result: Double?
    for (t, e) in zip(times, energies) where t >= time - span {
      result = max(result ?? 0, e)
    }
    return result
  }
}
