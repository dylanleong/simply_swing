# SimpleSwing launch checklist (v1.0)

_Drafted 2026-10-16. Store rules were checked against Google and Apple help pages on that date. Anything marked
**verify** wasn't confirmed from an official source. Related files:_

- [`store-listing.md`](store-listing.md)
- [`privacy-declarations.md`](privacy-declarations.md)
- the website in [`site/`](../../site/)

The order matters: Play's 14-day closed test is the long pole, so the developer steps start with accounts.

---

## A. Done in code

- [x] **No accounts, backend, analytics or ads.**
  - Grep found no HTTP or analytics code.
  - The only network code is the local second-camera link.
- [x] **Purpose strings** (`app.json`): camera, microphone, local network (+ `NSBonjourServices`) and Photos add-only (`savePhotosPermission`, `photosPermission: false`).
- [x] **`ITSAppUsesNonExemptEncryption: false`.**
- [x] **Android permission trims:**
  - `SYSTEM_ALERT_WINDOW` and `WRITE_SETTINGS` are blocked.
  - Camera, audio, internet (local sockets) and Wi-Fi multicast are declared.
- [x] **Wear OS app:**
  - Same `applicationId` (`app.simpleswing`) and signing key as the phone app.
  - `versionCode` sits in the 1,000,000+ range.
  - `standalone=false`, `allowBackup=false`.
  - Health FGS with `HIGH_SAMPLING_RATE_SENSORS`, target SDK 36.
- [x] **Target SDK 36** (phone and watch). This meets Play's 31 Aug 2026 rule: new apps and updates must target API 36, and Wear OS apps API 35+.
- [x] **Release signing plugin** (`plugins/with-release-signing.js`): `bundleRelease` signs with the upload key, and sideload APKs stay debug-signed.
- [x] **Help content** is in the app (`src/lib/help-topics.ts`).
- [x] **Privacy policy, support and landing pages:** `site/`.

### Still to do in code before the first store upload (for the engineers)

_Items marked "in progress" appeared as uncommitted changes from other engineers on 2026-10-16. Confirm that they're
committed and present in the release build._

- [x] **Version numbers.**
  - `app.json` `version` is now `1.0.0`, with `ios.buildNumber` "1" and `android.versionCode` 1.
  - The Wear `versionName` is now `1.0.0`. Keep its `versionCode` (1000001) above any phone code.
  - **Pick one source of truth:** `eas.json` uses `appVersionSource: remote` + `autoIncrement`, which ignores the `app.json` numbers on EAS builds.
- [x] **`READ_MEDIA_*` blocked.** `app.json` `blockedPermissions` lists VIDEO, VISUAL_USER_SELECTED, IMAGES and AUDIO. Still re-test Save to Photos on Android 13+ and on Android 10–12 (section C).
- [x] **Android backup rules.** `plugins/with-android-policy.js` excludes `files/swings/` from cloud backup and device transfer, which the privacy policy now describes.
  - Notes and tags in that folder are excluded too.
  - Verify with `bmgr` after `prebuild --clean`.
- [x] **Large screens (Android 17 ready).** No orientation opt-out any more: phones lock to portrait at runtime, screens 600 dp and wider rotate freely with landscape layouts and upright landscape clips (STATUS.md "Large screens and rotation"). Still to check on a tablet or foldable emulator, and on the iPad.
- [ ] **Pairing code** shipped on Android **and** iOS. The privacy policy and support page describe it.
- [x] **iOS privacy manifest added** (`ios.privacyManifests` in `app.json`: file timestamps, `UserDefaults`, disk space). After `npx expo prebuild -p ios`, confirm the aggregated `PrivacyInfo.xcprivacy` carries it.
- [x] **16 KB page size verified.** The release build's native libraries are 16 KB-aligned (Play requires it for apps targeting Android 15+; checked with `check_elf_alignment`-style inspection of the AAB).
- [x] **Xcode 26.4+ requirement.** App Store uploads need Xcode 26.4+ / the iOS 26 SDK; the EAS image is pinned to one that has it (see B.6).
- [x] **`ACTIVITY_RECOGNITION` blocked** on the phone (`app.json` `blockedPermissions`), matching the watch, which never declared it.
- [x] **iOS HealthKit entitlement + purpose strings added** for the Apple Watch golf workout (`NSHealthShareUsageDescription`, `NSHealthUpdateUsageDescription`; nothing is written to Health).
- [ ] **Bundle id decision** (see B.4) before any upload.
- [ ] **Wear notification permission (check).** Android 13+ hides FGS notifications without `POST_NOTIFICATIONS`. The service still runs, but check whether the watch should request it so users can see the sensing notice.
- [ ] **Paywall:** not for 1.0 unless pricing is decided. If added later, see the "If purchases ship" sections in the other two files.

