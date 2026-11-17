# Developer notes

Aislet was called Untethered until 1.0.7. Some internal names keep the old one, so existing installs, backups and pairings keep working: the Android app ID `app.untethered.assistant`, the native module `modules/untethered-library`, the backup format id `untethered-backup`, the hub's discovery id (`"app": "untethered"`) and the `UNTETHERED_*` build and test settings. The laptop hub moves its data from the `Untethered` folder, and the installers remove the old shortcuts.

TypeScript · React Native (Expo) · React Native Paper · Ollama on the computer (Windows, Linux, Mac) · llama.cpp (llama.rn) on Android · a small Python hub.

## Layout

- `src/engine`: the two AI engines. `ollama.ts` is used on the PC, and on the phone via the hub. `device.ts` runs on-device on the phone.
- `src/store.tsx`: app state, learning and sync. Sync is newest-wins per item, by `updated`, and the hub (`merge()` in `pc/hub.py`) keeps every field of a chat, so new chat fields such as `pinned` sync with no hub change. Pinning or unpinning makes a chat just 1 ms newer: enough for sync to carry it, never enough to win over newer messages from the other device, and the chat keeps its place by date.
- `src/brain.ts`: prompts, memory and notes search.
- `src/ui`: the screens.
- `src/backup.ts`: automatic encrypted backups on the phone (Settings → Your data). Each day, when memory, notes, name or instructions have changed, it saves `aislet-backup-YYYY-MM-DD-HHMM.json` (`untethered-backup-…` before the rename; both are kept, pruned and restored) to a folder the user picks with Android's folder picker. The app keeps access to that folder. It keeps the newest 7 and only ever deletes its own backup files. Restoring merges like Import: anything new is added and nothing is overwritten. The PC has no automatic backups (`backup.web.ts`), because the hub's data file already holds a copy.
- `src/ui/share.ts`: "Share to Aislet" on Android. The share filters are the `expo-sharing` plugin's options in `app.json`: single text, images and PDFs, or several images. A share opens a new chat with the text, photos (as JPEGs, at most 3) or files in the message box, ready to send. Shared PDFs are read by the laptop, as when attached. Only shared files are resolved: resolving shared text would make `expo-sharing` open any web link in it, and nothing in Aislet goes online by itself.
- `src/deviceActions.ts` and `modules/aislet-actions`: alarms, timers and calendar events on Android. When asked, the AI ends its reply with one action line, such as `[[alarm 07:30 | Wake up]]`, `[[timer 10m | Pasta]]` or `[[event 2026-11-18 15:00 | 60m | Dentist]]`. The system prompt explains the format, with the current date and time, only on the phone and only when the latest messages hold a number or a word like "alarm", "calendar" or "tomorrow" (`mayWantAction`), to keep other prompts short. The chat hides the line and shows a card; a line that can't be read is dropped with a note saying so, and a past date gets a warning. Copy, Read aloud, Save to Notes and hands-free all leave the line out. Only a tap on the card hands it to the phone's own Clock or Calendar app by intent (`ACTION_SET_ALARM`, `ACTION_SET_TIMER`, a `CalendarContract` insert), which shows it to check and keep. Times, lengths and text are checked in JS and again in `ActionsModule.kt` (their limits must match). It needs no internet. Its one permission, `SET_ALARM`, is granted at install without asking and reads nothing; the Clock app requires it of anyone handing it an alarm. The PC shows the card without a button.
- `src/widget.ts` and `modules/aislet-widget`: the Android home-screen widget, a bar that opens a new chat ready to type and a round button that starts hands-free. It's a plain `AppWidgetProvider` with a RemoteViews layout (`AskWidget.kt`, `res/layout/aislet_widget.xml`), declared in the module's own `AndroidManifest.xml`, which Android's build merges into the app; no config plugin. It never updates itself, so it costs no battery. Settings → Widget → Add asks the home screen to add it (`requestPinAppWidget`), and the home screen asks the user. The widget opens `aislet://new` or `aislet://talk` with this install's secret token (see the security model).
- `src/ui/voice.ts`: talking instead of typing, with Android's on-device speech recognition only. Settings → Voice picks the language from the phone's installed offline packs (`offlineLanguages`). Empty ("Same as the phone") means the phone's own language (`deviceLanguage` in `src/ui/languages.ts`): its pack if installed, else an installed pack of the same language, else Android is asked for the pack. `speak()` in `src/ui/actions.ts` reads answers aloud in the same language (the browser's language on the PC), using only voices that run on the device: Chrome's online voices on the PC and Android's "-network" voices are skipped. **Hands-free** (the waveform button, in Send's place while the message box is empty; phone only) is a loop in `Composer` in `src/ui/ChatView.tsx`: listen, send what was heard, read the answer aloud, listen again. The microphone is never on while an answer is written or read aloud. It ends after a quiet moment ("no speech heard"), on End, when another chat opens, and when the app leaves the screen.
- `src/library.ts` and `modules/untethered-library`: offline libraries, of two kinds, shown in one list and searched together. **Your own files** (PDF, EPUB, text, Markdown, HTML) are read by `LibraryFiles.kt` on the phone and `pc/library.py` on the laptop, which work the same way and must be kept in step (limits, messages, index format). They list the library folder without reading contents (`books`), read new and changed files into Aislet's own SQLite FTS4 index in the app's private storage (`index`, one pass at a time, off the shared Expo queue), and search it (`search`, plain words only). A file is read again only when its size or date changes; one that has gone is forgotten; an identical copy is searched once. They never write to the library folder (the laptop makes it only when you tap Open). PDFs are read with PdfBox-Android on the phone and pypdf, in a separate time-limited process, on the laptop. The laptop's folder is `Documents/Aislet/Libraries` (`UNTETHERED_LIBRARY` overrides it for tests); only the laptop's own window may use `/api/library/*`. **Kiwix libraries:** the native module wraps Kiwix's reader (`org.kiwix:libkiwix`, GPL-3.0) to search Kiwix `.zim` files on the phone. For each question the app looks for overview articles by title, runs Kiwix's full-text search, picks the best passages (by meaning when an embedding model is available, otherwise by shared words) and puts up to three in the prompt. Libraries live in `Aislet/Libraries` on the phone (`Untethered/Libraries`, from before the rename, is still read where it is). Reading them, and moving Kiwix's own files out of `Android/media/org.kiwix.kiwixmobile` (which Android deletes with Kiwix), needs "All files access". The app's own folder `Android/data/app.untethered.assistant/files/libraries` works without it. The PC has no Kiwix libraries yet: Smart App Control blocks the unsigned libzim DLL, so `pip install libzim` can't load on Windows. It lists `.zim` files with a message saying so.
- `pc/hub.py`: the laptop hub. It serves the PC app on :8766 and handles sync, Ollama passthrough and PDF text. It runs on Windows, Linux and Mac (Python 3.10+, standard library, plus pypdf for PDFs). Its data folder is `%LOCALAPPDATA%\Aislet` on Windows, `~/.local/share/Aislet` on Linux (`$XDG_DATA_HOME` if set) and `~/Library/Application Support/Aislet` on a Mac. On first run it copies `hub.json` from the folder of an earlier name (`Untethered`, then `Unplugged` and `Assistant`). `pc/launch.py` opens the app in its own window, and `pc/install_shortcuts.py` adds it to the Start menu (Windows), the app menu with an autostart entry (Linux), or `~/Applications` with a LaunchAgent (Mac).
- `src/link.ts`, `pc/link.py` and `LinkCrypto.kt`: the private link between phone and hub (see the security model). `src/hub.ts` sends and checks every phone request with it; big bodies are sealed by `LinkCrypto.kt` in the native module, off the JavaScript thread. The three must give the same bytes: `python pc/tests/link_test.py` checks `pc/link.py` against `pc/tests/link_vectors.json`, `node scripts/check-link.mjs` checks the TypeScript, and `LinkCryptoTest` (`./gradlew :untethered-library:testDebugUnitTest` in the Android project) checks the Kotlin.
- `src/pairLink.ts` and `src/ui/ScanPair.tsx`: pairing by QR code. The computer's Settings → Home shows a QR code of `aislet://pair?u=<address>&c=<code>&s=<salt>` (`src/ui/PairQr.tsx`, drawn with `toqr`), which the phone scans inside the app (Settings → Home, or the welcome screen) with `expo-camera`. ML Kit's model is bundled, so scanning is offline; `plugins/withScannerOffline.js` removes the request for Play services to download its separate scanner. `src/ui/PairPrompt.tsx` only says where to scan when an `aislet://pair` link opens the app.
- `install/install.ps1`: the Windows installer. `install/install.sh`: the Linux and Mac installer. It puts the app, and its own Python environment for pypdf, in the data folder. Linux is tested in WSL (Ubuntu 24.04); the Mac path is untested. `scripts/package.ps1` makes the release files.

## Security model

- **Search the web** (`src/webSearch.ts`, off by default): with the switch on, a message is searched when it's a question or a request and either asks for a search or is about something current (`needsWeb`), or when the globe by the message box is on. Not in a get-to-know-me chat, and not by itself for a message with a photo or file. Only the search words (`webQuery`, 200 characters at most) go to DuckDuckGo's HTML page. The phone asks DuckDuckGo itself; the PC window can't read another site, so the hub fetches it (`/api/search`: the PC's token only, one fixed address, 300 characters at most, never a general proxy). The top five results go into the prompt as quotes the AI must never take orders from, and the reply shows "Searched the web for …" and a Sources line, one link per site, opened only after the usual "Site: host" check. `node scripts/check-web.mjs` checks the parsing and when it searches (`--live` adds one real search).
- **The private link (phone ↔ hub).** Everything between the phone and the laptop is encrypted and authenticated, using only Python's standard library on the hub (Smart App Control blocks unsigned DLLs, so no `cryptography`):
  - **Key:** K = PBKDF2-HMAC-SHA256(pairing code, the hub's random 16-byte salt, 200,000 rounds). The salt is public: it's in the hub's plain `/api/hub` answer and in the QR code. The phone works K out once, when it pairs (natively on the phone), and keeps K, not the code. Phones paired before 1.0.8 kept the code: the first time the laptop accepts it, they turn it into K and drop it. New codes are 10 characters from a 31-letter alphabet (about 50 bits), so guessing one from a recorded request takes a GPU centuries; 8-character codes from before still work until the laptop makes a new one.
  - **Seal:** separate encryption and MAC keys come from K. A message is a random 16-byte iv, the plain text XORed with an HMAC-SHA256 keystream (block i = HMAC(enc, iv ‖ i)), and an HMAC-SHA256 tag over what the message is for, the iv and the ciphertext (encrypt-then-MAC).
  - **Requests:** the headers carry the time, a random nonce and an HMAC over the time, nonce, method, path and the sealed body's length (`X-Aislet-Time`, `X-Aislet-Nonce`, `X-Aislet-Sig`), so the hub refuses a stranger, a stale request or a replayed nonce before reading the body. The body is sealed for that signature, so it can't be moved to another request.
  - **Replies:** one or more sealed frames, one base64 line each, each tied to the request's signature, the HTTP status, its position and whether it's the last. The phone refuses any reply that doesn't open: a forged, replayed, reordered or cut-short reply, or a plain one from anything else on the Wi-Fi. For those it shows its own message, never the reply's. A streamed chat is one frame per line. `/api/hub`, answered sealed to the request's random nonce, is the proof that the laptop is paired.
  - **Find again** only accepts a laptop that answers with the phone's key, and asks before switching to a new address.
  - **Older phones** (which signed with the code itself) get `426` with "Update Aislet on this phone"; nothing they send is checked.
- **The PC window** is served only to this computer (127.0.0.1): the hub's files, its token and `/api/launch` are refused to the network. `launch.py` opens the window with a one-time launch code after `#l=` (stored hashed in `launch.json`, for 2 minutes), which the window trades with the hub for its token, then hides. So the token is never on a command line, and a link from a website can't replace a working token. Wrong tokens or codes from this computer never lock it out.
- **The hub** only serves files that exist in `dist/`, checks the Host and Origin headers, and refuses a stranger's request without reading its body (beyond 64 KB, it isn't read at all). A device on the network gets at most 8 connections at once, and 48 in all, and must send its headers within 15 s and its body within 300 s; this computer has its own 32 connections, so the PC window is always let in. A device is paused for 10 minutes after 10 wrong attempts. On Linux and Mac the data folder is 0700 and its files 0600.
- **What the private link doesn't do:** it isn't forward-secret (someone who later learns the code can read traffic they recorded), and a phone that kept an 8-character code from before 1.0.8 is only as strong as that code until the laptop makes a new one (Settings → Home → New code, then scan it).
- **Your own library files are only read.** Nothing in Aislet writes to, moves or deletes them (the Kiwix Move and Delete buttons are for Kiwix libraries only). Links are not followed, hidden files are skipped, and each file is checked before it's read: its type by its first bytes (a PDF must start like one, an EPUB must be a zip), its size, and an EPUB's unpacked size, file count and copy protection (a "zip bomb" is stopped by reading at most a set amount, whatever the file claims). A file that fails gets a message in Settings saying why, and never stops the others being read. Search words are reduced to plain letters and numbers, so a question can't change how the search works. `pc/tests/library_test.py` checks all of this, including that every file is byte-for-byte unchanged afterwards.
- **Pairing:** any app or website can open an `aislet://pair` link, and one that did could choose both the address and the code, so links never pair: the QR code is scanned inside the app. The scanner only accepts home-network addresses (10.x, 172.16–31.x, 192.168.x), never this phone's own, and codes in the hub's alphabet, and pairs only when the laptop proves it knows the same key. The QR code holds the code shown beside it and the public salt, so it gives away nothing the screen didn't already show.
- **Widget links:** any app or website can open an `aislet://` link, so `useWidgetLinks` acts only on exactly `aislet://new?k=<token>` or `aislet://talk?k=<token>`, where the token is a random 128-bit secret made once per install and kept in the app's private storage. Only the widget's own PendingIntents hold it. Any other link, a wrong token or anything extra is ignored, so no other app can make Aislet open the microphone.
- **Library passages** go into the prompt marked as quotes from files, with an instruction never to follow instructions written in them. The AI has no tools, so the most a hostile passage could do is mislead an answer.
- **Links in answers** open only after a prompt that shows the site on its own line; one that hides the site behind a user name (`https://google.com@other.example`) isn't opened. Only https and mailto links are offered.
- **What goes online:** downloads (AI models from Hugging Face on the phone; the app and Ollama's models on the computer), and web search if it's switched on. Settings → Privacy (`PRIVACY` in `src/ui/SettingsView.tsx`) and the README's "How private is it?" say so. Keep both true: update them whenever something new uses the network. Voice input is on-device only (`requiresOnDeviceRecognition`), and the PC has none, because browser speech recognition goes online.
- On Android, plain HTTP is allowed so the phone can reach the hub on the home network; the private link does the encrypting. Android's cloud backup is off, and data extraction rules (`plugins/withBackupOff.js`) exclude everything from device-to-device transfer too.
- **Encrypted backups:** the format is JSON. A plain header holds the app, the date and the key settings. The data is encrypted with AES-256-GCM (`expo-crypto`), using a key made from the passphrase with PBKDF2-HMAC-SHA256 (200,000 iterations, a random 16-byte salt; `pbkdf2Sha256` in `src/crypto.ts`, checked against Node's crypto). A file is only opened with 100,000 to 2,000,000 iterations and a 16-byte salt, so a made-up one can't freeze the app. The passphrase is never stored. The key made from it is kept in the app's own storage, beside the memory it protects, so the daily backup runs without asking. A wrong passphrase fails the GCM check and is reported as such.

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
  adb install --user 0 -r release/Aislet.apk
  ```

  Use `--user 0` on phones with a second profile, such as Samsung Dual Apps or Secure Folder. Without it the app installs into every profile and shows two icons.
- **Release files:**

  ```powershell
  pwsh scripts/package.ps1
  ```

  This makes `release/aislet-pc.zip` (with a `.sha256`) and `release/Aislet.apk`. For 1.0.7 only, it also makes `untethered-pc.zip`, the same zip under the old name, for installers saved before the rename; upload it to the release too.
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
- **Library tests:** after any change to `pc/library.py`, run `python pc/tests/library_test.py` (it makes its own made-up files in a temporary folder). On Linux it also checks that links aren't followed; Windows needs symlink rights for that part. Changes to `LibraryFiles.kt` should match, and are checked on the phone by the `library_files` check.
- **Hub security tests:** after any change to `pc/hub.py`, run `pc/tests/hub_attack_test.py` against a test hub. Its first lines say how, on Windows and on Linux. Where Ollama isn't installed (for example WSL), `pc/tests/fake_ollama.py` stands in for it. All checks must pass.

## Measuring answers and speed

Before and after a change to prompts, memory, models or the engines, compare against the baseline numbers (v1.0.9: 65/87 on the laptop's `qwen3.5:9b`). Everything in `scripts/eval/` uses made-up data only.

- **Answer quality:**

  ```bash
  node scripts/eval/run.mjs --runs 3 --out eval.json
  ```

  This sends 29 made-up prompts (`scripts/eval/cases.mjs`) to Ollama and checks each answer with pass/fail rules. The checks cover:
  - knowing it is Aislet;
  - never claiming an alarm is set;
  - using memories only when relevant;
  - not inventing sources;
  - short answers with no filler;
  - drafts in their own card;
  - Get to know me.

  It builds every prompt with the app's own `src/brain.ts` and sends it with `src/engine/ollama.ts`, loaded by plain Node 22.18+ (`scripts/eval/hooks.mjs` stands in for Expo, React Native and the hub), so it needs no packages. Use `--model qwen3.5:4b` for another model and `--only <case or group>` for a few cases. A few cases can flip between runs even with fixed seeds, so treat ±2 as noise.
- **Learning:** `node scripts/eval/learning.mjs [--model qwen3.5:9b]` sends 8 made-up messages through the app's learning prompt and checks what it would save. It checks that:
  - a correction becomes a preference;
  - a new job or a move replaces the old fact;
  - a second pet doesn't replace the first;
  - one-off requests and things only the reply said aren't saved.

  The phone's default size, `qwen3.5:4b`, scored 8/8 on 18 Nov. `node scripts/eval/memory.mjs` runs the same logic without a model: replacing facts, history, and looking back at earlier chats.
- **Prompt size and laptop speed:** `node scripts/eval/speed.mjs tokens` counts the system prompt's tokens. `node scripts/eval/speed.mjs speed` times the first word and words per second. To go through a hub as the laptop's window, add `--hub http://127.0.0.1:8767 --key <local_token>`, and only ever point it at a test hub.
- **Phone:** `python scripts/eval/phone_speed.py cold|chat|memory|state` times cold starts, replies (from llama.rn's own log) and memory in the installed app. It follows the e2e etiquette: it reads the foreground app first, prints timings only and deletes its "E2E check" chats. To time the phone's own model, run `laptop-off` first and `laptop-on` afterwards. Set `ANDROID_SERIAL` when adb lists the phone twice.

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
| `chat_typing` | Typed text shows in the message box. The box and Send stay above the keyboard, and the tabs hide while typing. Long text grows the box up to its 160 dp limit, and it shrinks again when cleared. Back closes the attach menu without leaving the app. |
| `chat_send` | Tapping Send with the keyboard open sends the message, clears the box, and a reply arrives. |
| `web_search` | With Search the web switched on, the globe by the message box is tapped and a neutral message sent (`E2E check: latest Expo SDK version`, the only words sent to DuckDuckGo). It gets a reply that says "Searched the web for …" and has a Sources line. The switch is put back as it was, and the chat is deleted. |
| `resume` | After Android closes the app (force-stop) and it's opened again, it shows the chat that was open, and then the Notes screen when that was open. The test chat is deleted. |
| `save_note` | Save to Notes on an answer saves it as a note titled with the question. The button then shows it as saved and can't save a copy. The note holds the answer. Deleting the note frees the button again. The note and the chat are deleted afterwards. |
| `pin_chat` | Pin chat on a chat in the chat list moves it under Pinned at the top, with an Unpin chat button. It is still pinned after the app is closed and opened again. Unpin chat puts it back under its date. The chat is deleted afterwards. |
| `actions` | Asking for a made-up calendar event (`E2E check event`, 15 Jan 2030) gets a card with its name and date, and no raw action line in the chat. Asking for an alarm at 06:15 gets an alarm card, which is never tapped, because it would set a real alarm. Add to calendar opens the phone's calendar with the event filled in or, on a phone with more than one calendar app and no default, Android's "Complete action using" picker listing them. Nothing is tapped in either: Aislet is brought back to the front, which closes them, unsaved. The chat is deleted. |
| `share` | Android shares reach the app. Text shared while the app is open on another tab opens a new chat with the text in the message box, unsent. A photo shared while the app is closed starts it with the photo attached. A shared PDF is read by the laptop and attached, or, when the laptop isn't connected, the app says it needs the laptop. |
| `text_fields` | Typing shows, above the keyboard, in Memory's "Add a fact", a new note's title and text, and Settings' name and custom instructions. |
| `find_laptop` | Settings → Home shows the pairing status. When paired, Advanced → "Find again" finds the laptop with the same code and stays connected. When not paired, "Find my laptop" lists it. It never unpairs. |
| `pair_link` | A pairing link, as the laptop's QR code gives, is handled safely. A link to an address outside the home network is turned away without asking. A made-up home address (`192.168.255.254`, code `E2ETESTS`) opens the app from cold with "Pair with the laptop at …?". Cancel, and Back, leave the pairing as it was. It never pairs and never uses the real code. |
| `memory` | Two facts are added, "Tidy up" runs, and the facts are forgotten again. Suggestions are applied only when memory held nothing else; otherwise they're cancelled. |
| `performance` | Cool, Max and Balanced each switch over and show their description, then the original mode is put back. |
| `haptics` | The "Vibrate on taps" switch in Settings turns off and on, then is put back as it was. |
| `library_files` | Made-up files of your own (a Markdown note, an EPUB, a PDF, plus a fake PDF and a Word file) pushed to the app's own folder are listed in Settings → Libraries: the good ones with their type and pages or chapters, the others with a message saying why they can't be read. Asking about the made-up boiler in the note gets its made-up pressure (1.4 bar). Each file's checksum is compared before and after, to prove nothing was changed. The files and the chat are deleted afterwards. |
| `library` | A made-up library (`fixtures/e2e-library.zim`, made by `make_test_library.py`) pushed to the app's own folder shows in Settings → Libraries, and asking about its made-up lantern gets an answer with its made-up fact (42 hours). The file and the chat are deleted afterwards. Your own libraries and "All files access" are never touched. |
| `backup` | Backups turn on with a passphrase and a folder chosen in Android's picker. The file is in the backup format and doesn't contain the test fact in plain text. A wrong passphrase is refused, and the right one restores a fact forgotten after the backup. If backups were already on, it only checks "Back up now" and leaves them as they were. |
| `voice_language` | Settings → Voice lists the phone's installed offline speech packs. Back closes the menu without leaving the app. Choosing a language shows it on the row, and the setting is put back as it was. The microphone is never used. |
| `hands_free` | With the message box empty, Hands-free is in Send's place; typing swaps it for Send. When the microphone is allowed: it listens, End stops it and brings the message box back, going to the home screen stops it, and a quiet moment stops it with "no speech heard". If someone talks near the phone, the chat that starts is stopped and deleted. The check never grants microphone access itself. |
| `widget` | The widget is registered with Android. Settings → Widget → Add makes the home screen offer to add Aislet's widget; Back cancels it there, and no widget is added. Links any app could send (`aislet://talk`, `aislet://new`, a wrong token, an extra part) are ignored: the screen doesn't change and hands-free doesn't start. |
| `privacy` | Settings → Privacy lists what goes online (downloads, and web search only if switched on) and what never does. Nothing is tapped, so no browser opens. |
| `layout` | List rows on Memory and Settings line up. Titles start at one left edge and buttons end at one right edge, the same on every card. No button is stretched or off-centre on its row. |

The checks use made-up text starting "E2E" and clean up after themselves:

- The test chat is deleted.
- The backup test uses `Documents/E2E-untethered-backups`. It turns backups off again, forgets its fact and deletes the folder. It taps in Android's folder and file picker only while Aislet has that picker open.
- Shared text, photos and PDFs are removed from the message box unsent. The made-up picture and PDF are pushed to the app's own folder (`Android/data/app.untethered.assistant/files/e2e`), never the gallery, and deleted afterwards.
- Test facts are forgotten.
- Notes are never saved, except by `save_note`, which deletes its note again.
- Text added to the name and instructions boxes is deleted before they save.
- The performance mode is put back.

When a check fails, a screenshot and screen dump go to `e2e/phone/out/`, which git ignores.

`chat_send` and `memory` use the AI, so they need it ready: the laptop's AI, or a downloaded phone model. Allow a few minutes for a full run.
