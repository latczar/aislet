// The private link between the phone and the laptop hub. The hub's side is pc/link.py: both must agree byte
// for byte, and scripts/check-link.mjs checks this file against the vectors pc/tests/link_test.py makes.
//
// - The key is PBKDF2-HMAC-SHA256(pairing code, the hub's public salt, 200,000 rounds). The phone works it out
//   once, when it pairs, and keeps the key, not the code.
// - Every request and reply is encrypted (an HMAC-SHA256 keystream with a random iv) and authenticated (an HMAC
//   tag over the encrypted bytes and what the message is for). A reply is tied to the signature of the request
//   it answers, so a reply from anything that doesn't know the key, or a recorded one, is refused.
// Nothing here touches the network or picks random numbers: src/hub.ts does both.
import { HmacKey, fromHex, hex, pbkdf2Sha256, sameBytes, utf8 } from './crypto';

export const LINK_VERSION = 2;
export const LINK_ITERATIONS = 200_000;
export const IV_BYTES = 16;
const TAG_BYTES = 32;
/** The letters a pairing code uses: no 0/O, 1/I/L. */
export const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** The code as typed: case, spaces and dashes don't matter. */
export const cleanCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

/** A pairing code as the hub makes it: 10 letters (8 before the private link). */
export const isPairingCode = (code: string) => new RegExp(`^[${CODE_LETTERS}]{8}([${CODE_LETTERS}]{2})?$`).test(code);

/** A link key (64 hex characters), as opposed to the pairing code phones kept before 1.0.8. */
export const isLinkKey = (key: string) => /^[0-9a-f]{64}$/.test(key);

export const isSalt = (salt: unknown): salt is string => typeof salt === 'string' && /^[0-9a-f]{32}$/.test(salt);

/** The link key for a code and the hub's salt, as hex. Slow on purpose (about a second on a phone). */
export function linkKey(code: string, salt: string): string {
  return hex(pbkdf2Sha256(utf8(cleanCode(code)), fromHex(salt), LINK_ITERATIONS));
}

export interface LinkKeys {
  enc: HmacKey;
  mac: HmacKey;
  encHex: string; // the same keys as hex, for the app's native code
  macHex: string;
}

export function linkKeys(key: string): LinkKeys {
  const k = new HmacKey(fromHex(key));
  const enc = k.mac(utf8('aislet link 2 encrypt'));
  const mac = k.mac(utf8('aislet link 2 authenticate'));
  return { enc: new HmacKey(enc), mac: new HmacKey(mac), encHex: hex(enc), macHex: hex(mac) };
}

export function seal(keys: LinkKeys, context: string, plain: Uint8Array, iv: Uint8Array): Uint8Array {
  const data = keys.enc.xorStream(iv, plain);
  const tag = keys.mac.mac(utf8(context), iv, data);
  const out = new Uint8Array(IV_BYTES + data.length + TAG_BYTES);
  out.set(iv);
  out.set(data, IV_BYTES);
  out.set(tag, IV_BYTES + data.length);
  return out;
}

/** The plain bytes, or null if the message wasn't sealed with these keys for this context. */
export function unseal(keys: LinkKeys, context: string, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < IV_BYTES + TAG_BYTES) return null;
  const iv = sealed.subarray(0, IV_BYTES);
  const data = sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  if (!sameBytes(tag, keys.mac.mac(utf8(context), iv, data))) return null;
  return keys.enc.xorStream(iv, data);
}

export function requestSignature(keys: LinkKeys, time: string, nonce: string, method: string, path: string, length: number): string {
  return hex(keys.mac.mac(utf8(`aislet 2 request\n${time}\n${nonce}\n${method}\n${path}\n${length}`)));
}

export const requestContext = (sig: string) => `aislet 2 request body\n${sig}\n`;
export const replyContext = (sig: string, status: number, index: number, last: boolean) =>
  `aislet 2 reply\n${sig}\n${status}\n${index}\n${last ? 1 : 0}\n`;

// ---- Base64 (strict: anything else is refused) ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INDEX[B64.charCodeAt(i)] = i;

export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

export function fromBase64(text: string): Uint8Array | null {
  if (text.length % 4) return null;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const c = text.charCodeAt(i + j);
      const last = i + 4 === text.length;
      if (c === 61 && last && j >= 4 - pad) {
        n <<= 6;
        continue;
      }
      const v = c < 128 ? B64_INDEX[c] : -1;
      if (v < 0) return null;
      n = (n << 6) | v;
    }
    out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// ---- Requests and replies ----

/**
 * The length of a sealed body (base64) for `n` plain bytes. It's known before the body is sealed, so the signature
 * can cover it and the hub can check the signature before reading the body.
 */
export const sealedLength = (n: number) => Math.ceil((IV_BYTES + n + TAG_BYTES) / 3) * 4;

/** The headers that sign a request; `length` is the sealed body's (0 for none). Time in ms; nonce 32 hex. */
export function signRequest(keys: LinkKeys, method: string, path: string, length: number, time: string, nonce: string) {
  const sig = requestSignature(keys, time, nonce, method, path, length);
  return { sig, headers: { 'X-Aislet-Time': time, 'X-Aislet-Nonce': nonce, 'X-Aislet-Sig': sig } };
}

/** Headers and body for a request, all at once. `body` undefined means none (a GET). */
export function sealRequest(
  keys: LinkKeys, method: string, path: string, body: string | undefined, time: string, nonce: string, iv: Uint8Array,
): { headers: Record<string, string>; body?: string; sig: string } {
  const plain = body === undefined || body === '' ? null : utf8(body);
  const { sig, headers } = signRequest(keys, method, path, plain ? sealedLength(plain.length) : 0, time, nonce);
  return { headers, sig, body: plain ? toBase64(seal(keys, requestContext(sig), plain, iv)) : undefined };
}

/**
 * Opens a reply's frames (one base64 line each) in order. Each must be sealed for this request, its HTTP status
 * and its position; the last is marked last, so a reply that's cut short is noticed.
 */
export class ReplyOpener {
  private index = 0;
  finished = false;

  constructor(private keys: LinkKeys, private sig: string, private status: number) {}

  /** The frame's plain bytes, or null if it doesn't open. `last` is true, false, or unknown while streaming. */
  frame(line: string, last?: boolean): Uint8Array | null {
    if (this.finished) return null;
    const sealed = fromBase64(line.trim());
    if (!sealed) return null;
    for (const isLast of last === undefined ? [false, true] : [last]) {
      const plain = unseal(this.keys, replyContext(this.sig, this.status, this.index, isLast), sealed);
      if (plain) {
        this.index++;
        this.finished = isLast;
        return plain;
      }
    }
    return null;
  }
}

/** A whole reply's plain text, or null unless every frame opens and the reply is complete. */
export function openReply(keys: LinkKeys, sig: string, status: number, text: string): string | null {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const opener = new ReplyOpener(keys, sig, status);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < lines.length; i++) {
    const plain = opener.frame(lines[i], i === lines.length - 1);
    if (!plain) return null;
    parts.push(plain);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new TextDecoder().decode(all);
}
