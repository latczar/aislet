// Small helpers: copy, read aloud and a gentle tap feel.
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';
import { Platform } from 'react-native';

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

export function speak(text: string, onDone: () => void) {
  Speech.stop();
  Speech.speak(speakable(text), { language: 'en-GB', onDone, onStopped: onDone, onError: onDone });
}

export function stopSpeaking() {
  Speech.stop();
}
