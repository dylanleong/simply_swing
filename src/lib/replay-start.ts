import type { TriggerSource } from '../../modules/swing-capture/src/SwingCapture.types';

/**
 * Where a replay starts, so the golfer sees the swing (not three seconds of address) as soon as it
 * opens. The engine says where impact is for sound-triggered clips; for a button save the anchor is
 * the press, which comes after the finish, so the start reaches further back to cover the swing.
 */

/** Before impact: the downswing plus a little of the transition at ¼ speed. */
export const IMPACT_LEAD_MS = 1200;
/** Before a button press (after the finish): takeaway to finish is ~1.5 s, plus the time to reach for SAVE. */
export const BUTTON_LEAD_MS = 3500;

/** Triggers pressed after the swing, so their anchor is after it. */
const PRESS_SOURCES: readonly TriggerSource[] = ['manual', 'volumeKey', 'watch'];

export type ReplayClip = {
  impactOffsetMs: number | null;
  anchorOffsetMs: number | null;
  durationMs: number | null;
  source: TriggerSource | null;
};

/**
 * Start of the replay loop in ms. The lead before a press is capped at the seconds the save kept
 * ([lookbackSec]); a start past the clip's end (a bad sidecar) falls back to 0.
 */
export function replayStartMs(clip: ReplayClip, lookbackSec: number | null = null): number {
  let start: number;
  if (clip.impactOffsetMs != null) {
    start = clip.impactOffsetMs - IMPACT_LEAD_MS;
  } else if (clip.anchorOffsetMs != null) {
    const pressed = clip.source != null && PRESS_SOURCES.includes(clip.source);
    const lead = pressed ? Math.min(BUTTON_LEAD_MS, lookbackSec != null ? lookbackSec * 1000 : BUTTON_LEAD_MS) : IMPACT_LEAD_MS;
    start = clip.anchorOffsetMs - lead;
  } else {
    return 0;
  }
  if (clip.durationMs != null && start >= clip.durationMs) return 0;
  return Math.max(0, start);
}

/**
 * Where a looping player should be sent back to: [currentSec] has wrapped to before the start point
 * (expo-video loops to 0), so seek to the start again. Null means leave it.
 */
export function loopSeekSec(currentSec: number, startSec: number): number | null {
  // A small margin: the first frames after a seek can report a hair before the target.
  return startSec > 0 && currentSec < startSec - 0.05 ? startSec : null;
}

/** One line under the status pill when the camera couldn't give the frame rate Settings asks for. */
export function frameRateHint(requestedFps: number, activeFps: number | null | undefined): string | null {
  if (activeFps == null || activeFps >= requestedFps) return null;
  return `This phone records at ${activeFps} fps, so slow motion is less smooth.`;
}
