import { BUTTON_LEAD_MS, frameRateHint, IMPACT_LEAD_MS, loopSeekSec, replayStartMs } from '../replay-start';

const clip = (over: Partial<Parameters<typeof replayStartMs>[0]>) => ({
  impactOffsetMs: null,
  anchorOffsetMs: null,
  durationMs: 4500,
  source: null,
  ...over,
});

describe('replayStartMs', () => {
  it('starts a little before impact when the engine heard it', () => {
    expect(replayStartMs(clip({ impactOffsetMs: 3000, anchorOffsetMs: 3000, source: 'impact' }))).toBe(3000 - IMPACT_LEAD_MS);
  });

  it('never starts before the clip', () => {
    expect(replayStartMs(clip({ impactOffsetMs: 800, source: 'impact' }))).toBe(0);
    expect(replayStartMs(clip({ anchorOffsetMs: 2000, source: 'manual' }))).toBe(0);
  });

  it('reaches back past the swing for a button save, whose anchor is the press', () => {
    expect(replayStartMs(clip({ anchorOffsetMs: 5900, durationMs: 6000, source: 'manual' }), 6)).toBe(5900 - BUTTON_LEAD_MS);
    expect(replayStartMs(clip({ anchorOffsetMs: 5900, durationMs: 6000, source: 'volumeKey' }), 6)).toBe(5900 - BUTTON_LEAD_MS);
    expect(replayStartMs(clip({ anchorOffsetMs: 5900, durationMs: 6000, source: 'watch' }), 6)).toBe(5900 - BUTTON_LEAD_MS);
  });

  it('caps the reach at what a short save kept', () => {
    expect(replayStartMs(clip({ anchorOffsetMs: 3900, durationMs: 4000, source: 'manual' }), 2)).toBe(3900 - 2000);
  });

  it('treats a wrist-sensed anchor like impact', () => {
    expect(replayStartMs(clip({ anchorOffsetMs: 3000, source: 'wrist' }))).toBe(3000 - IMPACT_LEAD_MS);
  });

  it('falls back to the beginning without an anchor or with a nonsense one', () => {
    expect(replayStartMs(clip({}))).toBe(0);
    expect(replayStartMs(clip({ impactOffsetMs: 9000, durationMs: 4500, source: 'impact' }))).toBe(0);
  });
});

describe('loopSeekSec', () => {
  it('sends a looped player back to the start point', () => {
    expect(loopSeekSec(0.1, 1.8)).toBe(1.8);
    expect(loopSeekSec(1.78, 1.8)).toBeNull();
    expect(loopSeekSec(2.5, 1.8)).toBeNull();
    expect(loopSeekSec(0, 0)).toBeNull();
  });
});

describe('frameRateHint', () => {
  it('says so when the camera fell back to a lower rate', () => {
    expect(frameRateHint(120, 60)).toBe('This phone records at 60 fps, so slow motion is less smooth.');
    expect(frameRateHint(120, 120)).toBeNull();
    expect(frameRateHint(60, 120)).toBeNull();
    expect(frameRateHint(120, null)).toBeNull();
  });
});
