// PC: export and import memory and notes as a file.
import * as DocumentPicker from 'expo-document-picker';
import type { Backup } from './types';

export async function exportFile(backup: Backup): Promise<void> {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `assistant-backup-${backup.exported.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function pickFile(): Promise<string | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: 'application/json' });
  if (result.canceled || !result.assets?.length) return null;
  return (await fetch(result.assets[0].uri)).text();
}
