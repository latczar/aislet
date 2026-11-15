// Phone: text, photos and files shared into Aislet from other apps through Android's share sheet.
// The share filters are set in app.json (the expo-sharing plugin).
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef } from 'react';
import { AppState, Linking } from 'react-native';
import { readBase64, readText } from './attach';

export const MAX_PHOTOS = 3;           // the same limit as the message box
const MAX_PDF_BYTES = 30_000_000;      // the laptop accepts up to 60 MB, and base64 adds a third
const MAX_TEXT_CHARS = 200_000;        // the chat only ever uses the first 15,000

export interface Incoming {
  text: string;                                   // goes into the message box
  images: string[];                               // base64 JPEG
  files: { name: string; text: string }[];        // text already read from the file
  pdfs: { name: string; base64: string }[];       // read by the laptop once it's connected
  notice?: string;                                // something couldn't be added
}

/** A shared photo as a JPEG no bigger than 2048 px, like the photos the message box attaches. */
async function toJpeg(uri: string): Promise<string> {
  const image = await ImageManipulator.manipulate(uri, { maxWidth: 2048, maxHeight: 2048 }).renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.6, base64: true });
  if (!saved.base64) throw new Error('no image data');
  return saved.base64;
}

const isText = (p: Sharing.SharePayload) => p.shareType === 'text' || p.shareType === 'url';

async function readShare(raw: Sharing.SharePayload[]): Promise<Incoming> {
  const out: Incoming = { text: '', images: [], files: [], pdfs: [] };
  out.text = raw.filter(isText).map((p) => p.value.trim()).filter(Boolean).join('\n\n');
  if (raw.every(isText)) return out;

  // Only files are resolved (copied into the cache). Resolving shared text would open any web link in it,
  // and nothing in Aislet goes online by itself.
  const problems: string[] = [];
  let extraPhotos = 0;
  for (const f of await Sharing.getResolvedSharedPayloadsAsync()) {
    if (!f.contentUri) continue;
    // Android gives "file:/data/…"; the file and image modules want "file:///data/…".
    const uri = f.contentUri.replace(/^file:\/(?!\/)/, 'file:///');
    const mime = (f.contentMimeType ?? f.mimeType ?? '').toLowerCase();
    const name = f.originalName || 'Shared file';
    try {
      if (mime.startsWith('image/')) {
        if (out.images.length >= MAX_PHOTOS) extraPhotos++;
        else out.images.push(await toJpeg(uri));
      } else if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
        if ((f.contentSize ?? 0) > MAX_PDF_BYTES) problems.push(`${name} is too big to read (over 30 MB).`);
        else out.pdfs.push({ name, base64: await readBase64(uri) });
      } else if (mime.startsWith('text/') || mime === 'application/json') {
        out.files.push({ name, text: (await readText(uri)).slice(0, MAX_TEXT_CHARS) });
      } else {
        problems.push(`Aislet can't read ${name}. Share a photo, a PDF or text instead.`);
      }
    } catch {
      problems.push(`Couldn't open ${name}. Try sharing it again.`);
    }
  }
  if (extraPhotos) problems.unshift(`Only the first ${MAX_PHOTOS} photos were added.`);
  if (problems.length) out.notice = problems.join(' ');
  return out;
}

/**
 * Calls `onShare` whenever something is shared into the app: at launch, and when the app comes back to the
 * front with a new share. Each share is handled once, then expo-sharing's cached copies are deleted.
 */
export function useIncomingShare(onShare: (share: Incoming) => void) {
  const handler = useRef(onShare);
  handler.current = onShare;

  useEffect(() => {
    let reading = false;
    const check = async () => {
      if (reading) return;
      let raw: Sharing.SharePayload[];
      try {
        raw = Sharing.getSharedPayloads();
      } catch {
        return;
      }
      if (!raw.length) return;
      reading = true;
      try {
        handler.current(await readShare(raw));
      } catch {
        handler.current({ text: '', images: [], files: [], pdfs: [], notice: "Couldn't open what you shared. Try sharing it again." });
      } finally {
        Sharing.clearSharedPayloads();
        reading = false;
      }
    };
    check();
    // A share while the app is already open: Android brings it to the front and expo-sharing sends a link.
    const state = AppState.addEventListener('change', (s) => { if (s === 'active') check(); });
    const link = Linking.addEventListener('url', ({ url }) => { if (url.includes('expo-sharing')) check(); });
    return () => {
      state.remove();
      link.remove();
    };
  }, []);
}
