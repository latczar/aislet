// The QR scanner (expo-camera's barcode scanning) reads codes with ML Kit's model bundled in the app, offline.
// expo-camera's manifest also asks Google Play services to download its separate code-scanner module when the app
// is installed; Aislet never uses that module, so the request is removed and nothing is downloaded for it.
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withScannerOffline(config) {
  return withAndroidManifest(config, (c) => {
    const manifest = c.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools';
    const app = manifest.application[0];
    const meta = (app['meta-data'] || []).filter((m) => m.$['android:name'] !== 'com.google.mlkit.vision.DEPENDENCIES');
    meta.push({ $: { 'android:name': 'com.google.mlkit.vision.DEPENDENCIES', 'tools:node': 'remove' } });
    app['meta-data'] = meta;
    return c;
  });
};
