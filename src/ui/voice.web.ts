// PC: voice input is off. Browser speech recognition sends audio to online services, which would
// break the "stays on this device" promise.
export const voiceSupported = false;

export function useVoice(_onText: (text: string, final: boolean) => void) {
  return { listening: false, error: null as string | null, clearError: () => undefined, start: async () => undefined, stop: () => undefined };
}
