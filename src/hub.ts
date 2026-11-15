// Talking to the laptop hub (pc/hub.py): pairing, sync and reading PDFs.
// The PC app sends the hub's secret token (it never leaves the computer). The phone signs each
// request with the pairing code (see crypto.ts), so the code itself never crosses the network.
import { Platform } from 'react-native';
import { signRequest } from './crypto';
import { fetch } from './net';
import type { Chat, Memory, Note } from './types';

export interface HubTarget {
  base: string;          // '' on the PC (same server), 'http://192.168.x.x:8766' on the phone
  key: string;           // PC: the hub token; phone: the pairing code
  kind: 'pc' | 'phone';
}

export interface SyncData {
  memories: Memory[];
  notes: Note[];
  chats: Chat[];
  deleted: Record<string, number>;
}

export const HUB_PORT = 8766;

/** The PC window's key no longer matches the hub (for example, the hub's data was reset). Reopening fetches the new one. */
export const STALE_PC_KEY = 'This window needs reconnecting to the hub. Close it and open Aislet from the Start menu.';

/** Headers that let the hub know who's asking. */
export function hubHeaders(t: Pick<HubTarget, 'key' | 'kind'>, method: string, path: string, body: string): Record<string, string> {
  if (!t.key) return {};
  return t.kind === 'pc' ? { 'X-Key': t.key } : signRequest(t.key, method, path, body);
}

/** Turn "192.168.1.20" or "http://192.168.1.20" into a full hub address. */
export function normaliseAddress(input: string): string {
  let a = input.trim().replace(/\/+$/, '');
  if (!a) return '';
  if (!/^https?:\/\//.test(a)) a = `http://${a}`;
  if (!/:\d+$/.test(a.replace(/^https?:\/\//, ''))) a = `${a}:${HUB_PORT}`;
  return a;
}

async function call<T>(t: HubTarget, path: string, init: { method?: string; body?: unknown } = {}, timeoutMs = 8000): Promise<T> {
  const method = init.method ?? 'GET';
  const body = init.body === undefined ? '' : JSON.stringify(init.body);
  const request = fetch(`${t.base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...hubHeaders(t, method, path, body) },
    body: init.body === undefined ? undefined : body,
  });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Couldn't reach the laptop.")), timeoutMs));
  const res = await Promise.race([request, timeout]);
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status === 401 && t.kind === 'pc') throw new Error(STALE_PC_KEY);
  if (!res.ok) throw new Error((data as { error?: string }).error || `The laptop replied with an error (${res.status}).`);
  return data as T;
}

export interface HubInfo {
  app: string;
  name: string;
  paired: boolean;
  ollama: boolean;
  starting?: boolean; // the hub has just started Ollama
}

export function hubPing(t: HubTarget): Promise<HubInfo> {
  return call<HubInfo>(t, '/api/hub', {}, 3000);
}

export function hubSync(t: HubTarget, data: SyncData): Promise<SyncData> {
  return call<SyncData>(t, '/api/sync', { method: 'POST', body: data }, 30000);
}

export async function hubExtract(t: HubTarget, name: string, base64: string): Promise<string> {
  return (await call<{ text: string }>(t, '/api/extract', { method: 'POST', body: { name, data: base64 } }, 90000)).text;
}

/** PC only: the address and code to type into the phone. */
export function hubPairing(): Promise<{ code: string; urls: string[] }> {
  return call(localHub()!, '/api/pairing');
}

/** PC only: make a new pairing code (the phone must then be connected again). */
export function hubNewCode(): Promise<{ code: string; urls: string[] }> {
  return call(localHub()!, '/api/pairing/new', { method: 'POST', body: {} });
}

/** PC: the token launch.py put after # in the address. Kept in this browser window, then hidden from the address. */
function pcToken(): string {
  try {
    const match = window.location.hash.match(/[#&]t=([A-Za-z0-9_-]+)/);
    if (match) {
      window.localStorage.setItem('hubToken', match[1]);
      window.history.replaceState(null, '', window.location.pathname);
    }
    return window.localStorage.getItem('hubToken') ?? '';
  } catch {
    return '';
  }
}

/** On the PC the app is served by the hub itself, so it can always talk to it. */
export function localHub(): HubTarget | null {
  return Platform.OS === 'web' ? { base: '', key: pcToken(), kind: 'pc' } : null;
}
