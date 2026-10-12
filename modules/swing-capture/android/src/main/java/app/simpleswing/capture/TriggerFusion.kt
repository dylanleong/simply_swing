package app.simpleswing.capture

/**
 * Combines impact sounds with wrist swings from the watch, used while the watch is actively sensing.
 *
 *  - Sound + wrist peak within [windowUs] → IMPACT at the sound time (most precise impact time).
 *  - Sound with no wrist swing within [waitUs] → NO_WRIST: someone else's shot.
 *  - Wrist swing with no sound within [waitUs] → PRACTICE (a swing without a ball), if enabled.
 *  - A wrist message that arrives late (Bluetooth hiccup) still claims a sound rejected in the last
 *    [lateUs], so a real shot isn't lost.
 *
 * Callers pass times on the capture clock and call [poll] at [nextDeadlineUs]. Not thread-safe;
 * the engine serialises access.
 */
class TriggerFusion(
  private val windowUs: Long = 150_000,
  private val waitUs: Long = 500_000,
  private val lateUs: Long = 2_000_000,
) {
  enum class Kind { IMPACT, NO_WRIST, PRACTICE }

  data class Decision(val kind: Kind, val atUs: Long)

  var savePracticeSwings = false

  private val sounds = ArrayList<Long>()
  private val wrists = ArrayList<Long>()
  private val rejected = ArrayList<Long>()

  fun onSound(atUs: Long, nowUs: Long): List<Decision> {
    sounds.add(atUs)
    return poll(nowUs)
  }

  fun onWrist(atUs: Long, nowUs: Long): List<Decision> {
    // Late wrist for a sound we already gave up on: it was a real shot after all.
    val late = rejected.firstOrNull { kotlin.math.abs(it - atUs) <= windowUs }
    if (late != null) {
      rejected.remove(late)
      return listOf(Decision(Kind.IMPACT, late)) + poll(nowUs)
    }
    wrists.add(atUs)
    return poll(nowUs)
  }

  fun poll(nowUs: Long): List<Decision> {
    val out = ArrayList<Decision>()

    val soundIt = sounds.iterator()
    while (soundIt.hasNext()) {
      val s = soundIt.next()
      val w = wrists.firstOrNull { kotlin.math.abs(it - s) <= windowUs }
      if (w != null) {
        wrists.remove(w)
        soundIt.remove()
        out.add(Decision(Kind.IMPACT, s))
      } else if (nowUs - s >= waitUs) {
        soundIt.remove()
        rejected.add(s)
        out.add(Decision(Kind.NO_WRIST, s))
      }
    }

    val wristIt = wrists.iterator()
    while (wristIt.hasNext()) {
      val w = wristIt.next()
      if (nowUs - w >= waitUs) {
        wristIt.remove()
        if (savePracticeSwings) out.add(Decision(Kind.PRACTICE, w))
      }
    }

    rejected.removeAll { nowUs - it > lateUs }
    return out
  }

  /** When [poll] next has something to decide, or null if nothing is pending. */
  fun nextDeadlineUs(): Long? = (sounds + wrists).minOrNull()?.plus(waitUs)

  fun clear() {
    sounds.clear()
    wrists.clear()
    rejected.clear()
  }
}
