import { getBrightnessAsync, restoreSystemBrightnessAsync, setBrightnessAsync } from 'expo-brightness';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { DIM_BRIGHTNESS } from './idle';

/**
 * Android dims only this app's window and can hand control straight back to the system.
 * iOS changes the device brightness, so remember the user's level and put it back. It's also kept
 * on disk while dimmed: if the app dies dimmed, the next launch restores it (`recoverScreenBrightness`).
 */
let savedIosBrightness: number | null = null;

const savedBrightnessFile = () => new File(Paths.document, 'dimmed-from-brightness.json');

function rememberBrightness(level: number | null) {
  try {
    const file = savedBrightnessFile();
    if (level == null) {
      if (file.exists) file.delete();
    } else {
      file.write(JSON.stringify(level));
    }
  } catch {
    // Only a safety net for a crash while dimmed.
  }
}

export async function dimScreen() {
  try {
    if (Platform.OS === 'ios' && savedIosBrightness == null) {
      savedIosBrightness = await getBrightnessAsync();
      rememberBrightness(savedIosBrightness);
    }
    await setBrightnessAsync(DIM_BRIGHTNESS);
  } catch {
    // Dimming only saves battery; never let it break capture.
  }
}

export async function restoreScreen() {
  try {
    if (Platform.OS === 'android') {
      await restoreSystemBrightnessAsync();
    } else if (savedIosBrightness != null) {
      await setBrightnessAsync(savedIosBrightness);
      savedIosBrightness = null;
      rememberBrightness(null);
    }
  } catch {
    // See dimScreen.
  }
}

/** At launch (iOS): the app last quit while dimmed, so put the user's brightness back. */
export async function recoverScreenBrightness() {
  if (Platform.OS !== 'ios') return;
  try {
    const file = savedBrightnessFile();
    if (!file.exists) return;
    const level = Number(JSON.parse(file.textSync()));
    if (Number.isFinite(level) && level > 0 && level <= 1) await setBrightnessAsync(level);
    rememberBrightness(null);
  } catch {
    // See dimScreen.
  }
}
