import { registerWebModule, NativeModule } from 'expo';

import type { SwingCaptureModuleEvents } from './SwingCapture.types';

// SwingCaptureModule is not available on the web platform.
class SwingCaptureModule extends NativeModule<SwingCaptureModuleEvents> {}

export default registerWebModule(SwingCaptureModule, 'SwingCaptureModule');
