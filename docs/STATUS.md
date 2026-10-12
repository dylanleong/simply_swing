# SimpleSwing: status and hand-over

_Last updated 2026-10-12. The plan is in [`PLAN.md`](PLAN.md); this file records what has actually been built, what was learned on real devices, and what comes next._

## Where we are

| Area | Android | iOS |
|---|---|---|
| Capture engine (rolling buffer, triggers, export) | ✅ Built and verified on the test phone | 🟡 **Written, never compiled.** First Mac build will surface errors |
| Impact-sound detector + golfer-box motion gate | ✅ Verified (claps / arm swings at home) | 🟡 Ported, untested |
| Capture UI, golfer box, help, levels, idle dim / standby | ✅ Verified | Shared JS. Should work once the engine compiles |
| Swings library, review (speeds, frame step), multi-delete | ✅ Verified | Shared JS |
| Save to Photos / Share (slow-motion export) | ✅ Built | 🟡 Ported (re-encodes; see below) |
| Settings (fps, clip length, sensitivity, sharp, battery, storage) | ✅ Built | Shared JS |
| Watch companion | 🟡 Wear OS app built (`wear/`), never run: test phone has no Wear OS link | ⬜ Apple Watch: Phase 6 |
| Purchases / paywall | ⬜ | ⬜ |
| Store accounts & listing | ⬜ (upload key created) | ⬜ |

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

    JUnit tests live in `android/src/test`.
  - `ios/` (Swift):

    | File | What it does |
    |---|---|
    | `CaptureEngine` | AVCaptureSession and the state machine |
    | `ChunkRecorder` | Rolling buffer as roughly 1 s AVAssetWriter files, rotated |
    | `ClipExporter` | Stitch and trim (passthrough), thumbnail, sidecar, slow-motion (re-encode) |
    | `ImpactDetector`, `MotionGate` | Line-for-line ports of the Kotlin versions |
    | `SwingCaptureView` | Preview layer, and volume keys via `AVCaptureEventInteraction` (iOS 17.2+) |
- `wear/`: standalone Wear OS Gradle project. It uses the same `applicationId` and signing key as the phone app, which the Wear Data Layer requires.
- `plugins/with-release-signing.js`: Play bundles are signed with the upload key; sideload APKs stay debug-signed.
- `scripts/generate-icons.py`: draws every icon size (strobe-swing mark). Run it after changing the design.

## Device findings (things that cost time, so you don't repeat them)

Test phone: HONOR VKP-NX9, Android 16 (MagicOS), Qualcomm. It records 1080p at 120 fps and 1080p at 240 fps in high-speed mode.

1. **HONOR's high-speed encoder stamps frames with `CLOCK_MONOTONIC`**, even though the camera declares `REALTIME`. The difference was about 13.5 days, so clips never finished saving. The engine now measures the gap on the first frame and shifts by the exact difference between the two clocks (`CaptureEngine.measureVideoOffset`). Keep this logic.
2. **Constrained high-speed sessions accept only two outputs** (preview and encoder), and the **preview runs at 30 fps** while the encoder gets 120 fps. Motion sensing therefore copies the preview with `PixelCopy` at 15 fps rather than adding an `ImageReader`.
3. **The tab bar keeps the Capture view, and its SurfaceView surface, alive** across tab switches. The engine must reuse a still-valid preview surface on restart, or it waits forever on "Starting camera".
4. **A paused replay overlay looks like a frozen camera** after locking and unlocking. Replays now close when the app is backgrounded and after 20 s.
5. **The phone's microphone hears screen taps** at −30 to −50 dB. That is why the detector has an absolute loudness floor (−27.5 dB at medium sensitivity) and mutes for 1.5 s after a touch. Touch-mute is Android-only so far.
6. **The `logcat` buffer is tiny** (256 KB) and HONOR's camera service floods it. Run `adb logcat -G 16M` and filter by tag (`-s SwingCaptureEngine:I`).
7. **Release Gradle builds run out of memory at 2 GB** (lint). Pass `-Dorg.gradle.jvmargs=-Xmx6g`.
8. **Android's Wear OS link isn't present on the test phone** (`Wearable.API is not available`). The watch model is still unconfirmed. If it's a HONOR watch, it can't run Wear OS apps.

Measured on the phone: an arm swing in the box gave movement **≈ 66** against a threshold of about 11. A still scene sits at about 0–2. Accepted claps were −20 to −26 dB.

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
- [ ] **Exports:** Save to Photos and Share produce a slow-motion clip (the iOS export re-encodes, so expect a second or two).

### Not yet on iOS

- Touch-mute of the impact detector (Android catches touches natively). On iOS it needs a JS→native "user touched" call or a window gesture recogniser.
- Apple Watch remote (WatchConnectivity), Phase 6.

## Signing and accounts

- **Bundle / package id `app.simpleswing`** is a placeholder. It's permanent after the first store upload, so confirm it (a reverse domain you own) beforehand.
- **Play upload key:** `~/.android/simpleswing-upload.jks` on the Linux VM, with credentials in `~/.gradle/gradle.properties`. **Back both up together.** Only `bundleRelease` uses it.
- **No store accounts yet.**
  - **Apple Developer** (US$99/yr): needed for TestFlight and the App Store. Apply for the Small Business Program too.
  - **Google Play** (US$25): a new personal account must run a closed test with 12 testers for 14 days before production. Start that about 3 weeks before launch.

## Next steps, in order

1. **Range session** with the current Android build. Record Levels readings (dB, "swing P/T", shutter) for your strikes versus neighbours'. Also measure battery and warmth over 1 hour.
2. **iOS first build** on the Mac and fix compile errors. Then work through the checklist above.
3. **Tune thresholds** from the range data, on both platforms. The constants are `ImpactDetector.minLevelDb/marginDb` and `MotionGate.minMotion/thresholdFactor`.
4. **Play policy tidy-up.** Try blocking `READ_MEDIA_VIDEO`, `READ_MEDIA_VISUAL_USER_SELECTED` and `INTERNET` while confirming Save to Photos still works.
5. **Purchases.** A £14.99 lifetime unlock via `expo-iap`. The free tier allows 3 auto-saves per session; `src/lib/trigger-quota.ts` is ready to wire to `SwingCapture.setAutoTrigger`.
6. **Watch.** Wear OS once a Wear OS watch is paired. Apple Watch (WCSession tap-to-save) on the Mac.
7. **Store listing,** privacy policy ("Data Not Collected"), screenshots, then closed and TestFlight betas.
