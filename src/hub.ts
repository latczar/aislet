// Talking to the laptop hub (pc/hub.py): pairing, sync, reading PDFs and the laptop's AI.
// The PC app is served by the hub itself and proves itself with the hub's secret token, which never leaves the
// computer. The phone uses the private link (src/link.ts): every request and reply is encrypted and
// authenticated with a key made from the pairing code, and the phone refuses any reply that doesn't prove it
// came from the hub, so nothing else on the Wi-Fi can read the data, pose as the laptop or change what it says.
import { getRandomBytes } from 'expo-crypto';
import { Platform } from 'react-native';
import { hex, utf8 } from './crypto';
import {
  IV_BYTES, LINK_VERSION, type LinkKeys, ReplyOpener, fromBase64, isSalt, linkKey, linkKeys, replyContext, requestContext,
  seal, sealedLength, signRequest, toBase64, unseal,
} from './link';
import { linkNative } from './linkNative';
import { fetch } from './net';
import type { Chat, Memory, Note } from './types';

export { isLinkKey } from './link';

export interface HubTarget {
  base: string;          // '' on the PC (same server), 'http://192.168.x.x:8766' on the phone
  key: string;           // phone: the link key (hex); PC: unused (the window keeps the hub's token itself)
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
export const UNREACHABLE = "Couldn't reach the laptop.";
const NOT_LAPTOP = "A reply that didn't come from your laptop was ignored. Check this phone is on your home Wi-Fi.";
const NOT_ACCEPTED = "Your laptop didn't accept this phone. If you made a new code on the laptop, disconnect here and pair again.";
const WRONG_CODE = "The laptop didn't accept this code. It may have a new one: check the code on the laptop.";
const UPDATE_LAPTOP = 'Update Aislet on your laptop to use it with this phone.';
const TOO_MANY = 'Too many wrong attempts from this phone. Wait 10 minutes, then try again.';
const CUT_OFF = 'The reply from your laptop was cut off. Try again.';

/** An error from the hub, or about a reply that didn't come from it. */
export class HubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** A reply from the hub: plain from this computer's own hub; opened and checked on the phone. */
export interface HubReply {
  ok: boolean;
  status: number;
  /** The whole reply. On the phone, throws unless it really came from the laptop. */
  text(): Promise<string>;
  /** The reply line by line as it arrives (a streamed chat). Throws as text() does, or if it's cut off. */
  lines(onLine: (line: string) => void): Promise<void>;
}

/** Turn "192.168.1.20" or "http://192.168.1.20" into a full hub address. */
export function normaliseAddress(input: string): string {
  let a = input.trim().replace(/\/+$/, '');
  if (!a) return '';
  if (!/^https?:\/\//.test(a)) a = `http://${a}`;
  if (!/:\d+$/.test(a.replace(/^https?:\/\//, ''))) a = `${a}:${HUB_PORT}`;
  return a;
}

/** Each line of a response as it arrives. */
export async function readLines(res: Response, onLine: (line: string) => void | Promise<void>): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) await onLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) await onLine(buffer);
}

// ---- The phone's private link ----

let cachedKeys: { key: string; keys: LinkKeys } | null = null;

function keysFor(key: string): LinkKeys {
  if (cachedKeys?.key !== key) cachedKeys = { key, keys: linkKeys(key) };
  return cachedKeys.keys;
}

// Big bodies (a PDF to read, a sync) are sealed and opened by the app's native code, off the JavaScript thread,
// so the app doesn't freeze; small ones here. Both give the same bytes (scripts/check-link.mjs, pc/tests).
const NATIVE_FROM = 4096;

async function sealBody(keys: LinkKeys, context: string, plain: Uint8Array): Promise<string> {
  const iv = getRandomBytes(IV_BYTES);
  // The text is passed as decoded from `plain`, so a stray half of an emoji becomes the same bytes in both.
  if (linkNative && plain.length >= NATIVE_FROM) return linkNative.linkSeal(keys.encHex, keys.macHex, context, hex(iv), new TextDecoder().decode(plain));
  return toBase64(seal(keys, context, plain, iv));
}

async function openFrame(keys: LinkKeys, context: string, frame: string): Promise<string | null> {
  if (linkNative && frame.length >= NATIVE_FROM) return linkNative.linkOpen(keys.encHex, keys.macHex, context, frame.trim());
  const sealed = fromBase64(frame.trim());
  const plain = sealed && unseal(keys, context, sealed);
  return plain ? new TextDecoder().decode(plain) : null;
}

/** Whether the hub at this address is one of ours, and the link version and salt it gives anyone who asks. */
async function hubHello(base: string, timeoutMs = 4000): Promise<{ v: number; salt?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      fetch(`${base}/api/hub`),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(UNREACHABLE)), timeoutMs); }),
    ]);
    const info = await res.json().catch(() => null);
    if (!res.ok || info?.app !== 'untethered') throw new Error("There's no Aislet laptop at that address.");
    return { v: typeof info.v === 'number' ? info.v : 1, salt: isSalt(info.salt) ? info.salt : undefined };
  } catch (e) {
    throw (e as Error).message.startsWith("There's no") ? e : new Error(UNREACHABLE);
  } finally {
    clearTimeout(timer);
  }
}

