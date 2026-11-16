"""Checks pc/link.py, the private link's crypto, and keeps the vectors src/link.ts is checked against.

    python pc/tests/link_test.py            # check link.py against pc/tests/link_vectors.json
    python pc/tests/link_test.py --write    # remake the vectors (only when the format changes on purpose)
    node scripts/check-link.mjs             # check src/link.ts against the same vectors

The values are made up: a fixed code, salt, times and ivs, so the vectors never change.
"""
import hashlib
import hmac
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import link  # noqa: E402

VECTORS = Path(__file__).with_name("link_vectors.json")
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


def make() -> dict:
    code, salt = "abcde-fghjk", "00112233445566778899aabbccddeeff"
    key = link.link_key(code, bytes.fromhex(salt))
    keys = link.Keys(key)
    time, nonce = "1763300000000", "0123456789abcdef0123456789abcdef"
    get_sig = link.request_signature(keys, time, nonce, "GET", "/api/hub", 0)
    body = json.dumps({"memories": [{"id": "m1", "fact": "Likes flying kites at Glimmerfold beach"}]}).encode()
    length = (len(body) + link.IV_BYTES + link.TAG_BYTES + 2) // 3 * 4
    post_sig = link.request_signature(keys, time, "fedcba9876543210fedcba9876543210", "POST", "/api/sync", length)
    wire = link.seal_request_body(keys, post_sig, body, bytes(range(16)))
    assert len(wire) == length
    reply = link.reply_frame(keys, get_sig, 200, 0, True, b'{"paired":true}', bytes(range(16, 32)))
    stream = b"".join(link.reply_frame(keys, post_sig, 200, i, last, text, bytes([i]) * 16)
                      for i, (text, last) in enumerate([(b'{"t":"a"}\n', False), (b'{"t":"b"}\n', False), (b"", True)]))
    long_plain = bytes(range(256)) * 5  # several keystream blocks, not a multiple of 32
    long_sealed = link.seal(keys, "long", long_plain, bytes([7]) * 16)
    return {
        "code": code, "salt": salt, "iterations": link.ITERATIONS, "key": key.hex(),
        "enc": keys.enc.hex(), "mac": keys.mac.hex(),
        "time": time, "nonce": nonce, "get_sig": get_sig,
        "post_nonce": "fedcba9876543210fedcba9876543210", "post_body": body.decode(), "post_length": length,
        "post_sig": post_sig, "post_wire": wire.decode(),
        "reply": reply.decode(), "reply_plain": '{"paired":true}',
        "stream": stream.decode(), "stream_plain": '{"t":"a"}\n{"t":"b"}\n',
        "long_plain": long_plain.hex(), "long_sealed": link.b64(long_sealed).decode(),
    }


if "--write" in sys.argv:
    VECTORS.write_text(json.dumps(make(), indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {VECTORS}")
    sys.exit(0)

v = json.loads(VECTORS.read_text(encoding="utf-8"))
made = make()
check("vectors unchanged (link.py still makes the same bytes)", made == v,
      [k for k in v if v[k] != made.get(k)])
key = link.link_key(v["code"], bytes.fromhex(v["salt"]))
check("key is PBKDF2-HMAC-SHA256 of the cleaned code",
      key == hashlib.pbkdf2_hmac("sha256", b"ABCDEFGHJK", bytes.fromhex(v["salt"]), 200_000, 32))
keys = link.Keys(key)
check("separate keys for encrypting and authenticating", keys.enc != keys.mac and len(keys.enc) == len(keys.mac) == 32)

# The hub opens the phone's request body only for the signature it came with.
body = link.open_request_body(keys, v["post_sig"], v["post_wire"].encode())
check("request body opens", body == v["post_body"].encode())
check("request body is unreadable on the wire", b"Glimmerfold" not in v["post_wire"].encode()
      and b"Glimmerfold" not in link.unb64(v["post_wire"].encode()))
check("request body refused with another request's signature", link.open_request_body(keys, v["get_sig"], v["post_wire"].encode()) is None)
raw = bytearray(link.unb64(v["post_wire"].encode()))
raw[20] ^= 1
check("tampered request body refused", link.open_request_body(keys, v["post_sig"], link.b64(bytes(raw))) is None)
check("request body sealed with another key refused",
      link.open_request_body(link.Keys(b"\x01" * 32), v["post_sig"], v["post_wire"].encode()) is None)
check("garbage body refused", link.open_request_body(keys, v["post_sig"], b"not base64!") is None)

# The phone accepts a reply only if it's sealed for its own request, status and order, and complete.
check("reply opens", link.open_reply(keys, v["get_sig"], 200, v["reply"].encode()) == v["reply_plain"].encode())
check("reply to another request refused (replayed)", link.open_reply(keys, v["post_sig"], 200, v["reply"].encode()) is None)
check("reply with a changed status refused", link.open_reply(keys, v["get_sig"], 500, v["reply"].encode()) is None)
check("made-up plain reply refused", link.open_reply(keys, v["get_sig"], 200, b'{"app":"untethered","paired":true}') is None)
frames = v["stream"].encode().split(b"\n")[:-1]
check("streamed reply opens", link.open_reply(keys, v["post_sig"], 200, v["stream"].encode()) == v["stream_plain"].encode())
check("streamed reply cut short refused", link.open_reply(keys, v["post_sig"], 200, b"\n".join(frames[:2]) + b"\n") is None)
check("streamed reply reordered refused",
      link.open_reply(keys, v["post_sig"], 200, b"\n".join([frames[1], frames[0], frames[2]]) + b"\n") is None)
check("streamed reply with a frame dropped refused",
      link.open_reply(keys, v["post_sig"], 200, b"\n".join([frames[0], frames[2]]) + b"\n") is None)
check("long message round trip",
      link.unseal(keys, "long", link.unb64(v["long_sealed"].encode())) == bytes.fromhex(v["long_plain"]))
check("context matters", link.unseal(keys, "other", link.unb64(v["long_sealed"].encode())) is None)
check("signature covers method, path and length", len({
    link.request_signature(keys, v["time"], v["nonce"], m, p, n)
    for m, p, n in [("GET", "/api/hub", 0), ("POST", "/api/hub", 0), ("GET", "/api/tags", 0), ("GET", "/api/hub", 4)]}) == 4)
check("signature is HMAC with the MAC key", v["get_sig"] == hmac.new(
    keys.mac, f"aislet 2 request\n{v['time']}\n{v['nonce']}\nGET\n/api/hub\n0".encode(), "sha256").hexdigest())

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
