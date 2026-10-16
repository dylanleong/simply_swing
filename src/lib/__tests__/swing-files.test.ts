import { DELETE_ORDER, isSwingId, LEFTOVER_AGE_MS, planSwingDir, SWING_FILE_EXTENSIONS } from '../swing-files';

const NOW = 1_800_000_000_000;
const OLD = NOW - LEFTOVER_AGE_MS - 1;
const FRESH = NOW - 1000;

/** Every file old unless listed in [fresh]. */
const plan = (names: string[], fresh: string[] = []) =>
  planSwingDir(names, (name) => (fresh.includes(name) ? FRESH : OLD), NOW);

describe('planSwingDir', () => {
  it('pairs a full swing with its angle and notes', () => {
    const names = ['swing_1.mp4', 'swing_1.json', 'swing_1.jpg', 'swing_1.b.mp4', 'swing_1.b.json', 'swing_1.user.json'];
    expect(plan(names)).toEqual({
      swings: [{ id: 'swing_1', sidecar: true, thumb: true, angleClip: true, angleSidecar: true, notes: true }],
      leftovers: [],
    });
  });

  it('hides a clip that is still being written (no sidecar yet)', () => {
    expect(plan(['swing_2.mp4'], ['swing_2.mp4']).swings).toEqual([]);
  });

  it('lists an old clip with no sidecar so it can be deleted', () => {
    const { swings, leftovers } = plan(['swing_3.mp4', 'swing_3.jpg']);
    expect(swings).toEqual([
      { id: 'swing_3', sidecar: false, thumb: true, angleClip: false, angleSidecar: false, notes: false },
    ]);
    expect(leftovers).toEqual([]);
  });

  it('keeps an angle clip without its sidecar on the swing (it counts for storage)', () => {
    const { swings } = plan(['swing_4.mp4', 'swing_4.json', 'swing_4.b.mp4']);
    expect(swings[0]).toMatchObject({ angleClip: true, angleSidecar: false });
  });

  it('cleans up what is left of a deleted swing once it is stale', () => {
    const names = ['swing_5.b.mp4', 'swing_5.b.json', 'swing_5.user.json', 'swing_5.jpg', 'swing_5.json'];
    const { swings, leftovers } = plan(names);
    expect(swings).toEqual([]);
    expect(leftovers.sort()).toEqual([...names].sort());
  });

  it('leaves an orphan angle alone while it may still be arriving', () => {
    expect(plan(['swing_6.b.json', 'swing_6.b.mp4.part'], ['swing_6.b.json', 'swing_6.b.mp4.part']).leftovers).toEqual(
      []
    );
  });

  it('removes a transfer that stopped, but not one in progress', () => {
    const names = ['swing_7.mp4', 'swing_7.json', 'swing_7.b.mp4.part', 'swing_8.mp4', 'swing_8.json', 'swing_8.b.mp4.part'];
    const { swings, leftovers } = plan(names, ['swing_8.b.mp4.part']);
    expect(swings.map((s) => s.id).sort()).toEqual(['swing_7', 'swing_8']);
    expect(leftovers).toEqual(['swing_7.b.mp4.part']);
  });

  it('ignores files that are not swing files', () => {
    const names = ['capture-settings.json', 'swing_x.mp4', 'notes.user.json', 'swing_9.mp4.tmp', '.DS_Store'];
    expect(plan(names)).toEqual({ swings: [], leftovers: [] });
  });

  it('treats an unreadable age as stale', () => {
    const { swings } = planSwingDir(['swing_10.mp4'], () => null, NOW);
    expect(swings.map((s) => s.id)).toEqual(['swing_10']);
  });
});

describe('isSwingId', () => {
  it('accepts only swing stems, never a path', () => {
    expect(isSwingId('swing_1760270000000')).toBe(true);
    expect(isSwingId('../capture-settings')).toBe(false);
    expect(isSwingId('swing_1/../../x')).toBe(false);
    expect(isSwingId(undefined)).toBe(false);
  });
});

describe('DELETE_ORDER', () => {
  it('deletes every swing file, the main clip last', () => {
    expect([...DELETE_ORDER].sort()).toEqual([...SWING_FILE_EXTENSIONS].sort());
    expect(DELETE_ORDER[DELETE_ORDER.length - 1]).toBe('mp4');
  });
});
