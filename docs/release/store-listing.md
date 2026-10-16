# SimpleSwing store listing (v1.0)

_Drafted 2026-10-16. Written for a **free** app with no in-app purchases. Purchase wording lives only in the
"Optional: if purchases ship" notes at the end. Character counts were checked with `wc -m`. Re-check after any edit._

**Two rules that shape the copy:**

- **Apple:** App Store metadata must not mention Android, Wear OS or Google Play (App Review Guideline 2.3.10).
- **Google:** Play metadata must not mention Apple. Play also requires the listing to **mention Wear OS** for the watch app to pass Wear review.

So there are two full descriptions, one per store.

---

## Names

| Field | Limit | Text | Chars |
|---|---|---|---|
| App Store name | 30 | `SimpleSwing: Golf Swing Camera` | 30 |
| App Store subtitle | 30 | `Hands-free slow-mo swing video` | 30 |
| Play title | 30 | `SimpleSwing: Golf Swing Camera` | 30 |
| Play short description | 80 | `Hit the ball, watch your swing. Hands-free slow-motion golf video, no account.` | 78 |
| Home-screen name | — | `SimpleSwing` (from `app.json` `name`) | 11 |

Alternatives if "SimpleSwing: Golf Swing Camera" is taken or rejected as too generic:
- `SimpleSwing - Golf Replay` (25)
- `SimpleSwing Golf` (16)

## iOS keywords (100 max, comma-separated, no spaces)

```
replay,analyzer,analysis,tempo,practice,range,coach,driver,iron,tripod,plane,trainer,frame,lesson
```

That's 97 characters. Words already in the name and subtitle (golf, swing, camera, hands-free, slow-mo, video) are
indexed anyway, so they aren't repeated. App Store Connect counts the characters for you, so check there.

## Categories

| Store | Primary | Secondary | Notes |
|---|---|---|---|
| App Store | **Sports** | Photo & Video | Health & Fitness is also defensible, but it invites health-feature scrutiny for no gain |
| Google Play | **Sports** | — | Play has one category. Tags: pick golf / sports training / video tags offered in Store settings → Tags (verify which are offered) |

---

## Full description: Google Play (≤ 4000; this draft is about 2,830)

```
Hit the ball, then watch your swing in slow motion, without touching your phone.

SimpleSwing is a hands-free golf swing recorder. Put your phone on a tripod, point it at yourself and hit balls. The app keeps the last few seconds of video. When it hears the strike, and sees you moving in your golfer box just before it, it saves the swing and loops it in slow motion straight away. You stay in your stance. Your neighbour's shots are ignored.

NO ACCOUNT. NO CLOUD. NO TRACKING.
Your swings stay on your phone. There's no sign-in, no subscription, no ads and no analytics. SimpleSwing works fully offline, at the range, on the course or in your garage net.

CAPTURE
• Saves automatically on the sound of impact, gated by movement in an adjustable golfer box
• Or save with the on-screen SAVE button, a volume button, a cheap Bluetooth camera remote or your Wear OS watch, right after you swing
• 120 fps slow motion, and 240 fps where your phone supports it
• Sharp mode for a crisp club in daylight
• Level indicator so the camera is straight
• Pick your club before you hit, and tag the result in one tap after the replay
• Screen dims between shots, and the camera rests when you step away, to save battery

REVIEW
• Play at full, ½, ¼ or ⅛ speed, or step frame by frame
• Draw a swing plane, lines, circles around your head, and measure angles
• Grid and mirror
• Compare two swings side by side, lined up on impact
• Filter by club, result or favourites, grouped by practice session
• Save to your gallery or share as a slow-motion video that plays anywhere

TWO ANGLES (OPTIONAL)
Have a second Android phone? Run SimpleSwing on it as a second camera. Film down the line and face on at the same time, and every saved swing is recorded from both angles, in sync. Review them side by side, or save one side-by-side video. The phones talk directly over your Wi-Fi or one phone's hotspot. Nothing goes over the internet.

WEAR OS (OPTIONAL)
Install SimpleSwing on your Wear OS watch to:
• Use it as a remote: tap to save
• Sense your swing from your wrist, so only your own shots are saved
• See your tempo (backswing : downswing) on every swing
• Optionally save practice swings with no ball
The watch app needs the phone app.

WHAT YOU NEED
• A tripod or phone stand. The app watches for movement where you stand, so the phone must stay still.
• Good light. Slow motion needs it: outdoors, or a bright room.
• High-speed recording (120/240 fps) depends on your phone model. Phones without it record at a lower frame rate.
• A second phone and a Wear OS watch are optional.

BUILT-IN HELP
Setup guides for down-the-line and face-on camera positions, what to look for with the plane line, head circle and angles, and troubleshooting, all available offline.

Privacy policy: [privacy URL]
Questions or problems: [contact email]
```

## Full description: App Store (≤ 4000; this draft is about 2,440)

