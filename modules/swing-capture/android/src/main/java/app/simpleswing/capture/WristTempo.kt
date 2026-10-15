package app.simpleswing.capture

/** A swing's timing from the wrist: takeaway → top, and top → impact. */
data class WristTempo(val backswingMs: Long, val downswingMs: Long)

/** The watch's swing message: "ageMs,peakDps[,backswingMs,downswingMs]" (see wear/WearProtocol). */
data class WristSwingMessage(val ageMs: Long, val peakDps: Int, val tempo: WristTempo?) {
  companion object {
    fun parse(payload: String): WristSwingMessage? {
      val parts = payload.split(",")
      val ageMs = parts.getOrNull(0)?.toLongOrNull() ?: return null
      val peakDps = parts.getOrNull(1)?.toIntOrNull() ?: 0
      val backswingMs = parts.getOrNull(2)?.toLongOrNull()
      val downswingMs = parts.getOrNull(3)?.toLongOrNull()
      val tempo = if (backswingMs != null && downswingMs != null && backswingMs > 0 && downswingMs > 0) {
        WristTempo(backswingMs, downswingMs)
      } else {
        null
      }
      return WristSwingMessage(ageMs, peakDps, tempo)
    }
  }
}

/**
 * Recent wrist tempos by peak time (capture clock), so a saved clip can carry the tempo of the swing
 * that triggered it. Thread-safe: the watch link adds, the export thread looks up.
 */
class TempoLog(private val keep: Int = 8) {
  private val entries = ArrayDeque<Pair<Long, WristTempo>>()

  @Synchronized
  fun add(peakUs: Long, tempo: WristTempo) {
    entries.addLast(peakUs to tempo)
    while (entries.size > keep) entries.removeFirst()
  }

  /** The tempo of the wrist swing that peaked closest to [atUs], if within [withinUs]. */
  @Synchronized
  fun near(atUs: Long, withinUs: Long = 500_000): WristTempo? =
    entries.filter { kotlin.math.abs(it.first - atUs) <= withinUs }.minByOrNull { kotlin.math.abs(it.first - atUs) }?.second

  @Synchronized
  fun clear() = entries.clear()
}
