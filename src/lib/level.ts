/**
 * Is the phone level? A tilted camera makes every plane line and spine angle drawn on the clip lie,
 * and one pointing up or down distorts the golfer, so the Capture screen checks it from gravity.
 */

/** Degrees of sideways tilt (rotation in the screen's plane) and of the camera pointing up or down. */
export type Tilt = { rollDeg: number; pitchDeg: number };

const DEG = 180 / Math.PI;

/** Sideways tilt that still counts as level: drawn lines stay within about a club-shaft width. */
export const ROLL_TOLERANCE_DEG = 2;
/** Up/down aim that still counts as level. */
export const PITCH_TOLERANCE_DEG = 8;

/**
 * From the accelerometer's gravity reading in device axes (portrait: x across, y along, z out of the
 * screen). Only the axes' sizes are trusted for pitch; roll keeps its sign so the horizon can be drawn.
 */
export function tiltFromGravity(x: number, y: number, z: number): Tilt {
  return {
    rollDeg: Math.atan2(x, Math.abs(y)) * DEG,
    pitchDeg: Math.atan2(Math.abs(z), Math.hypot(x, y)) * DEG,
  };
}

/** Smooths readings so the indicator doesn't jitter: exponential moving average. */
export function smoothTilt(prev: Tilt | null, next: Tilt, alpha = 0.2): Tilt {
  if (!prev) return next;
  return {
    rollDeg: prev.rollDeg + alpha * (next.rollDeg - prev.rollDeg),
    pitchDeg: prev.pitchDeg + alpha * (next.pitchDeg - prev.pitchDeg),
  };
}

/** What to tell the golfer, or null when the phone is level. */
export function levelAdvice(t: Tilt): string | null {
  const roll = Math.abs(t.rollDeg);
  if (roll > 45 || t.pitchDeg > 45) return null; // Lying flat or sideways: being carried, not set up.
  if (roll > ROLL_TOLERANCE_DEG) return `Tilted ${Math.round(roll)}° sideways: straighten the phone`;
  if (t.pitchDeg > PITCH_TOLERANCE_DEG) return `Aimed ${Math.round(t.pitchDeg)}° off level: point it straight at the golfer`;
  return null;
}
