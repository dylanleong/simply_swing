import { Asset, requestPermissionsAsync } from 'expo-media-library';
import { isAvailableAsync, shareAsync } from 'expo-sharing';

import SwingCapture from '../../modules/swing-capture';

/** Exports play this many times slower in any app: 120 fps capture → 30 fps playback. */
export const SLOW_MOTION_FACTOR = 4;

/** Saves a slow-motion copy of the clip to the phone's gallery / Photos. */
export async function saveSwingToPhotos(clipUri: string) {
  const permission = await requestPermissionsAsync(true, ['video']);
  if (!permission.granted) {
    throw new Error('Allow SimpleSwing to add videos to your gallery in system Settings.');
  }
  const slowMo = await SwingCapture.exportSlowMotionAsync(clipUri, SLOW_MOTION_FACTOR);
  await Asset.create(slowMo);
}

/** Opens the share sheet with a slow-motion copy of the clip (WhatsApp, email, a coach…). */
export async function shareSwing(clipUri: string) {
  if (!(await isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  const slowMo = await SwingCapture.exportSlowMotionAsync(clipUri, SLOW_MOTION_FACTOR);
  await shareAsync(slowMo, { mimeType: 'video/mp4', dialogTitle: 'Share swing' });
}
