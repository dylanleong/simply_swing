import { DIM_AFTER_MS, idlePhase, shouldDim, STANDBY_AFTER_MS } from '../idle';

const both = { dimScreen: true, autoStandby: true };

describe('idlePhase', () => {
  it('stays active while the golfer is around', () => {
    expect(idlePhase(DIM_AFTER_MS - 1, both)).toBe('active');
  });

  it('dims, then goes to standby', () => {
    expect(idlePhase(DIM_AFTER_MS, both)).toBe('dimmed');
    expect(idlePhase(STANDBY_AFTER_MS, both)).toBe('standby');
  });

  it('respects each setting independently', () => {
    expect(idlePhase(STANDBY_AFTER_MS, { dimScreen: false, autoStandby: true })).toBe('standby');
    expect(idlePhase(STANDBY_AFTER_MS, { dimScreen: true, autoStandby: false })).toBe('dimmed');
    expect(idlePhase(60 * 60_000, { dimScreen: false, autoStandby: false })).toBe('active');
  });
});

describe('shouldDim', () => {
  it('dims in standby only when dimming is enabled', () => {
    expect(shouldDim('standby', both)).toBe(true);
    expect(shouldDim('standby', { dimScreen: false, autoStandby: true })).toBe(false);
    expect(shouldDim('active', both)).toBe(false);
  });
});
