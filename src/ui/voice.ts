// Phone: talk instead of typing. Uses the phone's own speech recogniser, on-device only, so what you say
// stays on the phone. Phones that can't recognise speech offline get a message instead of an online recogniser.
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useRef, useState } from 'react';
import { languageName } from './languages';

export const voiceSupported = true;

const PREFERRED = 'en-GB';
let chosen = ''; // Settings → Voice language; empty means English, as installed

/** Set from Settings. Used for talking and for reading answers aloud. */
export function setVoiceLanguage(language: string) {
  chosen = language;
}

/** The language answers are read aloud in. */
export function speechLanguage(): string {
  return chosen || PREFERRED;
}

/** The languages this phone can recognise offline: its installed speech packs. */
export async function offlineLanguages(): Promise<string[]> {
  try {
    if (!ExpoSpeechRecognitionModule.supportsOnDeviceRecognition()) return [];
    const { installedLocales } = await ExpoSpeechRecognitionModule.getSupportedLocales({});
    return [...new Set(installedLocales.map((l) => l.replace('_', '-')))].sort();
  } catch {
    return [];
  }
}

/** The chosen language, or English: UK if its pack is installed, else another installed English, else UK. */
async function listeningLanguage(): Promise<string> {
  if (chosen) return chosen;
  const installed = await offlineLanguages();
  return installed.find((l) => l.toLowerCase() === 'en-gb') ?? installed.find((l) => /^en-/i.test(l)) ?? PREFERRED;
}

export function useVoice(onText: (text: string, final: boolean) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callback = useRef(onText);
  callback.current = onText;
  const lang = useRef(PREFERRED);
  const onDevice = useRef(false);

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('result', (e) => callback.current(e.results[0]?.transcript ?? '', e.isFinal));
  useSpeechRecognitionEvent('error', (e) => {
    setListening(false);
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (e.error === 'language-not-supported' && onDevice.current) {
      // The phone can do this offline but hasn't got the language pack yet: ask Android to fetch it.
      setError(`Getting the offline voice pack for ${languageName(lang.current)}…`);
      ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale: lang.current })
        .then((r) => setError(
          r.status === 'download_success'
            ? 'The offline voice pack is ready. Tap the microphone again.'
            : r.status === 'download_scheduled'
              ? 'The offline voice pack is downloading (it waits for Wi-Fi). Try the microphone again in a minute.'
              : 'Follow the prompt to download the offline voice pack, then tap the microphone again.',
        ))
        .catch(() => setError(`Voice needs your phone's offline ${languageName(lang.current)} voice pack. Add it in the phone's speech recognition settings, then try again.`));
      return;
    }
    setError(
      e.error === 'network'
        ? "Voice needs your phone's offline speech pack when you're offline. Turn it on in Samsung/Google voice input settings."
        : e.error === 'not-allowed'
          ? 'Allow microphone access to talk to your assistant.'
          : `Voice input stopped: ${e.message || e.error}`,
    );
  });

  const start = async () => {
    setError(null);
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setError('Allow microphone access to talk to your assistant.');
      return;
    }
    onDevice.current = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
    if (!onDevice.current) {
      setError("This phone can't recognise speech offline, so voice is off to keep what you say on the phone. Typing works as normal.");
      return;
    }
    lang.current = await listeningLanguage();
    ExpoSpeechRecognitionModule.start({
      lang: lang.current,
      interimResults: true,
      continuous: false,
      addsPunctuation: true,
      requiresOnDeviceRecognition: true,
    });
  };

  const stop = () => ExpoSpeechRecognitionModule.stop();

  return { listening, error, clearError: () => setError(null), start, stop };
}
