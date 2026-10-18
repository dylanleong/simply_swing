import { levelAdvice, smoothTilt, tiltForScreen, tiltFromGravity } from '../level';

const deg = (d: number) => (d * Math.PI) / 180;

describe('tiltFromGravity', () => {
  it('reads an upright phone as level', () => {
    expect(tiltFromGravity(0, 1, 0)).toEqual({ rollDeg: 0, pitchDeg: 0 });
    expect(tiltFromGravity(0, -1, 0).rollDeg).toBeCloseTo(0);
  });

  it('measures sideways tilt with its direction', () => {
    expect(tiltFromGravity(Math.sin(deg(5)), Math.cos(deg(5)), 0).rollDeg).toBeCloseTo(5);
    expect(tiltFromGravity(-Math.sin(deg(5)), -Math.cos(deg(5)), 0).rollDeg).toBeCloseTo(-5);
  });

  it('measures the camera aiming up or down either way', () => {
    expect(tiltFromGravity(0, Math.cos(deg(12)), Math.sin(deg(12))).pitchDeg).toBeCloseTo(12);
    expect(tiltFromGravity(0, Math.cos(deg(12)), -Math.sin(deg(12))).pitchDeg).toBeCloseTo(12);
  });
});

describe('levelAdvice', () => {
  it('is quiet when level', () => {
    expect(levelAdvice({ rollDeg: 1.5, pitchDeg: 5 })).toBeNull();
  });

  it('asks to straighten a tilted phone first', () => {
    expect(levelAdvice({ rollDeg: -4.4, pitchDeg: 20 })).toMatch(/^Tilted 4° sideways/);
  });

  it('flags a camera aimed up or down', () => {
    expect(levelAdvice({ rollDeg: 0, pitchDeg: 15 })).toMatch(/^Aimed 15° off level/);
  });

  it('ignores a phone being carried around', () => {
    expect(levelAdvice({ rollDeg: 50, pitchDeg: 0 })).toBeNull();
    expect(levelAdvice({ rollDeg: 0, pitchDeg: 85 })).toBeNull();
    // Flat on a table, whichever way round.
    expect(levelAdvice({ rollDeg: 88, pitchDeg: 80 })).toBeNull();
  });

  it('asks for an upright mount when the phone is on its side', () => {
    expect(levelAdvice({ rollDeg: 88, pitchDeg: 3 })).toBe('Mount the phone upright');
    expect(levelAdvice({ rollDeg: -90, pitchDeg: 0 })).toBe('Mount the phone upright');
    expect(levelAdvice({ rollDeg: 62, pitchDeg: 10 })).toBe('Mount the phone upright');
  });
});

describe('a tablet on its side', () => {
  it('reads a level landscape mount as level in the screen frame', () => {
    expect(tiltForScreen({ rollDeg: 90, pitchDeg: 3 }, true)).toEqual({ rollDeg: 0, pitchDeg: 3 });
    expect(tiltForScreen({ rollDeg: -88, pitchDeg: 3 }, true).rollDeg).toBeCloseTo(2);
    expect(tiltForScreen({ rollDeg: -92, pitchDeg: 3 }, true).rollDeg).toBeCloseTo(-2);
    expect(tiltForScreen({ rollDeg: 92, pitchDeg: 3 }, true).rollDeg).toBeCloseTo(2);
    expect(tiltForScreen({ rollDeg: 5, pitchDeg: 3 }, false)).toEqual({ rollDeg: 5, pitchDeg: 3 });
  });

  it('advises on the screen-frame tilt and never asks for an upright mount', () => {
    expect(levelAdvice(tiltForScreen({ rollDeg: 90, pitchDeg: 3 }, true), true)).toBeNull();
    expect(levelAdvice(tiltForScreen({ rollDeg: 86, pitchDeg: 3 }, true), true)).toBe('Tilted 4° sideways: straighten the tablet');
    // Held portrait while the screen says landscape (rotation lock): say nothing rather than the wrong thing.
    expect(levelAdvice(tiltForScreen({ rollDeg: 0, pitchDeg: 3 }, true), true)).toBeNull();
  });
});

describe('smoothTilt', () => {
  it('moves part of the way to the new reading', () => {
    expect(smoothTilt({ rollDeg: 0, pitchDeg: 0 }, { rollDeg: 10, pitchDeg: 5 }, 0.5)).toEqual({ rollDeg: 5, pitchDeg: 2.5 });
    expect(smoothTilt(null, { rollDeg: 3, pitchDeg: 1 })).toEqual({ rollDeg: 3, pitchDeg: 1 });
  });
});
