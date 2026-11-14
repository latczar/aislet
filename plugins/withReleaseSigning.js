// Signs Android release builds with your own key, when its details are in Gradle properties
// (for example ~/.gradle/gradle.properties on the build machine, never in this repo):
//   UNTETHERED_STORE_FILE, UNTETHERED_STORE_PASSWORD, UNTETHERED_KEY_ALIAS, UNTETHERED_KEY_PASSWORD
// Without them, release builds use the debug key: fine for your own phone, not for sharing.
const { withAppBuildGradle } = require('expo/config-plugins');

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    let gradle = c.modResults.contents;
    if (gradle.includes('UNTETHERED_STORE_FILE')) return c;
    gradle = gradle.replace(
      /signingConfigs\s*\{/,
      `signingConfigs {
        release {
            if (project.hasProperty('UNTETHERED_STORE_FILE')) {
                storeFile file(UNTETHERED_STORE_FILE)
                storePassword UNTETHERED_STORE_PASSWORD
                keyAlias UNTETHERED_KEY_ALIAS
                keyPassword UNTETHERED_KEY_PASSWORD
            }
        }`,
    );
    gradle = gradle.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/,
      "$1signingConfig project.hasProperty('UNTETHERED_STORE_FILE') ? signingConfigs.release : signingConfigs.debug",
    );
    c.modResults.contents = gradle;
    return c;
  });
};
