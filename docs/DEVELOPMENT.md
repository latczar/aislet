# Developer notes

TypeScript · React Native (Expo) · React Native Paper · Ollama on Windows · llama.cpp (llama.rn) on Android · a small Python hub.

## Layout

- `src/engine`: the two AI engines. `ollama.ts` is used on the PC, and on the phone via the hub. `device.ts` runs on-device on the phone.
- `src/store.tsx`: app state, learning and sync.
- `src/brain.ts`: prompts, memory and notes search.
- `src/ui`: the screens.
- `pc/hub.py`: the laptop hub. It serves the PC app on :8766 and handles sync, Ollama passthrough and PDF text.
- `install/install.ps1`: the Windows installer. `scripts/package.ps1` makes the release files.

## Security model

- The PC app proves itself to the hub with a secret token. `launch.py` passes it after `#`, so it never crosses the network.
- The phone signs every request with HMAC-SHA256 keyed by the pairing code (`src/crypto.ts`). Each signature covers the time, a nonce, the method, the path and a hash of the body. The code itself never crosses the network, and replays are refused.
- The hub only serves files that exist in `dist/`, checks the Host and Origin headers, and limits body size and connections. It pauses a device for 10 minutes after 10 wrong attempts.
- On Android, plain HTTP is allowed so the phone can reach the hub on the home network. Backup is off.

## Build

- **PC app:**

  ```bash
  npm run build:pc
  ```

- **Android** (WSL Ubuntu). Run this once:

  ```bash
  bash scripts/wsl-android-setup.sh
  ```

  Then build with:

  ```bash
  bash scripts/build-android.sh
  ```

  Release builds are signed when the `UNTETHERED_*` properties are set in `~/.gradle/gradle.properties`.
- **Install on a phone with adb:**

  ```bash
  adb install --user 0 -r release/Untethered.apk
  ```

  Use `--user 0` on phones with a second profile, such as Samsung Dual Apps or Secure Folder. Without it the app installs into every profile and shows two icons.
- **Release files:**

  ```powershell
  pwsh scripts/package.ps1
  ```

  This makes `release/untethered-pc.zip` (with a `.sha256`) and `release/Untethered.apk`.
- **Licences:**

  ```bash
  node scripts/third-party-licences.js .
  ```

  This regenerates `THIRD_PARTY_LICENSES.md`.
- **Typecheck:**

  ```bash
  npm run typecheck
  ```
- **Hub security tests:** after any change to `pc/hub.py`, run `pc/tests/hub_attack_test.py` against a test hub. Its first lines say how. All checks must pass.
