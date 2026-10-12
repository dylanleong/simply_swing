import { getBrightnessAsync, restoreSystemBrightnessAsync, setBrightnessAsync } from 'expo-brightness';
import { Platform } from 'react-native';

import { DIM_BRIGHTNESS } from './idle';

/**
 * Android dims only this app's window and can hand control straight back to the system.
 * iOS changes the device brightness, so remember the user's level and put it back.
 */
let savedIosBrightness: number | null = null;

export async function dimScreen() {
  try {
    if (Platform.OS === 'ios' && savedIosBrightness == null) savedIosBrightness = await getBrightnessAsync();
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
    }
  } catch {
    // See dimScreen.
  }
}
