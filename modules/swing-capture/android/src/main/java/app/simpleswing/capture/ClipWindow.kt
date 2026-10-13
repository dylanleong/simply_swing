package app.simpleswing.capture

/**
 * Which span of the rolling buffer becomes the saved clip. [anchorUs] is the trigger instant (the
 * impact, or the button press); a paired camera phone gets the same instant on its own clock, so
 * the two angles line up on it.
 */
data class ClipWindow(val startUs: Long, val endUs: Long, val impactUs: Long?, val anchorUs: Long)

object ClipWindows {
  /** Margin kept in the ring beyond the longest clip, so post-roll and export never race pruning. */
  const val RING_MARGIN_US = 1_500_000L

  /**
   * Impact triggers know when the ball was struck, so the clip is centred on it.
   * Manual, volume-key and watch triggers are pressed *after* the swing (the golfer walks to the
   * phone or taps the watch at the finish), so they save the last [lookbackUs] plus a short tail.
   */
  fun forTrigger(source: TriggerSource, triggerUs: Long, config: CaptureConfig): ClipWindow =
    when (source) {
      // A wrist swing's peak is the impact moment, so it's centred like an impact.
      TriggerSource.IMPACT, TriggerSource.WRIST -> ClipWindow(
        startUs = triggerUs - config.preRollUs,
        endUs = triggerUs + config.postRollUs,
        impactUs = triggerUs,
        anchorUs = triggerUs,
      )
      else -> ClipWindow(
        startUs = triggerUs - config.lookbackUs,
        endUs = triggerUs + MANUAL_TAIL_US,
        impactUs = null,
        anchorUs = triggerUs,
      )
    }

  fun ringWindowUs(config: CaptureConfig): Long =
    maxOf(config.preRollUs + config.postRollUs, config.lookbackUs + MANUAL_TAIL_US) + RING_MARGIN_US

  private const val MANUAL_TAIL_US = 300_000L
}