/** A reply that can't be opened: say why in our own words, as nothing in it can be trusted. */
async function refusal(t: HubTarget, status: number): Promise<HubError> {
  if (status === 401) {
    // The laptop doesn't know this phone's key, or it's an older hub that doesn't have the private link.
    const v = await hubHello(t.base, 2000).then((h) => h.v).catch(() => LINK_VERSION);
    return new HubError(v < LINK_VERSION ? UPDATE_LAPTOP : NOT_ACCEPTED, 401);
  }
  if (status === 429) return new HubError(TOO_MANY, 429);
  if (status >= 200 && status < 300) return new HubError(NOT_LAPTOP, status);
  return new HubError(`The laptop replied with an error (${status}).`, status);
}

async function phoneRequest(t: HubTarget, method: 'GET' | 'POST', path: string, body?: string, signal?: AbortSignal): Promise<HubReply> {
  const keys = keysFor(t.key);
  const plain = body ? utf8(body) : null;
  const { headers, sig } = signRequest(keys, method, path, plain ? sealedLength(plain.length) : 0, String(Date.now()), hex(getRandomBytes(16)));
  const wire = plain ? await sealBody(keys, requestContext(sig), plain) : undefined;
  let res: Response;
  try {
    res = (await fetch(`${t.base}${path}`, { method, headers: { 'Content-Type': 'text/plain', ...headers }, body: wire, signal })) as unknown as Response;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new HubError(UNREACHABLE, 0);
  }
  return {
    ok: res.ok,
    status: res.status,
    async text() {
      const frames = (await res.text()).split('\n').filter((l) => l.trim());
      const parts: string[] = [];
      for (let i = 0; i < frames.length; i++) {
        const part = await openFrame(keys, replyContext(sig, res.status, i, i === frames.length - 1), frames[i]);
        if (part === null) throw await refusal(t, res.status);
        parts.push(part);
      }
      if (!frames.length) throw await refusal(t, res.status);
      return parts.join('');
    },
    async lines(onLine) {
      const opener = new ReplyOpener(keys, sig, res.status);
      const decoder = new TextDecoder();
      let text = '';
      await readLines(res, async (frame) => {
        const part = opener.frame(frame);
        if (!part) throw await refusal(t, res.status);
        text += decoder.decode(part, { stream: true });
        let nl: number;
        while ((nl = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, nl);
          text = text.slice(nl + 1);
          if (line.trim()) onLine(line);
        }
      });
      text += decoder.decode();
      if (text.trim()) onLine(text);
      if (!opener.finished) throw new HubError(CUT_OFF, res.status);
    },
  };
}

// ---- The PC window ----

let launched: Promise<void> | null = null;

/**
 * PC: launch.py opens the window with a one-time code after #l=, which the window trades with the hub for its
 * token, then hides. A link from anywhere else can't change the token this window already has.
 */
