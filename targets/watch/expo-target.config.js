/**
 * Apple Watch companion (watchOS app embedded in the iPhone app), generated into the Xcode project
 * by @bacons/apple-targets on `expo prebuild`. Mirrors the Wear OS app in wear/: SAVE remote, wrist
 * swing sensing during a golf workout, tempo. Everything in this folder is compiled into the target.
 *
 * @type {import('@bacons/apple-targets/app.plugin').Config}
 */
module.exports = {
  type: 'watch',
  name: 'SimpleSwingWatch',
  displayName: 'SimpleSwing',
  // Apple's convention for a companion watch app; WatchConnectivity needs it under the phone's id.
  bundleIdentifier: '.watchkitapp',
  icon: '../../assets/images/icon.png',
  frameworks: ['SwiftUI', 'WatchConnectivity', 'HealthKit', 'CoreMotion', 'WatchKit'],
  // 10.0 for SwiftUI's two-value onChange(of:initial:). Phones paired with older watches get no watch app.
  deploymentTarget: '10.0',
  // Starting a workout session needs HealthKit; the phone app itself doesn't.
  entitlements: {
    'com.apple.developer.healthkit': true,
  },
};
