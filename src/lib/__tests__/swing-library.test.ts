import {
  clipAspect,
  filterSwings,
  formatBytes,
  formatClipTime,
  formatSession,
  formatTempo,
  formatTempoRatio,
  groupSessions,
  NO_FILTER,
  parseSwing,
  parseTempo,
  pruneQuestion,
  swingsToPrune,
  type Swing,
} from '../swing-library';
import { EMPTY_NOTES } from '../swing-notes';

const DIR = 'file:///data/user/0/app.simpleswing/files/swings';

describe('parseSwing', () => {
  it('reads metadata from the sidecar', () => {
    const json = JSON.stringify({
      createdAt: 1760270001234,
      fps: 120,
      durationMs: 4500.5,
      impactOffsetMs: 3000,
      source: 'impact',
    });
    expect(parseSwing('swing_1760270000000.mp4', DIR, json, true, 15_000_000)).toEqual({
      id: 'swing_1760270000000',
      uri: `${DIR}/swing_1760270000000.mp4`,
      thumbUri: `${DIR}/swing_1760270000000.jpg`,
      createdAt: 1760270001234,
      fps: 120,
      durationMs: 4500.5,
      impactOffsetMs: 3000,
      anchorOffsetMs: 3000,
      source: 'impact',
      sizeBytes: 15_000_000,
      angle: null,
      width: null,
      height: null,
      tempo: null,
      notes: EMPTY_NOTES,
      version: 1,
    });
  });

  it('reads the upright clip size and falls back to portrait 9:16 without one', () => {
    const landscape = parseSwing('swing_1.mp4', DIR, '{"width":1920,"height":1080,"orientation":0}', false);
    expect(landscape).toMatchObject({ width: 1920, height: 1080 });
    expect(clipAspect(landscape)).toBeCloseTo(16 / 9);
    expect(clipAspect(parseSwing('swing_1.mp4', DIR, null, false))).toBeCloseTo(9 / 16);
    // An older camera phone sends 0 for "unknown".
    expect(parseSwing('swing_1.mp4', DIR, '{"width":0,"height":0}', false)).toMatchObject({ width: null, height: null });
    expect(clipAspect(null)).toBeCloseTo(9 / 16);
  });

  it('reads the schema version and ignores fields it does not know', () => {
    const future = JSON.stringify({ v: 3, fps: 240, impactOffsetMs: 2500, lensTemperatureC: 41, extras: { a: 1 } });
    const s = parseSwing('swing_9.mp4', DIR, future, false);
    expect(s).toMatchObject({ version: 3, fps: 240, impactOffsetMs: 2500 });
    expect(s).not.toHaveProperty('lensTemperatureC');
    expect(parseSwing('swing_9.mp4', DIR, '{"v":"two"}', false)?.version).toBe(1);
    expect(parseSwing('swing_9.mp4', DIR, null, false)?.version).toBe(1);
  });

  it('attaches a second angle and counts its size', () => {
    const main = JSON.stringify({ fps: 120, impactOffsetMs: null, anchorOffsetMs: 5800, source: 'manual' });
    const b = JSON.stringify({ fps: 240, durationMs: 6200, anchorOffsetMs: 5750, view: 'faceOn', deviceName: 'Pixel 8', syncMs: 0.8 });
    const s = parseSwing('swing_7.mp4', DIR, main, true, 10, { sidecarJson: b, sizeBytes: 5 });
    expect(s?.anchorOffsetMs).toBe(5800);
    expect(s?.sizeBytes).toBe(15);
    expect(s?.angle).toEqual({
      uri: `${DIR}/swing_7.b.mp4`,
      fps: 240,
      durationMs: 6200,
      anchorOffsetMs: 5750,
      view: 'faceOn',
      deviceName: 'Pixel 8',
      syncMs: 0.8,
      nudgeMs: 0,
      width: null,
      height: null,
    });
  });

  it('drops an angle that cannot be lined up', () => {
    const noAnchor = JSON.stringify({ fps: 240 });
    expect(parseSwing('swing_7.mp4', DIR, '{"anchorOffsetMs":1}', false, 1, { sidecarJson: noAnchor, sizeBytes: 1 })?.angle).toBeNull();
    expect(parseSwing('swing_7.mp4', DIR, '{"anchorOffsetMs":1}', false, 1, { sidecarJson: null, sizeBytes: 1 })?.angle).toBeNull();
    // An old main clip with neither anchor nor impact offset.
    const b = JSON.stringify({ anchorOffsetMs: 3000 });
    expect(parseSwing('swing_7.mp4', DIR, null, false, 1, { sidecarJson: b, sizeBytes: 1 })?.angle).toBeNull();
  });

  it('keeps clips without a sidecar, dated from the file name', () => {
    const s = parseSwing('swing_1760270000000.mp4', `${DIR}/`, null, false);
    expect(s).toMatchObject({ createdAt: 1760270000000, fps: null, source: null, thumbUri: null });
    expect(s?.uri).toBe(`${DIR}/swing_1760270000000.mp4`);
  });

  it('survives a corrupt sidecar and rejects unknown sources', () => {
    expect(parseSwing('swing_5.mp4', DIR, '{not json', false)?.createdAt).toBe(5);
    expect(parseSwing('swing_5.mp4', DIR, '{"source":"telepathy"}', false)?.source).toBeNull();
  });

  it('ignores files that are not clips', () => {
    expect(parseSwing('swing_5.jpg', DIR, null, false)).toBeNull();
    expect(parseSwing('swing_5.b.mp4', DIR, null, false)).toBeNull();
    expect(parseSwing('notes.mp4', DIR, null, false)).toBeNull();
  });
});

