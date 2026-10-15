import { levelAdvice, smoothTilt, tiltFromGravity } from '../level';

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
    expect(levelAdvice({ rollDeg: 80, pitchDeg: 0 })).toBeNull();
    expect(levelAdvice({ rollDeg: 0, pitchDeg: 85 })).toBeNull();
  });
});

describe('smoothTilt', () => {
  it('moves part of the way to the new reading', () => {
    expect(smoothTilt({ rollDeg: 0, pitchDeg: 0 }, { rollDeg: 10, pitchDeg: 5 }, 0.5)).toEqual({ rollDeg: 5, pitchDeg: 2.5 });
    expect(smoothTilt(null, { rollDeg: 3, pitchDeg: 1 })).toEqual({ rollDeg: 3, pitchDeg: 1 });
  });
});
