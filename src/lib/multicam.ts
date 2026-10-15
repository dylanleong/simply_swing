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

/**
 * How a second clip follows the first: at `tA` seconds into the first it shows `tA + shiftSec`
 * (clamped to its own length). Used for a swing's two angles and for comparing two swings.
 */
export type Link = { shiftSec: number; durationSec: number | null; fps: number | null };

export function linkedTimeSec(tA: number, link: Link): number {
  const end = link.durationSec ?? Infinity;
  return Math.min(Math.max(0, tA + link.shiftSec), end);
}

/** Seconds to seek the second clip by to bring it back in line, or 0 if it's within one of its frames. */
export function linkDriftSec(posA: number, posB: number, link: Link): number {
  const drift = linkedTimeSec(posA, link) - posB;
  return Math.abs(drift) > 1 / (link.fps ?? 120) ? drift : 0;
}

/** A swing's second angle, lined up on the shared anchor (plus the review nudge). */
export function angleLink(swing: Pick<Swing, 'anchorOffsetMs'>, angle: Angle): Link {
  return {
    shiftSec: angleShiftSec(swing, angle),
    durationSec: angle.durationMs == null ? null : angle.durationMs / 1000,
    fps: angle.fps,
  };
}

/** The moment two different swings are lined up on: impact if known, else the trigger. */
export const swingAnchorMs = (s: Pick<Swing, 'impactOffsetMs' | 'anchorOffsetMs'>) =>
  s.impactOffsetMs ?? s.anchorOffsetMs ?? 0;

/** Swing [b] following swing [a], lined up on their impacts, nudged by [nudgeMs]. */
export function compareLink(
  a: Pick<Swing, 'impactOffsetMs' | 'anchorOffsetMs'>,
  b: Pick<Swing, 'impactOffsetMs' | 'anchorOffsetMs' | 'durationMs' | 'fps'>,
  nudgeMs = 0
): Link {
  return {
    shiftSec: (swingAnchorMs(b) - swingAnchorMs(a) + nudgeMs) / 1000,
    durationSec: b.durationMs == null ? null : b.durationMs / 1000,
    fps: b.fps,
  };
}

/** Where the second angle should be when the main clip is at [tA] seconds (clamped to the clip). */
export function angleTimeSec(tA: number, swing: Pick<Swing, 'anchorOffsetMs'>, angle: Angle): number {
  return linkedTimeSec(tA, angleLink(swing, angle));
}

/** Review shows both angles, or one of them full size. */
export type ReviewLayout = 'both' | 'a' | 'b';

/** What Save / Share exports: one clip, or both side by side with the angle `shiftMs` ahead of the main clip. */
export type ExportSource = { uri: string; angle: { uri: string; shiftMs: number } | null };

/** Both angles side by side when both are on screen, otherwise the one that is. */
export function exportSource(
  swing: Pick<Swing, 'uri' | 'anchorOffsetMs'>,
  angle: Angle | null,
  layout: ReviewLayout
): ExportSource {
  if (!angle || layout === 'a') return { uri: swing.uri, angle: null };
  if (layout === 'b') return { uri: angle.uri, angle: null };
  return { uri: swing.uri, angle: { uri: angle.uri, shiftMs: angleShiftSec(swing, angle) * 1000 } };
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
  return linkDriftSec(posA, posB, angleLink(swing, angle));
}

/** "±2 ms" for the sync readout; under 1 ms reads as "±1 ms" (sub-frame either way). */
export function formatSync(syncMs: number | null): string | null {
  if (syncMs == null) return null;
  return `±${Math.max(1, Math.round(syncMs))} ms`;
}