```
Hit the ball, then watch your swing in slow motion, without touching your phone.

SimpleSwing is a hands-free golf swing recorder. Put your iPhone or iPad on a tripod, point it at yourself and hit balls. The app keeps the last few seconds of video. When it hears the strike, and sees you moving in your golfer box just before it, it saves the swing and loops it in slow motion straight away. You stay in your stance. Your neighbour's shots are ignored.

NO ACCOUNT. NO CLOUD. NO TRACKING.
Your swings stay on your device. There's no sign-in, no subscription, no ads and no analytics. SimpleSwing works fully offline, at the range, on the course or in your garage net.

CAPTURE
• Saves automatically on the sound of impact, gated by movement in an adjustable golfer box
• Or save with the on-screen SAVE button, a volume button, a cheap Bluetooth camera remote or your Apple Watch, right after you swing
• 120 fps slow motion, and 240 fps where your device supports it
• Sharp mode for a crisp club in daylight
• Level indicator so the camera is straight
• Pick your club before you hit, and tag the result in one tap after the replay
• Screen dims between shots, and the camera rests when you step away, to save battery

REVIEW
• Play at full, ½, ¼ or ⅛ speed, or step frame by frame
• Draw a swing plane, lines, circles around your head, and measure angles
• Grid and mirror
• Compare two swings side by side, lined up on impact
• Filter by club, result or favourites, grouped by practice session
• Save to Photos or share as a slow-motion video that plays anywhere

TWO ANGLES (OPTIONAL)
Have a second iPhone or an iPad? Run SimpleSwing on it as a second camera. Film down the line and face on at the same time, and every saved swing is recorded from both angles, in sync. Review them side by side, or save one side-by-side video. The devices talk directly over your Wi-Fi, a hotspot or peer-to-peer Wi-Fi. Nothing goes over the internet.

APPLE WATCH (OPTIONAL)
Wear your Apple Watch on your lead wrist and open SimpleSwing on it to:
• Save a swing with a tap on your wrist
• Sense your swing: only shots where your own wrist swung are saved, even at a busy range
• See your tempo (backswing : downswing) for every swing
• Feel a tap on your wrist when a swing is saved
Swing sensing runs as a golf workout so it keeps working with the screen off. Nothing is saved to Health.

WHAT YOU NEED
• A tripod or stand. The app watches for movement where you stand, so the device must stay still.
• Good light. Slow motion needs it: outdoors, or a bright room.
• Frame rates depend on your device. Volume-button saving needs iOS 17.2 or later.
• A second device and an Apple Watch are optional.

BUILT-IN HELP
Setup guides for down-the-line and face-on camera positions, what to look for with the plane line, head circle and angles, and troubleshooting, all available offline.

Questions or problems: [contact email]
```

