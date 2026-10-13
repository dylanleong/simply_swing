import {
  angleLabels,
  angleShiftSec,
  angleTimeSec,
  driftCorrectionSec,
  formatSync,
  nudgeStepMs,
  otherView,
} from '../multicam';
import type { Angle } from '../swing-library';

const angle = (over: Partial<Angle> = {}): Angle => ({
  uri: 'file:///swings/swing_1.b.mp4',
  fps: 240,
  durationMs: 4600,
  anchorOffsetMs: 3100,
  view: 'faceOn',
  deviceName: 'Pixel 8',
  syncMs: 1,
  nudgeMs: 0,
  ...over,
});

const swing = { anchorOffsetMs: 3000 };

describe('angle alignment', () => {
  it('lines the clips up on the shared anchor', () => {
    // Impact is 3.0 s into the main clip and 3.1 s into the second angle.
    expect(angleShiftSec(swing, angle())).toBeCloseTo(0.1);
    expect(angleTimeSec(3.0, swing, angle())).toBeCloseTo(3.1);
    expect(angleTimeSec(0, swing, angle())).toBeCloseTo(0.1);
  });

  it('applies the manual nudge', () => {
    expect(angleTimeSec(3.0, swing, angle({ nudgeMs: -12.5 }))).toBeCloseTo(3.0875);
  });

  it('clamps to the second clip', () => {
    expect(angleTimeSec(0, swing, angle({ anchorOffsetMs: 2500 }))).toBe(0);
    expect(angleTimeSec(10, swing, angle())).toBeCloseTo(4.6);
    expect(angleTimeSec(10, swing, angle({ durationMs: null }))).toBeCloseTo(10.1);
  });

  it('treats a main clip without an anchor as anchored at 0', () => {
    expect(angleShiftSec({ anchorOffsetMs: null }, angle())).toBeCloseTo(3.1);
  });
});

describe('driftCorrectionSec', () => {
  it('leaves the players alone within a frame', () => {
    expect(driftCorrectionSec(1.0, 1.1 + 0.003, swing, angle())).toBe(0); // 3 ms < 1/240 s
  });

  it('seeks back when drift exceeds a frame', () => {
    expect(driftCorrectionSec(1.0, 1.15, swing, angle())).toBeCloseTo(-0.05);
    expect(driftCorrectionSec(1.0, 1.0, swing, angle())).toBeCloseTo(0.1);
  });
});

describe('labels and readouts', () => {
  it('names the main clip as the other classic view', () => {
    expect(otherView('dtl')).toBe('faceOn');
    expect(angleLabels(angle({ view: 'dtl' }))).toEqual(['Face on', 'DTL']);
    expect(angleLabels(angle({ view: null }))).toEqual(['Angle 1', 'Angle 2']);
  });

  it('formats sync and nudge steps', () => {
    expect(formatSync(null)).toBeNull();
    expect(formatSync(0.3)).toBe('±1 ms');
    expect(formatSync(2.6)).toBe('±3 ms');
    expect(nudgeStepMs(240)).toBeCloseTo(4.1667);
    expect(nudgeStepMs(null)).toBeCloseTo(8.333);
  });
});
