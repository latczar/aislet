// Phone: find the laptop hub on the home Wi-Fi, so nobody has to type its address.
// It asks each address on this network "is a hub here?" (/api/hub), a few at a time with short
// timeouts. Nothing secret is sent: the pairing code is only used after you pick the laptop.
import * as Network from 'expo-network';
import { HUB_PORT, hubPing, normaliseAddress } from './hub';
import { fetch } from './net';

const TIMEOUT_MS = 1000; // a hub on the same Wi-Fi answers in well under this
const AT_ONCE = 16;

function homeNetworkAddress(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}

/** Whether an Aislet hub answers at this address. Gives up after TIMEOUT_MS. */
async function isHub(address: string, cancelled: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  cancelled.addEventListener('abort', stop);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { stop(); resolve(false); }, TIMEOUT_MS);
  });
  const ask = (async () => {
    try {
      const res = await fetch(`http://${address}:${HUB_PORT}/api/hub`, { signal: controller.signal });
      if (!res.ok) return false;
      return ((await res.json()) as { app?: string })?.app === 'untethered'; // the hub's id from before the rename, kept so every version finds every other
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([ask, timeout]);
  } finally {
    clearTimeout(timer);
    cancelled.removeEventListener('abort', stop);
  }
}

/**
 * Look for laptops running the hub on this phone's Wi-Fi (the same /24 network).
 * Calls onFound for each one as it turns up; resolves with all of them when the search ends.
 */
export async function findLaptops(
  onFound: (address: string) => void,
  onProgress: (fraction: number) => void,
  cancelled: AbortSignal,
): Promise<string[]> {
  const state = await Network.getNetworkStateAsync();
  if (state.type !== Network.NetworkStateType.WIFI && state.type !== Network.NetworkStateType.ETHERNET) {
    throw new Error('Connect this phone to your home Wi-Fi first.');
  }
  const ip = await Network.getIpAddressAsync();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !homeNetworkAddress(ip)) {
    throw new Error("Couldn't read this phone's Wi-Fi address. Type the laptop's address instead.");
  }
  const parts = ip.split('.');
  const prefix = parts.slice(0, 3).join('.');
  const own = Number(parts[3]);
  // Nearest numbers first: routers often give devices in the same home neighbouring addresses.
  const hosts = Array.from({ length: 254 }, (_, i) => i + 1)
    .filter((n) => n !== own)
    .sort((x, y) => Math.abs(x - own) - Math.abs(y - own));

  const found: string[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < hosts.length && !cancelled.aborted) {
      const address = `${prefix}.${hosts[next++]}`;
      if (await isHub(address, cancelled)) {
        found.push(address);
        onFound(address);
      }
      onProgress(++done / hosts.length);
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  return found;
}

/**
 * Look on this Wi-Fi for the laptop this phone is paired with, for when its address has changed. Only a laptop that
 * answers with this phone's key counts, so it can't be someone else's. Resolves with its address, or null.
 */
export async function findOurLaptop(
  key: string,
  cancelled: AbortSignal,
  onProgress: (fraction: number) => void = () => undefined,
): Promise<string | null> {
  const stop = new AbortController();
  const cancel = () => stop.abort();
  cancelled.addEventListener('abort', cancel);
  let match: string | null = null;
  const checks: Promise<void>[] = [];
  try {
    await findLaptops(
      (address) => {
        checks.push(hubPing({ base: normaliseAddress(address), key, kind: 'phone' })
          .then((info) => {
            if (info.paired && !match) {
              match = address;
              stop.abort(); // found it: stop looking
            }
          })
          .catch(() => undefined));
      },
      onProgress,
      stop.signal,
    );
    await Promise.all(checks);
  } finally {
    cancelled.removeEventListener('abort', cancel);
  }
  return match;
}
