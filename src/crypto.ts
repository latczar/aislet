// SHA-256 and HMAC-SHA256 in plain TypeScript (React Native has no built-in crypto).
// Used to sign requests to the laptop hub so the pairing code never crosses the network.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** One SHA-256 block: `w[0..15]` hold the block's words; `w[16..63]` are overwritten. Updates `h`. */
function compress(h: Uint32Array, w: Uint32Array): void {
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15], b = w[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
  h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
}

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array(IV);
  const bitLength = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    compress(h, w);
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((v, i) => outView.setUint32(i * 4, v));
  return out;
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64 + message.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(message, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

/**
 * PBKDF2-HMAC-SHA256 (RFC 8018), for turning a backup passphrase into a key. The HMAC pads are hashed
 * once, so each iteration costs two SHA-256 blocks.
 */
export function pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number, length = 32): Uint8Array {
  const key = new Uint8Array(64);
  key.set(password.length > 64 ? sha256(password) : password);
  const w = new Uint32Array(64);
  const padState = (x: number) => {
    const st = new Uint32Array(IV);
    for (let i = 0; i < 16; i++) {
      w[i] = (((key[i * 4] ^ x) << 24) | ((key[i * 4 + 1] ^ x) << 16) | ((key[i * 4 + 2] ^ x) << 8) | (key[i * 4 + 3] ^ x)) >>> 0;
    }
    compress(st, w);
    return st;
  };
  const inner = padState(0x36);
  const outer = padState(0x5c);
  const st = new Uint32Array(8);
  const u = new Uint32Array(8);
  const t = new Uint32Array(8);
  const out = new Uint8Array(length);
  const outView = new DataView(out.buffer);
  for (let block = 1, pos = 0; pos < length; block++, pos += 32) {
    const msg = new Uint8Array(salt.length + 4);
    msg.set(salt);
    new DataView(msg.buffer).setUint32(salt.length, block);
    const first = new DataView(hmacSha256(password, msg).buffer);
    for (let j = 0; j < 8; j++) u[j] = t[j] = first.getUint32(j * 4);
    for (let i = 1; i < iterations; i++) {
      // HMAC(key, u): the inner and outer messages are each one 32-byte digest after a 64-byte pad block.
      st.set(inner);
      for (let j = 0; j < 8; j++) w[j] = u[j];
      w[8] = 0x80000000; w[9] = 0; w[10] = 0; w[11] = 0; w[12] = 0; w[13] = 0; w[14] = 0; w[15] = (64 + 32) * 8;
      compress(st, w);
      for (let j = 0; j < 8; j++) w[j] = st[j];
      w[8] = 0x80000000; w[9] = 0; w[10] = 0; w[11] = 0; w[12] = 0; w[13] = 0; w[14] = 0; w[15] = (64 + 32) * 8;
      st.set(outer);
      compress(st, w);
      for (let j = 0; j < 8; j++) {
        u[j] = st[j];
        t[j] ^= st[j];
      }
    }
    for (let j = 0; j < 8 && pos + j * 4 < length; j++) {
      if (pos + j * 4 + 4 <= length) outView.setUint32(pos + j * 4, t[j]);
      else for (let k = 0; pos + j * 4 + k < length; k++) out[pos + j * 4 + k] = (t[j] >>> (24 - k * 8)) & 0xff;
    }
  }
  return out;
}

export const utf8 = (text: string) => new TextEncoder().encode(text);
export const fromHex = (text: string) => new Uint8Array((text.match(/../g) ?? []).map((b) => parseInt(b, 16)));
export const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Headers that prove we know the pairing code without sending it: HMAC over time, nonce, method, path and body. */
export function signRequest(code: string, method: string, path: string, body: string): Record<string, string> {
  const time = String(Date.now());
  const nonce = hex(Uint8Array.from({ length: 12 }, () => Math.floor(Math.random() * 256)));
  const message = `${time}\n${nonce}\n${method}\n${path}\n${hex(sha256(utf8(body)))}`;
  return { 'X-Time': time, 'X-Nonce': nonce, 'X-Sig': hex(hmacSha256(utf8(code.toUpperCase()), utf8(message))) };
}
