# Developer notes

TypeScript · React Native (Expo) · React Native Paper · Ollama on the computer (Windows, Linux, Mac) · llama.cpp (llama.rn) on Android · a small Python hub.

## Layout

- `src/engine`: the two AI engines. `ollama.ts` is used on the PC, and on the phone via the hub. `device.ts` runs on-device on the phone.
- `src/store.tsx`: app state, learning and sync.
- `src/brain.ts`: prompts, memory and notes search.
- `src/ui`: the screens.
- `src/backup.ts`: automatic encrypted backups on the phone (Settings → Your data). Each day, when memory, notes, name or instructions have changed, it saves `untethered-backup-YYYY-MM-DD-HHMM.json` to a folder the user picks with Android's folder picker. The app keeps access to that folder. It keeps the newest 7 and only ever deletes its own backup files. Restoring merges like Import: anything new is added and nothing is overwritten. The PC has no automatic backups (`backup.web.ts`), because the hub's data file already holds a copy.
- `src/ui/share.ts`: "Share to Untethered" on Android. The share filters are the `expo-sharing` plugin's options in `app.json`: single text, images and PDFs, or several images. A share opens a new chat with the text, photos (as JPEGs, at most 3) or files in the message box, ready to send. Shared PDFs are read by the laptop, as when attached. Only shared files are resolved: resolving shared text would make `expo-sharing` open any web link in it, and nothing in Untethered goes online by itself.
- `src/library.ts` and `modules/untethered-library`: offline libraries. The native module wraps Kiwix's reader (`org.kiwix:libkiwix`, GPL-3.0) to search Kiwix `.zim` files on the phone. For each question the app looks for overview articles by title, runs Kiwix's full-text search, picks the best passages (by meaning when an embedding model is available, otherwise by shared words) and puts up to three in the prompt. Libraries live in `Untethered/Libraries` on the phone. Reading them, and moving Kiwix's own files out of `Android/media/org.kiwix.kiwixmobile` (which Android deletes with Kiwix), needs "All files access". The app's own folder `Android/data/app.untethered.assistant/files/libraries` works without it. The PC has no libraries yet: Smart App Control blocks the unsigned libzim DLL, so `pip install libzim` can't load on Windows.
- `pc/hub.py`: the laptop hub. It serves the PC app on :8766 and handles sync, Ollama passthrough and PDF text. It runs on Windows, Linux and Mac (Python 3.10+, standard library, plus pypdf for PDFs). Its data folder is `%LOCALAPPDATA%\Untethered` on Windows, `~/.local/share/Untethered` on Linux (`$XDG_DATA_HOME` if set) and `~/Library/Application Support/Untethered` on a Mac. `pc/launch.py` opens the app in its own window, and `pc/install_shortcuts.py` adds it to the Start menu (Windows), the app menu with an autostart entry (Linux), or `~/Applications` with a LaunchAgent (Mac).
- `src/pairLink.ts` and `src/ui/PairPrompt.tsx`: pairing by QR code. The computer's Settings → Home shows a QR code of `untethered://pair?u=<address>&c=<code>` (`src/ui/PairQr.tsx`, drawn with `toqr`). The phone's camera opens the link in the app, which asks first (see the security model).
- `install/install.ps1`: the Windows installer. `install/install.sh`: the Linux and Mac installer. It puts the app, and its own Python environment for pypdf, in the data folder. Linux is tested in WSL (Ubuntu 24.04); the Mac path is untested. `scripts/package.ps1` makes the release files.

## Security model

