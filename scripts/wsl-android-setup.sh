#!/usr/bin/env bash
# One-time set-up inside WSL (Ubuntu): Java 17, Node and the Android SDK for building the phone app.
# Run from Windows:  wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/path/to/untethered/scripts/wsl-android-setup.sh
# The Android build runs in Linux because Windows Smart App Control blocks some unsigned build tools.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
NODE_VER=v26.13.1   # same as Windows
SDK=/opt/android-sdk

echo "== packages"
apt-get update -qq
apt-get install -y -qq openjdk-17-jdk-headless unzip rsync xz-utils curl ca-certificates libatomic1 >/dev/null

echo "== node"
if [ "$(node -v 2>/dev/null || true)" != "$NODE_VER" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
fi

echo "== android command-line tools"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  ZIP=$(curl -fsSL https://dl.google.com/android/repository/repository2-3.xml \
        | grep -oE 'commandlinetools-linux-[0-9]+_latest\.zip' | sort -t- -k3 -n | tail -1)
  curl -fsSL -o /tmp/clt.zip "https://dl.google.com/android/repository/$ZIP"
  rm -rf /tmp/clt && unzip -q /tmp/clt.zip -d /tmp/clt
  mkdir -p "$SDK/cmdline-tools" && rm -rf "$SDK/cmdline-tools/latest"
  mv /tmp/clt/cmdline-tools "$SDK/cmdline-tools/latest"
fi

export ANDROID_HOME=$SDK JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
echo "== sdk packages"
yes 2>/dev/null | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true
if [ ! -d "$SDK/build-tools/36.0.0" ]; then
  "$SDK/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "platforms;android-36" "build-tools;36.0.0" | tail -1
fi

cat > /etc/profile.d/android.sh <<EOF
export ANDROID_HOME=$SDK
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH=\$PATH:$SDK/platform-tools
EOF

echo "== ready"
node -v
java -version 2>&1 | head -1
ls "$SDK"
