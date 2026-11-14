// PC: nothing is shared into the app from other programs, so this does nothing there.
export const MAX_PHOTOS = 3;

export interface Incoming {
  text: string;
  images: string[];
  files: { name: string; text: string }[];
  pdfs: { name: string; base64: string }[];
  notice?: string;
}

export function useIncomingShare(_onShare: (share: Incoming) => void) {}