> **Check before pasting:**
>
> - **Second camera:** the iOS copy says "second iPhone or an iPad". The protocol is cross-platform (Android ↔ iPhone), but Apple metadata can't say "Android", so cross-platform pairing is left for the support page.
> - **Frame rates:** the "240 fps" and "⅛ speed" claims match `CaptureSettings.fps` and the review speeds. Confirm on the first iOS device run that 240 fps is offered on the test iPhone.
> - **Remove the TWO ANGLES section** from either store's copy if multicam ends up gated behind a purchase or isn't verified on that platform by submission. On iOS it has never been compiled.
> - **Remove the Wear OS section** from the Play copy if the watch app isn't uploaded with 1.0.
> - **Apple Watch section:** keep it only once the watch app has run on a real watch (it's written but not yet compiled). Recount the length after edits (limit 4000).

## Promotional text (App Store, ≤ 170, editable without review)

```
Hit the ball and your swing is already playing back in slow motion. Hands-free, private and offline: no account, no cloud, no ads.
```
(130 chars)

## What's new in 1.0

**App Store (version notes):**
```
The first release of SimpleSwing. Hands-free swing capture on the impact sound, slow-motion replay, drawing tools, side-by-side compare, shot tags, an optional second-device camera angle, and an Apple Watch app that senses your swing and shows your tempo.
```

**Google Play (release notes, ≤ 500 per language):**
```
<en-GB>
The first release of SimpleSwing. Hands-free swing capture on the impact sound, slow-motion replay, drawing tools, side-by-side compare, shot tags, an optional second-phone camera angle and a Wear OS watch remote with wrist tempo.
</en-GB>
```

Add an `<en-US>` block with the same text if you add an en-US listing. The copy uses British spelling ("favourites",
"neighbour"). For a US listing, swap to "favorites" and "neighbor".

---

## Screenshot plan

### What to capture (same order on every device)

| # | Screen | What should be on it | Caption (≤ ~40 chars, overlaid above the screenshot) |
|---|---|---|---|
| 1 | Capture, armed | Golfer at address inside the green golfer box, level bar straight, status pill "ARMED", Club chip set to 7-iron | **Hit the ball. It saves itself.** |
| 2 | Replay overlay | Slow-motion loop mid-downswing, "How was it?" result chips | **Instant slow-motion replay** |
| 3 | Review → Draw | Down-the-line clip paused in transition, plane line and head circle drawn | **Plane line, circles and angles** |
| 4 | Compare | Two swings side by side, lined up on impact | **Compare two swings on impact** |
| 5 | Review, two angles | DTL + face-on of the same swing side by side | **Two angles with a second phone** (iOS: "…second device") |
| 6 | Swings library | 3-column grid with club/result tags, a session header, Filter sheet open on "Slice" | **Find the pattern in your misses** |
| 7 | Settings | Clip length, Auto-save and Watch (Play only) sections | **SAVE button, remote or watch** (iOS: "**SAVE button or a remote**") |
| 8 | Privacy card (designed, not a screenshot) | Plain text: "No account. No cloud. No tracking. Your swings stay on your phone." | — |

**Tips:**

- **Shoot a real swing outdoors** in good light, with a friend swinging, so the slow-motion frames are crisp. Dim indoor footage reads as low quality.
- **Show the app's real UI.** Both stores reject frames that misrepresent the app.
- **Keep text overlays short.** Apple and Google allow captions, but Google discourages excessive text and forbids device frames on Wear OS shots (see below).
- **Clean status bars:**
  - iOS Simulator: `xcrun simctl status_bar booted override --time 9:41 --batteryLevel 100`.
  - Android: use System UI demo mode (`adb shell settings put global sysui_demo_allowed 1`, then the `com.android.systemui.demo` broadcasts).
- **Screenshot 8 may be dropped.** Some reviewers dislike non-UI screens. It's allowed on both stores if it isn't misleading, but verify against current guidance.

### Sizes required (checked 2026-10-16. **Verify in each console before exporting**)

**App Store** (from Apple's "Screenshot specifications" page, checked 2026-10-16):

| Display | Required? | Portrait size (px) | How to get it |
|---|---|---|---|
| iPhone with Dynamic Island, **medium** | **Yes. At least 1.** Apple's page lists this as the iPhone minimum | 1206 × 2622 or 1179 × 2556 | iPhone 16 / 17 class phone, or Simulator |
| iPhone with Dynamic Island, **large** (6.9") | Optional, recommended (the largest shows best) | 1320 × 2868, 1290 × 2796 or 1260 × 2736 | iPhone 16/17 Pro Max class, or Simulator |
| iPad **13"** | **Yes**, because `supportsTablet: true` | 2064 × 2752 or 2048 × 2732 | iPad Pro 13" / iPad Air 13" Simulator, or upscale cautiously |
| Apple Watch | **Yes**, the 1.0 includes a watch app (verify the current required watch size on Apple's page) | e.g. 422 × 514 (Ultra), 416 × 496 (Series 10/11 46 mm) | Watch screenshots (press side button + Digital Crown) or watch Simulator |

- **Limits:** 1–10 screenshots per size, PNG or JPEG, no transparency.
- **Older guidance:** this said "6.9" required, else 6.5"". Apple's page now names the medium Dynamic Island size as the minimum, so **verify**. Uploading both medium and large sets is safest.
- **App preview videos** are optional (15–30 s). A 20 s preview of a swing auto-saving and replaying would sell the app well.

**Google Play:**

| Asset | Required? | Spec |
|---|---|---|
| App icon | Yes | 512 × 512 PNG (32-bit), ≤ 1 MB |
| Feature graphic | Yes | 1024 × 500 JPEG or 24-bit PNG, no alpha |
| Phone screenshots | Yes, at least 2 (verify the minimum), up to 8 | JPEG or 24-bit PNG, each side 320–3840 px, long side ≤ 2× short side. Use 1080 × 1920 or larger, 9:16 portrait |
| 7" and 10" tablet screenshots | Optional. Needed to be featured in tablet surfaces | Same rules. Take from a tablet emulator if the layout holds up |
| **Wear OS screenshots** | **Yes, at least 1**, to opt into Wear OS | 1:1, min 384 × 384, **app UI only**: no device frame, no added text or graphics, no transparency or round mask (verify current rules; the main source is Google's 2021 Wear OS 3 post) |
| Promo video | Optional | YouTube URL |

**Wear screenshots to take:**

1. The SAVE button screen, connected.
2. The sensing state.
3. The "saved" confirmation.

Capture them with `adb -s <watch> exec-out screencap -p > wear1.png` on the watch, or a Wear OS emulator (round, 454 × 454 or similar).

---

## Optional: if purchases ship (not built. Pricing undecided)

Use **none** of this until `expo-iap` is actually in the build.

- **Descriptions:** add a short section before "WHAT YOU NEED", for example:
  - "FREE TO TRY: The first [N] automatic saves in each session are free. Unlock unlimited automatic saves [and …] with a one-time purchase. No subscription."
  - Name exactly what's paid (the plan's candidates: unlimited auto-triggers, ⅛ speed, angle/plane tools, Photos export, the second-camera add-on). Apple rejects descriptions that hide what's behind a paywall.
- **"No subscription" can stay.** "Free" must not appear in the name or subtitle if features are paid.
- **App Store:** the listing shows "In-App Purchases" automatically. Each IAP product needs its own display name, description and a review screenshot of the paywall.
- **Play:** "Contains in-app purchases" appears automatically. Setting up a merchant account makes your **address public** on the listing for a personal account (verify the current rule). Consider a business address or PO box.
- **Promo text:** "One-time unlock, no subscription" fits in the 170 characters.
