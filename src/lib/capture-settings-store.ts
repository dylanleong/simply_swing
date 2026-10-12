import { File, Paths } from 'expo-file-system';

import { parseSettings, type CaptureSettings } from './capture-settings';

const settingsFile = () => new File(Paths.document, 'capture-settings.json');

export function loadCaptureSettings(): CaptureSettings {
  const file = settingsFile();
  try {
    return parseSettings(file.exists ? file.textSync() : null);
  } catch {
    return parseSettings(null);
  }
}

export function saveCaptureSettings(settings: CaptureSettings) {
  try {
    const file = settingsFile();
    if (!file.exists) file.create();
    file.write(JSON.stringify(settings));
  } catch {
    // Preferences are a convenience; never let a write failure interrupt capture.
  }
}
