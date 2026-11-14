// Phone: pick a photo (library or camera) or a document, and read it.
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

export const cameraSupported = true;

export async function pickPhoto(camera: boolean): Promise<string | null> {
  if (camera) {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error('Allow camera access to take a photo.');
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], base64: true, quality: 0.5 };
  const result = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled || !result.assets?.[0]?.base64) return null;
  return result.assets[0].base64;
}

export async function pickDocument(): Promise<{ name: string; uri: string } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/*'],
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.length) return null;
  return { name: result.assets[0].name, uri: result.assets[0].uri };
}

export const readText = (uri: string) => new File(uri).text();
export const readBase64 = (uri: string) => new File(uri).base64();
