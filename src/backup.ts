// Phone: automatic encrypted backups of memory and notes to a folder you pick (for example Documents,
// a memory card, or a folder you sync to another device). A backup survives uninstalling the app.
//
// Each file is JSON: a small plain header (app, date, key-derivation settings) and the data, encrypted with
// AES-256-GCM using a key made from your passphrase with PBKDF2-HMAC-SHA256. The passphrase itself is never
// stored; the key made from it is kept in the app's own storage (where your memory already lives), so
// automatic backups can run without asking. Restoring needs the passphrase.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync, getRandomBytes } from 'expo-crypto';
import { Directory, File } from 'expo-file-system';
import { fromHex, hex, pbkdf2Sha256, sha256, utf8 } from './crypto';
import type { Backup } from './types';

export const backupSupported = true;

const CONFIG_KEY = 'backup-config';
const ITERATIONS = 200_000;
const KEEP = 7;                          // newest backups kept in the folder
const EVERY = 20 * 60 * 60 * 1000;       // about once a day (a little under, so a morning habit keeps it daily)
const NAME = /^(aislet|untethered)-backup-\d{4}-\d{2}-\d{2}-\d{4}( \(\d+\))?\.json$/; // untethered: before the rename
/** "2026-11-16-0930…" from a backup's file name, old name or new. */
const dated = (name: string) => name.replace(/^(aislet|untethered)-backup-/, '');
const FORMAT = 'untethered-backup'; // the file format's id, unchanged by the rename so old backups still open
// Opens the folder picker in Documents, a sensible home for backups.
const DOCUMENTS = 'content://com.android.externalstorage.documents/document/primary%3ADocuments';

interface Config {
  folder: string;     // the picked folder (a content:// tree URI the app keeps access to)
  salt: string;       // hex
  iterations: number;
  key: string;        // hex: the AES key made from the passphrase
  last?: number;      // when the last backup was saved
  lastHash?: string;  // what was in it, so an unchanged day doesn't add a copy
  problem?: string;   // why the last automatic backup failed
}

export interface BackupStatus {
  on: boolean;
  folder?: string;   // a readable name, e.g. "Documents/Aislet"
  last?: number;
  problem?: string;
}

interface BackupFile {
  app: typeof FORMAT;
  version: 1;
  created: string;
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string };
  cipher: 'AES-256-GCM';
  data: string;      // base64: nonce + ciphertext + tag
}

async function loadConfig(): Promise<Config | null> {
  try {
    const raw = await AsyncStorage.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as Config) : null;
  } catch {
    return null;
  }
}

const saveConfig = (c: Config) => AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(c));

/** "Documents/Aislet" from a picked folder's URI. */
export function folderLabel(uri: string): string {
  // The folder's id is the part after /tree/, still encoded (its own slashes are %2F): "primary%3ADocuments%2FBackups".
  const raw = uri.replace(/\/+$/, '');
  const id = decodeURIComponent(raw.match(/\/tree\/([^/]+)/)?.[1] ?? raw.split('/').pop() ?? '');
  const inside = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  return inside || 'phone storage';
}

/** A file's own name from its content:// URI (the path inside the URI is encoded). */
const fileName = (uri: string) => decodeURIComponent(uri).replace(/\/+$/, '').split('/').pop() ?? '';

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** What goes in a backup: memory, notes, your name and instructions (chats stay on the phone). */
const contentHash = (b: Backup) => hex(sha256(utf8(JSON.stringify([b.name, b.instructions, b.memories, b.notes]))));

export async function backupStatus(): Promise<BackupStatus> {
  const c = await loadConfig();
  return c ? { on: true, folder: folderLabel(c.folder), last: c.last, problem: c.problem } : { on: false };
}

