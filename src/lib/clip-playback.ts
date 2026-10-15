import type { BufferOptions } from 'expo-video';

/**
 * Buffer limits for every clip player. Clips are local files, so a short buffer refills instantly.
 * Android's default (~130 MB per player, refilled on every loop) filled the Java heap: two review
 * players, or the capture replay next to the camera's rolling buffer, crashed the app.
 */
export const CLIP_BUFFER_OPTIONS: BufferOptions = {
  preferredForwardBufferDuration: 3,
  minBufferForPlayback: 0.5,
  maxBufferBytes: 24 * 1024 * 1024,
};
