// SHA-256, HMAC-SHA256 and PBKDF2 in plain TypeScript (React Native has no built-in crypto).
// Used for the private link to the laptop hub (src/link.ts) and for backup passphrases.

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

/** SHA-256 fed in pieces, so a big message is never copied into one buffer. */
export class Sha256 {
  private h = new Uint32Array(IV);
  private w = new Uint32Array(64);
  private block = new Uint8Array(64);
  private used = 0;
  private length = 0;

  /** Optionally carry on from a saved state after `length` bytes (an HMAC pad). */
  constructor(state?: Uint32Array, length = 0) {
    if (state) {
      this.h.set(state);
      this.length = length;
    }
  }

  private process(bytes: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    compress(this.h, w);
  }

  update(data: Uint8Array): this {
    let i = 0;
    this.length += data.length;
    if (this.used) {
      const take = Math.min(64 - this.used, data.length);
      this.block.set(data.subarray(0, take), this.used);
      this.used += take;
      i = take;
      if (this.used < 64) return this;
      this.process(this.block, 0);
      this.used = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.process(data, i);
    if (i < data.length) {
      this.block.set(data.subarray(i));
      this.used = data.length - i;
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.length * 8;
    const tail = new Uint8Array(((this.used + 9 + 63) >> 6) << 6);
    tail.set(this.block.subarray(0, this.used));
    tail[this.used] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(tail.length - 4, bits >>> 0);
    for (let off = 0; off < tail.length; off += 64) this.process(tail, off);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    this.h.forEach((v, i) => outView.setUint32(i * 4, v));
    return out;
  }
}

/** An HMAC-SHA256 key with its pads hashed once, for many messages. */
export class HmacKey {
  private inner: Uint32Array;
  private outer: Uint32Array;
  private w = new Uint32Array(64);
  private st = new Uint32Array(8);

  constructor(key: Uint8Array) {
    const block = new Uint8Array(64);
    block.set(key.length > 64 ? sha256(key) : key);
    const pad = (x: number) => {
      const st = new Uint32Array(IV);
      for (let i = 0; i < 16; i++) {
        this.w[i] = (((block[i * 4] ^ x) << 24) | ((block[i * 4 + 1] ^ x) << 16) | ((block[i * 4 + 2] ^ x) << 8) | (block[i * 4 + 3] ^ x)) >>> 0;
      }
      compress(st, this.w);
      return st;
    };
    this.inner = pad(0x36);
    this.outer = pad(0x5c);
  }

  /** HMAC of the parts joined together. */
  mac(...parts: Uint8Array[]): Uint8Array {
    const inner = new Sha256(this.inner, 64);
    for (const part of parts) inner.update(part);
    return new Sha256(this.outer, 64).update(inner.digest()).digest();
  }

  /**
   * XOR data with the keystream HMAC(key, iv || 0), HMAC(key, iv || 1), …, where iv is 16 bytes and the
   * counter 4 bytes, big-endian. Each 32 bytes cost two SHA-256 blocks, as the message fits in one.
   */
  xorStream(iv: Uint8Array, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    const w = this.w;
    const st = this.st;
    const ivWords = [0, 1, 2, 3].map((i) => ((iv[i * 4] << 24) | (iv[i * 4 + 1] << 16) | (iv[i * 4 + 2] << 8) | iv[i * 4 + 3]) >>> 0);
    for (let pos = 0, counter = 0; pos < data.length; pos += 32, counter++) {
      st.set(this.inner);
      w[0] = ivWords[0]; w[1] = ivWords[1]; w[2] = ivWords[2]; w[3] = ivWords[3]; w[4] = counter >>> 0;
      w[5] = 0x80000000;
      for (let i = 6; i < 15; i++) w[i] = 0;
      w[15] = (64 + 20) * 8;
      compress(st, w);
      for (let i = 0; i < 8; i++) w[i] = st[i];
      w[8] = 0x80000000;
      for (let i = 9; i < 15; i++) w[i] = 0;
      w[15] = (64 + 32) * 8;
      st.set(this.outer);
      compress(st, w);
      const end = Math.min(32, data.length - pos);
      for (let i = 0; i < end; i++) out[pos + i] = data[pos + i] ^ ((st[i >> 2] >>> (24 - (i & 3) * 8)) & 0xff);
    }
    return out;
  }
}

/** Compare two byte strings in time that doesn't depend on where they differ. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
