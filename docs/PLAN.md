# SimpleSwing — Build & Rollout Plan

## Context
`reference/SimpleSwing proposal v1.pdf` describes a hands-free golf swing recorder. You put the phone on a tripod and hit balls. A trigger (impact sound, watch tap or remote) saves the last few seconds from a rolling buffer, and the app instantly loops a slow-motion replay.

The proposal's commercial rules:
- local-first, no server, no account, £0/month backend
- one-time £14.99 unlock with a free tier of 3 auto-triggers per session
- optional Apple Watch and Wear OS triggers

Your constraints:
- Ship to both stores together from one codebase, with minimal per-platform changes.
- Develop on a Linux VMware VM: cloud iOS builds now, a Mac only later.
- Test hardware: your Android phone, Wear OS watch and iPad, plus your partner's iPhone and Apple Watch.
- Claude writes most of the code.
- "Standalone, no SaaS bloat" is the defining product value.

The repo is empty apart from the PDF, so this is a greenfield plan.

---

## 1. Do you need a Mac?
**You need macOS to compile iOS apps. You don't need to own a Mac yet.**

- **What needs macOS:** iOS and watchOS apps can only be compiled and signed with Xcode, and Xcode only runs on macOS. Linux and VMware can't do this. Running macOS in a VMware VM on non-Apple hardware breaks Apple's licence terms and is unreliable, so we won't.
- **How we avoid a Mac:** Expo EAS Build compiles the iOS app on Expo's cloud Macs, triggered from your Linux terminal (`eas build -p ios`). EAS Submit then uploads it to App Store Connect and TestFlight. iOS test builds are installed on your iPad and your partner's iPhone over the air, by link or QR code, so no cable or Mac is needed.
- **Where a Mac really helps:** writing and debugging native Swift, for the camera engine and especially the Apple Watch app. Each cloud build takes about 10–20 minutes, versus seconds in Xcode. Plan to get a used M1/M2 Mac mini (about £300–450), or rent a cloud Mac by the hour, **at the Apple Watch phase (Phase 6)**. Everything before that works from Linux.
- **Android and Wear OS:** builds fully on Linux with the Android SDK and Gradle. You can connect your phone to the VM by VMware USB passthrough, or use wireless `adb pair`.

---

## 2. Technology selection (recommended stack)

| Layer | Choice | Why |
|---|---|---|
| App framework | **React Native + Expo (latest SDK, New Architecture), TypeScript** | Shared UI and logic for iOS and Android. EAS gives cloud iOS builds from Linux. Config plugins mean no hand-edited Xcode or Gradle projects. |
| Capture engine | **Custom Expo native module `swing-capture`**: Swift (AVFoundation) and Kotlin (Camera2 + MediaCodec) | A high-fps rolling buffer, impact detection and frame-accurate trimming can't be done well in JS or with off-the-shelf camera libraries. Writing this native is unavoidable on any cross-platform stack. It's the only per-platform code in the phone app. |
| Playback | Native `SwingPlayerView`, part of the same module | Frame-accurate stepping and ¼/⅛ speed loops at 120/240fps need AVPlayer and ExoPlayer (Media3) set to zero seek tolerance. |
| Drawing overlays | `@shopify/react-native-skia` + Reanimated + Gesture Handler | Lines, circles, angles and plane lines, stored as normalised vectors, shared across platforms |
| Navigation / state | `expo-router`, `zustand` | Simple and standard |
| Local data | `expo-sqlite` (clip metadata) + `expo-file-system` (clips) | Keeps everything on the device, with no backend |
| Photos export | `expo-media-library` (iOS add-only permission) | "Save to Photos" and optional auto-save |
| Purchases | **`expo-iap`** (StoreKit 2 / Play Billing, verified on-device) | One non-consumable `pro_lifetime` product. No RevenueCat or other third-party SaaS, so the app keeps an **App Store "Data Not Collected"** privacy label. |
| Misc | `expo-keep-awake`, `expo-haptics`, `expo-localization` | Range usability |
| Wear OS app | Kotlin + Compose for Wear OS, Wearable Data Layer `MessageClient` | Native only; builds on Linux |
| Apple Watch app | SwiftUI + WatchConnectivity, added as a target via the `@bacons/apple-targets` config plugin | Native only. EAS builds it, and it's developed on a Mac in Phase 6. |
| Crash data | Xcode Organizer + Play Console Android Vitals only | No analytics SDK, which keeps the app standalone and the privacy labels clean |

Alternatives considered and rejected:
- **Flutter:** the same native-module burden, and a weaker "build iOS from Linux" story than EAS.
- **Two fully native apps:** double the UI work.
- **VisionCamera:** no rolling-buffer recording, so we'd fight it rather than own the camera.

---

## 3. Architecture

