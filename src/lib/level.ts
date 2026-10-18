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

/** Sideways roll from here up (near ±90°) is a phone mounted landscape, not one being carried. */
export const LANDSCAPE_ROLL_DEG = 60;

/**
 * The tilt in the screen's frame. The accelerometer reads device axes, so on a tablet turned to
 * landscape a perfectly level mount reads as ±90° of roll; what the golfer needs is how far it is
 * from that. Portrait screens are the device frame already.
 */
export function tiltForScreen(t: Tilt, landscape: boolean): Tilt {
  if (!landscape) return t;
  // VERIFY on a tablet: the sign decides which way the horizon bar leans; flip it here if it's backwards.
  const roll = Math.sign(t.rollDeg || 1) * (Math.abs(t.rollDeg) - 90);
  return { rollDeg: roll, pitchDeg: t.pitchDeg };
}

/**
 * What to tell the golfer, or null when the device is level. [landscape] is the screen's
 * orientation: a large screen on its side is a landscape mount, not a phone that needs turning.
 */
export function levelAdvice(t: Tilt, landscape = false): string | null {
  const roll = Math.abs(t.rollDeg);
  if (t.pitchDeg > 45) return null; // Lying flat: being carried, not set up.
  // A phone's preview and golfer box are portrait; a landscape mount is on its side, not just tilted.
  if (roll >= LANDSCAPE_ROLL_DEG) return landscape ? null : 'Mount the phone upright';
  if (roll > 45) return null; // Half way over: in hand.
  if (roll > ROLL_TOLERANCE_DEG) return `Tilted ${Math.round(roll)}° sideways: straighten the ${landscape ? 'tablet' : 'phone'}`;
  if (t.pitchDeg > PITCH_TOLERANCE_DEG) return `Aimed ${Math.round(t.pitchDeg)}° off level: point it straight at the golfer`;
  return null;
}
