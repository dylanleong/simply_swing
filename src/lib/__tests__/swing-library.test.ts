import { formatBytes, formatClipTime, parseSwing, swingsToPrune, type Swing } from '../swing-library';

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
      source: 'impact',
      sizeBytes: 15_000_000,
    });
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
});

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect(formatBytes(500)).toBe('1 KB');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
});