---

## B. You (the developer) must do

### B.1 Google Play Console account (start first: about 3+ weeks before launch)

1. Create a **personal** developer account at play.google.com/console. It costs US$25 once.
   - Complete **identity verification** (government ID).
   - Verify the **contact email and phone**.
   - Since 2023, new accounts must also verify access to a real Android device via the Play Console mobile app (**verify** the current steps).
2. Note the **testing requirement for new personal accounts.** It applies to accounts created after 13 Nov 2023 (Play Console Help answer 14151465, read 2026-10-16):
   - Run a **closed test with at least 12 testers, opted in continuously for at least 14 days**, before you can apply for production.
   - Testers who leave before day 14 don't count.
   - 12 must still be opted in when you apply.
   - Production and pre-registration stay locked until then.
   - Third-party reports say Google also checks that testers actually *used* the app (**verify**). Ask testers to record a few swings and give feedback.
3. **Alternative:** an **organisation** account (needs a D-U-N-S number, free but slow) is reported as exempt from the 12-tester rule (**verify**).
4. Recruit **14–15 testers** (a margin over 12), each with a Google account on an Android phone. Golf friends with 120 fps-capable phones are ideal. Collect their Gmail addresses for a Google Group or email list.

### B.2 Apple Developer Program

1. Enrol as an **individual** at developer.apple.com/programs (US$99/yr). It needs an Apple Account with two-factor authentication. Approval usually takes 1–2 days.
   - The listing's seller name will be your legal name.
2. Apply to the **App Store Small Business Program** (15% commission). It only matters once purchases ship, but it's free to do now.
3. In App Store Connect, **Business → Agreements**:
   - The Free Apps agreement is automatic.
   - The Paid Apps agreement and banking/tax are needed only for IAP.
4. **EU Digital Services Act trader status:** declare **non-trader** for a free, non-monetised hobby app. Declare trader if you monetise; your address, phone and email are then shown in the EU (**verify** the current wording).

### B.3 Expo / EAS (optional for Android, needed for iOS without a Mac)

1. Create an Expo account, then `npx eas-cli@latest login` and `npx eas-cli@latest init` (this writes `extra.eas.projectId` to `app.json`; coordinate, since others are editing it).
2. **Android on EAS (if used):**
   - Upload the **existing upload keystore** with `npx eas-cli@latest credentials -p android`, so EAS-signed AABs match the key Play expects.
   - Otherwise build locally (B.6). Don't let EAS generate a new key if you've already uploaded a locally signed AAB.

### B.4 Confirm the bundle / package id: `app.simpleswing` (permanent)

- **It can't change.** After the first upload, the Play package name and iOS bundle id are fixed forever.
- **Do you own the domain?** `app.simpleswing` implies you own `simpleswing.app`.
  - If you don't (and don't plan to buy it), switch now to something you control, for example `io.github.<username>.simpleswing`.
  - The id must change in `app.json` (`ios.bundleIdentifier`, `android.package`) **and** `wear/build.gradle` (`applicationId`; also `namespace` is fine to keep).