describe('formatClipTime', () => {
  it('omits the date for clips from today', () => {
    const now = new Date(2026, 9, 12, 15, 0).getTime();
    const today = new Date(2026, 9, 12, 11, 57).getTime();
    const earlier = new Date(2026, 9, 10, 11, 57).getTime();
    expect(formatClipTime(today, now)).not.toMatch(/Oct/);
    expect(formatClipTime(earlier, now)).toMatch(/10/);
  });
});

describe('swingsToPrune', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;
  const swing = (id: string, ageDays: number) =>
    ({ ...parseSwing(`swing_${now - ageDays * day}.mp4`, DIR, null, false)!, id }) as Swing;

  it('keeps everything when auto-delete is off', () => {
    expect(swingsToPrune([swing('old', 90)], 0, now)).toEqual([]);
  });

  it('selects only swings older than the limit', () => {
    const swings = [swing('fresh', 1), swing('edge', 7), swing('old', 8)];
    expect(swingsToPrune(swings, 7, now)).toEqual(['old']);
  });

  it('never deletes a favourite', () => {
    const fav = { ...swing('fav', 90), notes: { ...EMPTY_NOTES, favorite: true } };
    expect(swingsToPrune([fav, swing('old', 90)], 7, now)).toEqual(['old']);
  });

  it('counts what a shorter period would delete, for the confirmation', () => {
    const fav = { ...swing('fav', 40), notes: { ...EMPTY_NOTES, favorite: true } };
    const swings = [swing('a', 2), swing('b', 10), swing('c', 40), fav];
    expect(swingsToPrune(swings, 30, now)).toHaveLength(1);
    expect(swingsToPrune(swings, 7, now)).toEqual(['b', 'c']);
    expect(pruneQuestion(37, 7)).toBe('Delete 37 swings older than 7 days? Favourites are kept.');
    expect(pruneQuestion(1, 30)).toBe('Delete 1 swing older than 30 days? Favourites are kept.');
  });
});

describe('tempo', () => {
  it('reads the watch tempo from the sidecar', () => {
    const json = JSON.stringify({ source: 'impact', backswingMs: 810, downswingMs: 270 });
    const s = parseSwing('swing_1.mp4', DIR, json, false);
    expect(s?.tempo).toEqual({ backswingMs: 810, downswingMs: 270 });
    expect(formatTempoRatio(s!.tempo!)).toBe('3.0 : 1');
    expect(formatTempo(s!.tempo!)).toBe('Tempo 3.0 : 1 · backswing 0.81 s');
  });

  it('is null when missing or nonsense', () => {
    expect(parseTempo(null, null)).toBeNull();
    expect(parseTempo(800, 0)).toBeNull();
    expect(parseTempo('800', 270)).toBeNull();
  });
});

