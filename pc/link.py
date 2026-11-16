"""The private link between a phone and the laptop hub: Python standard library only.

The phone's TypeScript side is src/link.ts. Both must agree byte for byte; pc/tests/link_test.py and
scripts/check-link.mjs check them against the same vectors (pc/tests/link_vectors.json).

- Key: K = PBKDF2-HMAC-SHA256(pairing code, the hub's random salt, 200,000 rounds, 32 bytes). The phone works
  it out once, when it pairs, and keeps K, not the code.
- From K come two keys: one to encrypt, one to authenticate (MAC).
- Encryption: an HMAC-SHA256 keystream (block i = HMAC(enc, iv || i)) with a random 16-byte iv per message.
- Each sealed message is iv || ciphertext || tag, where tag = HMAC(mac, context || iv || ciphertext)
  (encrypt-then-MAC). The context says what the message is and ties it to its request, so a sealed body
  can't be moved to another request, another position in a reply, or from a reply to a request.
- A request is signed in its headers (time, nonce, method, path, body length), so the hub can refuse a
  stranger before reading the body. Its body is one sealed message tied to that signature.
- A reply is one or more sealed frames, one per line in base64, each tied to the request's signature, the
  HTTP status, its position and whether it is the last. A reply that is cut short, reordered or made up
  fails to open.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re

VERSION = 2
ITERATIONS = 200_000
IV_BYTES = 16
TAG_BYTES = 32
CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
NONCE = re.compile(r"[0-9a-f]{32}")
SIG = re.compile(r"[0-9a-f]{64}")


def clean_code(code: str) -> str:
    """The code as typed: case, spaces and dashes don't matter."""
    return "".join(c for c in code.upper() if c not in " -")


def link_key(code: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", clean_code(code).encode(), salt, ITERATIONS, 32)


class Keys:
    def __init__(self, key: bytes):
        self.enc = hmac.digest(key, b"aislet link 2 encrypt", "sha256")
        self.mac = hmac.digest(key, b"aislet link 2 authenticate", "sha256")


def _keystream(enc: bytes, iv: bytes, n: int) -> bytes:
    return b"".join(hmac.digest(enc, iv + i.to_bytes(4, "big"), "sha256") for i in range((n + 31) // 32))[:n]


def _xor(a: bytes, b: bytes) -> bytes:
    return (int.from_bytes(a, "big") ^ int.from_bytes(b, "big")).to_bytes(len(a), "big") if a else b""


def _tag(keys: Keys, context: str, iv: bytes, data: bytes) -> bytes:
    h = hmac.new(keys.mac, context.encode(), "sha256")
    h.update(iv)
    h.update(data)
    return h.digest()


def seal(keys: Keys, context: str, plain: bytes, iv: bytes) -> bytes:
    data = _xor(plain, _keystream(keys.enc, iv, len(plain)))
    return iv + data + _tag(keys, context, iv, data)


def unseal(keys: Keys, context: str, sealed: bytes) -> bytes | None:
    """The plain text, or None if the message wasn't sealed with these keys for this context."""
    if len(sealed) < IV_BYTES + TAG_BYTES:
        return None
    iv, data, tag = sealed[:IV_BYTES], sealed[IV_BYTES:-TAG_BYTES], sealed[-TAG_BYTES:]
    if not hmac.compare_digest(tag, _tag(keys, context, iv, data)):
        return None
    return _xor(data, _keystream(keys.enc, iv, len(data)))


def request_signature(keys: Keys, time: str, nonce: str, method: str, path: str, length: int) -> str:
    message = f"aislet 2 request\n{time}\n{nonce}\n{method}\n{path}\n{length}"
    return hmac.digest(keys.mac, message.encode(), "sha256").hex()


def request_context(sig: str) -> str:
    return f"aislet 2 request body\n{sig}\n"


def reply_context(sig: str, status: int, index: int, last: bool) -> str:
    return f"aislet 2 reply\n{sig}\n{status}\n{index}\n{1 if last else 0}\n"


def b64(data: bytes) -> bytes:
    return base64.b64encode(data)


def unb64(text: bytes) -> bytes | None:
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return None


def seal_request_body(keys: Keys, sig: str, plain: bytes, iv: bytes) -> bytes:
    return b64(seal(keys, request_context(sig), plain, iv))


def open_request_body(keys: Keys, sig: str, wire: bytes) -> bytes | None:
    sealed = unb64(wire.strip())
    return None if sealed is None else unseal(keys, request_context(sig), sealed)


def reply_frame(keys: Keys, sig: str, status: int, index: int, last: bool, plain: bytes, iv: bytes) -> bytes:
    return b64(seal(keys, reply_context(sig, status, index, last), plain, iv)) + b"\n"


def open_reply(keys: Keys, sig: str, status: int, wire: bytes) -> bytes | None:
    """A whole reply's plain text, or None unless every frame opens, in order, and the last one is marked last."""
    lines = [line for line in wire.split(b"\n") if line.strip()]
    out = []
    for index, line in enumerate(lines):
        last = index == len(lines) - 1
        sealed = unb64(line.strip())
        plain = None if sealed is None else unseal(keys, reply_context(sig, status, index, last), sealed)
        if plain is None:
            return None
        out.append(plain)
    return b"".join(out) if lines else None
