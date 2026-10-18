import type { StyleProp, ViewProps, ViewStyle } from 'react-native';

/**
 * What fired the capture. Auto sources count against the free-tier quota.
 * 'wrist' = a swing sensed by the watch with no impact sound (practice swing).
 */
export type TriggerSource = 'manual' | 'volumeKey' | 'watch' | 'impact' | 'wrist';

export const AUTO_TRIGGER_SOURCES: readonly TriggerSource[] = ['watch', 'impact', 'wrist'];

/** auto = the watch senses swings on the wrist; tap = watch SAVE button only; off = ignore the watch. */
export type WatchMode = 'auto' | 'tap' | 'off';

/** A camera's angle on the golfer: down the line (behind the hands, along the target line) or face on. */
export type CameraView = 'dtl' | 'faceOn';

/**
 * Two-phone capture. 'main' triggers as usual and drives a paired 'camera' phone, which saves the same
 * moments from its own buffer and sends them back as the swing's second angle.
 */
export type PeerRole = 'solo' | 'main' | 'camera';

/** Golfer region of interest, normalised 0..1 in preview coordinates. Used by the motion gate. */
export type NormalizedRect = { x: number; y: number; width: number; height: number };

export type CaptureConfig = {
  /** Requested capture rate; the engine falls back to the best supported rate. */
  fps: 60 | 120 | 240;
  /** Seconds kept before the impact instant (impact triggers). */
  preRollSec: number;
  /** Seconds recorded after the impact instant. */
  postRollSec: number;
  /**
   * Manual, volume-key and watch triggers are pressed after the swing, so they save the last
   * `lookbackSec` seconds instead of a window around an impact.
   */
  lookbackSec: number;
  roi: NormalizedRect;
  /** 0 (least sensitive) .. 1 (most sensitive) for the impact detector. */
  sensitivity: number;
  /** Favour a faster shutter to freeze the club (Android: auto-exposure aims one stop darker). */
  sharpMode: boolean;
  /** Whether impact / watch triggers are honoured (JS disables when the free quota is used). */
  autoTrigger: boolean;
  /** Whether the impact-sound detector may fire (user toggle). */
  impactTrigger: boolean;
  watchMode: WatchMode;
  /** With the watch sensing: save swings that had no impact sound (practice swings). */
  savePracticeSwings: boolean;
  /**
   * Play a short chime when a swing is saved (follows the phone's silent switch / ringer). The impact
   * detector ignores the chime. Camera phones never chime.
   */
  savedSound: boolean;
};

export type CaptureCapabilities = {
  /** Frame rates the active camera can sustain at the capture resolution. */
  supportedFps: number[];
  /** Android: constrained high-speed session available. iOS: always true for >= 120 fps formats. */
  highSpeed: boolean;
  /** Hardware volume-key / Bluetooth-remote trigger available. */
  volumeKeyTrigger: boolean;
};

/** 'standby' = low-power: preview + golfer-box motion only, nothing is being recorded. */
export type EngineState = 'idle' | 'armed' | 'triggered' | 'exporting' | 'standby';

/** The camera mode actually running (sensor orientation, so width > height). */
export type ActiveFormat = { width: number; height: number; fps: number; highSpeed: boolean };

export type StateChangeEvent = { state: EngineState; format: ActiveFormat | null };

export type TriggerEvent = {
  source: TriggerSource;
  /** Capture-clock time of the impact / trigger, in ms. */
  tImpactMs: number;
};

export type ClipReadyEvent = {
  /** File stem (`swing_<epochMs>`), shared with the second angle. */
  id: string;
  uri: string;
  /** JPEG thumbnail beside the clip, or null if frame extraction failed. */
  thumbUri: string | null;
  fps: number;
  durationMs: number;
  /** Impact position inside the clip in ms (lets review open on the impact frame); null for non-impact triggers. */
  impactOffsetMs: number | null;
  /** Position of the trigger instant (impact or button press) inside the clip, in ms; lines up the angles. */
  anchorOffsetMs: number;
  source: TriggerSource;
  /**
   * Size of the clip as shown upright (portrait from a phone, landscape from a tablet on its side), so
   * screens can shape a pane without opening the video. `orientation` is the rotation stored with it.
   */
  width: number;
  height: number;
  orientation: number;
  /** Tempo of the wrist swing that triggered the clip (watch sensing), else absent / null. */
  backswingMs?: number | null;
  downswingMs?: number | null;
};