- **Register it before the first upload:**
  - Register the iOS bundle id in Certificates, Identifiers & Profiles (EAS does this automatically).
  - Create the App Store Connect app record.

### B.5 Host the website (GitHub Pages)

1. Put `site/` online. **Either:**
   - Make a small **public** repo (e.g. `simpleswing-site`) containing just the three HTML files, then Settings → Pages → Deploy from branch `main` / root. **Or**
   - If the app repo is public, use a GitHub Actions Pages workflow that publishes `site/`. Pages "deploy from branch" only supports `/` or `/docs`, so `site/` needs the workflow or a copy.
2. Replace the placeholders in all three files:
   - `[Developer name]`
   - `[contact email]`: use a dedicated address, e.g. a new Gmail. It's shown publicly on both stores.
3. Note the URLs: `https://<user>.github.io/<repo>/privacy.html` and `/support.html`. Optionally point a custom domain (e.g. `simpleswing.app`) at it.
4. Put the URLs in:
   - **Play:** App content → Privacy policy; Store settings → Website + email.
   - **App Store Connect:** App Information → Privacy Policy URL; Version → Support URL (and Marketing URL = the index page).
   - The Play full description's `[privacy URL]`.

### B.6 Build the release binaries

**Android phone (local, per `STATUS.md` → Signing and accounts):**

```bash
# Upload key: ~/.android/simpleswing-upload.jks, credentials in ~/.gradle/gradle.properties
npx expo prebuild -p android --clean
cd android && ./gradlew bundleRelease -Dorg.gradle.jvmargs=-Xmx6g
# → android/app/build/outputs/bundle/release/app-release.aab
```

**Android phone (EAS alternative):** `npx eas-cli@latest build -p android --profile production`. This needs the upload key in EAS credentials first (B.3).

**Wear OS:**

```bash
cd wear && ./gradlew bundleRelease -Dorg.gradle.jvmargs=-Xmx6g
# → wear/build/outputs/bundle/release/wear-release.aab  (signed with the same upload key)
```

**iOS (no Mac needed to build):**

```bash
npx eas-cli@latest build -p ios --profile production     # cloud Mac build
npx eas-cli@latest submit -p ios --latest                 # uploads to App Store Connect / TestFlight
```

- **Compile errors are expected.** The Swift has **never been compiled** (`STATUS.md`), so expect several EAS round trips of 10–20 min each. A Mac (or a rented cloud Mac) makes this much faster.
- **Xcode 26.4+ is required.** App Store uploads must be built with Xcode 26.4+ / the iOS 26 SDK. EAS's default image for SDK 57 should satisfy this (**verify** the image in the build log).
- **The first device test still needs a real device.** The camera, microphone and high-fps formats can't be tested in the Simulator.
  - Without a Mac: install the build through **TestFlight internal testing** on your partner's iPhone and your iPad.
  - Or use an EAS `development`/`preview` build installed via `eas device:create` + link.
  - With a Mac: `npx expo run:ios --device` (see the `STATUS.md` iOS checklist).

### B.7 Back up the upload key (do this today)

- Copy `~/.android/simpleswing-upload.jks` **and** `~/.gradle/gradle.properties` (or the four `SIMPLESWING_UPLOAD_*` values) to two places off the VM: a password manager plus an encrypted USB stick or cloud drive.
- With **Play App Signing** (default for new apps), Google holds the app signing key. A lost *upload* key can be reset through Play support, but it takes days and blocks updates.
- The Wear app uses the same key.

### B.8 Google Play setup and closed test

1. **Create app** in Play Console:
   - Name "SimpleSwing: Golf Swing Camera", default language English (UK), App (not game), Free.
   - Accept the declarations.
