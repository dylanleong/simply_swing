import { NativeModule, requireNativeModule, type PermissionResponse } from 'expo';

import type {
  CameraView,
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
  /**
   * A two-angle swing as one slow-motion video, the main clip on the left and the second angle on the
   * right, lined up so the angle's time is the main clip's plus [shiftMs]. Video only. Cached like
   * `exportSlowMotionAsync`; another pairing or shift (a nudge) makes a new file. Also used to compare two swings.
   */
  exportSideBySideAsync(uri: string, angleUri: string, shiftMs: number, factor: number): Promise<string>;
  /** Main phone: look for camera phones (reported via `onPeersFound`) and reconnect to the last one. */
  startMainLink(): void;
  /**
   * Main phone: connect to a found camera (`PeerInfo.id`) or a typed `host:port` / `host`, using the
   * pairing [code] the camera phone shows. A wrong code reports `E_PEER_CODE` and stops retrying.
   */
  connectPeer(idOrAddress: string, code: string): void;
  /**
   * Become a camera phone: advertise on the local network and save whatever the main phone triggers.
   * Local triggers (impact sound, buttons, watch) are ignored while in this role.
   */
  startCameraLink(view: CameraView): void;
  /** Back to solo: disconnect and stop advertising / searching. */
  stopPeerLink(): void;
}

export default requireNativeModule<SwingCaptureModule>('SwingCapture');
