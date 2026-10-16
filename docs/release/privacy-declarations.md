# SimpleSwing privacy and policy declarations

_Drafted 2026-10-16, against the code at commit `60592f9` plus the uncommitted pairing-code work. Answers assume a
**free** app without `expo-iap`. See "If purchases ship" at the end._

## 0. What the code actually does (audit, 2026-10-16)

| Claim | Evidence | Status |
|---|---|---|
| No HTTP or analytics | No `fetch`/`XMLHttpRequest`/`axios`/`URLSession`/`HttpURLConnection`/OkHttp in `src/`, `modules/swing-capture/` or `wear/`. No Firebase, Sentry, Crashlytics or other analytics/ads packages in `package.json`, `wear/build.gradle` or the module | ✅ Verified by grep |
| Only network code is the local multicam link | `PeerLink.kt` (`ServerSocket`/`Socket` + `NsdManager`), `PeerLink.swift` (`NWListener`/`NWBrowser`/`NWConnection`, Bonjour `_simpleswing._tcp`, `includePeerToPeer`) | ✅ Verified |
| The link sends no data beyond what's described | Protocol: `HELLO {v, role, name, platform, fps, view, code?}`, PING/PONG, STATE, TRIGGER, REJECT, CLIP+DATA+DONE (clip bytes), BYE | ✅ Verified (`PeerProtocol.kt`) |
| Device name is visible on the LAN in camera mode | Android: `Settings.Global "device_name"` or `Build.MODEL` as the NSD service name and in HELLO. iOS: "iPhone"/"iPad" | ✅ Verified. Disclosed in the privacy policy |
| The link isn't encrypted | Plain TCP frames, no TLS | ✅ Verified. Disclosed in the policy |
| Pairing code gates the link | 6-digit code in `PeerStatusEvent.code`; HELLO carries `code`; camera replies only when it matches | 🟡 **In progress** (uncommitted diff in `PeerProtocol.kt` + types). The policy and support page describe it, so it **must ship in 1.0 on both platforms**, or those paragraphs must be edited |
| Watch messages are short control/timing strings | `WearProtocol.kt` / `WearBridge.kt`: hello, trigger, state, saved, rejected, config, ping/pong, heartbeat, swing `"ageMs,peakDps,backswingMs,downswingMs"` via `MessageClient` | ✅ Verified |
| Watch doesn't use Health Connect, heart rate or location | Only the gyroscope (`HIGH_SAMPLING_RATE_SENSORS`); no `BODY_SENSORS`, `ACTIVITY_RECOGNITION` or location permissions in `wear/src/main/AndroidManifest.xml` | ✅ Verified |
| Watch backup off | `android:allowBackup="false"` in the wear manifest | ✅ Verified |
| **Android backup excludes swings** | New, uncommitted `plugins/with-android-policy.js` (registered in `app.json`) writes `fullBackupContent` + `dataExtractionRules` that exclude `files/swings/` from cloud backup **and** device transfer. That folder also holds the `.user.json` notes and tags, so they're excluded too. Settings (`capture-settings.json`) stay in | 🟡 **In progress.** The privacy policy is worded to match this plugin. The committed generated manifest still has no rules, so re-check after `prebuild --clean` and a `bmgr` backup test |
| iOS backup | Clips are in `Documents/swings`, with no `isExcludedFromBackup`. iCloud Backup includes them | ✅ The policy says so ("may be included") |
| Photos access is add-only | `requestPermissionsAsync(true, ['video'])` (write-only); `app.json` `photosPermission: false`, `savePhotosPermission` set | ✅ iOS verified. 🟡 **Android:** the uncommitted `app.json` now blocks `READ_MEDIA_VIDEO`, `READ_MEDIA_VISUAL_USER_SELECTED`, `READ_MEDIA_IMAGES` and `READ_MEDIA_AUDIO`. The old generated manifest still lists them. Confirm in the release AAB (§2.1) |
| Microphone audio isn't stored on its own | `ImpactDetector` analyses PCM in memory. Audio is muxed only into saved clips | ✅ Consistent with STATUS.md. Not line-audited |
| Accelerometer | `expo-sensors` `Accelerometer` in `level-indicator.tsx`, used live only. No iOS motion permission needed | ✅ |

