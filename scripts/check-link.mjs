// Checks the phone's side of the private link (src/link.ts, src/crypto.ts) against the vectors the hub's
// side makes (pc/tests/link_test.py writes pc/tests/link_vectors.json), so the two agree byte for byte.
//   node scripts/check-link.mjs
// The TypeScript is turned into plain JavaScript in a temporary folder with the project's own TypeScript.
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbkdf2Sync } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require(join(root, 'node_modules/typescript'));
const out = mkdtempSync(join(tmpdir(), 'aislet-link-'));
writeFileSync(join(out, 'package.json'), '{"type":"commonjs"}');
for (const name of ['crypto', 'link']) {
  const source = readFileSync(join(root, 'src', `${name}.ts`), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  writeFileSync(join(out, `${name}.js`), js.outputText);
}
const link = require(join(out, 'link.js'));
const crypto = require(join(out, 'crypto.js'));
rmSync(out, { recursive: true, force: true });

const v = JSON.parse(readFileSync(join(root, 'pc/tests/link_vectors.json'), 'utf8'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`);
};
const bytes = (hexText) => Uint8Array.from(Buffer.from(hexText, 'hex'));
const iv = (fill) => new Uint8Array(16).fill(fill);

let started = Date.now();
const key = link.linkKey(v.code, v.salt);
check('link key matches the hub', key === v.key, `${Date.now() - started} ms`);
check('link key is PBKDF2 of the cleaned code', key === pbkdf2Sync('ABCDEFGHJK', Buffer.from(v.salt, 'hex'), 200000, 32, 'sha256').toString('hex'));
const keys = link.linkKeys(key);
const enc = crypto.hex(new crypto.HmacKey(bytes(v.key)).mac(crypto.utf8('aislet link 2 encrypt')));
check('encryption key matches', enc === v.enc);

const get = link.sealRequest(keys, 'GET', '/api/hub', undefined, v.time, v.nonce, iv(0));
check('GET signature matches', get.sig === v.get_sig && get.body === undefined && get.headers['X-Aislet-Sig'] === v.get_sig);
const post = link.sealRequest(keys, 'POST', '/api/sync', v.post_body, v.time, v.post_nonce, Uint8Array.from({ length: 16 }, (_, i) => i));
check('POST signature covers the sealed length', post.sig === v.post_sig);
check('sealed request body matches byte for byte', post.body === v.post_wire);
check('sealed body has the signed length', post.body.length === v.post_length);
check('request body unreadable on the wire', !post.body.includes('Glimmerfold') && !Buffer.from(post.body, 'base64').toString('latin1').includes('Glimmerfold'));

check('reply opens', link.openReply(keys, v.get_sig, 200, v.reply) === v.reply_plain);
check('reply to another request refused', link.openReply(keys, v.post_sig, 200, v.reply) === null);
check('reply with a changed status refused', link.openReply(keys, v.get_sig, 503, v.reply) === null);
check('made-up plain reply refused', link.openReply(keys, v.get_sig, 200, '{"app":"untethered","paired":true}') === null);
check('reply with another key refused', link.openReply(link.linkKeys('11'.repeat(32)), v.get_sig, 200, v.reply) === null);
const tampered = Buffer.from(v.reply.trim(), 'base64');
tampered[20] ^= 1;
check('tampered reply refused', link.openReply(keys, v.get_sig, 200, tampered.toString('base64')) === null);

const frames = v.stream.split('\n').filter(Boolean);
check('streamed reply opens', link.openReply(keys, v.post_sig, 200, v.stream) === v.stream_plain);
check('streamed reply cut short refused', link.openReply(keys, v.post_sig, 200, frames.slice(0, 2).join('\n')) === null);
check('streamed reply reordered refused', link.openReply(keys, v.post_sig, 200, [frames[1], frames[0], frames[2]].join('\n')) === null);
const opener = new link.ReplyOpener(keys, v.post_sig, 200);
const live = frames.map((f) => opener.frame(f));
check('streaming opener finds the last frame by itself', live.every(Boolean) && opener.finished
  && Buffer.concat(live.map((p) => Buffer.from(p))).toString() === v.stream_plain);
check('nothing accepted after the last frame', opener.frame(frames[0]) === null);
const early = new link.ReplyOpener(keys, v.post_sig, 200);
early.frame(frames[0]);
check('streaming opener not finished when cut short', !early.finished && early.frame(frames[2]) === null);

const sealed = link.fromBase64(v.long_sealed);
check('long message opens (keystream over many blocks)', Buffer.from(link.unseal(keys, 'long', sealed)).toString('hex') === v.long_plain);
check('long message seals to the same bytes', link.toBase64(link.seal(keys, 'long', bytes(v.long_plain), iv(7))) === v.long_sealed);
check('context matters', link.unseal(keys, 'other', sealed) === null);

for (const n of [0, 1, 2, 3, 4, 31, 32, 33, 1000]) {
  const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
  const b64 = link.toBase64(data);
  const back = link.fromBase64(b64);
  if (b64 !== Buffer.from(data).toString('base64') || !back || Buffer.compare(Buffer.from(back), Buffer.from(data))) {
    check(`base64 of ${n} bytes`, false);
  }
}
check('base64 matches Node for many lengths', true);
check('bad base64 refused', ['abc', 'ab=c', '!!!!', 'a===', 'ab\ncd'].every((t) => link.fromBase64(t) === null));

const big = new Uint8Array(3_000_000).map((_, i) => i & 255);
started = Date.now();
const bigSealed = link.seal(keys, 'big', big, iv(9));
const opened = link.unseal(keys, 'big', bigSealed);
check('3 MB sealed and opened', !!opened && Buffer.compare(Buffer.from(opened), Buffer.from(big)) === 0, `${Date.now() - started} ms`);
const sha = new crypto.Sha256();
for (let i = 0; i < big.length; i += 777) sha.update(big.subarray(i, i + 777));
check('SHA-256 in pieces matches', crypto.hex(sha.digest()) === crypto.hex(crypto.sha256(big)));
check('codes: 8 or 10 letters from the alphabet', link.isPairingCode('ABCDEFGH') && link.isPairingCode('ABCDEFGHJK')
  && !link.isPairingCode('ABCDEFGHJ') && !link.isPairingCode('ABCDEFGH0I'));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
