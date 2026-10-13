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
      anchorOffsetMs: 3000,
      source: 'impact',
      sizeBytes: 15_000_000,
      angle: null,
    });
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
});

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect(formatBytes(500)).toBe('1 KB');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });
});