**Couldn't verify:**

1. The iOS Swift has never been compiled or run, so iOS runtime behaviour is unobserved.
2. The aggregated iOS privacy manifest (`PrivacyInfo.xcprivacy`) hasn't been generated or inspected.
3. Whether third-party native libraries (Expo modules, Google Play services wearable) open network connections at runtime. No such code is in this repo. `play-services-wearable` talks to Google Play services on the device; any data Google itself collects there is covered by Google's own policy.

---

## 1. Google Play: Data safety form

Play Console → Policy → App content → **Data safety**.

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **No** |
| (The form then skips the data-type sections) | — |
| Privacy policy URL (App content → Privacy policy) | `https://<user>.github.io/<repo>/privacy.html` (or a custom domain) |

**Why "No" is correct under Google's definitions** (Play Console Help, "Provide information for Google Play's Data
safety section", answer 10787469, read 2026-10-16):

- **Collection** means "transmitting data from your app off a user's device".
  - SimpleSwing never transmits anything to the developer, a server or a third party.
  - Camera, microphone and accelerometer data are **processed only on the device**. Google says data that is "only processed locally on the user's device and not sent off device" doesn't need to be disclosed.
- **Sharing** means "transferring user data collected from your app to a third party". Nothing is collected, so nothing is shared.
- **Save to gallery and Share** are user-initiated. Google exempts transfers "based on a specific user-initiated action, where the user reasonably expects the data to be shared". The Share sheet is exactly that.
- **Second-phone link (judgment call, verify).**
  - Clips and control messages go directly between two of the user's own devices on their local network, started by the user (pairing code, + Cam).
  - The developer can't access the data, and no third party receives it.
  - Google's page doesn't address transfers between a user's own devices. The intent of the form is to disclose what the developer or third parties obtain, so "No" is the honest answer.
  - The same reasoning is used by local-only apps such as LAN file-transfer and remote-shutter apps.
  - If a reviewer pushes back, the fallback is to declare **Photos and videos → Videos** and **Audio → Voice or sound recordings** as *collected, not shared, processed for App functionality, optional*, which would be misleading to users. Prefer replying to the reviewer with this explanation first.
- **Watch link:**
  - Messages between the user's own paired watch and phone carry swing timing, peak rotation speed and tempo numbers.
  - They go via the Wearable Data Layer and never reach the developer. Same reasoning as above.
  - The data is derived on the watch from the gyroscope. No raw sensor data, health records or location are involved.
- **Crash data:** Android vitals comes from Google Play's own system, under the user's Google diagnostics setting, not from code in the app. It isn't declared by the developer.
- **Backups:** Android Auto Backup goes to the user's own Google account, which is Google's service. It isn't collection by the developer.

**Security practices section:** not shown when nothing is collected. If the form still asks, answer:

- "Data is encrypted in transit": **No**. Nothing is transmitted to you. If it insists, note that the local link is unencrypted.
- "Users can request deletion": **N/A**. Users delete on device.

---

## 2. Google Play: permission and App content declarations

### 2.1 Phone app permissions (from `app.json` + the generated manifest)

