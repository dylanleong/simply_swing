import type { TriggerSource } from '../../modules/swing-capture/src/SwingCapture.types';

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
  source: TriggerSource | null;
  /** Video file size, for the storage summary. */
  sizeBytes: number | null;
};

const CLIP_NAME = /^(swing_(\d+))\.mp4$/;
const SOURCES: readonly TriggerSource[] = ['manual', 'volumeKey', 'watch', 'impact'];

const numberOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Builds a Swing from a clip file. Clips saved before sidecars existed (or with a corrupt one)
 * still appear, dated from the file name.
 */
export function parseSwing(
  fileName: string,
  dirUri: string,
  sidecarJson: string | null,
  hasThumb: boolean,
  sizeBytes: number | null = null
): Swing | null {
  const match = CLIP_NAME.exec(fileName);
  if (!match) return null;
  const [, id, stamp] = match;
  const base = dirUri.endsWith('/') ? dirUri : `${dirUri}/`;

  let meta: Record<string, unknown> = {};
  if (sidecarJson) {
    try {
      const parsed = JSON.parse(sidecarJson);
      if (parsed && typeof parsed === 'object') meta = parsed;
    } catch {
      // Corrupt sidecar: fall back to what the file name tells us.
    }
  }

  return {
    id,
    uri: `${base}${fileName}`,
    thumbUri: hasThumb ? `${base}${id}.jpg` : null,
    createdAt: numberOrNull(meta.createdAt) ?? Number(stamp),
    fps: numberOrNull(meta.fps),
    durationMs: numberOrNull(meta.durationMs),
    impactOffsetMs: numberOrNull(meta.impactOffsetMs),
    source: SOURCES.includes(meta.source as TriggerSource) ? (meta.source as TriggerSource) : null,
    sizeBytes,
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
};

export function formatClipTime(epochMs: number, now = Date.now()): string {
  const d = new Date(epochMs);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}
