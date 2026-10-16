import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useCapturePermissions } from '../../modules/swing-capture';

/**
 * Camera + microphone permission, checked again whenever the app comes back to the foreground, so
 * allowing access in the phone's Settings works without restarting the app.
 */
export function useCapturePermission() {
  const [permission, request, get] = useCapturePermissions();
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') get().catch(() => {});
    });
    return () => sub.remove();
  }, [get]);
  return [permission, request] as const;
}
