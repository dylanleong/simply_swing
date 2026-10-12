// Signs Android release builds with the Play upload key when it is configured on this machine.
//
// The key and its passwords never live in the repo. Put these in ~/.gradle/gradle.properties:
//   SIMPLESWING_UPLOAD_STORE_FILE=/absolute/path/to/upload.jks
//   SIMPLESWING_UPLOAD_STORE_PASSWORD=...
//   SIMPLESWING_UPLOAD_KEY_ALIAS=upload
//   SIMPLESWING_UPLOAD_KEY_PASSWORD=...
//
// Only Play bundles (`bundleRelease`, the .aab) use the upload key. Sideloaded test APKs
// (`assembleRelease`) stay on the debug key: Android won't update an app whose signing key changed,
// so switching would force an uninstall that wipes the swings saved on the test phone.
// Without the properties, everything falls back to the debug key (Play rejects that).
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// simpleswing:release-signing';

const SIGNING_CONFIG = `
        release { ${MARKER}
            if (project.hasProperty('SIMPLESWING_UPLOAD_STORE_FILE')) {
                storeFile file(SIMPLESWING_UPLOAD_STORE_FILE)
                storePassword SIMPLESWING_UPLOAD_STORE_PASSWORD
                keyAlias SIMPLESWING_UPLOAD_KEY_ALIAS
                keyPassword SIMPLESWING_UPLOAD_KEY_PASSWORD
            }
        }`;

const RELEASE_SIGNING = [
  "def playUpload = project.hasProperty('SIMPLESWING_UPLOAD_STORE_FILE') &&",
  "                gradle.startParameter.taskNames.any { it.toLowerCase().contains('bundle') }",
  '            signingConfig playUpload ? signingConfigs.release : signingConfigs.debug',
].join('\n');

function addReleaseSigning(gradle) {
  if (gradle.includes(MARKER)) return gradle;

  const withConfig = gradle.replace(/signingConfigs\s*\{/, (m) => `${m}${SIGNING_CONFIG}`);
  // Only the release build type's debug signing line: the one following `release {` inside buildTypes.
  const withBuildType = withConfig.replace(
    /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
    `$1${RELEASE_SIGNING}`
  );
  if (withConfig === gradle || withBuildType === withConfig) {
    throw new Error('with-release-signing: app/build.gradle layout changed; update the plugin');
  }
  return withBuildType;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = addReleaseSigning(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.addReleaseSigning = addReleaseSigning;
