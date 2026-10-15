import { Asset, requestPermissionsAsync } from 'expo-media-library';
import { isAvailableAsync, shareAsync } from 'expo-sharing';

import SwingCapture from '../../modules/swing-capture';
import type { ExportSource } from './multicam';

/** Exports play this many times slower in any app: 120 fps capture → 30 fps playback. */
export const SLOW_MOTION_FACTOR = 4;

function slowMotionCopy(source: ExportSource) {
  return source.angle
    ? SwingCapture.exportSideBySideAsync(source.uri, source.angle.uri, source.angle.shiftMs, SLOW_MOTION_FACTOR)
    : SwingCapture.exportSlowMotionAsync(source.uri, SLOW_MOTION_FACTOR);
}

/** Saves a slow-motion copy of the clip (or both angles side by side) to the phone's gallery / Photos. */
export async function saveSwingToPhotos(source: ExportSource) {
  const permission = await requestPermissionsAsync(true, ['video']);
  if (!permission.granted) {
    throw new Error('Allow SimpleSwing to add videos to your gallery in system Settings.');
  }
  await Asset.create(await slowMotionCopy(source));
}

/** Opens the share sheet with a slow-motion copy (WhatsApp, email, a coach…). */
export async function shareSwing(source: ExportSource) {
  if (!(await isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  await shareAsync(await slowMotionCopy(source), { mimeType: 'video/mp4', dialogTitle: 'Share swing' });
}