2. **Store listing:** text, icon, feature graphic and screenshots from `store-listing.md`, plus contact email and website.
3. **App content:** every form in `privacy-declarations.md` §2–§5 (privacy policy, ads, app access, content rating, target audience, data safety, health apps, foreground service + video).
4. **Wear OS form factor:**
   - Release → Advanced settings → **Form factors** → add **Wear OS**.
   - Create its **dedicated Wear OS track** (closed testing first).
   - Upload at least **one Wear OS screenshot** and make sure the listing **mentions Wear OS**.
   - Opt in to Wear OS review (Wear app quality guidelines).
   - The Wear AAB is a separate release on the Wear track, same package `app.simpleswing`.
   - From 15 Sep 2026, Wear OS apps must support 64-bit. The Kotlin-only Wear app has no native libs, so it's fine.
5. **Internal testing** (instant, up to 100 testers): upload the phone AAB and invite yourself and your partner. Fix the **pre-launch report** findings.
6. **Closed testing:**
   - Create a track, add the 14–15 tester emails or a Google Group, and upload the same AAB.
   - Send testers the opt-in link.
   - **The 14-day clock starts when ≥ 12 are opted in.** Track this in the Dashboard.
7. **Apply for production** from the Dashboard after day 14. Answer the questions about the test and feedback.
8. **Production release:** staged rollout 10% → 50% → 100% (see `PLAN.md` §5). Then promote the Wear release on its track.

### B.9 App Store setup and TestFlight

1. **App Store Connect → My Apps → +:**
   - Platforms: iOS.
   - Name "SimpleSwing: Golf Swing Camera", primary language English (UK), bundle id `app.simpleswing` (or the replacement), SKU `simpleswing`.
2. **App Information:**
   - Subtitle, categories (Sports / Photo & Video) and age rating questionnaire (`privacy-declarations.md` §5).
   - Privacy policy URL, content rights (no third-party content).
