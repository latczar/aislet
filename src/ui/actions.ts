// Small helpers: copy, read aloud and a gentle tap feel.
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';
import { Platform } from 'react-native';

export function tap() {
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

export async function copy(text: string) {
  await Clipboard.setStringAsync(text);
  tap();
}

/** Plain text for reading aloud: drop Markdown symbols and code blocks. */
function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code) ')
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
