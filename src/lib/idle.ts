/** No touches, swings or movement in the golfer box for this long: dim the screen. */
export const DIM_AFTER_MS = 30_000;
/** ...and for this long: drop the camera to low-power standby. */
export const STANDBY_AFTER_MS = 5 * 60_000;
/** Dimmed screen brightness (0-1): visible up close, negligible drain. */
export const DIM_BRIGHTNESS = 0.05;

export type IdlePhase = 'active' | 'dimmed' | 'standby';

export type IdleOptions = { dimScreen: boolean; autoStandby: boolean };

/** Where an idle capture screen should be after [idleMs] without activity. */
export function idlePhase(idleMs: number, opts: IdleOptions): IdlePhase {
  if (opts.autoStandby && idleMs >= STANDBY_AFTER_MS) return 'standby';
  if (opts.dimScreen && idleMs >= DIM_AFTER_MS) return 'dimmed';
  return 'active';
}

/** Standby also dims, unless the user turned dimming off. */
export const shouldDim = (phase: IdlePhase, opts: IdleOptions) => opts.dimScreen && phase !== 'active';
