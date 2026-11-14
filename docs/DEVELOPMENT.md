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

## List rows

Rows in cards use `Row` and `Lead` from `src/ui/rows.tsx`. Every row in a card shares the same columns:

- a 24 dp leading slot: a `List.Icon`, or a status dot or radio button inside `Lead`;
- the title and description;
- one trailing control.

Always pass the renderer's `p.style` on to the control, as in `right={(p) => <Button mode="contained-tonal" compact style={p.style}>…`. Dropping it stretches buttons to the row's height and shifts titles. Trailing actions are compact tonal buttons. The `layout` check below catches a row that breaks this.

## Phone end-to-end checks

`e2e/phone/run.py` drives the installed app on a real Android phone over adb. It taps and types like a person, reads the screen with uiautomator, and prints one `PASS` or `FAIL` line per check. It exits with 1 if any check fails. It needs only Python 3 and adb.

Run it after installing a new APK, before every release:

```bash
python e2e/phone/run.py
```

- **Before running:** connect the phone over adb, unlock it and leave it on the home screen. The runner won't start while another app is in front, so it never types into something else.
- **One check at a time:** `python e2e/phone/run.py chat_typing`. List them with `--list`. Every run starts with a fresh launch of the app.
- **More than one device:** add `--device <serial>`.

| Check | What it proves |
|---|---|
| `launch` | The app starts from cold and its AI becomes ready. |
| `chat_typing` | Typed text shows in the message box. The box and Send stay above the keyboard, and the tabs hide while typing. Long text grows the box up to its 160 dp limit, and it shrinks again when cleared. |
| `chat_send` | Tapping Send with the keyboard open sends the message, clears the box, and a reply arrives. |
| `text_fields` | Typing shows, above the keyboard, in Memory's "Add a fact", a new note's title and text, and Settings' name and custom instructions. |
| `find_laptop` | Settings → Home shows the pairing status. When paired, "Find again" finds the laptop with the same code and stays connected. When not paired, "Find my laptop" lists it. It never unpairs. |
| `memory` | Two facts are added, "Tidy up" runs, and the facts are forgotten again. Suggestions are applied only when memory held nothing else; otherwise they're cancelled. |
| `performance` | Cool, Max and Balanced each switch over and show their description, then the original mode is put back. |
| `layout` | List rows on Memory and Settings line up. Titles start at one left edge and buttons end at one right edge, the same on every card. No button is stretched or off-centre on its row. |

The checks use made-up text starting "E2E" and clean up after themselves:

- The test chat is deleted.
- Test facts are forgotten.
- Notes are never saved.
- Text added to the name and instructions boxes is deleted before they save.
- The performance mode is put back.

When a check fails, a screenshot and screen dump go to `e2e/phone/out/`, which git ignores.

`chat_send` and `memory` use the AI, so they need it ready: the laptop's AI, or a downloaded phone model. Allow a few minutes for a full run.
