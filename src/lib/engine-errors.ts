/**
 * The capture engine reports errors as a code plus a developer-ish message. Codes the golfer can
 * act on get one friendly line here; anything else keeps the native message.
 */

const FRIENDLY: Record<string, string> = {
  E_CAMERA: 'The camera stopped. Leave and reopen Capture.',
  E_PERMISSION: 'Allow the camera and microphone in system Settings.',
  E_STORAGE: 'Phone storage is nearly full. Free up space to keep recording.',
  E_AUDIO: 'The microphone stopped. Leave and reopen Capture.',
  E_EXPORT: 'Couldn’t save that swing. Try again.',
  E_EXPORT_TIMEOUT: 'Saving took too long and was stopped. Try again.',
  E_SESSION: 'The camera session failed. Leave and reopen Capture.',
};

/** Codes whose native message already says what to do (which camera is busy, say). */
const PASS_THROUGH = new Set(['E_CAMERA_BUSY']);

export function friendlyEngineError(code: string | null | undefined, message: string): string {
  if (!code || PASS_THROUGH.has(code)) return message;
  return FRIENDLY[code] ?? message;
}

/** For a rejected promise from the engine (expo's CodedError carries the code). */
export function friendlyEngineFailure(e: unknown): string {
  const err = e as { code?: unknown; message?: unknown };
  const message = typeof err?.message === 'string' ? err.message : String(e);
  return friendlyEngineError(typeof err?.code === 'string' ? err.code : null, message);
}