function pcLaunch(): Promise<void> {
  launched ??= (async () => {
    try {
      const match = window.location.hash.match(/[#&]l=([A-Za-z0-9_-]{16,64})/);
      if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
      if (!match) return;
      const res = await globalThis.fetch('/api/launch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: match[1] }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.token === 'string') window.localStorage.setItem('hubToken', data.token);
    } catch {
      // Keep the token this window already has.
    }
  })();
  return launched;
}

function pcToken(): string {
  try {
    return window.localStorage.getItem('hubToken') ?? '';
  } catch {
    return '';
  }
}

/** Ask the hub something. On the phone, the request is sealed and the reply checked when it's read. */
export async function hubRequest(t: HubTarget, method: 'GET' | 'POST', path: string, body?: string, signal?: AbortSignal): Promise<HubReply> {
  if (t.kind === 'phone') return phoneRequest(t, method, path, body, signal);
  await pcLaunch();
  const res = (await fetch(`${t.base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Key': pcToken() }, body, signal,
  })) as unknown as Response;
  return { ok: res.ok, status: res.status, text: () => res.text(), lines: (onLine) => readLines(res, onLine) };
}

async function call<T>(t: HubTarget, path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}, timeoutMs = 8000): Promise<T> {
  const method = init.method ?? 'GET';
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const work = (async () => {
    const reply = await hubRequest(t, method, path, body);
    let data: { error?: string };
    if (t.kind === 'phone') {
      data = JSON.parse(await reply.text()); // the reply really is from the laptop, or text() threw
    } else {
      data = await reply.text().then(JSON.parse).catch(() => ({}));
      if (reply.status === 401) throw new Error(STALE_PC_KEY);
    }
    if (!reply.ok) throw new HubError(data.error || `The laptop replied with an error (${reply.status}).`, reply.status);
    return data as T;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(UNREACHABLE)), timeoutMs); });
  try {
    return await Promise.race([work, timeout]);
  } catch (e) {
    throw e instanceof SyntaxError ? new Error("The laptop's reply couldn't be read. Try again.") : e;
  } finally {
    clearTimeout(timer);
  }
}

export interface HubInfo {
  app: string;
  name: string;
  paired: boolean;
  ollama: boolean;
  starting?: boolean; // the hub has just started Ollama
}

/** Phone: a reply here proves the laptop knows this phone's key. PC: checks the window's token. */
export function hubPing(t: HubTarget): Promise<HubInfo> {
  return call<HubInfo>(t, '/api/hub', {}, 3000);
}

export function hubSync(t: HubTarget, data: SyncData): Promise<SyncData> {
  return call<SyncData>(t, '/api/sync', { method: 'POST', body: data }, 30000);
}

export async function hubExtract(t: HubTarget, name: string, base64: string): Promise<string> {
  return (await call<{ text: string }>(t, '/api/extract', { method: 'POST', body: { name, data: base64 } }, 90000)).text;
}

/**
 * Phone: pair with the laptop at `base` using the code it shows. The code is turned into the link key here, so it
 * never crosses the network, and the laptop must prove it knows the same key. `salt` comes with a scanned code;
 * otherwise the laptop is asked for it. Resolves with the key to keep (the code isn't kept).
 */
export async function pairWith(base: string, code: string, salt?: string): Promise<{ key: string; name: string }> {
  if (!salt) {
    const hello = await hubHello(base);
    if (hello.v < LINK_VERSION || !hello.salt) throw new Error(UPDATE_LAPTOP);
    salt = hello.salt;
  }
  await new Promise((resolve) => setTimeout(resolve, 30)); // lets "Pairing…" show first
  const key = linkNative ? await linkNative.linkKey(code, salt) : linkKey(code, salt);
  try {
    const info = await hubPing({ base, key, kind: 'phone' });
    return { key, name: info.name };
  } catch (e) {
    throw (e as HubError).status === 401 && (e as Error).message === NOT_ACCEPTED ? new Error(WRONG_CODE) : e;
  }
}

/** PC only: the code and address to pair a phone, and the salt the QR code carries. */
export function hubPairing(): Promise<{ code: string; salt: string; urls: string[] }> {
  return call(localHub()!, '/api/pairing');
}

/** PC only: make a new pairing code (the phone must then pair again). */
export function hubNewCode(): Promise<{ code: string; salt: string; urls: string[] }> {
  return call(localHub()!, '/api/pairing/new', { method: 'POST', body: {} });
}

/** PC only: the laptop's own library folder (list, read, search or open it). */
export function hubLibrary<T>(action: 'books' | 'index' | 'search' | 'open', body: unknown = {}, timeoutMs = 15000): Promise<T> {
  return call<T>(localHub()!, `/api/library/${action}`, { method: 'POST', body }, timeoutMs);
}

/** PC only: the laptop fetches DuckDuckGo's results page for "Search the web" (the window itself can't read it). */
export function hubSearch(query: string): Promise<{ html: string }> {
  return call<{ html: string }>(localHub()!, '/api/search', { method: 'POST', body: { query } }, 20000);
}

/** On the PC the app is served by the hub itself, so it can always talk to it. */
export function localHub(): HubTarget | null {
  return Platform.OS === 'web' ? { base: '', key: '', kind: 'pc' } : null;
}
