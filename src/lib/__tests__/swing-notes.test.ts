import { angleDegrees, EMPTY_NOTES, extendToEdges, fitRect, notesSummary, parseNotes } from '../swing-notes';

describe('parseNotes', () => {
  it('reads tags, favourite and drawings', () => {
    const json = JSON.stringify({
      result: 'hook',
      club: 'PW',
      favorite: true,
      drawings: {
        a: [{ kind: 'plane', a: [0.1, 0.9], b: [0.5, 0.4] }],
        b: [{ kind: 'circle', center: [0.5, 0.2], edge: [0.55, 0.2] }],
      },
    });
    expect(parseNotes(json)).toEqual({
      result: 'hook',
      club: 'PW',
      favorite: true,
      drawings: {
        a: [{ kind: 'plane', a: [0.1, 0.9], b: [0.5, 0.4] }],
        b: [{ kind: 'circle', center: [0.5, 0.2], edge: [0.55, 0.2] }],
      },
    });
  });

  it('falls back to empty for missing or corrupt files', () => {
    expect(parseNotes(null)).toEqual(EMPTY_NOTES);
    expect(parseNotes('{not json')).toEqual(EMPTY_NOTES);
    expect(parseNotes('[]')).toEqual({ ...EMPTY_NOTES });
  });

  it('drops unknown values and malformed shapes', () => {
    const json = JSON.stringify({
      result: 'shank',
      club: '2i',
      favorite: 'yes',
      drawings: { a: [{ kind: 'line', a: [0, 0] }, { kind: 'blob' }, { kind: 'line', a: [0, 0], b: [1, 1] }] },
    });
    expect(parseNotes(json)).toEqual({
      ...EMPTY_NOTES,
      drawings: { a: [{ kind: 'line', a: [0, 0], b: [1, 1] }], b: [] },
    });
  });
});

describe('notesSummary', () => {
  it('joins club and result', () => {
    expect(notesSummary({ club: '7i', result: 'slice' })).toBe('7i · Slice');
    expect(notesSummary({ club: null, result: 'top' })).toBe('Topped');
    expect(notesSummary({ club: null, result: null })).toBe('');
  });
});

describe('angleDegrees', () => {
  it('measures on the picture as shown', () => {
    // A right angle in a square picture.
    expect(angleDegrees({ kind: 'angle', vertex: [0.5, 0.5], a: [0.9, 0.5], b: [0.5, 0.1] }, 1)).toBeCloseTo(90);
    // The same normalised points on a 9:16 picture: x distances shrink, so the angle stays 90 here...
    expect(angleDegrees({ kind: 'angle', vertex: [0.5, 0.5], a: [0.9, 0.5], b: [0.5, 0.1] }, 9 / 16)).toBeCloseTo(90);
    // ...but a 45° diagonal in normalised units isn't 45° on a tall picture.
    expect(angleDegrees({ kind: 'angle', vertex: [0, 1], a: [1, 1], b: [1, 0] }, 9 / 16)).toBeCloseTo(
      (Math.atan2(1, 9 / 16) * 180) / Math.PI
    );
  });

  it('is 0 for a collapsed arm', () => {
    expect(angleDegrees({ kind: 'angle', vertex: [0.5, 0.5], a: [0.5, 0.5], b: [0.1, 0.1] }, 1)).toBe(0);
  });
});

describe('extendToEdges', () => {
  it('runs a line edge to edge', () => {
    const [p, q] = extendToEdges([0.25, 0.5], [0.75, 0.5]);
    expect(p).toEqual([0, 0.5]);
    expect(q).toEqual([1, 0.5]);
  });

  it('clips a diagonal to the square', () => {
    const [p, q] = extendToEdges([0.4, 0.6], [0.5, 0.5]);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(1);
    expect(q[0]).toBeCloseTo(1);
    expect(q[1]).toBeCloseTo(0);
  });

  it('leaves a single point alone', () => {
    expect(extendToEdges([0.3, 0.3], [0.3, 0.3])).toEqual([
      [0.3, 0.3],
      [0.3, 0.3],
    ]);
  });
});

describe('fitRect', () => {
  it('letterboxes a wide view at the sides', () => {
    expect(fitRect(400, 320, 9 / 16)).toEqual({ x: 110, y: 0, width: 180, height: 320 });
  });

  it('letterboxes a tall view top and bottom', () => {
    expect(fitRect(90, 400, 9 / 16)).toEqual({ x: 0, y: 120, width: 90, height: 160 });
  });

  it('is empty before layout', () => {
    expect(fitRect(0, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