3. **App Privacy:** "Data Not Collected" (§3).
4. **Pricing:** Free, all territories (or exclude where you don't want to deal with local rules).
5. **TestFlight:** after `eas submit`, add an internal group (you and your partner; no review needed).
   - External testers need a quick Beta App Review.
   - Run external TestFlight with the same golf friends during the Play closed test.
6. **Version 1.0:**
   - Screenshots (6.9"/medium iPhone + 13" iPad), description, keywords, promo text, support URL.
   - Review notes (§4), build selection.
   - **Manual release** after approval, with **phased release** on.
7. **Submit for review.** Typical review is 1–2 days. A camera app is often rejected only for unclear permission use, so the review notes cover it.

---

## C. Test before submitting (device matrix)

Run the full pass on a **release** build (Play internal track AAB / TestFlight build), not a dev client.

### Devices

| Device | OS | Why |
|---|---|---|
| HONOR VKP-NX9 | Android 16 (MagicOS) | Main test phone; 120/240 fps; monotonic-clock quirk |
| OnePlus 9 (LE2113) | Android 14 | Second Android; noisy motion gate in dim light |
| A Google Pixel (borrow or a tester's) | Android 16 | Reference Android; Play pre-launch report covers some |
| An Android 10–12 phone (any) | Android 10–12 | Save to Photos via legacy storage permission; no `READ_MEDIA_*` |
| A phone **without** constrained high-speed | any | Graceful fallback to a normal-speed session; listing says frame rate depends on phone |
| Partner's iPhone | iOS 17.2+ (ideally 26) | First real iOS run; volume-button saves |
| Your iPad | iPadOS | `supportsTablet: true`; iPad as camera or monitor; 13" screenshots |
| An iPhone on iOS 16.4–17.1 (if available) | iOS < 17.2 | Minimum deployment target (podspec `16.4`); volume buttons off, SAVE works |
| OnePlus Watch 2R | Wear OS | Remote, wrist sensing, tempo, FGS behaviour, Wear screenshots |

### Checks on every phone

- [ ] **Fresh install:** the permission prompts read correctly. Deny the microphone: SAVE still works, and auto-save explains why it's off. Deny the camera: the permission gate offers Settings.
- [ ] **Auto-save on claps at home**, then at a **real range** (capture rate, neighbour false triggers; targets in `PLAN.md` §6).
- [ ] **Save triggers:** SAVE button, volume keys and a Bluetooth camera remote all save. Cooldown works.
- [ ] **Replay and tagging:** the replay loops, "How was it?" tags and closes it, and the Club chip stamps clips.
- [ ] **Review:** speeds, frame step, the Draw tools survive rotation and relaunch, and mirror/grid work.
- [ ] **Compare:** two swings line up on impact.
- [ ] **Save to Photos and Share:** the slow-motion copy plays at slow speed in the gallery and in WhatsApp/Messages. The Photos prompt appears only on first save, and on iOS it's add-only.
- [ ] **Storage:** auto-delete keeps favourites. Behaviour is sensible when storage is nearly full.
- [ ] **Idle:** the screen dims at 30 s, standby comes at 5 min, and any trigger wakes the camera.
- [ ] **Heat and battery:** 45–60 min session at 120 fps outdoors; the thermal downgrade message appears; battery drain is under ~25%/h.
- [ ] **Airplane mode** (Wi-Fi off): everything except the second camera works (proves no hidden network dependency).
- [ ] **Interruptions:** a phone call, Control Centre or quick-settings camera, then lock/unlock. The camera recovers and no frozen replay is left.
- [ ] **Upgrade path:** install the closed-test build over the internal build. Swings, notes and settings survive.
- [ ] **Backup:** Android `adb shell bmgr backupnow app.simpleswing`, then check that `files/swings/` isn't in the backup set and settings are.

### Second camera (all combinations you can assemble)

- [ ] Android ↔ Android (HONOR + OnePlus 9) over home Wi-Fi **and** over one phone's hotspot.
- [ ] iPhone ↔ iPad: Local Network prompt, Bonjour discovery and AWDL without shared Wi-Fi.
- [ ] Android ↔ iPhone, both directions (main/camera).
- [ ] **Pairing code:** the right code connects, a wrong code is refused, and the code is remembered next session.
- [ ] Clap alignment is within about 1 frame, the nudge saves, and the side-by-side export plays on both platforms.
- [ ] Mismatched app versions show the `E_PEER_VERSION` message.

### Watch (Wear OS)

- [ ] Install from the Play Wear track (not adb). The watch app appears for the paired phone.
- [ ] Tap to save. The haptic confirms, and rejection is shown when the phone isn't armed.
- [ ] Sense swings: wrist plus sound saves, a neighbour's sound without a wrist swing is ignored, and practice swings save when enabled.
- [ ] Tempo is shown on the replay, in review and on the tiles. It's plausible against slow-motion frame counts.
- [ ] The service stops about 2 min after the phone leaves Capture. No battery drain overnight.
- [ ] Record the **FGS declaration video** during this pass (`privacy-declarations.md` §2.2).

### Store pre-flight

- [ ] Play **pre-launch report**: no crashes, and the accessibility warnings have been reviewed.
- [ ] `bundletool dump manifest` on the release AAB: no `READ_MEDIA_*`, no unexpected permissions.
- [ ] iOS: App Store Connect processing email shows no privacy-manifest or missing-purpose-string warnings.
- [ ] Privacy policy, support and landing pages are live, the links work from both listings, and no placeholders are left.
- [ ] The listing text matches what shipped: remove the second-camera or Wear sections if a platform's version isn't verified.

---

## Open questions for the developer

1. **Bundle id:** keep `app.simpleswing` (do you own `simpleswing.app`?) or switch now?
2. **Contact email and name** for the public listings and site.
3. **Play account type:** personal (12 testers × 14 days) or organisation (D-U-N-S, reportedly exempt)?
4. **Health apps declaration:** "no health features" or "Activity and fitness"? See `privacy-declarations.md` §2.3.
5. **Ship multicam and the Wear app in 1.0?** On iOS, multicam is uncompiled. The Wear app hasn't run on a watch yet. Either can be left out of 1.0 and its listing section removed.
6. **Pricing:** stays free for 1.0? If not, the listing, labels and review notes all need the "if purchases ship" changes.
