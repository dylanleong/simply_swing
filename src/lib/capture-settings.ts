import type { NormalizedRect } from '../../modules/swing-capture/src/SwingCapture.types';

export type Sensitivity = 'low' | 'medium' | 'high';

/** Capture preferences that survive restarts. */
export type CaptureSettings = {
  /** Golfer box in normalised preview coordinates. */
  roi: NormalizedRect;
  /** Auto-save on impact sound. */
  soundTrigger: boolean;
  /** The "How it works" card has been shown once. */
  seenHelp: boolean;
  /** Requested capture rate; the camera falls back to the best it supports. */
  fps: 60 | 120 | 240;
  /** Auto-saved clips: seconds kept before impact (1.5 s after is fixed). */
  preRollSec: 2 | 3 | 4;
  /** SAVE / remote / watch: seconds kept, ending when pressed. */
  lookbackSec: 4 | 6 | 8;
  /** How loud a strike must be to count. */
  sensitivity: Sensitivity;
  /** Favour a faster shutter (crisper club) at the cost of a slightly darker image. */
  sharpMode: boolean;
  /** Delete clips older than this many days; 0 keeps everything. */
  autoDeleteDays: 0 | 7 | 30;
  /** Dim the screen between shots. */
  dimScreen: boolean;
  /** Low-power camera standby when nobody has been in the golfer box for a while. */
  autoStandby: boolean;
};

export const FPS_OPTIONS = [60, 120, 240] as const;
export const PRE_ROLL_OPTIONS = [2, 3, 4] as const;
export const LOOKBACK_OPTIONS = [4, 6, 8] as const;
export const SENSITIVITY_OPTIONS = ['low', 'medium', 'high'] as const;
export const AUTO_DELETE_OPTIONS = [0, 7, 30] as const;

/** Detector sensitivity (0..1) for each user-facing level. */
export const SENSITIVITY_VALUE: Record<Sensitivity, number> = { low: 0.2, medium: 0.5, high: 0.8 };

/** Seconds recorded after an impact. Covers the finish; not worth a setting. */
export const POST_ROLL_SEC = 1.5;

/** Centre of the frame, most of the height: where a golfer stands when the phone is set up per the guide. */
export const DEFAULT_ROI: NormalizedRect = { x: 0.25, y: 0.1, width: 0.5, height: 0.85 };

export const DEFAULT_SETTINGS: CaptureSettings = {
  roi: DEFAULT_ROI,
  soundTrigger: true,
  seenHelp: false,
  fps: 120,
  preRollSec: 3,
  lookbackSec: 6,
  sensitivity: 'medium',
  sharpMode: false,
  autoDeleteDays: 0,
  dimScreen: true,
  autoStandby: true,
};

/** Smallest golfer box, as a fraction of the preview on each axis. */
export const MIN_ROI_SIZE = 0.15;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Vertical band of the preview not covered by on-screen controls, normalised 0..1. */
export type RoiBounds = { minY: number; maxY: number };

export const FULL_BOUNDS: RoiBounds = { minY: 0, maxY: 1 };

/** Keeps a box inside [bounds] (the clear part of the preview) and at least MIN_ROI_SIZE on each side. */
export function clampRoi(r: NormalizedRect, bounds: RoiBounds = FULL_BOUNDS): NormalizedRect {
  const span = Math.max(MIN_ROI_SIZE, bounds.maxY - bounds.minY);
  const width = clamp(r.width, MIN_ROI_SIZE, 1);
  const height = clamp(r.height, MIN_ROI_SIZE, span);
  return {
    x: clamp(r.x, 0, 1 - width),
    y: clamp(r.y, bounds.minY, bounds.minY + span - height),
    width,
    height,
  };
}

function isRoi(v: unknown): v is NormalizedRect {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]));
}

function oneOf<T>(options: readonly T[], value: unknown, fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

/** Parses stored settings, falling back to defaults for anything missing or malformed. */
export function parseSettings(json: string | null): CaptureSettings {
  if (!json) return DEFAULT_SETTINGS;
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS;
    raw = parsed;
  } catch {
    return DEFAULT_SETTINGS;
  }
  const d = DEFAULT_SETTINGS;
  return {
    roi: isRoi(raw.roi) ? clampRoi(raw.roi) : d.roi,
    soundTrigger: bool(raw.soundTrigger, d.soundTrigger),
    seenHelp: bool(raw.seenHelp, d.seenHelp),
    fps: oneOf(FPS_OPTIONS, raw.fps, d.fps),
    preRollSec: oneOf(PRE_ROLL_OPTIONS, raw.preRollSec, d.preRollSec),
    lookbackSec: oneOf(LOOKBACK_OPTIONS, raw.lookbackSec, d.lookbackSec),
    sensitivity: oneOf(SENSITIVITY_OPTIONS, raw.sensitivity, d.sensitivity),
    sharpMode: bool(raw.sharpMode, d.sharpMode),
    autoDeleteDays: oneOf(AUTO_DELETE_OPTIONS, raw.autoDeleteDays, d.autoDeleteDays),
    dimScreen: bool(raw.dimScreen, d.dimScreen),
    autoStandby: bool(raw.autoStandby, d.autoStandby),
  };
}