/** A sharp sound heard by the impact detector (for on-screen calibration). */
export type SoundEvent = {
  /** Loudness of the 5 ms window around the sound, dBFS. */
  levelDb: number;
  /** Loudness a strike must reach at the current sensitivity. */
  minLevelDb: number;
  accepted: boolean;
  /**
   * Why it was ignored: 'quiet' (below minLevelDb), 'off' (toggle), 'touch' (phone being handled),
   * 'still' (no swing in the golfer box), 'wrist' (watch sensing, but no wrist swing), 'busy'
   * (saving / cooldown / quota).
   */
  reason: 'quiet' | 'off' | 'touch' | 'still' | 'wrist' | 'busy' | null;
  /** Peak golfer-box motion in the 1.5 s before the sound, and what it needed; null if not judged. */
  motionPeak: number | null;
  motionThreshold: number | null;
};

/** Golfer-box motion (mean luma change per frame, 0-255), ~2 Hz. */
export type MotionEvent = { level: number; threshold: number };

/** The SimpleSwing watch app is reachable / sensing wrist swings (auto mode, heartbeats arriving). */
export type WatchStatusEvent = { connected: boolean; sensing: boolean };

/** A wrist swing reported by the watch (peak rotation speed). */
/** A wrist swing; the tempo fields are present when the watch measured them (Wear OS only so far). */
export type WristSwingEvent = { peakDps: number; backswingMs?: number | null; downswingMs?: number | null };

/** What auto-exposure chose, ~1 Hz. Faster than 1/1000 s freezes the club. */
export type ExposureEvent = { shutterSec: number; iso: number | null };

/**
 * The two-phone link. Main: 'searching' until a camera phone is connected. Camera: 'advertising'
 * until a main phone connects; `address` is what to type on the main phone if discovery fails.
 */
export type PeerStatusEvent = {
  role: PeerRole;
  state: 'idle' | 'searching' | 'advertising' | 'connected';
  peerName: string | null;
  /** The other phone's engine state (e.g. 'armed'), once connected. */
  peerState: EngineState | null;
  /** Clock-sync uncertainty, ± ms; null until measured. */
  syncMs: number | null;
  address: string | null;
  /**
   * Camera role: this phone's 6-digit pairing code, shown on screen and typed on the main phone the
   * first time. It stays the same between sessions. Null in other roles.
   */
  code: string | null;
};

/**
 * A camera phone found on the local network (main role). On iOS `host` is '' and `port` 0: Bonjour
 * services are connected to by name, without resolving an address first.
 */
export type PeerInfo = { id: string; name: string; host: string; port: number };

export type PeersFoundEvent = { peers: PeerInfo[] };

/** The second angle of swing [id] has arrived (`<id>.b.mp4`). */
export type AngleReadyEvent = { id: string };

export type ThermalDowngradeEvent = { fromFps: number; toFps: number };

export type CaptureErrorEvent = { code: string; message: string };

export type SwingCaptureModuleEvents = {
  onStateChange: (event: StateChangeEvent) => void;
  onTrigger: (event: TriggerEvent) => void;
  onClipReady: (event: ClipReadyEvent) => void;
  onSound: (event: SoundEvent) => void;
  onMotion: (event: MotionEvent) => void;
  onExposure: (event: ExposureEvent) => void;
  onWatchStatus: (event: WatchStatusEvent) => void;
  onWristSwing: (event: WristSwingEvent) => void;
  onThermalDowngrade: (event: ThermalDowngradeEvent) => void;
  onPeerStatus: (event: PeerStatusEvent) => void;
  onPeersFound: (event: PeersFoundEvent) => void;
  onAngleReady: (event: AngleReadyEvent) => void;
  onError: (event: CaptureErrorEvent) => void;
};

export type SwingCaptureViewProps = {
  style?: StyleProp<ViewStyle>;
  onLayout?: ViewProps['onLayout'];
};
