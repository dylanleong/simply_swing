// Android manifest settings the store release needs that app.json can't express.
//
// 1. Backup rules. Android's automatic backup has a 25 MB quota per app; with the swing videos in
//    files/swings it overflows and the whole backup is skipped, settings included. Videos are kept
//    out of both cloud backup and device-to-device transfer; settings (and anything else small) stay in.
//    Shot tags live beside the videos in files/swings, so they don't travel either (a known limit).
// 2. Large screens. From Android 16 (API 36) the portrait lock is ignored on screens 600 dp and wider
//    (tablets, unfolded foldables). The capture view and golfer-box mapping assume portrait, so opt out
//    for now. Android 17 removes this opt-out for apps targeting it: landscape layouts are needed then.
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const BACKUP_RULES = `<?xml version="1.0" encoding="utf-8"?>
<!-- Android 11 and older (android:fullBackupContent). See plugins/with-android-policy.js. -->
<full-backup-content>
  <exclude domain="file" path="swings/" />
</full-backup-content>
`;

const DATA_EXTRACTION_RULES = `<?xml version="1.0" encoding="utf-8"?>
<!-- Android 12+ (android:dataExtractionRules). See plugins/with-android-policy.js. -->
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="file" path="swings/" />
  </cloud-backup>
  <device-transfer>
    <exclude domain="file" path="swings/" />
  </device-transfer>
</data-extraction-rules>
`;

const RESIZABILITY_PROPERTY = 'android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY';

function withBackupRuleFiles(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'backup_rules.xml'), BACKUP_RULES);
      fs.writeFileSync(path.join(dir, 'data_extraction_rules.xml'), DATA_EXTRACTION_RULES);
      return cfg;
    },
  ]);
}

function withPolicyManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.$['android:fullBackupContent'] = '@xml/backup_rules';
    app.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
    const properties = (app.property = app.property ?? []);
    if (!properties.some((p) => p.$['android:name'] === RESIZABILITY_PROPERTY)) {
      properties.push({ $: { 'android:name': RESIZABILITY_PROPERTY, 'android:value': 'true' } });
    }
    return cfg;
  });
}

module.exports = (config) => withPolicyManifest(withBackupRuleFiles(config));
