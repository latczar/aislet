// Pairing by QR code. The laptop (Settings → Home) shows a QR code of aislet://pair?u=<address>&c=<code>&s=<salt>,
// and the phone scans it inside Aislet (ui/ScanPair.tsx). Only that scanner pairs: any app or website can open an
// aislet:// link, and one that did could choose both the address and the code, so a link that opens the app only
// says where to scan (ui/PairPrompt.tsx).
import { APP_NAME } from './config';
import { HUB_PORT } from './hub';
import { cleanCode, isPairingCode, isSalt } from './link';

export const PAIR_SCHEME = 'aislet';

export type PairLink = { address: string; code: string; salt?: string } | { problem: string };

/** A laptop on the home network: 10.x, 172.16–31.x or 192.168.x, as the hub itself offers. */
export function isHomeAddress(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function param(query: string, name: string): string {
  for (const part of query.split('&')) {
    const [k, ...v] = part.split('=');
    if (k === name) {
      try {
        return decodeURIComponent(v.join('=').replace(/\+/g, ' ')).trim();
      } catch {
        return '';
      }
    }
  }
  return '';
}

/** The link the laptop's QR code holds. The port is left out when it's the usual one. The salt isn't secret. */
export function makePairLink(hubUrl: string, code: string, salt: string): string {
  const address = hubUrl.replace(/^https?:\/\//, '').replace(new RegExp(`:${HUB_PORT}$`), '');
  return `${PAIR_SCHEME}://pair?u=${encodeURIComponent(address)}&c=${encodeURIComponent(code)}&s=${salt}`;
}

/** Read a pairing link. Null when the link isn't one; a problem when it is but can't be used. */
export function parsePairLink(url: string): PairLink | null {
  const m = url.trim().match(/^aislet:\/\/pair\/?(?:\?(.*))?$/i);
  if (!m) return null;
  const query = (m[1] ?? '').split('#')[0];
  const address = param(query, 'u');
  const code = cleanCode(param(query, 'c'));
  const salt = param(query, 's').toLowerCase();
  const [host, port, extra] = address.split(':');
  if (!host || extra !== undefined || (port !== undefined && !/^\d{1,5}$/.test(port)) || Number(port) > 65535) {
    return { problem: "That code doesn't have a laptop address in it. Scan the code on the laptop again." };
  }
  if (!isHomeAddress(host)) {
    return { problem: `That code points to ${address}, which isn't on a home network, so ${APP_NAME} ignored it.` };
  }
  if (!isPairingCode(code) || (salt && !isSalt(salt))) {
    return { problem: "That code isn't right. Scan the code on the laptop again." };
  }
  return { address, code, ...(salt ? { salt } : {}) };
}
