// Chats, memory and notes stay on the phone: no Android cloud backup, and nothing copied to a new phone in a
// device-to-device transfer (Android 12+ does that even with allowBackup off, unless data extraction rules say not to).
// Kiwix's reader (org.kiwix:libkiwix) declares android:allowBackup="true" in its own manifest, so the app's
// manifest tells Android's manifest merger to keep the app's value instead of failing the build.
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const DOMAINS = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'];
const excludeAll = DOMAINS.map((d) => `    <exclude domain="${d}" path="." />`).join('\n');
const RULES = `<?xml version="1.0" encoding="utf-8"?>
<!-- Made by plugins/withBackupOff.js: nothing in the app goes to cloud backup or to another phone. -->
<data-extraction-rules>
  <cloud-backup>
${excludeAll}
  </cloud-backup>
  <device-transfer>
${excludeAll}
  </device-transfer>
</data-extraction-rules>
`;

module.exports = function withBackupOff(config) {
  config = withDangerousMod(config, ['android', async (c) => {
    const dir = path.join(c.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data_extraction_rules.xml'), RULES);
    return c;
  }]);
  return withAndroidManifest(config, (c) => {
    const manifest = c.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools';
    const app = manifest.application[0];
    app.$['android:allowBackup'] = 'false';
    app.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
    const replace = new Set((app.$['tools:replace'] || '').split(',').map((s) => s.trim()).filter(Boolean));
    replace.add('android:allowBackup');
    app.$['tools:replace'] = [...replace].join(',');
    return c;
  });
};
