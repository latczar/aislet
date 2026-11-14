// Phone: talk instead of typing. Uses the phone's own speech recogniser, on-device when available.
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useRef, useState } from 'react';

export const voiceSupported = true;

export function useVoice(onText: (text: string, final: boolean) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callback = useRef(onText);
  callback.current = onText;

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('result', (e) => callback.current(e.results[0]?.transcript ?? '', e.isFinal));
  useSpeechRecognitionEvent('error', (e) => {
    setListening(false);
    if (e.error === 'no-speech' || e.error === 'aborted') return;
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
    ExpoSpeechRecognitionModule.start({
      lang: 'en-GB',
      interimResults: true,
      continuous: false,
      addsPunctuation: true,
      requiresOnDeviceRecognition: ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(),
    });
  };

  const stop = () => ExpoSpeechRecognitionModule.stop();

  return { listening, error, clearError: () => setError(null), start, stop };
}
