import type { CameraView } from '../../modules/swing-capture/src/SwingCapture.types';

import type { Angle, Swing } from './swing-library';

/**
 * Two-angle review maths. Both phones were told the same anchor instant (the impact, or the button
 * press) on their own clock, and each clip records where that instant falls. So a moment `tA`
 * seconds into the main clip is `tA − anchorA + anchorB (+ nudge)` seconds into the second angle,
 * with no absolute times shared between the files.
 */

export const VIEW_LABEL: Record<CameraView, string> = { dtl: 'Down the line', faceOn: 'Face on' };

export const SHORT_VIEW_LABEL: Record<CameraView, string> = { dtl: 'DTL', faceOn: 'Face on' };

/** Golf setups pair the two classic views, so each phone is whichever the other isn't. */
export const otherView = (view: CameraView): CameraView => (view === 'dtl' ? 'faceOn' : 'dtl');

/** Labels for the main clip and the second angle in review. */
export function angleLabels(angle: Angle): [string, string] {
  if (!angle.view) return ['Angle 1', 'Angle 2'];
  return [SHORT_VIEW_LABEL[otherView(angle.view)], SHORT_VIEW_LABEL[angle.view]];
}

/** Seconds from main-clip time to second-angle time. */
export function angleShiftSec(swing: Pick<Swing, 'anchorOffsetMs'>, angle: Angle): number {
  return (angle.anchorOffsetMs + angle.nudgeMs - (swing.anchorOffsetMs ?? 0)) / 1000;
}

/** Where the second angle should be when the main clip is at [tA] seconds (clamped to the clip). */
export function angleTimeSec(tA: number, swing: Pick<Swing, 'anchorOffsetMs'>, angle: Angle): number {
  const t = tA + angleShiftSec(swing, angle);
  const end = angle.durationMs == null ? Infinity : angle.durationMs / 1000;
  return Math.min(Math.max(0, t), end);
}

/** One frame of the second angle, the step for manual alignment. */
export const nudgeStepMs = (fps: number | null) => 1000 / (fps ?? 120);

/**
 * Seconds to seek the second angle by to bring it back in line, or 0 if it's within one of its
 * frames (two native players drift apart while playing; seeking on every tick would stutter).
 */
export function driftCorrectionSec(
  posA: number,
  posB: number,
  swing: Pick<Swing, 'anchorOffsetMs'>,
  angle: Angle
): number {
  const drift = angleTimeSec(posA, swing, angle) - posB;
  return Math.abs(drift) > 1 / (angle.fps ?? 120) ? drift : 0;
}

/** "±2 ms" for the sync readout; under 1 ms reads as "±1 ms" (sub-frame either way). */
export function formatSync(syncMs: number | null): string | null {
  if (syncMs == null) return null;
  return `±${Math.max(1, Math.round(syncMs))} ms`;
}