- The PC app proves itself to the hub with a secret token. `launch.py` passes it after `#`, so it never crosses the network.
- The phone signs every request with HMAC-SHA256 keyed by the pairing code (`src/crypto.ts`). Each signature covers the time, a nonce, the method, the path and a hash of the body. The code itself never crosses the network, and replays are refused.
- The hub only serves files that exist in `dist/`, checks the Host and Origin headers, and limits body size and connections. It pauses a device for 10 minutes after 10 wrong attempts.
- **Pairing links:** any app or website can open an `untethered://pair` link, so the phone never pairs from one by itself. It only accepts home-network addresses (10.x, 172.16–31.x, 192.168.x) and codes in the hub's alphabet. It always shows the address, and pairs only after the user taps Pair and the hub accepts the code. The QR code holds the same code that's shown beside it, so it gives away nothing the screen didn't already show.
- On Android, plain HTTP is allowed so the phone can reach the hub on the home network. Android's own cloud backup is off.
- **Encrypted backups:** the format is JSON. A plain header holds the app, the date and the key settings. The data is encrypted with AES-256-GCM (`expo-crypto`), using a key made from the passphrase with PBKDF2-HMAC-SHA256 (200,000 iterations, a random 16-byte salt; `pbkdf2Sha256` in `src/crypto.ts`, checked against Node's crypto). The passphrase is never stored. The key made from it is kept in the app's own storage, beside the memory it protects, so the daily backup runs without asking. A wrong passphrase fails the GCM check and is reported as such.

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
- **Logo and icons:**

  ```bash
  python scripts/make-icons.py
  ```

  This draws the mark (a broken ring with a free dot, white on #18181B) and writes every icon in `assets/`. It needs Pillow.
- **Licences:**

  ```bash
  node scripts/third-party-licences.js .
  ```

  This regenerates `THIRD_PARTY_LICENSES.md`.
- **Typecheck:**

  ```bash
  npm run typecheck
  ```
- **Hub security tests:** after any change to `pc/hub.py`, run `pc/tests/hub_attack_test.py` against a test hub. Its first lines say how, on Windows and on Linux. Where Ollama isn't installed (for example WSL), `pc/tests/fake_ollama.py` stands in for it. All checks must pass.

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

- **Before running:** connect the phone over adb, unlock it and leave it on the home screen. The runner won't start while another app is in front, and checks again before every tap, key, swipe and launch, so it never types into something else. If another app comes to the front during a run, the current check stops.
- **One check at a time:** `python e2e/phone/run.py chat_typing`. List them with `--list`. Every run starts with a fresh launch of the app.
- **More than one device:** add `--device <serial>`.

| Check | What it proves |
|---|---|
| `launch` | The app starts from cold and its AI becomes ready. |
| `chat_typing` | Typed text shows in the message box. The box and Send stay above the keyboard, and the tabs hide while typing. Long text grows the box up to its 160 dp limit, and it shrinks again when cleared. |
| `chat_send` | Tapping Send with the keyboard open sends the message, clears the box, and a reply arrives. |
| `resume` | After Android closes the app (force-stop) and it's opened again, it shows the chat that was open, and then the Notes screen when that was open. The test chat is deleted. |
| `share` | Android shares reach the app. Text shared while the app is open on another tab opens a new chat with the text in the message box, unsent. A photo shared while the app is closed starts it with the photo attached. A shared PDF is read by the laptop and attached, or, when the laptop isn't connected, the app says it needs the laptop. |
| `text_fields` | Typing shows, above the keyboard, in Memory's "Add a fact", a new note's title and text, and Settings' name and custom instructions. |
| `find_laptop` | Settings → Home shows the pairing status. When paired, Advanced → "Find again" finds the laptop with the same code and stays connected. When not paired, "Find my laptop" lists it. It never unpairs. |
| `pair_link` | A pairing link, as the laptop's QR code gives, is handled safely. A link to an address outside the home network is turned away without asking. A made-up home address (`192.168.255.254`, code `E2ETESTS`) opens the app from cold with "Pair with the laptop at …?", and Cancel leaves the pairing as it was. It never pairs and never uses the real code. |
| `memory` | Two facts are added, "Tidy up" runs, and the facts are forgotten again. Suggestions are applied only when memory held nothing else; otherwise they're cancelled. |
| `performance` | Cool, Max and Balanced each switch over and show their description, then the original mode is put back. |
| `haptics` | The "Vibrate on taps" switch in Settings turns off and on, then is put back as it was. |
| `library` | A made-up library (`fixtures/e2e-library.zim`, made by `make_test_library.py`) pushed to the app's own folder shows in Settings → Libraries, and asking about its made-up lantern gets an answer with its made-up fact (42 hours). The file and the chat are deleted afterwards. Your own libraries and "All files access" are never touched. |
| `backup` | Backups turn on with a passphrase and a folder chosen in Android's picker. The file is in the backup format and doesn't contain the test fact in plain text. A wrong passphrase is refused, and the right one restores a fact forgotten after the backup. If backups were already on, it only checks "Back up now" and leaves them as they were. |
| `layout` | List rows on Memory and Settings line up. Titles start at one left edge and buttons end at one right edge, the same on every card. No button is stretched or off-centre on its row. |

The checks use made-up text starting "E2E" and clean up after themselves:

- The test chat is deleted.
- The backup test uses `Documents/E2E-untethered-backups`. It turns backups off again, forgets its fact and deletes the folder. It taps in Android's folder and file picker only while Untethered has that picker open.
- Shared text, photos and PDFs are removed from the message box unsent. The made-up picture and PDF are pushed to the app's own folder (`Android/data/app.untethered.assistant/files/e2e`), never the gallery, and deleted afterwards.
- Test facts are forgotten.
- Notes are never saved.
- Text added to the name and instructions boxes is deleted before they save.
- The performance mode is put back.

When a check fails, a screenshot and screen dump go to `e2e/phone/out/`, which git ignores.

`chat_send` and `memory` use the AI, so they need it ready: the laptop's AI, or a downloaded phone model. Allow a few minutes for a full run.
