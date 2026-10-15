/**
 * What the golfer adds to a swing: the ball's result, the club, a favourite star and drawings.
 * Kept in `swing_<epochMs>.user.json`, apart from the engine's own `.json` sidecar, so the two never
 * overwrite each other.
 */

export const SHOT_RESULTS = ['good', 'push', 'pull', 'slice', 'hook', 'fat', 'thin', 'top'] as const;
export type ShotResult = (typeof SHOT_RESULTS)[number];

export const RESULT_LABEL: Record<ShotResult, string> = {
  good: 'Good',
  push: 'Push',
  pull: 'Pull',
  slice: 'Slice',
  hook: 'Hook',
  fat: 'Fat',
  thin: 'Thin',
  top: 'Topped',
};

export const CLUBS = ['D', '3W', '5W', 'Hy', '3i', '4i', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW', 'SW', 'LW'] as const;
export type Club = (typeof CLUBS)[number];

/** A point on the clip's picture, 0..1 from the top-left, so drawings survive any screen size. */
export type Point = [number, number];

export type Shape =
  /** A segment between two points. */
  | { kind: 'line'; a: Point; b: Point }
  /** A line through two points, extended across the picture (the swing plane, the spine). */
  | { kind: 'plane'; a: Point; b: Point }
  /** A circle around `center` through `edge` (the head, the ball). */
  | { kind: 'circle'; center: Point; edge: Point }
  /** Two arms from `vertex`, with the angle between them shown. */
  | { kind: 'angle'; vertex: Point; a: Point; b: Point };

/** Drawings per clip: `a` the main clip, `b` the second angle. */
export type Drawings = { a: Shape[]; b: Shape[] };

export type SwingNotes = {
  result: ShotResult | null;
  club: Club | null;
  favorite: boolean;
  drawings: Drawings;
};

export const EMPTY_NOTES: SwingNotes = { result: null, club: null, favorite: false, drawings: { a: [], b: [] } };

const isPoint = (v: unknown): v is Point =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

function parseShape(v: unknown): Shape | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  switch (s.kind) {
    case 'line':
    case 'plane':
      return isPoint(s.a) && isPoint(s.b) ? { kind: s.kind, a: s.a, b: s.b } : null;
    case 'circle':
      return isPoint(s.center) && isPoint(s.edge) ? { kind: 'circle', center: s.center, edge: s.edge } : null;
    case 'angle':
      return isPoint(s.vertex) && isPoint(s.a) && isPoint(s.b)
        ? { kind: 'angle', vertex: s.vertex, a: s.a, b: s.b }
        : null;
    default:
      return null;
  }
}

const parseShapes = (v: unknown): Shape[] =>
  Array.isArray(v) ? v.map(parseShape).filter((s): s is Shape => s !== null) : [];

/** Reads a notes file; anything missing or unrecognised falls back to empty. */
export function parseNotes(json: string | null): SwingNotes {
  if (!json) return EMPTY_NOTES;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return EMPTY_NOTES;
    raw = parsed;
  } catch {
    return EMPTY_NOTES;
  }
  const drawings = (raw.drawings && typeof raw.drawings === 'object' ? raw.drawings : {}) as Record<string, unknown>;
  return {
    result: SHOT_RESULTS.includes(raw.result as ShotResult) ? (raw.result as ShotResult) : null,
    club: CLUBS.includes(raw.club as Club) ? (raw.club as Club) : null,
    favorite: raw.favorite === true,
    drawings: { a: parseShapes(drawings.a), b: parseShapes(drawings.b) },
  };
}

/** "7i · Slice", or '' when nothing is tagged. */
export function notesSummary(notes: Pick<SwingNotes, 'club' | 'result'>): string {
  return [notes.club, notes.result && RESULT_LABEL[notes.result]].filter(Boolean).join(' · ');
}

/** Degrees between an angle's two arms, 0..180, measured on the picture as shown (aspect applied). */
export function angleDegrees(shape: Extract<Shape, { kind: 'angle' }>, aspect: number): number {
  const ax = (shape.a[0] - shape.vertex[0]) * aspect;
  const ay = shape.a[1] - shape.vertex[1];
  const bx = (shape.b[0] - shape.vertex[0]) * aspect;
  const by = shape.b[1] - shape.vertex[1];
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return 0;
  const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Where a plane line through [a] and [b] meets the edges of the picture (both in 0..1), so it can be
 * drawn edge to edge. Returns [a, b] unchanged if they're the same point.
 */
export function extendToEdges(a: Point, b: Point): [Point, Point] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return [a, b];
  // Parametric line a + t·d; keep the t range inside the unit square.
  let tMin = -Infinity;
  let tMax = Infinity;
  for (const [p, d] of [
    [a[0], dx],
    [a[1], dy],
  ]) {
    if (d === 0) continue;
    const t0 = (0 - p) / d;
    const t1 = (1 - p) / d;
    tMin = Math.max(tMin, Math.min(t0, t1));
    tMax = Math.min(tMax, Math.max(t0, t1));
  }
  return [
    [a[0] + tMin * dx, a[1] + tMin * dy],
    [a[0] + tMax * dx, a[1] + tMax * dy],
  ];
}

/** Every clip SimpleSwing records is portrait 9:16, on both platforms. */
export const CLIP_ASPECT = 9 / 16;

export type Rect = { x: number; y: number; width: number; height: number };

/** Where a picture of [aspect] (width / height) sits inside a [width]×[height] view with "contain". */
export function fitRect(width: number, height: number, aspect = CLIP_ASPECT): Rect {
  if (width <= 0 || height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  if (width / height > aspect) {
    const w = height * aspect;
    return { x: (width - w) / 2, y: 0, width: w, height };
  }
  const h = width / aspect;
  return { x: 0, y: (height - h) / 2, width, height: h };
}
