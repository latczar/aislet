// Kiwix's reader (org.kiwix:libkiwix) declares android:allowBackup="true" in its own manifest.
// Untethered keeps backup off (chats and memory stay on the phone), so the app's manifest tells
// Android's manifest merger to keep the app's value instead of failing the build.
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withBackupOff(config) {
  return withAndroidManifest(config, (c) => {
    const manifest = c.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools';
    const app = manifest.application[0];
    app.$['android:allowBackup'] = 'false';
    const replace = new Set((app.$['tools:replace'] || '').split(',').map((s) => s.trim()).filter(Boolean));
    replace.add('android:allowBackup');
    app.$['tools:replace'] = [...replace].join(',');
    return c;
  });
};