### Repository layout
```
simple_swing/
  app/                         # expo-router screens: capture, library, review, paywall, settings, onboarding
  src/
    features/{capture,library,review,paywall,settings}/
    db/                        # sqlite schema + repo (clips, sessions, drawings)
    state/                     # zustand stores (session, entitlement, settings)
    lib/                       # trigger quota, storage cleanup, units
  modules/swing-capture/
    src/                       # TS API + types (single contract for both platforms)
    ios/                       # Swift: CaptureSession, SegmentRingBuffer, ImpactDetector, MotionGate,
                               #        ClipExporter, VolumeButtonTrigger, WatchBridge, SwingPlayerView
    android/                   # Kotlin: HighSpeedCamera, EncodedRingBuffer, ImpactDetector, MotionGate,
                               #         ClipMuxer, KeyTrigger, WearBridge, SwingPlayerView
  targets/watch/               # watchOS SwiftUI app (apple-targets)
  wear/                        # Wear OS Gradle project (same applicationId + signing key)
  plugins/                     # config plugins (Android volume-key hook, permissions strings)
  test-fixtures/audio/         # recorded range WAVs for detector tests (shared by Kotlin + Swift tests)
  reference/
```

### Capture engine (the core)
State machine: `IDLE → ARMED (buffering) → TRIGGERED (collecting post-roll) → EXPORTING → ARMED`. A 3 s cooldown prevents double triggers.

TS contract (`modules/swing-capture/src/index.ts`):
- `start({fps, preRollSec, postRollSec, roi, sensitivity, sharpMode})`, `stop()`, `trigger(source)`
- `setAutoTrigger(enabled)` (JS turns this off when the free quota runs out)
- Events: `onArmed`, `onTrigger({source, tImpact})`, `onClipReady({uri, thumbUri, fps, durationMs, source})`, `onThermalDowngrade`, `onError`

