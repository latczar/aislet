import AsyncStorage from '@react-native-async-storage/async-storage';

// Everything is stored on this device only.
export const KEYS = {
  settings: 'settings',
  memories: 'memories',
  notes: 'notes',
  noteIndex: 'note-index',
  memoryIndex: 'memory-index', // meaning vectors for facts, to pick the relevant ones
  chats: 'chats',
  chat: (id: string) => `chat:${id}`,
};

export async function load<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function save(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export async function remove(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
