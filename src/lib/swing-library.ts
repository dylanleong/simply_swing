import type { CameraView, TriggerSource } from '../../modules/swing-capture/src/SwingCapture.types';

/** The second camera's clip of a swing (`swing_<epochMs>.b.mp4` + `.b.json`), from a paired phone. */
export type Angle = {
  uri: string;
  fps: number | null;
  durationMs: number | null;
  /** Where the shared anchor instant (impact or button press) falls in this clip. */
  anchorOffsetMs: number;
  /** The camera phone's angle on the golfer, if it said. */
  view: CameraView | null;
  deviceName: string | null;
  /** Clock-sync uncertainty when the clip was taken (± ms). */
  syncMs: number | null;
  /** Manual alignment correction from the review screen. */
  nudgeMs: number;
};

/** What the store found on disk for a swing's second angle. */
export type AngleFile = { sidecarJson: string | null; sizeBytes: number | null };

/** A saved clip as the library shows it. Built from `swing_<epochMs>.mp4` plus its optional `.json` sidecar. */
export type Swing = {
  /** File stem, e.g. `swing_1760270000000`; stable id for routes. */
  id: string;
  uri: string;
  thumbUri: string | null;
  createdAt: number;
  fps: number | null;
  durationMs: number | null;
  impactOffsetMs: number | null;
  /** Where the trigger instant falls in the clip; lines the clip up with its second angle. */
  anchorOffsetMs: number | null;
  source: TriggerSource | null;
  /** Video file size (both angles), for the storage summary. */
  sizeBytes: number | null;
  angle: Angle | null;
};

const CLIP_NAME = /^(swing_(\d+))\.mp4$/;
const SOURCES: readonly TriggerSource[] = ['manual', 'volumeKey', 'watch', 'impact', 'wrist'];
const VIEWS: readonly CameraView[] = ['dtl', 'faceOn'];

const numberOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseJsonObject(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Corrupt sidecar: callers fall back to defaults.
  }
  return {};
}

/** An angle is only usable with its anchor; without one it can't be lined up with the main clip. */
function parseAngle(uri: string, file: AngleFile): Angle | null {
  const meta = parseJsonObject(file.sidecarJson);
  const anchorOffsetMs = numberOrNull(meta.anchorOffsetMs);
  if (anchorOffsetMs == null) return null;
  return {
    uri,
    fps: numberOrNull(meta.fps),
    durationMs: numberOrNull(meta.durationMs),
    anchorOffsetMs,
    view: VIEWS.includes(meta.view as CameraView) ? (meta.view as CameraView) : null,
    deviceName: typeof meta.deviceName === 'string' ? meta.deviceName : null,
    syncMs: numberOrNull(meta.syncMs),
    nudgeMs: numberOrNull(meta.nudgeMs) ?? 0,
  };
}

/**
 * Builds a Swing from a clip file. Clips saved before sidecars existed (or with a corrupt one)
 * still appear, dated from the file name.
 */
export function parseSwing(
  fileName: string,
  dirUri: string,
  sidecarJson: string | null,
  hasThumb: boolean,
  sizeBytes: number | null = null,
  angleFile: AngleFile | null = null
): Swing | null {
  const match = CLIP_NAME.exec(fileName);
  if (!match) return null;
  const [, id, stamp] = match;
  const base = dirUri.endsWith('/') ? dirUri : `${dirUri}/`;
  // Corrupt sidecar: fall back to what the file name tells us.
  const meta = parseJsonObject(sidecarJson);
  const impactOffsetMs = numberOrNull(meta.impactOffsetMs);
  const anchorOffsetMs = numberOrNull(meta.anchorOffsetMs) ?? impactOffsetMs;
  const angle = angleFile && anchorOffsetMs != null ? parseAngle(`${base}${id}.b.mp4`, angleFile) : null;

  return {
    id,
    uri: `${base}${fileName}`,
    thumbUri: hasThumb ? `${base}${id}.jpg` : null,
    createdAt: numberOrNull(meta.createdAt) ?? Number(stamp),
    fps: numberOrNull(meta.fps),
    durationMs: numberOrNull(meta.durationMs),
    impactOffsetMs,
    anchorOffsetMs,
    source: SOURCES.includes(meta.source as TriggerSource) ? (meta.source as TriggerSource) : null,
    sizeBytes: sizeBytes == null ? null : sizeBytes + (angleFile?.sizeBytes ?? 0),
    angle,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Swings older than [days] (0 = keep everything). */
export function swingsToPrune(swings: readonly Swing[], days: number, now = Date.now()): string[] {
  if (days <= 0) return [];
  return swings.filter((s) => now - s.createdAt > days * DAY_MS).map((s) => s.id);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const SOURCE_LABEL: Record<TriggerSource, string> = {
  manual: 'Button',
  volumeKey: 'Remote',
  watch: 'Watch',
  impact: 'Impact',
  wrist: 'Practice',
};

export function formatClipTime(epochMs: number, now = Date.now()): string {
  const d = new Date(epochMs);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}
