// Small helpers: copy, read aloud and a gentle tap feel.
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';
import { Platform } from 'react-native';
import { speechLanguage } from './voice';

let hapticsOn = true;

/** Settings can turn the buzz off. */
export function setHaptics(on: boolean) {
  hapticsOn = on;
}

export function tap() {
  if (hapticsOn && Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

export async function copy(text: string) {
  const ok = await Clipboard.setStringAsync(text).catch(() => false);
  if (!ok && !(Platform.OS === 'web' && browserCopy(text))) throw new Error("Couldn't copy that.");
  tap();
}

/** Older way to copy in a browser, for when the clipboard permission is refused. */
function browserCopy(text: string): boolean {
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    const done = document.execCommand('copy');
    box.remove();
    return done;
  } catch {
    return false;
  }
}

/** Plain text for reading aloud: drop Markdown symbols and code blocks. */
function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '') // table rules
    .replace(/\s*\|\s*/g, ', ')
    .replace(/[*_`#>]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .trim();
}

let voices: (Speech.Voice & { localService?: boolean })[] = [];

/** A voice that runs on this device. Some voices (Chrome's "Google" ones, Android's "-network" ones) send the text
 * to a server, so they're never used. */
async function offlineVoice(language: string): Promise<string | undefined | null> {
  if (!voices.length) voices = await Speech.getAvailableVoicesAsync().catch(() => []);
  const offline = voices.filter((v) => (Platform.OS === 'web' ? v.localService === true : !/network/i.test(v.identifier)));
  const lang = language.toLowerCase();
  const same = (v: Speech.Voice) => v.language.toLowerCase().replace('_', '-');
  const pick = offline.find((v) => same(v) === lang) ?? offline.find((v) => same(v).split('-')[0] === lang.split('-')[0]);
  // On the PC a voice must be chosen, or the browser may pick an online one. Null: there's no offline voice.
  return pick?.identifier ?? (Platform.OS === 'web' ? null : undefined);
}

export function speak(text: string, onDone: () => void) {
  Speech.stop();
  const language = speechLanguage();
  offlineVoice(language).then((voice) => {
    if (voice === null) return onDone();
    Speech.speak(speakable(text), { language, voice, onDone, onStopped: onDone, onError: onDone });
  });
}

export function stopSpeaking() {
  Speech.stop();
}

/** Whether anything is being read aloud right now. */
export async function isSpeaking(): Promise<boolean> {
  return Speech.isSpeakingAsync().catch(() => false);
}