| Permission | Why | Play declaration needed? |
|---|---|---|
| `CAMERA` | Recording | No form. Covered by the privacy policy + Data safety |
| `RECORD_AUDIO` | Impact-sound trigger, audio in clips | No form. Privacy policy required (it is) |
| `INTERNET` | Local TCP sockets for the second camera only | No |
| `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE` | mDNS discovery of the camera phone | No |
| `VIBRATE` | Haptics | No |
| `READ_MEDIA_VIDEO`, `READ_MEDIA_VISUAL_USER_SELECTED` | **Not needed**: the app only *adds* videos via MediaStore | **Remove them**, otherwise Play's Photo and Video Permissions policy requires a declaration that the app's core function needs broad access, which SimpleSwing can't justify. Fully enforced since 28 May 2025 |
| `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` (maxSdk 32) | Added by expo-media-library for Android ≤ 12 saving | No form. Verify Save to Photos on an Android 10–12 device after any blocking |

**Before uploading:**

- The blocks are now in `app.json` `android.blockedPermissions` (uncommitted, 2026-10-16).
- Run `npx expo prebuild -p android --clean`.
- Check the merged manifest of the release AAB: `bundletool dump manifest --bundle app-release.aab`.
- Re-test Save to Photos on Android 13+ **and** Android 10–12.

`STATUS.md` → Next steps #5 already plans this.

### 2.2 Wear OS app: foreground service declaration (required)

The wear manifest declares the following (`wear/src/main/AndroidManifest.xml`):

- `SwingSensorService` with `android:foregroundServiceType="health"`
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_HEALTH`
- `HIGH_SAMPLING_RATE_SENSORS`, which is the Android 14+ runtime prerequisite for the health FGS type that needs no runtime prompt
- target SDK 36

Play requires a declaration for **each foreground service type** in apps targeting Android 14+ (Play Console Help
answer 16965181: Policy → App content → **Foreground service permissions**). It applies to the whole app (package), so
the Wear bundle triggers it even though the phone app has no FGS. **Verify that the Wear-only FGS appears in the form
after uploading the Wear AAB.**

| Field | Suggested answer |
|---|---|
| Foreground service type | Health |
| Use case | Choose "Other" / enter manually (the preset "Health data sync" doesn't fit). Use the description below |
| Description of the feature | "During a golf practice session, SimpleSwing's Wear OS app reads the watch's gyroscope to detect the user's golf swing and measure its tempo (backswing and downswing time). It tells the paired phone, which is recording video, when a swing happened so the phone saves that swing and ignores other golfers' shots. The service runs only while the SimpleSwing phone app is on its Capture screen with 'Sense swings' selected, and stops itself 2 minutes after the phone leaves Capture." |
| User impact if deferred or interrupted | "Swings made while the service is stopped aren't detected on the wrist: the phone falls back to its camera-based check, neighbours' shots may be saved by mistake, and tempo isn't recorded for those swings. If the service is restarted, sensing resumes for the next swing." |
| Video link | An unlisted YouTube video, 30–60 s. See the shot list below |

**Video shot list.** Google says the video must show the *steps the user takes to trigger the feature*:

1. Phone: SimpleSwing → Settings → Watch → "Sense swings".
2. Watch: open SimpleSwing. It shows connected.
3. Phone: open the Capture tab. The watch shows sensing, and the ongoing notification/indicator appears.
4. Lower the watch wrist. The screen goes ambient or off.
5. Make a swing (a practice swing is fine). The phone saves it, the watch buzzes, and the tempo appears on the replay.
6. Leave Capture on the phone. After about 2 minutes the watch service stops.

### 2.3 Other App content forms

| Form | Answer |
|---|---|
| Privacy policy | URL of `site/privacy.html` |
| Ads | **No**, the app contains no ads |
| App access | **All functionality is available without special access** (no login). Add a note: "Hands-free capture triggers on a sharp impact sound with movement in the on-screen golfer box. To test indoors, swing an arm inside the box and clap, or tap SAVE." |
| Content rating | IARC questionnaire, see §5 |
| Target audience and content | Age groups **13–15, 16–17, 18+** (don't pick under-13 groups: it pulls in the Families policy). "Unintentionally appealing to children": No |
| News app | No |
| COVID-19 apps | No (if still shown) |
| Data safety | §1 |
| Government apps | No |
| Financial features | None |
| **Health apps** | Required for every app. **Open question.** The honest answer is probably "My app does not have any health features": it's a sports-video tool, not workout logging. But the Wear app declares a *health* FGS, and a reviewer may expect consistency. Suggestion: select **Activity and fitness** only if the FGS review asks why the health type is used. Otherwise declare none. Decide before submitting, and verify the current form options |
| Foreground service permissions | §2.2 |
| Photo and video permissions | Not needed once `READ_MEDIA_*` are blocked (§2.1) |
| Exact alarms, Full-screen intent, Accessibility, VPN, Location | Not used. The forms shouldn't appear |

---

## 3. App Store: App Privacy ("nutrition label")

App Store Connect → App → **App Privacy** → Get Started.

| Question | Answer |
|---|---|
| Do you or your third-party partners collect data from this app? | **No, we do not collect data from this app** |
| Resulting label | **Data Not Collected** |
| Privacy Policy URL | `site/privacy.html` URL |
| User Privacy Choices URL (optional) | Leave blank |

**Why this is correct.** Apple ("App privacy details on the App Store", read 2026-10-16) defines "collect" as:

> transmitting data off the device in a way that allows you and/or your third-party partners to access it for a period
> longer than what is necessary to service the transmitted request in real time

and states:

> Data that is processed only on device is not 'collected'

- **The second-device link:** device to device on the LAN or AWDL, never reaching the developer or a partner. It doesn't meet the definition.
- **Crash reports:** Apple's opt-in "Share with App Developers" is Apple's collection ("you are not responsible for disclosing data collected by Apple").

**Privacy manifest (verify).** Since 2024, apps and SDKs using "required reason" APIs need a `PrivacyInfo.xcprivacy`.

- Expo SDK 57 modules ship their own manifests, and EAS/prebuild aggregates them.
- The local `swing-capture` Swift module may use file-timestamp APIs (`FileManager` attributes) or `UserDefaults`. If so, add an `ios.privacyManifests` block in `app.json` (`NSPrivacyAccessedAPITypes` with reasons such as `C617.1` for file timestamps, `CA92.1` for UserDefaults).
- **Check** the generated `ios/SimpleSwing/PrivacyInfo.xcprivacy` after `npx expo prebuild -p ios`, and read App Store Connect's email after the first upload (missing reasons are reported there).
- `NSPrivacyTracking` = false, `NSPrivacyCollectedDataTypes` = empty.

---

## 4. App Store: App Review information

**Sign-in required:** No.

**Contact:** [Developer name], [contact email], [phone number required by App Store Connect, not shown publicly].

**Notes for the reviewer** (paste into "Notes"):

```
SimpleSwing is a hands-free golf swing recorder. No account or network service is used; everything stays on the device.

