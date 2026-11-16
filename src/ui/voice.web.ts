// PC: voice input is off. Browser speech recognition sends audio to online services, which would
// break the "stays on this device" promise.
import { deviceLanguage } from './languages';

export const voiceSupported = false;

export function useVoice(_onText: (text: string, final: boolean) => void, _onEnd?: (failed: boolean) => void) {
  return {
    listening: false, error: null as string | null, clearError: () => undefined,
    prepare: async () => false, start: async () => false, stop: () => undefined, abort: () => undefined,
  };
}

export function setVoiceLanguage(_language: string) {}

/** Read-aloud on the PC uses the browser's language. */
export function speechLanguage(): string {
  return deviceLanguage();
}

export async function offlineLanguages(): Promise<string[]> {
  return [];
}
