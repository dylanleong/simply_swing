import {
  clampRoi,
  DEFAULT_SETTINGS,
  isPairingCode,
  MIN_ROI_SIZE,
  pairingCodeDigits,
  parseSettings,
} from '../capture-settings';

describe('parseSettings', () => {
  it('uses defaults when nothing is stored or the file is corrupt', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{oops')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('42')).toEqual(DEFAULT_SETTINGS);
  });

  it('reads stored values', () => {
    const stored = {
      roi: { x: 0.1, y: 0.2, width: 0.4, height: 0.6 },
      soundTrigger: false,
      seenHelp: true,
      fps: 240,
      preRollSec: 4,
      lookbackSec: 8,
      sensitivity: 'high',
      sharpMode: true,
      autoDeleteDays: 30,
      dimScreen: false,
      autoStandby: false,
      watchMode: 'tap',
      savePracticeSwings: true,
      secondCamera: true,
      lastCameraName: 'Pixel 8',
      lastCameraCode: '048291',
      cameraView: 'dtl',
      club: '7i',
      savedSound: false,
    };
    expect(parseSettings(JSON.stringify(stored))).toEqual(stored);
  });

  it('replaces malformed or unsupported fields individually', () => {
    const s = parseSettings(
      JSON.stringify({
        roi: { x: 'left' },
        soundTrigger: 'yes',
        seenHelp: true,
        fps: 1000,
        sensitivity: 'max',
        lastCameraName: 7,
        lastCameraCode: '12345',
        cameraView: 'overhead',
        savedSound: 'loud',
      })
    );
    expect(s.roi).toEqual(DEFAULT_SETTINGS.roi);
    expect(s.soundTrigger).toBe(DEFAULT_SETTINGS.soundTrigger);
    expect(s.seenHelp).toBe(true);
    expect(s.fps).toBe(DEFAULT_SETTINGS.fps);
    expect(s.sensitivity).toBe(DEFAULT_SETTINGS.sensitivity);
    expect(s.lastCameraName).toBeNull();
    expect(s.cameraView).toBe(DEFAULT_SETTINGS.cameraView);
    expect(s.lastCameraCode).toBeNull();
    expect(s.savedSound).toBe(true);
  });

  it('chimes on save by default', () => {
    expect(DEFAULT_SETTINGS.savedSound).toBe(true);
  });

  it('upgrades settings saved by older versions', () => {
    const s = parseSettings(JSON.stringify({ soundTrigger: false }));
    expect(s).toEqual({ ...DEFAULT_SETTINGS, soundTrigger: false });
  });
});

describe('clampRoi', () => {
  it('keeps the box inside the preview', () => {
    expect(clampRoi({ x: 0.8, y: -0.2, width: 0.5, height: 0.5 })).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
  });

  it('fits the box between on-screen controls', () => {
    const r = clampRoi({ x: 0.25, y: 0.1, width: 0.5, height: 0.85 }, { minY: 0.12, maxY: 0.84 });
    expect(r.y).toBeCloseTo(0.12);
    expect(r.height).toBeCloseTo(0.72);
    expect(r.y + r.height).toBeLessThanOrEqual(0.84 + 1e-9);
  });

  it('enforces a minimum size', () => {
    const r = clampRoi({ x: 0.5, y: 0.5, width: 0.01, height: 2 });
    expect(r.width).toBe(MIN_ROI_SIZE);
    expect(r.height).toBe(1);
    expect(r.y).toBe(0);
  });
});

describe('pairing codes', () => {
  it('accepts exactly six digits', () => {
    expect(isPairingCode('482913')).toBe(true);
    expect(isPairingCode('000123')).toBe(true);
    expect(isPairingCode('48291')).toBe(false);
    expect(isPairingCode('4829134')).toBe(false);
    expect(isPairingCode('48291a')).toBe(false);
    expect(isPairingCode(482913)).toBe(false);
  });

  it('keeps only the digits the user typed', () => {
    expect(pairingCodeDigits('482 913')).toBe('482913');
    expect(pairingCodeDigits('482-9135')).toBe('482913');
    expect(pairingCodeDigits('abc')).toBe('');
  });
});