**Rolling buffer.** The buffer holds *encoded* video, not raw frames. Raw 1080p at 120 fps is about 360 MB/s, which is impossible to hold. HEVC/H.264 is about 3 MB/s, so 5 s fits in roughly 15 MB. (The proposal's `AVCaptureMovieFileOutput` can't do a rolling buffer, so we don't use it.)

- **iOS:**
  - `AVCaptureVideoDataOutput` and `AVCaptureAudioDataOutput` feed an `AVAssetWriter`.
  - The writer uses `outputFileTypeProfile = .mpeg4AppleHLS` with `preferredOutputSegmentInterval` of 0.5 s, so fragmented MP4 segments are delivered to the delegate in memory.
  - The last N segments are kept in a ring buffer.
  - On a trigger, after the post-roll, the init segment and ring segments are written to a temp file. `AVMutableComposition` then trims it to `[tImpact − preRoll, tImpact + postRoll]`, and the result is exported.
- **Android:**
  - A Camera2 `createConstrainedHighSpeedCaptureSession` runs at 120/240 fps when the device reports high-speed sizes. Otherwise a normal session runs at 60 fps.
  - The encoder surface feeds a `MediaCodec` H.264/HEVC encoder with a 0.5 s I-frame interval. Encoded buffers plus their timestamps go into a ring that is pruned on keyframe boundaries.
  - `AudioRecord` feeds an AAC encoder ring and also the impact detector.
  - On a trigger, `MediaMuxer` writes samples starting from the keyframe at or before the clip start.

**Frame rate and image quality defaults (golf-specific):**
- 120 fps at 1080p by default; 240 fps is optional and better for seeing the club at impact.
- **"Sharp mode"** fixes the shutter at 1/1000 s or faster outdoors and raises ISO instead. Motion-blurred clubs from auto-exposure are the main reason phone swing video looks poor.
- When the phone gets hot (`ProcessInfo.thermalState` on iOS, `PowerManager` thermal status on Android), the app drops to 60 fps and tells you.

**Clip window defaults:** 3.0 s before impact and 1.5 s after.
- The backswing plus transition takes about 1.0–1.2 s, so 3 s also catches the takeaway and some of the address.
- 1.5 s after covers the finish.
- Both are adjustable in settings.

### Triggers (in order of reliability)
1. **Manual:** a large on-screen button. Unlimited in the free tier.
2. **Volume buttons and £5 Bluetooth camera remotes:** these remotes send volume-up. iOS uses `AVCaptureEventInteraction` (iOS 17.2+). Android uses a config plugin that hooks `dispatchKeyEvent` in MainActivity. This is a zero-extra-hardware-cost "remote" that's easy to market.
3. **Watch tap:** WCSession `sendMessage` on watchOS, `MessageClient` on Wear OS. The watch gets a haptic confirmation when the clip is saved.
4. **Automatic: impact sound gated by motion.** This is the proposal's headline feature, made robust against neighbouring bays:
   - **ImpactDetector:**
     - 48 kHz mono, high-pass filtered at about 1.5 kHz, analysed in 5 ms frames.
     - A sound counts as an onset when energy rises sharply (under 3 ms) above an adaptive noise floor (the median of the last 2 s) by K dB, and spectral flux and the absolute peak pass their thresholds.
   - **MotionGate:**
     - Frame differencing on downscaled luma (about 64×36) inside the golfer area you mark during setup.
     - An impact is accepted **only if** significant motion happened inside that area in the 1.5 s before it.
     - A neighbour's strike makes a sound but no motion in your area, so it's rejected. Practice swings without a ball make no impact sound, so they're ignored.
   - The algorithm is specified once with shared parameters and implemented in Swift and in Kotlin (about 150 lines each). Both are tested against the same `test-fixtures/audio` WAV files.

Pose-based trimming (Vision / ML Kit pose) and watch-motion auto-detect come after launch. They aren't needed to ship.

### App screens and flow
- **Onboarding** (under 30 s, no account): permissions for camera and microphone. Photos permission is requested only on the first save. Then a 3-card setup guide:
  - Down-the-line: camera at hand height, on a line parallel to the target line, about 3 m back.
  - Face-on: camera level with the sternum.
  - Left-handed toggle.
- **Capture screen** (portrait):
  - Live preview, a level indicator from the accelerometer, a draggable golfer area box, a face-on/DTL toggle and quick club chips (Driver/Wood/Iron/Wedge).
  - A large ARMED status with the session's swing count. The screen stays awake.
  - After a trigger, a full-screen ¼-speed loop plays straight away while the engine re-arms. The next swing interrupts the replay.
- **Library:** clips grouped by session and date, with thumbnails, favourites, club tag filter, "Save to Photos" and the share sheet. Auto-cleanup removes non-favourites older than N days, because a 120 fps 4.5 s clip is about 10–15 MB.
- **Review:** loop with speed options (1×, ½, ¼, ⅛), frame stepping, scrub bar, drawing tools (line, circle, angle, plane line), grid overlay and mirror. Drawings are saved per clip as vector JSON.
- **Paywall:** `pro_lifetime` at £14.99/$19.99, with restore purchases.
  - The free tier gets 3 automatic triggers (sound or watch) per session. A session ends after 2 h of inactivity.
  - Manual and volume-button triggers, basic playback and line drawing are always free.
  - Pro unlocks unlimited auto-triggers, frame stepping, grid, ⅛ speed, angle and plane tools, and Photos export. This matches the proposal.
- **Settings:** fps, pre-roll and post-roll, sensitivity, Sharp mode, auto-save to Photos, storage cleanup, handedness.

---

## 4. Development steps

**Phase 0: Foundations (about 1 week)**
- Accounts:
  - Apple Developer (US$99/yr). Apply for the Small Business Program to get the 15% commission rate.
  - Google Play Console (US$25, one-off) with identity verification.
  - An Expo account.
  - *Tip:* a new **personal** Play account must run a closed test with **12 testers for 14 days** before it can go to production. Start recruiting testers now, or register as an organisation, which needs a D-U-N-S number.
- Scaffold the Expo TypeScript app: expo-router, ESLint/Prettier, Jest, `eas.json` (development, preview and production profiles).
- Set up GitHub Actions for lint, typecheck and Jest on each push.
- Register your iPad and your partner's iPhone (`eas device:create`), then send a dev-client build to every device.

**Phase 1: Capture engine spike (about 2 weeks; the main technical risk)**
- **Android first**, because the development loop on Linux is fast:
  - Find out what high-speed modes your phone supports.
  - Build the encoded ring buffer, a manual trigger and the exported clip.
  - Measure trigger-to-replay time (target under 1.5 s), memory and heat over 30 minutes.
- Port it to Swift and test via EAS dev builds on the iPad and iPhone.
- **Go/no-go:** clean A/V sync at 120 fps on both platforms. If the phone doesn't support high-speed mode, fall back to 60 fps.

**Phase 2: Triggers (about 2 weeks)**
- Volume-button and Bluetooth-remote triggers.
- Build the ImpactDetector and MotionGate.
  - *Finding (2026-10-12):* Android constrained high-speed sessions accept only two output surfaces (preview and encoder), so the MotionGate can't add an ImageReader. Route the camera through one GL `SurfaceTexture` instead, and render it to the preview, the encoder and a 64×36 FBO read with `glReadPixels`. The Android ImpactDetector already runs audio-only behind a user toggle.
- Add a hidden **debug "record everything" mode** that saves raw audio, motion energy and trigger logs. Collect fixtures from a real range: busy bays, a grass range, an indoor net or simulator, irons, driver and mis-hits.
- Tune thresholds offline against those fixtures. Kotlin unit tests (JUnit) and Swift tests (XCTest, run on an EAS or macOS CI runner) use the same WAV files.

**Phase 3: Library and review (about 2 weeks)**
- SQLite schema, file storage and cleanup.
- Native player view, speed and frame stepping, Skia drawing, grid and mirror.
- Photos export and sharing.

**Phase 4: Monetisation and polish (about 1 week)**
- `expo-iap` purchase, restore and entitlement cache, plus the trigger quota.
- Onboarding, settings, en-GB/en-US copy, accessibility (large type, contrast in sunlight), app icon and splash screen.

**Phase 5: Wear OS companion (about 1 week, on Linux)**
- A one-screen Compose app: a big Capture button plus a double-tap gesture.
- It sends a `MessageClient` message to the phone and gets a haptic confirmation back.
- Same applicationId and signing key as the phone app, and published under the same Play listing.

**Phase 6: Apple Watch companion (about 1 week, Mac arrives here)**
- A SwiftUI watch target added via apple-targets.
- WCSession trigger and haptic confirmation, tested on your partner's Apple Watch.

**Phase 7: Beta and launch (2–3 weeks, overlapping Phases 5 and 6)**
- See Rollout below.

**After launch (v1.x):**
- Watch motion auto-detect: `HKWorkoutSession` on watchOS, Health Services `ExerciseType.GOLF` on Wear OS.
- Pose-based swing phases and trimming.
- Paid add-ons: Multi-Camera Sync (£4.99), with the iPad down-the-line and the iPhone face-on; Pro Export (£2.99) for side-by-side and drawings burned into the video.
  - *Progress (2026-10-13):* Multi-Camera Sync is built early, on Android (unit-tested) and iOS (ported, not yet compiled), but not yet gated behind the paywall. It hasn't been run on two real phones. See `STATUS.md` → Second camera.
- Replay on the watch.

Rough total to v1.0: **10–12 weeks**.

---

## 5. Rollout
1. **Store prerequisites:**
   - Privacy policy and support page, hosted as a free static page on GitHub Pages.
   - Privacy declarations: App Store "Data Not Collected" and an empty Play Data Safety form.
   - Camera and microphone purpose strings.
   - Age rating.
   - Screenshots for iPhone 6.9", iPad 13" (the iPad is supported, and its big screen makes a great range monitor), Android phone, plus Wear OS and Apple Watch shots.
2. **Internal beta:**
   - iOS: a TestFlight internal group, which doesn't need App Review.
   - Android: the internal testing track.
   - Testers: you, your partner and 2–3 golf friends.
3. **Closed beta (14 days or more):**
   - Android: a closed-testing track with **12 or more opted-in testers**, which meets the Play rule for new accounts.
   - iOS: external TestFlight with the same group.
   - Collect the field-test metrics in §6.
4. **Launch pricing:**
   - The stores can't price by "first 1,000 downloads". Instead, schedule a **launch price of £9.99 for the first 4 weeks**, then raise it to £14.99. Both App Store Connect and Play Console support scheduled price changes.
   - Ask for a store review with the native in-app review prompt after the user's 5th captured swing in their 2nd session.
5. **Production release:**
   - iOS: submit for App Review and use **phased release** (7 days).
   - Android: **staged rollout** at 10% → 50% → 100%.
   - Watch Android Vitals and the Xcode Organizer for crashes and ANRs.
6. **Ongoing running costs:** £0 for servers.
   - Apple: US$99/yr.
   - EAS: the free tier, or the paid plan during months with heavy iOS iteration.
   - The Mac is a one-off cost.

---

## 6. Verification
- **Unit tests:**
  - Jest for quota, session, storage-cleanup and drawing maths.
  - JUnit and XCTest for the ImpactDetector and MotionGate against the shared WAV and motion fixtures.
  - Ring-buffer pruning and keyframe alignment tests.
- **Device tests, on every build via the dev client:**
  - Clip duration is within ±1 frame of preRoll + postRoll.
  - Impact lands at the expected timestamp (check the clap-board frame against the audio).
  - Audio and video are in sync.
  - fps metadata is correct.
  - The app re-arms within 1 s.
- **Range field test before beta exit.** Run each condition on Android, iPhone and iPad:
  - 50 swings in a busy bay.
  - 50 neighbour strikes with no swing.
  - 30 practice swings.

  | Metric | Target |
  |---|---|
  | Capture rate | 95% or higher |
  | False triggers per 50 neighbour shots | 1 or fewer |
  | Time to replay | Under 1.5 s |
  | Thermal | No forced downgrade within 45 min at 120 fps in mild weather |
  | Battery | Under 25% per hour (approximate) |
- **Purchase tests:**
  - iOS: StoreKit sandbox.
  - Android: Play license testers.
  - Both: purchase, restore, reinstall and offline launch.
- **Release check:** the app works fully in airplane mode, which proves it is standalone.
