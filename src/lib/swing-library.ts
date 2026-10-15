import type { CameraView, TriggerSource } from '../../modules/swing-capture/src/SwingCapture.types';
import { parseNotes, type Club, type ShotResult, type SwingNotes } from './swing-notes';

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

/** Swing timing from the watch: takeaway → top, top → impact. */
export type Tempo = { backswingMs: number; downswingMs: number };

/** Both parts, positive, or null. */
export function parseTempo(backswingMs: unknown, downswingMs: unknown): Tempo | null {
  const b = numberOrNull(backswingMs);
  const d = numberOrNull(downswingMs);
  return b != null && d != null && b > 0 && d > 0 ? { backswingMs: b, downswingMs: d } : null;
}

/** "3.1 : 1" — backswing time over downswing time. Tour players cluster around 3 : 1. */
export function formatTempoRatio(t: Tempo): string {
  return `${(t.backswingMs / t.downswingMs).toFixed(1)} : 1`;
}

/** "Tempo 3.1 : 1 · backswing 0.81 s" */
export function formatTempo(t: Tempo): string {
  return `Tempo ${formatTempoRatio(t)} · backswing ${(t.backswingMs / 1000).toFixed(2)} s`;
}

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
  /** From the watch, when it sensed the swing. */
  tempo: Tempo | null;
  /** The golfer's tags, favourite and drawings (`.user.json`). */
  notes: SwingNotes;
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
  angleFile: AngleFile | null = null,
  notesJson: string | null = null
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
    tempo: parseTempo(meta.backswingMs, meta.downswingMs),
    notes: parseNotes(notesJson),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Swings older than [days] (0 = keep everything). Favourites are always kept. */
export function swingsToPrune(swings: readonly Swing[], days: number, now = Date.now()): string[] {
  if (days <= 0) return [];
  return swings.filter((s) => !s.notes.favorite && now - s.createdAt > days * DAY_MS).map((s) => s.id);
}

/** The library's filter: null fields match everything. */
export type SwingFilter = { club: Club | null; result: ShotResult | null; favorites: boolean };

export const NO_FILTER: SwingFilter = { club: null, result: null, favorites: false };

export function filterSwings(swings: readonly Swing[], filter: SwingFilter): Swing[] {
  return swings.filter(
    (s) =>
      (filter.club == null || s.notes.club === filter.club) &&
      (filter.result == null || s.notes.result === filter.result) &&
      (!filter.favorites || s.notes.favorite)
  );
}

/** A break this long between swings starts a new practice session. */
export const SESSION_GAP_MS = 45 * 60 * 1000;

export type Session = { start: number; end: number; swings: Swing[] };

/** Groups newest-first swings into sessions, newest first; swings inside stay newest first. */
export function groupSessions(swings: readonly Swing[], gapMs = SESSION_GAP_MS): Session[] {
  const sessions: Session[] = [];
  for (const swing of swings) {
    const current = sessions[sessions.length - 1];
    if (current && current.start - swing.createdAt <= gapMs) {
      current.swings.push(swing);
      current.start = swing.createdAt;
    } else {
      sessions.push({ start: swing.createdAt, end: swing.createdAt, swings: [swing] });
    }
  }
  return sessions;
}

/** "Today · 14:14–15:26" / "12 Oct · 09:30" for a session header. */
export function formatSession(session: Pick<Session, 'start' | 'end'>, now = Date.now()): string {
  const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const start = new Date(session.start);
  const today = new Date(now);
  const yesterday = new Date(now - DAY_MS);
  const day =
    start.toDateString() === today.toDateString()
      ? 'Today'
      : start.toDateString() === yesterday.toDateString()
        ? 'Yesterday'
        : start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const range = session.end - session.start < 60_000 ? time(session.start) : `${time(session.start)}–${time(session.end)}`;
  return `${day} · ${range}`;
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