HOW TO TEST WITHOUT A GOLF SWING
1. Launch the app and allow Camera and Microphone. The Capture tab shows a live camera with a green "golfer box".
2. Prop the device so it is still (a tripod is ideal; the app treats a moving camera as motion).
3. Easiest: tap the large SAVE button. The last few seconds are saved and a slow-motion replay plays immediately. Tap a result chip ("How was it?") to close it.
4. Automatic save: stand so your body is inside the golfer box, swing your arms, and clap loudly about 1 m from the device straight after. The app saves when it hears a sharp sound that follows movement inside the box. Tap the status pill at the top to see live sound and movement levels.
5. Swings tab: open a swing to try slow-motion speeds, frame stepping, the Draw tools (plane line, circle, angle) and the ••• menu (Save to Photos, Share, Compare).
6. Volume buttons also save on iOS 17.2 or later.

PERMISSIONS
- Camera: films the swing.
- Microphone: detects the impact sound on-device; audio is only kept inside saved clips.
- Photos (add only): asked the first time you tap Save to Photos.
- Local Network: only asked if you use the optional second-camera feature (Settings > Second camera), which links two devices running SimpleSwing directly over Wi-Fi. Testing it needs two iOS devices: on device B choose Settings > Use this phone as the camera; on device A tap "+ Cam" on the Capture screen, pick device B and type the 6-digit code it shows.

