import { createPermissionHook } from 'expo';

import SwingCaptureModule from './SwingCaptureModule';

/** Camera + microphone permission hook: `const [status, request] = useCapturePermissions()`. */
export const useCapturePermissions = createPermissionHook({
  getMethod: () => SwingCaptureModule.getPermissionsAsync(),
  requestMethod: () => SwingCaptureModule.requestPermissionsAsync(),
});
