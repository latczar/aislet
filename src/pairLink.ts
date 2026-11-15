// Pairing by QR code. The laptop (Settings → Home) shows a QR code of untethered://pair?u=<address>&c=<code>.
// The phone's own camera opens it in Untethered, which asks before pairing: any app or website can open a link
// like this, so the address is always shown and nothing connects until the user says yes.
import { APP_NAME } from './config';
import { HUB_PORT } from './hub';

export const PAIR_SCHEME = 'untethered';
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/; // the alphabet hub.py's new_code() uses

export type PairLink = { address: string; code: string } | { problem: string };

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

/** The link the laptop's QR code holds. The port is left out when it's the usual one. */
export function makePairLink(hubUrl: string, code: string): string {
  const address = hubUrl.replace(/^https?:\/\//, '').replace(new RegExp(`:${HUB_PORT}$`), '');
  return `${PAIR_SCHEME}://pair?u=${encodeURIComponent(address)}&c=${encodeURIComponent(code)}`;
}

/** Read a pairing link. Null when the link isn't one; a problem when it is but can't be used. */
export function parsePairLink(url: string): PairLink | null {
  const m = url.match(/^untethered:\/\/pair\/?(?:\?(.*))?$/i);
  if (!m) return null;
  const query = (m[1] ?? '').split('#')[0];
  const address = param(query, 'u');
  const code = param(query, 'c').toUpperCase();
  const [host, port, extra] = address.split(':');
  if (!host || extra !== undefined || (port !== undefined && !/^\d{1,5}$/.test(port)) || Number(port) > 65535) {
    return { problem: "That pairing link doesn't have a laptop address in it. Scan the code on the laptop again." };
  }
  if (!isHomeAddress(host)) {
    return { problem: `That pairing link points to ${address}, which isn't on a home network, so ${APP_NAME} ignored it.` };
  }
  if (!CODE.test(code)) {
    return { problem: "That pairing link's code isn't right. Scan the code on the laptop again." };
  }
  return { address, code };
}
