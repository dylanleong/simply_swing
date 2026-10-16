# SimpleSwing: status and hand-over

_Last updated 2026-10-16. The plan is in [`PLAN.md`](PLAN.md); this file records what has actually been built, what was learned on real devices, and what comes next._

## Where we are

| Area | Android | iOS |
|---|---|---|
| Capture engine (rolling buffer, triggers, export) | ✅ Built and verified on the test phone | 🟡 **Written, never compiled.** First Mac build will surface errors |
| Impact-sound detector + golfer-box motion gate | ✅ Verified (claps / arm swings at home) | 🟡 Ported, untested |
| Capture UI, golfer box, help, levels, idle dim / standby | ✅ Verified | Shared JS. Should work once the engine compiles |
| Swings library, review (speeds, frame step), multi-delete | ✅ Verified | Shared JS |
| Save to Photos / Share (slow-motion export) | ✅ Built | 🟡 Ported (re-encodes; see below) |
| Settings (fps, clip length, sensitivity, sharp, battery, storage) | ✅ Built | Shared JS |
| Second phone as a second camera (multicam) | ✅ First two-phone run worked (HONOR main + OnePlus 9 camera, in sync ±11 ms) | 🟡 Ported, never compiled |
| Watch: tap-to-save remote | 🟡 Wear OS app built (`wear/`), never run on a watch | 🟡 Apple Watch app written (`targets/watch/`), **never compiled** |
| Watch: wrist swing detection + sound fusion | 🟡 Built and unit-tested, **never run on a watch** (OnePlus Watch 2R to come) | 🟡 Written (golf workout + 100 Hz motion); detector/fusion unit-tested on Linux; never compiled |
| Shot tags, club, favourites, filters, practice sessions | ✅ Verified on the HONOR | Shared JS |
| Review tools: plane / line / circle / angle, grid, mirror; compare two swings | ✅ Verified on the HONOR | Shared JS (mirror relies on the video view's transform) |
| Camera level check (accelerometer) | 🟡 Built; only checked lying flat (stays quiet). Check the tilt direction by hand | 🟡 Untested: the accelerometer's sign may differ |
| Tempo (backswing : downswing from the wrist) | 🟡 Watch + phone built and unit-tested, **never run on a watch** | 🟡 Written, unit-tested on Linux |
| Help & tips screen | ✅ Verified | Shared JS |
| Release hardening (pairing code, safe writes, chime, permissions; see below) | 🟡 Built, unit-tested; device check pending | 🟡 Written, never compiled |
| Purchases / paywall | ⬜ | ⬜ |
| Store accounts & listing | 🟡 Drafts in `docs/release/`, site in `site/`; accounts not opened (upload key created) | 🟡 Same drafts |

**Untested by design so far:** a real driving range. All thresholds are tuned on claps and arm swings at home.

## What the app does (both platforms)

- The Capture tab is **always recording** into an in-memory or temporary rolling buffer (about 8 s). Nothing is stored unless a swing is saved.
- **Triggers:**
  - **Impact:** a sharp, loud sound (`ImpactDetector`), accepted only if there was movement in the golfer box during the 1.5 s before it (`MotionGate`). The clip spans 3 s before to 1.5 s after (configurable).
  - **SAVE button / volume keys / Bluetooth remote / watch:** pressed after the swing, these keep the last 6 s (configurable).
  - 3 s cooldown between saves. In standby, any press wakes the camera instead of saving.
- **Clip files:** `Documents/swings/swing_<epochMs>.mp4`, plus `.jpg` (thumbnail) and `.json` (metadata sidecar). The JS library reads these directly (`src/lib/swing-store.ts`).
- **Idle handling:** the screen dims after 30 s. After 5 min the camera goes to standby (30 fps preview plus the motion check only). Moving in the box, touching the screen, SAVE, the remote or the watch wakes it.
- **Slow-motion export (Save to Photos / Share):** a ×4 retimed copy, so 120 fps plays back at 30 fps in any player.

## Golfer features (added 2026-10-15)

- **Tags:** `src/lib/swing-notes.ts`. The golfer's notes live in `swing_<id>.user.json` (result, club, favourite, drawings), never in the engine's `.json`. `updateSwingNotes` merges.
  - Capture: the **Club** chip sets `CaptureSettings.club`, stamped on every clip in `onClipReady`. The replay overlay asks "How was it?" (`ResultChips`), and one tap tags it and closes the replay.
  - Swings: `SwingBrowser` (shared with the compare picker) groups by session (`groupSessions`, a 45 min gap) and filters by club, result and favourites. Auto-delete never removes favourites.
- **Review** (`src/app/swing/[id].tsx`) has four panels: Play, Tag, Draw, Share. Players come from `useLinkedPlayers` (shared with compare).
  - Drawings: `DrawingOverlay` draws with plain views (no SVG dependency), in picture coordinates (0..1 of the 9:16 clip, `fitRect`), so they survive layout changes.
  - Video views use `surfaceType="textureView"`, because a SurfaceView ignores the mirror transform.
  - Touch start is kept in a ref, not state: a quick tap's release arrives before a re-render.
- **Compare:** Share → Compare with… → `/compare-pick` → `/compare?a&b`. The two swings line up on impact (`compareLink`), or on the trigger for button saves, with a nudge. Save/Share reuse `exportSideBySideAsync`. Its cache name includes both clip stems, so a comparison can't collide with an angle export.
- **Level:** `src/lib/level.ts` + `LevelIndicator` on Capture. It warns past 2° of roll or 8° of pitch, and is quiet when the phone lies flat or is carried.
- **Tempo:** the watch's `SwingDetector` keeps 4 s of speeds.
  - **Top of the backswing:** the slowest sample 0.1–0.6 s before the peak.
  - **Takeaway:** the last sample under 40°/s before the top.
  - **Message:** the watch sends `"ageMs,peakDps,backswingMs,downswingMs"`. Older phones ignore the extra fields.
  - **On the phone:** `WristSwingMessage`/`TempoLog` attach the tempo to the clip whose anchor is within 0.5 s of the wrist peak, written as `backswingMs`/`downswingMs` in the sidecar.
  - **Shown:** on the replay, in review (Play panel), on library tiles and in Levels.
  - **To tune on the watch:** the top search window and `stillDps`. Compare against a slow-motion clip's frame count for takeaway, top and impact.
- **Help:** `src/lib/help-topics.ts` (content) + `src/app/help.tsx`. Opened from Settings, the Capture card and the Draw panel's "?" (`?topic=reading`).

## Design rules (2026-10-16 redesign)

- **One look per role** (`src/components/chip.tsx`):
  - `option`: outlined; selected = accent outline, tint (`accentSoft`) and text.
  - `action`: filled neutral.
  - `primary`: filled accent, one per screen.
  - `danger`: red text.
  - Navigation (`ModeBar`, the tab bar) is icon + label with no pill. Never style tabs like options.
  - Settings' `Segmented` follows the option look.
- **Green means selected / on, or the one main action.** Never decoration. Red means recording.
- **Hide what's rare.** Review shows the transport and tagging. Draw is a mode. Save, share, compare, grid, mirror, aligning the angles, help and delete live in the ⋯ sheet (`Sheet` / `SheetRow`). Tapping an angle's label shows it alone.
- **Nothing moves when a mode changes.** Review's dock is scrubber + `Transport` + a fixed-height tray (`TRAY_HEIGHT`) + `ModeBar`. Compare uses the same `Transport`.
- **Icons:** `@expo/vector-icons` (Ionicons and MaterialCommunityIcons) via `<Icon name="ion:…" | "mci:…">`.
- **Library:** 3 columns, tags on the thumbnail, time only under it (the session header gives the day), filters in a sheet.

## Release hardening (2026-10-16)

From a pre-release audit of the whole codebase. Release documents: `docs/release/checklist.md` (launch steps, device test matrix), `store-listing.md`, `privacy-declarations.md`; privacy/support pages in `site/` (GitHub Pages).

- **Two-phone pairing code** (protocol v2): see "Second camera" below. Before it, anyone on the same Wi-Fi could connect to a camera phone, pull clips, and (via a crafted clip id used as a file name) overwrite or delete swings.
- **No lost or half-written clips:**
  - A swing still in its post-roll when the pipeline stops (tapping away, standby, heat downgrade) is saved with what was recorded (`CaptureEngine.stopPipeline` → `takeFrames`; `PendingClip.claimed` decides whether export or the stop owns it).
  - Clips and exports are written as `.part` and renamed (`ClipWriter.atomically`); leftovers are cleaned at engine start.
  - Less than 100 MB free → `E_STORAGE` before writing. iOS: disk-full reports once and stops retrying.
  - JS file writes (`swing-store.ts`) return false instead of throwing; screens show "Couldn't save".
- **Saved chime:** `SavedChime` (Kotlin/Swift) synthesises a soft 250 ms E6→A6 chime after a main/solo clip is saved, when Settings → Sound when saved is on (default). It plays as a notification/system sound, so silent mode, notification volume and Do Not Disturb mute it. The impact detector is muted through the chime + 400 ms (reuses the touch mute, so Levels shows "touch"). The Wear OS watch now also double-buzzes on save while its screen is off (`SwingSensorService`).
- **Capture tab is mounted behind other tabs:** idle dim, standby, keep-awake and the replay run only while it's focused (`useIsFocused`). Before, Swings/review dimmed to 5% after 30 s.
- **Settings → auto-delete** asks before deleting existing swings.
- **Permissions:** "Open Settings" when the OS won't ask again; re-checked on return to the foreground (`use-capture-permission.ts`, `permission-gate.tsx`).
- **Review/compare:** Save/Share can't run twice at once; a clip that can't play shows "Can't play this clip" + Delete; a missing swing id shows "Swing not found"; delete falls back to `/library` when there's no back (cold-start deep link; `unstable_settings.anchor = '(tabs)'`).
- **Library:** `getSwing` reads only that swing's files; pruning runs once per launch; file pairing is a pure, tested function (`swing-files.ts`); orphan angles and stale `.part` files are cleaned.
- **Android policy:** `READ_MEDIA_*` blocked (Save to Photos is write-only); backup excludes `files/swings/` (it overflowed the 25 MB quota and skipped everything); Android 16 large-screen portrait opt-out (`plugins/with-android-policy.js`; Android 17 removes the opt-out). Version 1.0.0 (versionCode 1; wear 1000001).
- **Robustness:** mic read errors stop the pipeline with `E_AUDIO` instead of spinning; `createSession` failures are caught; config/ROI values from JS are clamped (NaN-safe); the watch stops sensing after 2 min without any phone message; the peer link stops when the module is destroyed.
- **iOS-only:** mic refusal records video-only instead of failing; the app configures `AVAudioSession` itself (`.playAndRecord` + `.mixWithOthers`) and re-applies it when expo-video changes the category, so replays don't cut the mic; `UIRequiresFullScreen` (iPad, portrait only).
- **Accessibility:** scrubber is adjustable by screen readers; text in fixed-size controls is capped at 1.2–1.3× font scale.

## Apple Watch (added 2026-10-16, written blind)

1.0 ships the iPhone second camera, the Wear OS app and an Apple Watch app with the same features. All of the iOS/watchOS code waits for a Mac to be compiled.

- **Watch app:** `targets/watch/` (`@bacons/apple-targets`, type `watch`, watchOS 10, bundle `app.simpleswing.watchkitapp`, HealthKit entitlement). Prebuild (checked on Linux in a scratch copy) generates the `SimpleSwingWatch` target embedded in the iOS app. It writes `targets/watch/Assets.xcassets` (git-ignored).
  - `SwingDetector.swift` is a line-for-line port of the Wear OS detector (same constants and tempo logic; the Kotlin test cases pass in Docker `swift:5.10`).
  - `SwingSensor.swift`: a golf `HKWorkoutSession` keeps the app running with the screen off; `CMMotionManager` device motion at 100 Hz feeds the detector; heartbeat every 5 s; stops after 2 min of phone idle or silence, or 3 h. **Nothing is saved to Health** (no workout builder). Without Health permission it senses only while on screen.
  - `PhoneLink.swift` is the only `WCSession` delegate; `WatchModel.swift` ties it to the screen and haptics (saved = success, rejected = failure).
- **Phone side:** `modules/swing-capture/ios/WatchBridge.swift` mirrors `WearBridge.kt`; `TriggerFusion.swift` and `WristTempo.swift` are ports (Kotlin test cases pass in Docker); `CaptureEngine.swift` wires fusion, practice swings, tempo in the sidecar, `saved` and state broadcasts, as on Android.
- **Messages** (WatchConnectivity `sendMessage`; `t` is always the type): watch → phone `hello`, `trigger`, `swing` {ageMs, peakDps, backswingMs?, downswingMs?}, `heartbeat` (the only one sent with a reply handler: the phone answers `state` {state, mode}, which reaches a watch in a background workout when the phone's own messages may not), `pong` {ns}; phone → watch `state` {state}, `saved`, `rejected` {state}, `config` {mode}, `ping` {ns}. The phone also keeps the application context `{mode, state}` current. Nothing falls back to `transferUserInfo`: a late trigger or swing would do harm.
- **To verify on the first Mac build:** the `// VERIFY:` comments in `WatchBridge.swift`, `PhoneLink.swift` and `SwingSensor.swift` (WCSession delegate signatures, workout recovery, whether motion timestamps share the uptime clock); haptics and 100 Hz motion with the wrist down; whether `config` "auto" arriving in the background can start the workout. Enable HealthKit for `app.simpleswing.watchkitapp` in the developer portal. Optional later: start the watch from the phone with `HKHealthStore.startWatchApp(with:)` (needs HealthKit on the phone too).

## Watch: how wrist detection works (Wear OS)

- **Watch** (`wear/`):
  - `SwingSensorService` runs as a "health" foreground service with a wake lock while the phone is on Capture. It reads the gyroscope at 100 Hz.
  - `SwingDetector` reports a swing when there's a burst of rotation of at least 0.3 s, peaking at 700°/s or more, and the speed has then fallen to 60% of the peak.
  - It sends `/simpleswing/swing "ageMs,peakDps"` to the phone, plus a heartbeat every 5 s.
  - It stops itself 2 minutes after the phone leaves Capture.
- **Phone** (`WearBridge` + `TriggerFusion` in the engine):
  - **Clock alignment:** the phone pings the watch every 5 s. Half the smallest recent round trip gives the one-way delay, and the swing's peak time on the phone clock is `now − (age + one-way)`.
  - **While the watch is sensing** (auto mode, heartbeats arriving), the wrist replaces the camera motion check:
    - **Sound + wrist peak within 0.15 s:** save, centred on the sound.
    - **Sound with no wrist swing within 0.5 s:** ignored (`reason: "wrist"`). A wrist message arriving up to 2 s late still claims the sound.
    - **Wrist swing with no sound:** saved as source `wrist` ("Practice") if **Settings → Watch → Save practice swings** is on.
  - **If heartbeats stop,** it falls back to the camera motion check automatically.
- **Settings → Watch:**
  - *Sense swings* (default), *Tap to save* or *Off*
  - *Save practice swings* (off by default)
  - The Levels panel shows the watch status and the last wrist peak in °/s.
- **To tune on a real watch:** `SwingDetector.peakDps` (700°/s) and `minBackswingNs` (0.3 s), and the fusion window (0.15 s) and wait (0.5 s).

## Second camera (multicam)

A second phone running SimpleSwing films another angle of the same swing (face on or down the line). Both clips are saved together, and review plays them side by side.

### How it works

- **Roles:**
  - **Main phone:** the one you swing with. It triggers as usual and drives the camera phone. Turn it on from **+ Cam** on the Capture screen.
  - **Camera phone:** started from **Settings → Second camera → Use this phone as the camera**. It ignores its own triggers (impact sound, buttons, watch) and saves only what the main phone asks for. It goes into and out of standby with the main phone.
- **Pairing:** the camera phone shows a 6-digit code (random, kept in SharedPreferences `simpleswing_peer` / UserDefaults `simpleswing.pairCode`). The main phone asks for it once per camera and saves it (`lastCameraCode`) for auto-reconnect.
  - A connection can do nothing until its HELLO carries the code, and it never replaces the live link until then (5 s timeout, at most 4 waiting).
  - Wrong code → `REJECT {id:"", reason:"code"}`, and every HELLO is refused for 2 s (`"wait"`), so guessing takes about 12 days on average (one guess per 2 s, checked under a lock so parallel connections share it). The main phone shows `E_PEER_CODE` and stops retrying.
  - Both sides accept only clip ids `swing_<digits>`; the main phone only accepts clips it asked for (60 s), up to 256 MB and never more than announced; the camera rejects impossible windows (`PeerProtocol.isSaneWindow`, overflow-safe).
  - The link is still plain TCP (not encrypted) on the local network; the privacy policy says so.
- **Link:**
  - The camera phone listens on TCP **47800** (or any free port if that one is taken) and advertises `_simpleswing._tcp` over mDNS/Bonjour.
  - The main phone lists the camera phones it finds. If discovery fails, type the address the camera phone shows.
  - The main phone reconnects on its own to the last camera phone it used.
  - Same Wi-Fi or one phone's hotspot. Nothing leaves the local network.
- **Protocol** (`PeerProtocol.kt` / `.swift`, `scripts/multicam-peer.py`, keep all three in step):
  - Frames are `u8 type | u32 big-endian length | payload`. Payloads are JSON, except clip bytes, which go in 64 KB `DATA` chunks.
  - Version 2. `HELLO` (main's carries `code`), `PING`/`PONG` (every second), `STATE`, `TRIGGER`, `REJECT`, `CLIP` + `DATA`… + `DONE`, `BYE`.
  - The link drops after 6 s of silence.
- **Clock sync** (`ClockSync`): NTP style, using the capture clocks on both phones.
  - It keeps the last 20 pings and uses the one with the smallest round trip. The error is half that round trip, shown as "±N ms".
  - A sample that jumps by more than any round trip could explain (a camera restart switching clock base) starts the estimate afresh.
- **Alignment:**
  - When the main phone accepts a trigger, it picks the clip id (`swing_<epochMs>`). It sends the clip window and the **anchor** (the impact, or the button press) converted to the camera phone's clock.
  - Each clip records `anchorOffsetMs`, the anchor's position in the clip. Review maps `tB = tA − anchorA + anchorB + nudgeB`.
  - The camera phone saves the clip to a temporary folder, streams it back and deletes it.
- **Files on the main phone:** `swing_<id>.b.mp4` (written as `.part`, then renamed) and `swing_<id>.b.json`: `{fps, durationMs, anchorOffsetMs, view, deviceName, syncMs, nudgeMs}`. The main clip is saved even if the angle never arrives. The "Angle 2 ◀ ▶" nudge in review is saved back to `.b.json`.
- **Errors shown to the user:**
  - `E_PEER_MISSED`: the camera phone wasn't armed.
  - `E_PEER_CLIP`: the transfer was cut short.
  - `E_PEER_VERSION`: the two phones run different app versions.
  - `E_PEER_PERMISSION` (iOS): the Local Network permission was refused.
  - `E_PEER_CODE`: the pairing code was wrong.
- **Save / Share with "Both" on screen** export one side-by-side slow-motion video (`exportSideBySideAsync`): main clip left, angle right, 720×1280 panels with a 16 px gap (1456×1280), lined up with review's shift (nudge included, and part of the cache file name). Android: `SideBySideExporter` decodes both into SurfaceTextures and draws them with GL into the encoder; verified on the HONOR (upright, in step); a 4.5 s clip exports in ~2.3 s. Keep the decoders fed with every input buffer they will take and never block on the encoder mid-stream: one-at-a-time feeding with 10 ms waits made it ~25 s. iOS: `AVMutableVideoComposition`, written blind. With one angle on screen, only that angle is exported.
- **Not done yet:** a two-phone run at the range, the paywall gate (it's a paid add-on in the plan), and angle labels burned into the side-by-side export.

### Testing with one phone (Android, over adb)

`scripts/multicam-peer.py` stands in for the other phone (see its docstring):

- **HONOR as main:** `adb reverse tcp:47800 tcp:47800`, then `scripts/multicam-peer.py camera --clip <some.mp4>`. On the phone, tap **+ Cam**, enter `127.0.0.1` and code `123456` (the script's default `--code`). The pill should show connected with a sensible ±ms. Press SAVE or clap.
  - Check that `swing_<id>.b.mp4` and `.b.json` arrive (`adb shell run-as app.simpleswing ls files/swings`).
  - Check the library shows "2 angles" and review plays both, with frame step and nudge working.
- **HONOR as camera:** Settings → Use this phone as the camera. Then `adb forward tcp:47800 tcp:47800` and `scripts/multicam-peer.py main --host 127.0.0.1 --code <code on the phone> --trigger-every 10 --out /tmp/angles`.
  - Clips should arrive with `anchorOffsetMs` ≈ 3000 for impacts, and `ffprobe` should show 120 fps with audio.
- **Discovery:** `avahi-browse -r _simpleswing._tcp` should list the phone while it's in camera mode (if the VM's network bridging passes mDNS).
- **Then, with two real phones:** film one clap from both. In review, the clap frame should line up within about a frame. If it doesn't, it's the sync or the anchor maths, not the nudge.

### iOS specifics

- Built on Network.framework: an `NWListener` with a Bonjour service, an `NWBrowser`, and `NWConnection`. `includePeerToPeer` is on, so two iPhones can also link over AWDL without a shared Wi-Fi.
- `app.json` declares `NSLocalNetworkUsageDescription` and `NSBonjourServices`. iOS asks for Local Network permission the first time either role starts.
- Bonjour results aren't resolved, so found iPhones show no IP in the list (`PeerInfo.host` is empty). Connections go to the service by name.
- The device name is "iPhone" / "iPad" unless the app gets Apple's device-name entitlement. Two iPhones of the same kind show up as "iPhone" and "iPhone (2)".
- iOS stops the camera when the app is in the background, so **both phones must stay in the app**. A backgrounded camera phone goes idle, and the main phone reports misses.
- `ClockSync.swift` and `PeerProtocol.swift` were compiled and tested on Linux in Docker (`swift:5.10`), including frames exchanged with the Python peer. `PeerLink.swift` and the engine changes need Network and AVFoundation, so they were only syntax-checked.

## Code map

- `src/app/(tabs)/index.tsx`: Capture screen (status pill and hint, golfer box, levels panel, replay overlay, bottom controls, idle/standby).
- `src/app/(tabs)/library.tsx`, `src/app/swing/[id].tsx`, `src/app/(tabs)/settings.tsx`: library, review screen, settings.
- `src/lib/`: pure logic with Jest tests. Covers settings (`capture-settings*`), the clip library and pruning, the trigger quota (for the coming paywall), idle phases, the screen dimmer and Photos/share export.
- `modules/swing-capture/`: the native engine. The TypeScript contract is in `src/SwingCaptureModule.ts` and `src/SwingCapture.types.ts`.
  - `android/…/capture/` (Kotlin):

    | File | What it does |
    |---|---|
    | `CaptureEngine` | Camera2 high-speed session, MediaCodec encoder, and the state machine |
    | `EncodedRing` | Rolling buffer of encoded frames |
    | `ClipWriter` | MediaMuxer clip writing, thumbnails, sidecar files, slow-motion retiming |
    | `ImpactDetector`, `MotionGate` | Impact sound and golfer-box motion |
    | `VolumeKeyInterceptor` | Volume and remote keys, plus touch-mute |
    | `WearBridge` | Link to the Wear OS app |
    | `PeerLink`, `PeerProtocol`, `ClockSync` | Second-camera link: discovery, socket, messages, clock sync |

    JUnit tests live in `android/src/test`.
  - `ios/` (Swift):

    | File | What it does |
    |---|---|
    | `CaptureEngine` | AVCaptureSession and the state machine |
    | `ChunkRecorder` | Rolling buffer as roughly 1 s AVAssetWriter files, rotated |
    | `ClipExporter` | Stitch and trim (passthrough), thumbnail, sidecar, slow-motion (re-encode) |
    | `ImpactDetector`, `MotionGate` | Line-for-line ports of the Kotlin versions |
    | `SwingCaptureView` | Preview layer, and volume keys via `AVCaptureEventInteraction` (iOS 17.2+) |
    | `PeerLink`, `PeerProtocol`, `ClockSync` | Second-camera link on Network.framework (ports of the Kotlin) |
- `wear/`: standalone Wear OS Gradle project. It uses the same `applicationId` and signing key as the phone app, which the Wear Data Layer requires.
  - `MainActivity` is the SAVE button screen.
  - `SwingSensorService` and `SwingDetector` do the wrist sensing (JUnit tests in `wear/src/test`).
  - `WearProtocol` holds the message paths.
- Multicam JS:
  - `src/app/camera-mode.tsx`: the camera phone's screen.
  - `src/hooks/use-main-peer-link.ts` and `src/components/second-camera-sheet.tsx`: the main phone's link and pairing sheet.
  - `src/lib/multicam.ts`: angle alignment, drift correction and labels.
- `scripts/multicam-peer.py`: a fake second phone for testing over adb.
- `plugins/with-release-signing.js`: Play bundles are signed with the upload key; sideload APKs stay debug-signed.
- `scripts/generate-icons.py`: draws every icon size (strobe-swing mark). Run it after changing the design.

## Device findings (things that cost time, so you don't repeat them)

Test phone: HONOR VKP-NX9, Android 16 (MagicOS), Qualcomm. It records 1080p at 120 fps and 1080p at 240 fps in high-speed mode.

1. **HONOR's high-speed encoder stamps frames with `CLOCK_MONOTONIC`**, even though the camera declares `REALTIME`. The difference was about 13.5 days, so clips never finished saving. The engine now measures the gap on the first frame and shifts by the exact difference between the two clocks (`CaptureEngine.measureVideoOffset`). Keep this logic.
2. **Constrained high-speed sessions accept only two outputs** (preview and encoder), and the **preview runs at 30 fps** while the encoder gets 120 fps. Motion sensing therefore copies the preview with `PixelCopy` at 15 fps rather than adding an `ImageReader`.
3. **The tab bar keeps the Capture view, and its SurfaceView surface, alive** across tab switches. The engine must reuse a still-valid preview surface on restart, or it waits forever on "Starting camera".
4. **A paused replay overlay looks like a frozen camera** after locking and unlocking. Replays now close when the app is backgrounded and after 20 s.
5. **The phone's microphone hears screen taps** at −30 to −50 dB. That is why the detector has an absolute loudness floor (−32 dB at medium; −24 low, −40 high) and mutes for 1.5 s after a touch. Touch-mute is Android-only so far.
6. **The `logcat` buffer is tiny** (256 KB) and HONOR's camera service floods it. Run `adb logcat -G 16M` and filter by tag (`-s SwingCaptureEngine:I`).
7. **Release Gradle builds run out of memory at 2 GB** (lint). Pass `-Dorg.gradle.jvmargs=-Xmx6g`.
8. **Put overlays on the picture, not the pane.** With "contain", a video pane has letterbox bars, so labels and drawings are positioned from `fitRect`. Otherwise they float in the bars or drift off the golfer when the layout changes.
9. **expo-video's Android default buffer is ~130 MB per player**, refilled on every loop, all on the Java heap (limit 384 MB on the HONOR). Two review players, or the capture replay plus the camera's ring, crashed the app with an OOM. Every player now uses `CLIP_BUFFER_OPTIONS` (`src/lib/clip-playback.ts`, 24 MB cap); live heap is ~55–65 MB in every screen. Any new `useVideoPlayer` must use it too.
10. **expo-video's native view swallows touches on Android.** A `Pressable` wrapped *around* a `VideoView` never fires; put the `Pressable` on top as a sibling.
11. **VMware USB passthrough drops phones** whenever they re-enumerate (accepting the debugging prompt, unlocking, switching USB mode). Reattach via VM → Removable Devices. The VM sits on VMware NAT (192.168.136.x), so the phones can't reach it over Wi-Fi; the `multicam-peer.py` tunnel only works while USB stays attached.
12. **Android's Wear OS link isn't present on the test phone** (`Wearable.API is not available`). The watch model is still unconfirmed. If it's a HONOR watch, it can't run Wear OS apps.
13. **Two preview views can be on screen at once** (camera mode is pushed over the still-mounted Capture tab, and react-native-screens detaches the covered one). Leaving camera mode, Capture restarted the camera a moment *before* its own view came back, so the session opened on camera mode's closing view and kept drawing into it after it was destroyed: the preview froze and every save failed with "video stopped arriving" until the next tab switch (found 2026-10-16; timing-dependent, it passed once earlier the same day). `CaptureEngine` now keeps every attached view (`hosts`) and the one the session uses (`sessionHost`), restarts when that view is covered, destroyed or detached, and falls back to the view underneath. Check the same round trip on iOS.

**Second test phone: OnePlus 9 (LE2113), Android 14.** 1080p @ 120 fps high-speed; its encoder stamps frames on the declared clock (offset 0). In dim indoor light, sensor noise alone reads ~52% "motion" in the golfer box, so the threshold climbs above 100% and auto-trigger can't fire. Check this in daylight before tuning; the motion gate may need noise-aware thresholds.

Measured on the HONOR (2026-10-12, golfer about 3 m away):
- **Motion is the percentage of golfer-box pixels that changed** (|Δluma| ≥ 18) between preview frames taken 1/15 s apart.
- **Still** at address reads **0–2%**. **Swings and body movement** read **10–90%**. The threshold is 3× the scene's quiet level, with a floor of 1%.
- The first version measured the *mean* change instead. It read only ~0.7 for a full swing (threshold 4), so nothing saved. Don't go back to that.
- **Claps at 3 m** read **−31 to −45 dB**, below the original −27.5 dB floor, which is why it's now −32. A struck ball should be ~15–20 dB louder.
- **Moving the phone itself** reads 80–95%, so the app needs a tripod.

## iOS: first build on the Mac

### Setup

1. Install Xcode (App Store) and accept the licence.
2. `brew install node@22 watchman cocoapods`
3. `git clone <repo> && cd simple_swing && npm ci`
4. `npx expo prebuild -p ios`
5. Connect the iPhone or iPad by cable, then run `npx expo run:ios --device`.
6. Signing: in Xcode, open `ios/SimpleSwing.xcworkspace` → target → Signing & Capabilities. Pick your Apple ID as a "Personal Team". This is free; builds expire after 7 days. The paid account is only needed for TestFlight and the App Store.

Expect compile errors. The Swift was written blind against the SDK 57 sources. Paste the errors into the session.

### Verify on the first device run

- [ ] **Orientation:** the preview is portrait and the saved clips are upright (writer transform `rotationAngle: .pi/2`).
- [ ] **Motion thumbnail orientation:** with Levels open, moving inside the box should raise "movement" and moving outside it shouldn't. If the readings are swapped, the 90° mapping in `CaptureEngine.sampleMotion` is wrong.
- [ ] **Format and audio:** Levels shows 1920×1080 @ 120 (or 240). The impact detector logs sounds, which checks the audio format handling in `monoSamples`.
- [ ] **Clip continuity:** clips play smoothly across the roughly 1 s chunk joins, and audio stays in sync.
- [ ] **Save delay:** SAVE should save the clip in under about 1.5 s. This covers chunk rotation, the 0.25 s audio wait and the passthrough export.
- [ ] **Volume buttons:** they save (iOS 17.2+ only) and don't change the volume.
- [ ] **Sharp mode:** Levels shows a shutter of 1/1000 s or faster (iOS caps auto-exposure via `activeMaxExposureDuration`).
- [ ] **Standby:** wakes correctly. **Interruptions:** a phone call or Control Centre camera recovers cleanly.
- [ ] **Level bar:** tilt the phone clockwise. The bar should rotate to stay level with the real horizon. If it tilts the other way, flip the roll sign for iOS in `tiltFromGravity`.
- [ ] **Camera mode round trip:** open camera mode, stop it, return to Capture and press SAVE. The clip must save (Android device finding 13).
- [ ] **Exports:** Save to Photos and Share produce a slow-motion clip (the iOS export re-encodes, so expect a second or two).
- [ ] **Multicam:**
  - The Local Network prompt appears, and the iPhone appears in the Android main phone's list (and the other way round).
  - Clips transfer both ways.
  - `anchorOffsetMs` in the `.b.json` is sensible: about 3000 for an impact, about 6000 for SAVE with default settings.

### Not yet on iOS

- Touch-mute of the impact detector (Android catches touches natively). On iOS it needs a JS→native "user touched" call or a window gesture recogniser.
- Apple Watch: written (see "Apple Watch" above), not yet compiled.

## Signing and accounts

- **Bundle / package id `app.simpleswing`** is a placeholder. It's permanent after the first store upload, so confirm it (a reverse domain you own) beforehand.
- **Play upload key:** `~/.android/simpleswing-upload.jks` on the Linux VM, with credentials in `~/.gradle/gradle.properties`. **Back both up together.** Only `bundleRelease` uses it.
- **No store accounts yet.**
  - **Apple Developer** (US$99/yr): needed for TestFlight and the App Store. Apply for the Small Business Program too.
  - **Google Play** (US$25): a new personal account must run a closed test with 12 testers for 14 days before production. Start that about 3 weeks before launch.

## Next steps, in order

0. **Device-check the release hardening.** Verified on the HONOR (2026-10-16): the chime plays (notification usage), Swings no longer dims, Save to Photos works with `READ_MEDIA_*` blocked, the HONOR clock fix still applies, "Swing not found", and pairing both ways against `multicam-peer.py` (wrong code refused, 2 s lockout, right code pairs, angles arrive, a path-traversal id and an overflow window are rejected, the app survives). Still to check: tapping away mid-post-roll (needs a real impact), the auto-delete confirmation with old swings, the OnePlus, and a real two-phone pairing.
1. **Multicam:** the first two-phone run worked (2026-10-15). Still to check: clap alignment frame by frame, and why one SAVE got `REJECT busy` from the camera phone (probably still waking from standby right after the main phone's app restarted).
2. **Range session** with the current Android build. Record Levels readings (dB, "swing P/T", shutter) for your strikes versus neighbours'. Also measure battery and warmth over 1 hour.
3. **iOS first build** on the Mac and fix compile errors. Then work through the checklist above.
4. **Tune thresholds** from the range data, on both platforms. The constants are `ImpactDetector.minLevelDb/marginDb` and `MotionGate.minMotion/thresholdFactor`.
5. **Play policy.** `READ_MEDIA_*` are now blocked (confirm Save to Photos still works on Android 13+). **Keep `INTERNET`:** the second-camera link needs it for local sockets. Nothing leaves the local network, so "Data Not Collected" still holds. Answers for the Play forms are in `docs/release/privacy-declarations.md`.
6. **Purchases.** A £14.99 lifetime unlock via `expo-iap`. The free tier allows 3 auto-saves per session; `src/lib/trigger-quota.ts` is ready to wire to `SwingCapture.setAutoTrigger`.
7. **Watch.** Pair the OnePlus Watch 2R through OHealth and install `wear/` over wireless ADB. Then tune `SwingDetector` on real swings, including its tempo (top and takeaway against the slow-motion clip), and check the clock alignment (log: `Wrist swing peak … one-way … ms`). Apple Watch (WCSession plus a HealthKit workout) on the Mac.
8. **Store listing:** drafts in `docs/release/store-listing.md`; privacy and support pages in `site/` (fill in the developer name and contact email, host on GitHub Pages). Then screenshots, and closed and TestFlight betas. Open the Play account early: a new personal account needs a 14-day closed test with 12 testers.
