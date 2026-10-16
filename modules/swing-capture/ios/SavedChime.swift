import AudioToolbox
import Foundation

/**
 The soft two-note "saved" chime: E6 (1319 Hz) for 90 ms then A6 (1760 Hz) for 140 ms, each with a
 5 ms attack and an exponential decay, peaking around -12 dBFS. Same sound as Android's, synthesized
 here rather than shipped as an asset.

 Played as a system sound so it follows the ring / silent switch like any alert (the switch silences
 AudioServicesPlaySystemSound). The WAV is written to the temporary folder once per process.
 */
enum SavedChime {
  /// Length of the sound itself; the engine mutes impact detection for this plus a margin.
  static let duration = 0.25

  private static let sampleRate = 44_100
  private static let notes: [(hz: Double, seconds: Double)] = [(1319, 0.090), (1760, 0.140)]
  private static let tail = 0.020
  private static let peak = 0.25 // ≈ -12 dBFS
  private static let attack = 0.005

  /// Built on first use (static lets are initialised once, thread-safely); nil if that failed.
  private static let soundId: SystemSoundID? = {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("saved-chime.wav")
    do {
      try wav().write(to: url, options: .atomic)
    } catch {
      NSLog("SwingCapture: couldn't write the saved chime: \(error)")
      return nil
    }
    var id: SystemSoundID = 0
    let status = AudioServicesCreateSystemSoundID(url as CFURL, &id)
    guard status == noErr else {
      NSLog("SwingCapture: couldn't load the saved chime (\(status))")
      return nil
    }
    return id
  }()

  static func play() {
    guard let soundId else { return }
    AudioServicesPlaySystemSound(soundId)
  }

  /// 16-bit mono PCM WAV.
  private static func wav() -> Data {
    var samples: [Int16] = []
    for note in notes {
      let count = Int(note.seconds * Double(sampleRate))
      // Decays to about -40 dB by the end of the note.
      let tau = (note.seconds - attack) / 4.6
      for i in 0..<count {
        let t = Double(i) / Double(sampleRate)
        let envelope = t < attack ? t / attack : exp(-(t - attack) / tau)
        // A 2 ms fade at the very end, so the jump to the next note doesn't click.
        let fade = min(1, (note.seconds - t) / 0.002)
        let value = peak * envelope * fade * sin(2 * Double.pi * note.hz * t)
        samples.append(Int16(max(-1, min(1, value)) * 32_767))
      }
    }
    samples.append(contentsOf: repeatElement(0, count: Int(tail * Double(sampleRate))))

    var data = Data()
    func append<T: FixedWidthInteger>(_ value: T) {
      withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }
    let bytes = samples.count * 2
    data.append(contentsOf: Array("RIFF".utf8))
    append(UInt32(36 + bytes))
    data.append(contentsOf: Array("WAVE".utf8))
    data.append(contentsOf: Array("fmt ".utf8))
    append(UInt32(16)) // PCM format chunk size
    append(UInt16(1)) // PCM
    append(UInt16(1)) // mono
    append(UInt32(sampleRate))
    append(UInt32(sampleRate * 2)) // byte rate
    append(UInt16(2)) // block align
    append(UInt16(16)) // bits per sample
    data.append(contentsOf: Array("data".utf8))
    append(UInt32(bytes))
    for s in samples { append(s) }
    return data
  }
}