There are no in-app purchases, ads, accounts or analytics in this version.
```

- **Attachment (recommended):** a 1–2 minute screen recording of a real swing auto-saving at a range, plus the two-device flow. App Review accepts a video link or an attachment in the notes.
- **If purchases ship later:** remove the last line, and add how to reach the paywall and that sandbox purchases are restorable.

---

## 5. Export compliance and content rating

### Export compliance (both stores)

- **iOS:** `app.json` already sets `ios.infoPlist.ITSAppUsesNonExemptEncryption: false`, so App Store Connect won't ask per build.
  - This is accurate: the app implements no encryption. The local link is plain TCP, and any HTTPS inside Apple frameworks is exempt.
  - No export-compliance documentation is needed. (France: no encryption declaration needed for the same reason.)
- **Google Play:** no export-compliance form for this case. Play's "US export laws" acknowledgement at upload is a checkbox.

### App Store age rating (questionnaire as updated in 2025; answered after the 31 Jan 2026 deadline. Verify the current questions in App Store Connect)

| Section | Answer |
|---|---|
| Parental controls / age assurance (In-app controls) | No / No |
| Unrestricted web access | No |
| User-generated content shared with others / messaging or chat | No: videos stay on the user's own devices, and the second-camera link is between the user's own devices |
| Advertising | No |
| Gambling, simulated gambling, contests, loot boxes | None |
| Violence (cartoon, realistic, graphic), horror/fear | None |
| Sexual content, nudity, profanity, mature themes | None |
| Alcohol, tobacco, drugs | None |
| Medical or treatment information | None |
| Health or wellness topics | **No.** Sports technique video, not health advice (tempo is a timing number, not a health metric) |
| Guns or other weapons | None |
| Made for Kids | No |
| **Expected rating** | **4+** |

### Google Play content rating (IARC questionnaire)

| Question | Answer |
|---|---|
| Category | "All Other App Types" (utility, productivity, communication and other; verify the exact label) |
| Violence, fear, sexuality, language, controlled substances, crude humour | No to all |
| Gambling / simulated gambling | No |
| Users can interact or exchange content with other users | **No.** The local link pairs the user's own devices. It doesn't let users communicate with other people. If the questionnaire asks specifically about "sharing content", mention that Share hands videos to other apps chosen by the user (OS share sheet), which IARC typically treats as not in-app UGC |
| Shares user's current physical location with other users | No |
| Allows purchase of digital goods | **No** (Yes once IAP ships) |
| Unrestricted internet access / web browser | No |
| **Expected ratings** | ESRB Everyone, PEGI 3, USK 0, IARC 3+ |

---

## 6. If purchases ship (`expo-iap`, not built. Pricing undecided)

| Place | Change |
|---|---|
| Data safety (Play) | Google Play Billing is Google's own service, so purchase history isn't collected by you if verification stays on-device and nothing goes to your server. Answer stays **No** (verify against the "Purchase history" data type guidance at the time) |
| App Privacy (Apple) | StoreKit purchases are handled by Apple ("not responsible for disclosing data collected by Apple"). Label stays **Data Not Collected** while there's no server receipt validation |
| IARC | "Allows purchase of digital goods": **Yes** |
| Apple age rating | Unchanged |
| Review notes | Explain the free quota (`trigger-quota.ts`), how to reach the paywall, and "Restore Purchases" |
| Privacy policy | Un-comment the "Purchases" paragraph in `site/privacy.html` |
| Play merchant account | Personal accounts that monetise show an address publicly (verify). Apple's EU **trader status** (DSA) must then be "trader", with address, phone and email shown in the EU. For a free app with no monetisation, you can declare non-trader (verify) |
