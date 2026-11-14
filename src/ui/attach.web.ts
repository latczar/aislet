// PC: pick a photo or a document from the computer, and read it.
import * as DocumentPicker from 'expo-document-picker';

export const cameraSupported = false;

async function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(blob);
  });
}

export async function pickPhoto(_camera: boolean): Promise<string | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: ['image/jpeg', 'image/png', 'image/webp'] });
  if (result.canceled || !result.assets?.length) return null;
  return toBase64(await (await fetch(result.assets[0].uri)).blob());
}

export async function pickDocument(): Promise<{ name: string; uri: string } | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'text/plain', 'text/markdown', '.md', '.csv', '.json'] });
  if (result.canceled || !result.assets?.length) return null;
  return { name: result.assets[0].name, uri: result.assets[0].uri };
}

export const readText = async (uri: string) => (await fetch(uri)).text();
export const readBase64 = async (uri: string) => toBase64(await (await fetch(uri)).blob());
