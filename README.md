# SimpleSwing

Set your phone on a tripod, hit a ball and get an instant slow-motion replay. There's no subscription and no account, and everything stays on your device.

See [`docs/PLAN.md`](docs/PLAN.md) for the technology choices, architecture, development phases and rollout.

## Development

```bash
npm install
npm run lint && npm run typecheck && npm test

# Android (Linux). Needs a JDK (e.g. JAVA_HOME=/opt/android-studio/jbr) and USB debugging on the phone.
npx expo prebuild -p android --no-install       # regenerate android/ after app.json / plugin changes
cd android
./gradlew :swing-capture:testDebugUnitTest      # native unit tests
./gradlew :app:assembleRelease -Dorg.gradle.jvmargs=-Xmx6g   # standalone test APK (debug-signed, sideload)
./gradlew :app:bundleRelease -Dorg.gradle.jvmargs=-Xmx6g     # Play bundle (.aab), signed with the upload key
adb install -r app/build/outputs/apk/release/app-release.apk

# Wear OS companion
cd ../wear && ./gradlew assembleDebug

# iOS: built in the cloud with EAS (no Mac needed)
npx eas-cli@latest build --profile development --platform ios
```

Release signing: Play bundles use the upload key configured in `~/.gradle/gradle.properties` (never in this
repo); see `plugins/with-release-signing.js`. Sideload APKs keep the debug key so they update in place.

The capture engine is a native module in `modules/swing-capture/`, so Expo Go can't run the app. Use a development build instead.
