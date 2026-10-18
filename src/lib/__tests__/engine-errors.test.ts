import { friendlyEngineError, friendlyEngineFailure } from '../engine-errors';

describe('friendlyEngineError', () => {
  it('replaces engine codes the golfer can act on', () => {
    expect(friendlyEngineError('E_CAMERA', 'CameraAccessException: 4')).toBe('The camera stopped. Leave and reopen Capture.');
    expect(friendlyEngineError('E_STORAGE', 'free=12MB')).toMatch(/storage/i);
    expect(friendlyEngineError('E_EXPORT_TIMEOUT', 'muxer timeout')).toMatch(/too long/);
  });

  it('keeps native messages that already say what to do, and unknown codes', () => {
    expect(friendlyEngineError('E_CAMERA_BUSY', 'The camera is in use by another app.')).toBe('The camera is in use by another app.');
    expect(friendlyEngineError('E_PEER_MISSED', 'Camera phone was not armed')).toBe('Camera phone was not armed');
    expect(friendlyEngineError(null, 'plain')).toBe('plain');
  });

  it('reads the code off a rejected promise', () => {
    expect(friendlyEngineFailure(Object.assign(new Error('boom'), { code: 'E_SESSION' }))).toMatch(/session/);
    expect(friendlyEngineFailure(new Error('boom'))).toBe('boom');
    expect(friendlyEngineFailure('text')).toBe('text');
  });
});
