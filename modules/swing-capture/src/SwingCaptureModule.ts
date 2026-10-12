import { NativeModule, requireNativeModule, type PermissionResponse } from 'expo';

import type {
  CaptureCapabilities,
  CaptureConfig,
  NormalizedRect,
  SwingCaptureModuleEvents,
  TriggerSource,
} from './SwingCapture.types';

declare class SwingCaptureModule extends NativeModule<SwingCaptureModuleEvents> {
  /** Camera + microphone. */
  getPermissionsAsync(): Promise<PermissionResponse>;
  requestPermissionsAsync(): Promise<PermissionResponse>;
  getCapabilitiesAsync(): Promise<CaptureCapabilities>;
  /**
   * Configures the engine. The camera opens once a SwingCaptureView is on screen and stops when it
   * leaves (or the app is backgrounded); state changes arrive via `onStateChange`.
   */
  startAsync(config: CaptureConfig): Promise<void>;
  stopAsync(): Promise<void>;
  /** Fires a capture as if `source` had triggered now. Returns false if ignored (not armed, cooldown, quota). */
  trigger(source: TriggerSource): boolean;
  setAutoTrigger(enabled: boolean): void;
  setImpactTrigger(enabled: boolean): void;
  /** Moves the golfer box used by the motion gate (normalised preview coordinates). */
  setRoi(roi: NormalizedRect): void;
  /**
   * Low-power standby (30 fps preview + motion only) or back to full recording. While in standby a
   * SAVE / remote / watch press wakes the engine instead of saving.
   */
  setStandby(on: boolean): void;
  /**
   * Writes a copy of a clip retimed to play [factor]x slower in any player (video only), for saving
   * to the gallery or sharing. Returns its file URI (cached; regenerated if the clip changes).
   */
  exportSlowMotionAsync(uri: string, factor: number): Promise<string>;
}

export default requireNativeModule<SwingCaptureModule>('SwingCapture');
