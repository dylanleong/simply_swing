/**
 Combines impact sounds with wrist swings from the watch, used while the watch is actively sensing.
 Line-for-line port of TriggerFusion.kt (keep the two in step).

  - Sound + wrist peak within `windowUs` → impact at the sound time (most precise impact time).
  - Sound with no wrist swing within `waitUs` → noWrist: someone else's shot.
  - Wrist swing with no sound within `waitUs` → practice (a swing without a ball), if enabled.
  - A wrist message that arrives late (Bluetooth hiccup) still claims a sound rejected in the last
    `lateUs`, so a real shot isn't lost.

 Callers pass times on the capture clock (microseconds) and call `poll` at `nextDeadlineUs()`. Not
 thread-safe; the engine uses it on its capture queue only. Pure Swift (no Foundation), so it's
 unit-tested on Linux.
 */
final class TriggerFusion {
  enum Kind: Equatable {
    case impact
    case noWrist
    case practice
  }

  struct Decision: Equatable {
    let kind: Kind
    let atUs: Int64
  }

  var savePracticeSwings = false

  private let windowUs: Int64
  private let waitUs: Int64
  private let lateUs: Int64
  private var sounds: [Int64] = []
  private var wrists: [Int64] = []
  private var rejected: [Int64] = []

  init(windowUs: Int64 = 150_000, waitUs: Int64 = 500_000, lateUs: Int64 = 2_000_000) {
    self.windowUs = windowUs
    self.waitUs = waitUs
    self.lateUs = lateUs
  }

  func onSound(atUs: Int64, nowUs: Int64) -> [Decision] {
    sounds.append(atUs)
    return poll(nowUs: nowUs)
  }

  func onWrist(atUs: Int64, nowUs: Int64) -> [Decision] {
    // Late wrist for a sound we already gave up on: it was a real shot after all.
    if let index = rejected.firstIndex(where: { Self.within($0, atUs, windowUs) }) {
      let late = rejected.remove(at: index)
      return [Decision(kind: .impact, atUs: late)] + poll(nowUs: nowUs)
    }
    wrists.append(atUs)
    return poll(nowUs: nowUs)
  }

  func poll(nowUs: Int64) -> [Decision] {
    var out: [Decision] = []

    var keptSounds: [Int64] = []
    for s in sounds {
      if let index = wrists.firstIndex(where: { Self.within($0, s, windowUs) }) {
        wrists.remove(at: index)
        out.append(Decision(kind: .impact, atUs: s))
      } else if Self.elapsed(nowUs, since: s) >= waitUs {
        rejected.append(s)
        out.append(Decision(kind: .noWrist, atUs: s))
      } else {
        keptSounds.append(s)
      }
    }
    sounds = keptSounds

    var keptWrists: [Int64] = []
    for w in wrists {
      if Self.elapsed(nowUs, since: w) >= waitUs {
        if savePracticeSwings { out.append(Decision(kind: .practice, atUs: w)) }
      } else {
        keptWrists.append(w)
      }
    }
    wrists = keptWrists

    rejected.removeAll { Self.elapsed(nowUs, since: $0) > lateUs }
    return out
  }

  /// When `poll` next has something to decide, or nil if nothing is pending.
  func nextDeadlineUs() -> Int64? {
    guard let first = (sounds + wrists).min() else { return nil }
    return first.addingReportingOverflow(waitUs).overflow ? Int64.max : first + waitUs
  }

  func clear() {
    sounds.removeAll()
    wrists.removeAll()
    rejected.removeAll()
  }

  /// |a - b| <= limit without trapping on extreme values (Swift arithmetic traps on overflow).
  private static func within(_ a: Int64, _ b: Int64, _ limit: Int64) -> Bool {
    let (d, overflow) = a.subtractingReportingOverflow(b)
    return !overflow && d.magnitude <= UInt64(limit)
  }

  /// now - then, saturating instead of trapping.
  private static func elapsed(_ now: Int64, since then: Int64) -> Int64 {
    let (d, overflow) = now.subtractingReportingOverflow(then)
    if overflow { return now > then ? Int64.max : Int64.min }
    return d
  }
}
