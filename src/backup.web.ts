// PC: no automatic backups here. The laptop already holds a copy of your memory and notes (the hub's
// data file), and Export / Import in Settings still works.
import type { Backup } from './types';

export const backupSupported = false;

export interface BackupStatus {
  on: boolean;
  folder?: string;
  last?: number;
  problem?: string;
}

const unsupported = () => Promise.reject(new Error('Automatic backups are on the phone.'));

export const folderLabel = (uri: string) => uri;
export const backupStatus = async (): Promise<BackupStatus> => ({ on: false });
export const setUpBackups = (_passphrase: string, _data: Backup): Promise<BackupStatus> => unsupported();
export const turnOffBackups = async () => undefined;
export const backUp = async (_data: Backup, _force = false): Promise<'saved' | 'not-due' | 'off'> => 'off';
export const pickBackupFile = async (): Promise<{ name: string; text: string } | null> => null;
export const openBackup = (_text: string, _passphrase: string): Promise<Backup> => unsupported();
