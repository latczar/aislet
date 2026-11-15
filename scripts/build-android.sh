#!/usr/bin/env bash
# Build the Android app (APK) inside WSL, then copy it to build/Assistant.apk on Windows.
# Run from Windows (PowerShell):
#   wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/path/to/untethered/scripts/build-android.sh
# First time only: run scripts/wsl-android-setup.sh the same way.
set -euo pipefail
source /etc/profile.d/android.sh
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$ANDROID_HOME/platform-tools"  # Linux tools only, never the Windows ones

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the project folder (on /mnt/c when run from Windows)
# Building on the Linux disk is much faster than on /mnt/c. Set UNTETHERED_WORK to build a second checkout
# (for example a git worktree) in its own folder, so two builds never share one.
WORK="${UNTETHERED_WORK:-/root/assistant-app}"

# A swap file inside Ubuntu, so WSL's 6 GB limit (set in .wslconfig) can't freeze the build.
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || fallocate -l 8G /swapfile
  chmod 600 /swapfile
  swapon /swapfile 2>/dev/null || { mkswap /swapfile >/dev/null && swapon /swapfile; } || true
fi

echo "== copy source"
mkdir -p "$WORK"
# /android and /ios only at the top: modules/*/android is source code and must be copied.
rsync -a --delete --exclude node_modules --exclude /android --exclude /ios --exclude dist \
  --exclude .expo --exclude build --exclude .lock-hash "$SRC/" "$WORK/"
cd "$WORK"

echo "== install packages"
# Only reinstall when the package list changed: reinstalling wipes compiled C++ and makes every build slow.
LOCK_HASH=$(sha1sum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$(cat .lock-hash 2>/dev/null)" != "$LOCK_HASH" ]; then
  npm ci --no-audit --no-fund --loglevel=error
  echo "$LOCK_HASH" > .lock-hash
else
  echo "unchanged, keeping node_modules"
fi
# llama.rn ships ready-built native libraries; fetch them (npm holds back install scripts by default).
(cd node_modules/llama.rn && node ./install/download-native-artifacts.js)

echo "== generate android project"
# Keep the previous android/ folder so Gradle only rebuilds what changed. Run with CLEAN=1 to start fresh.
if [ "${CLEAN:-0}" = "1" ]; then rm -rf android; fi
npx expo prebuild -p android --no-install >/dev/null
sed -i '/# Added by build-android.sh/,$d' android/gradle.properties  # replace our block each time
cat >> android/gradle.properties <<'EOF'

# Added by build-android.sh: fit WSL's 6 GB, build for the S25's 64-bit ARM only, room for chats.
org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8
org.gradle.parallel=true
org.gradle.caching=true
kotlin.compiler.execution.strategy=in-process
reactNativeArchitectures=arm64-v8a
AsyncStorage_db_size_in_MB=256
EOF

echo "== build (first run downloads Gradle, the NDK and libraries: allow 15-30 minutes)"
cd android
# All cores. Needs WSL memory of 12 GB+ in .wslconfig; with 6 GB, limit cores with: taskset -c 0-2 ./gradlew ...
./gradlew assembleRelease --no-daemon --console=plain -q 2>&1 | grep -vE "^w: |warning:" | tail -40

mkdir -p "$SRC/build"
cp app/build/outputs/apk/release/app-release.apk "$SRC/build/Assistant.apk"
echo "== done: build/Assistant.apk ($(du -h "$SRC/build/Assistant.apk" | cut -f1))"