/** Turn backups on: choose a folder, make the key from the passphrase, and save the first backup. */
export async function setUpBackups(passphrase: string, data: Backup): Promise<BackupStatus> {
  let folder: Directory;
  try {
    folder = await Directory.pickDirectoryAsync(DOCUMENTS);
  } catch {
    throw new Error('No folder chosen, so backups are still off.');
  }
  await new Promise((r) => setTimeout(r, 60)); // let the screen redraw after the picker before the slow step
  const salt = getRandomBytes(16);
  const key = pbkdf2Sha256(utf8(passphrase), salt, ITERATIONS);
  const config: Config = { folder: folder.uri, salt: hex(salt), iterations: ITERATIONS, key: hex(key) };
  await saveConfig(config);
  await writeBackup(config, data);
  return backupStatus();
}

export async function turnOffBackups(): Promise<void> {
  await AsyncStorage.removeItem(CONFIG_KEY);
}

async function writeBackup(config: Config, data: Backup): Promise<void> {
  const key = await AESEncryptionKey.import(fromHex(config.key));
  const sealed = await aesEncryptAsync(utf8(JSON.stringify(data)), key);
  const file: BackupFile = {
    app: FORMAT, version: 1, created: new Date().toISOString(),
    kdf: { name: 'PBKDF2-SHA256', iterations: config.iterations, salt: config.salt },
    cipher: 'AES-256-GCM',
    data: (await sealed.combined('base64')) as string,
  };
  try {
    const folder = new Directory(config.folder);
    const out = folder.createFile(`aislet-backup-${stamp()}.json`, 'application/json');
    await out.write(JSON.stringify(file));
    // Keep the newest few. Only this app's backup files are ever deleted.
    const ours = folder.list().filter((f): f is File => f instanceof File && NAME.test(fileName(f.uri)))
      .sort((a, b) => dated(fileName(b.uri)).localeCompare(dated(fileName(a.uri)))); // newest first, whatever the name
    for (const old of ours.slice(KEEP)) old.delete();
  } catch {
    throw new Error("Couldn't save to the backup folder. It may have been moved or deleted; turn backups off and on again to choose it.");
  }
  await saveConfig({ ...config, last: Date.now(), lastHash: contentHash(data), problem: undefined });
}

/** Save a backup now (force), or the daily one if it's due and something changed. */
export async function backUp(data: Backup, force = false): Promise<'saved' | 'not-due' | 'off'> {
  const config = await loadConfig();
  if (!config) return 'off';
  if (!force && config.last && Date.now() - config.last < EVERY) return 'not-due';
  if (!force && config.lastHash === contentHash(data)) return 'not-due';
  try {
    await writeBackup(config, data);
    return 'saved';
  } catch (e) {
    await saveConfig({ ...config, problem: (e as Error).message });
    throw e;
  }
}

/** Choose a backup file (the picker opens in the backup folder when there is one). */
export async function pickBackupFile(): Promise<{ name: string; text: string } | null> {
  const config = await loadConfig();
  const picked = await File.pickFileAsync({ initialUri: config?.folder, mimeTypes: ['application/json', 'application/octet-stream'] })
    .catch(() => null);
  if (!picked || picked.canceled) return null;
  return { name: fileName(picked.result.uri), text: await picked.result.text() };
}

/** Open a backup file with its passphrase. */
export async function openBackup(text: string, passphrase: string): Promise<Backup> {
  let file: BackupFile;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error("That file isn't an Aislet backup.");
  }
  if (file?.app !== FORMAT || file.cipher !== 'AES-256-GCM' || file.kdf?.name !== 'PBKDF2-SHA256' || typeof file.data !== 'string') {
    throw new Error("That file isn't an Aislet backup.");
  }
  // Only settings Aislet makes: a made-up file could ask for billions of rounds and freeze the app.
  const { iterations, salt } = file.kdf;
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000 || typeof salt !== 'string' || !/^[0-9a-f]{32}$/i.test(salt)) {
    throw new Error("That file isn't an Aislet backup.");
  }
  const key = await AESEncryptionKey.import(pbkdf2Sha256(utf8(passphrase), fromHex(salt.toLowerCase()), iterations));
  let plain: Uint8Array;
  try {
    plain = (await aesDecryptAsync(AESSealedData.fromCombined(file.data), key, { output: 'bytes' })) as Uint8Array;
  } catch {
    throw new Error("That passphrase doesn't open this backup.");
  }
  return JSON.parse(new TextDecoder().decode(plain)) as Backup;
}