describe('notes on a swing', () => {
  it('reads the .user.json beside the clip', () => {
    const notes = JSON.stringify({ club: '7i', result: 'slice', favorite: true });
    const s = parseSwing('swing_1.mp4', DIR, null, false, null, null, notes);
    expect(s?.notes).toMatchObject({ club: '7i', result: 'slice', favorite: true });
  });
});

describe('filterSwings', () => {
  const make = (id: string, club: string | null, result: string | null, favorite = false) =>
    parseSwing(`swing_${id}.mp4`, DIR, null, false, null, null, JSON.stringify({ club, result, favorite }))!;
  const swings = [make('1', '7i', 'slice'), make('2', '7i', 'good', true), make('3', 'D', 'slice')];

  it('matches everything with no filter', () => {
    expect(filterSwings(swings, NO_FILTER)).toHaveLength(3);
  });

  it('combines club, result and favourites', () => {
    expect(filterSwings(swings, { ...NO_FILTER, result: 'slice' }).map((s) => s.id)).toEqual(['swing_1', 'swing_3']);
    expect(filterSwings(swings, { ...NO_FILTER, club: '7i', result: 'slice' }).map((s) => s.id)).toEqual(['swing_1']);
    expect(filterSwings(swings, { ...NO_FILTER, favorites: true }).map((s) => s.id)).toEqual(['swing_2']);
  });
});

describe('groupSessions', () => {
  const min = 60 * 1000;
  const at = (t: number) => parseSwing(`swing_${t}.mp4`, DIR, null, false)!;

  it('splits on long breaks and keeps newest first', () => {
    const swings = [at(300 * min), at(290 * min), at(280 * min), at(100 * min), at(95 * min)];
    const sessions = groupSessions(swings);
    expect(sessions.map((s) => s.swings.length)).toEqual([3, 2]);
    expect(sessions[0]).toMatchObject({ start: 280 * min, end: 300 * min });
    expect(sessions[1]).toMatchObject({ start: 95 * min, end: 100 * min });
  });

  it('is empty for no swings', () => {
    expect(groupSessions([])).toEqual([]);
  });
});

describe('formatSession', () => {
  it('names today and shows the time range', () => {
    const now = new Date(2026, 9, 15, 18, 0).getTime();
    const start = new Date(2026, 9, 15, 14, 14).getTime();
    const end = new Date(2026, 9, 15, 15, 26).getTime();
    expect(formatSession({ start, end }, now)).toMatch(/^Today · .+–.+$/);
    expect(formatSession({ start: start - 24 * 60 * 60 * 1000, end: start - 24 * 60 * 60 * 1000 }, now)).toMatch(
      /^Yesterday · [^–]+$/
    );
  });

  describe('across a clock change', () => {
    const tz = process.env.TZ;
    // 29 March 2026 is a 23-hour day in the UK.
    beforeAll(() => {
      process.env.TZ = 'Europe/London';
    });
    afterAll(() => {
      process.env.TZ = tz;
    });

    it('calls the previous calendar day yesterday, however long it was', () => {
    // Just after midnight, a swing late last evening is yesterday, not "24 h ago" (a 23 h day when the
    // clocks go forward would make it the day before).
    const now = new Date(2026, 2, 30, 0, 30).getTime();
    const lateLastNight = new Date(2026, 2, 29, 0, 10).getTime();
    expect(formatSession({ start: lateLastNight, end: lateLastNight }, now)).toMatch(/^Yesterday · /);
    const twoDaysAgo = new Date(2026, 2, 28, 23, 50).getTime();
    expect(formatSession({ start: twoDaysAgo, end: twoDaysAgo }, now)).not.toMatch(/^Yesterday/);
    });
  });
});

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect(formatBytes(500)).toBe('1 KB');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
});
