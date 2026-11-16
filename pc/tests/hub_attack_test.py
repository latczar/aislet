"""Attack and function tests for pc/hub.py: the private link to phones, and what a stranger might try.

Run them against a test hub with its own data folder, library folder and port, because the last checks lock a
device out of that hub for 10 minutes. Some checks must come from "the network" rather than this computer
(127.0.0.1): give this computer's own network address in UNTETHERED_LAN, or they're skipped.

On Linux (or WSL), with the stand-in for Ollama:

    python3 pc/tests/fake_ollama.py &
    export XDG_DATA_HOME=/tmp/aislet-test UNTETHERED_PORT=8768 UNTETHERED_LIBRARY=/tmp/aislet-test/Libraries
    python3 pc/hub.py &
    UNTETHERED_LAN=$(hostname -I | cut -d' ' -f1) python3 pc/tests/hub_attack_test.py /tmp/aislet-test/Aislet/hub.json pc/tests/good.pdf

In PowerShell, set $env:LOCALAPPDATA instead of XDG_DATA_HOME (the hub.json is then under it, in Aislet), and run
Ollama with qwen3.5:9b or the stand-in. Needs pypdf. The data it sends is made up and is cleaned up afterwards.
"""
import base64, http.client, json, os, secrets, socket, sys, threading, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import link  # noqa: E402

store = json.load(open(sys.argv[1], encoding="utf-8"))
CODE, SALT, TOKEN = store["code"], store["salt"], store["local_token"]
KEYS = link.Keys(link.link_key(CODE, bytes.fromhex(SALT)))
PORT = int(os.environ.get("UNTETHERED_PORT", "8766"))
LAN = os.environ.get("UNTETHERED_LAN", "")
results = []
MID, NID = (f"t-{k}-{secrets.token_hex(4)}" for k in ("m", "n"))
FACT = "Test fact from the attack script: the made-up word vellichor"


def check(name, ok, detail=""):
    ok = bool(ok)
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


def req(method, path, body=b"", headers=None, raw_headers=None, host="127.0.0.1"):
    c = http.client.HTTPConnection(host, PORT, timeout=120)
    h = {"Host": f"{host}:{PORT}", "Content-Type": "application/json", **(headers or {})}
    if raw_headers is None:
        c.request(method, path, body=body, headers=h)
    else:
        c.putrequest(method, path, skip_host=True)
        for k, v in {**h, **raw_headers}.items():
            c.putheader(k, v)
        c.endheaders(body)
    r = c.getresponse()
    return r.status, r.read()


def sign(method, path, plain=b"", keys=KEYS, stamp=None, nonce=None):
    """Headers and sealed body for a paired phone's request, and its signature."""
    t, n = str(stamp or int(time.time() * 1000)), nonce or secrets.token_hex(16)
    length = (len(plain) + link.IV_BYTES + link.TAG_BYTES + 2) // 3 * 4 if plain else 0
    sig = link.request_signature(keys, t, n, method, path, length)
    wire = link.seal_request_body(keys, sig, plain, secrets.token_bytes(16)) if plain else b""
    return {"X-Aislet-Time": t, "X-Aislet-Nonce": n, "X-Aislet-Sig": sig}, wire, sig


def phone(method, path, plain=b"", host="127.0.0.1", **kw):
    """A paired phone's request. Returns the status, the reply opened (None if it doesn't), and the raw reply."""
    headers, wire, sig = sign(method, path, plain, **kw)
    s, raw = req(method, path, wire, headers, host=host)
    return s, link.open_reply(kw.get("keys", KEYS), sig, s, raw), raw


def opened_json(plain):
    return json.loads(plain) if plain else {}


# ---- Strangers: they may only ask whether a hub is here --------------------------------------------------
s, b = req("GET", "/api/hub"); j = json.loads(b)
check("unpaired /api/hub gives only the app, version and public salt",
      s == 200 and j == {"app": "untethered", "v": 2, "salt": SALT, "paired": False}, j)
s, b = req("GET", "/%5C%5C192.0.2.9%5Cs%5Cx"); check("network-share path refused", s == 404, s)
s, b = req("GET", "/..%2F..%2Fpc%2Fhub.py"); check("path traversal gives the app page, not source", b"import secrets" not in b and s in (200, 404))
s, b = req("GET", "/C:%2FWindows%2Fwin.ini"); check("drive path refused", s == 404, s)
s, b = req("GET", "/api/pairing"); check("pairing needs credentials", s == 401, s)
s, b = req("GET", "/api/pairing", headers={"X-Key": TOKEN}); j = json.loads(b)
check("PC token can read pairing (code and salt)", s == 200 and j["code"] == CODE and j["salt"] == SALT)
s, plain, raw = phone("GET", "/api/pairing"); check("phone can't read pairing code", s == 403 and b"error" in plain, s)

# ---- The private link -------------------------------------------------------------------------------------
s, plain, raw = phone("GET", "/api/hub"); j = opened_json(plain)
check("paired /api/hub is sealed to the request and proves the hub knows the key", s == 200 and j.get("paired") is True and j.get("name"), j)
check("replies are unreadable on the wire", b"paired" not in raw and b"name" not in raw and b"{" not in raw, raw[:40])
s, plain, raw = phone("GET", "/api/tags"); check("signed phone request works", s == 200 and b"models" in (plain or b""), s)
check("Ollama's reply is unreadable on the wire", b"models" not in raw and b"qwen" not in raw)
headers, wire, sig = sign("GET", "/api/tags")
s1, raw1 = req("GET", "/api/tags", headers=headers)
s, b = req("GET", "/api/tags", headers=headers); check("replayed request refused", s1 == 200 and s == 401, (s1, s))
h2, _, sig2 = sign("GET", "/api/tags")
check("a reply can't be replayed to another request", link.open_reply(KEYS, sig2, 200, raw1) is None)
check("a made-up 'paired' reply doesn't open", link.open_reply(KEYS, sig, 200, b'{"app":"untethered","paired":true}') is None)
wrong = link.Keys(link.link_key("WRONGCODE2", bytes.fromhex(SALT)))
s, plain, raw = phone("GET", "/api/tags", keys=wrong); check("wrong code refused", s == 401 and plain is None, s)
s, plain, raw = phone("GET", "/api/tags", stamp=int(time.time() * 1000) - 10 * 60_000); check("stale request refused", s == 401, s)
headers, _, _ = sign("GET", "/api/tags"); headers["X-Aislet-Sig"] = headers["X-Aislet-Sig"][:-1] + ("0" if headers["X-Aislet-Sig"][-1] != "0" else "1")
s, b = req("GET", "/api/tags", headers=headers); check("tampered signature refused", s == 401, s)
headers, _, _ = sign("GET", "/api/tags"); headers["X-Aislet-Nonce"] = "short"
s, b = req("GET", "/api/tags", headers=headers); check("bad nonce refused", s == 401, s)
# A phone from before the private link signed with the code itself: it's told to update, and nothing is checked.
t, n = str(int(time.time() * 1000)), secrets.token_hex(12)
s, b = req("GET", "/api/tags", headers={"X-Time": t, "X-Nonce": n, "X-Sig": "0" * 64})
check("old-protocol request refused with 'Update Aislet on this phone'", s == 426 and b"Update Aislet on this phone" in b, (s, b[:80]))

body = json.dumps({"memories": [{"id": MID, "fact": FACT, "added": "2026-11-16", "category": "about"}],
                   "notes": [{"id": NID, "title": "T", "text": "x", "updated": 9e15}], "chats": [], "deleted": {}}).encode()
headers, wire, sig = sign("POST", "/api/sync", body)
check("sync body is unreadable on the wire", b"vellichor" not in wire and b"vellichor" not in base64.b64decode(wire))
s, raw = req("POST", "/api/sync", wire, headers); j = opened_json(link.open_reply(KEYS, sig, s, raw))
note = next((n for n in j.get("notes", []) if n["id"] == NID), {})
check("signed, sealed sync works", s == 200 and any(m["id"] == MID for m in j.get("memories", [])), s)
check("sync reply is unreadable on the wire", b"vellichor" not in raw)
check("far-future timestamps are capped", note.get("updated", 9e15) < time.time() * 1000 + 2 * 86_400_000, note.get("updated"))
nan = b'{"memories": [], "notes": [{"id": "t-nan", "updated": NaN}], "chats": [], "deleted": {}}'
s, plain, raw = phone("POST", "/api/sync", nan); check("NaN in data refused", s == 400 and plain is not None, s)
headers, wire, sig = sign("POST", "/api/sync", body); sealed = bytearray(base64.b64decode(wire)); sealed[30] ^= 1
s, raw = req("POST", "/api/sync", base64.b64encode(bytes(sealed)), headers)
check("tampered body refused", s == 400 and b"damaged" in (link.open_reply(KEYS, sig, s, raw) or b""), s)
_, other_wire, _ = sign("POST", "/api/sync", body)
headers, wire, sig = sign("POST", "/api/sync", body)
s, raw = req("POST", "/api/sync", other_wire, headers); check("body sealed for another request refused", s == 400, s)
plain_body = json.dumps({"memories": [], "notes": [], "chats": [], "deleted": {MID: 1}}).encode()
t, n = str(int(time.time() * 1000)), secrets.token_hex(16)
sig = link.request_signature(KEYS, t, n, "POST", "/api/sync", len(plain_body))
s, raw = req("POST", "/api/sync", plain_body, {"X-Aislet-Time": t, "X-Aislet-Nonce": n, "X-Aislet-Sig": sig})
check("unsealed body refused, even with a good signature", s == 400, s)
cleanup = json.dumps({"memories": [], "notes": [], "chats": [], "deleted": {MID: time.time() * 1000, NID: time.time() * 1000 + 86_400_000}}).encode()
phone("POST", "/api/sync", cleanup)
s, b = req("POST", "/api/sync", b"", headers={"X-Key": TOKEN}, raw_headers={"Content-Length": "-5"}); check("negative length refused", s == 400, s)
pdf = base64.b64encode(open(sys.argv[2], "rb").read()).decode()
s, plain, raw = phone("POST", "/api/extract", json.dumps({"name": "good.pdf", "data": pdf}).encode())
check("PDF read in a separate process, sealed both ways", s == 200 and b"Rent is due" in (plain or b"") and b"Rent" not in raw, s)
chat = json.dumps({"model": "qwen3.5:9b", "messages": [{"role": "user", "content": "Reply with just: hello"}], "stream": True, "think": False}).encode()
headers, wire, sig = sign("POST", "/api/chat", chat)
s, raw = req("POST", "/api/chat", wire, headers)
frames = [f for f in raw.split(b"\n") if f]
check("chat streams from the laptop's AI, one sealed frame per line", s == 200 and len(frames) >= 3 and link.open_reply(KEYS, sig, s, raw) is not None,
      (s, len(frames)))
check("a streamed reply cut short doesn't open", link.open_reply(KEYS, sig, s, b"\n".join(frames[:-1]) + b"\n") is None)

# ---- The laptop's own library folder: its window may list and search it; phones and strangers may not ----
s, b = req("POST", "/api/library/books", b"{}"); check("library needs credentials", s == 401, s)
s, plain, raw = phone("POST", "/api/library/books", b"{}"); check("phone can't list the laptop's files", s == 403, s)
s, plain, raw = phone("POST", "/api/library/search", json.dumps({"query": "rent"}).encode()); check("phone can't search the laptop's files", s == 403, s)
s, plain, raw = phone("POST", "/api/library/open", b"{}"); check("phone can't open folders on the laptop", s == 403, s)
s, b = req("POST", "/api/library/books", b"{}", headers={"X-Key": TOKEN}); check("PC lists its library", s == 200 and "books" in json.loads(b), s)
s, b = req("GET", "/api/library/books", headers={"X-Key": TOKEN}); check("library only answers POST", s == 404, s)
for bad in (b'{"query": 5}', b'{"query": "x", "limit": 500}', b'{"query": "x", "limit": true}', b"[]", b"not json",
            json.dumps({"query": "x" * 600}).encode()):
    s, b = req("POST", "/api/library/search", bad, headers={"X-Key": TOKEN}); check(f"bad library search refused: {bad[:24]!r}", s == 400, s)
# ---- Search the web: only the laptop's window, only DuckDuckGo, only a short query (no real search is made here) ----
s, b = req("POST", "/api/search", b'{"query": "x"}'); check("web search needs credentials", s == 401, s)
s, plain, raw = phone("POST", "/api/search", b'{"query": "x"}'); check("phone can't search through the laptop", s == 403, s)
for bad in (b'{"query": 5}', b'{"query": "   "}', b"[]", b"not json", json.dumps({"query": "x" * 301}).encode(),
            json.dumps({"url": "http://127.0.0.1:11434/api/tags"}).encode()):
    s, b = req("POST", "/api/search", bad, headers={"X-Key": TOKEN}); check(f"bad web search refused: {bad[:24]!r}", s == 400, s)
s, b = req("GET", "/api/search?q=x", headers={"X-Key": TOKEN}); check("web search only answers POST", s == 404, s)
odd = json.dumps({"query": '" OR * NEAR(rent) -x'}).encode()
s, b = req("POST", "/api/library/search", odd, headers={"X-Key": TOKEN}); check("search syntax in a question is harmless", s == 200, s)
s, b = req("POST", "/api/sync", b"{}", headers={"X-Key": TOKEN, "Origin": "http://evil.example"}); check("cross-site request refused", s == 403, s)
s, b = req("GET", "/api/hub", headers={"Host": f"evil.example:{PORT}"}); check("fake host name refused", s == 403, s)

# ---- The PC window: a one-time launch code, and nothing a web page can do locks it out ----------------------
import hub  # noqa: E402  (same data folder as the test hub, from the same settings)
code = hub.new_launch_code()
s, b = req("POST", "/api/launch", json.dumps({"code": code}).encode())
check("a launch code gets the window its token", s == 200 and json.loads(b).get("token") == TOKEN, s)
s, b = req("POST", "/api/launch", json.dumps({"code": code}).encode()); check("a launch code works only once", s == 403, s)
for _ in range(12):
    req("POST", "/api/launch", json.dumps({"code": secrets.token_urlsafe(24)}).encode())
    req("GET", "/api/pairing", headers={"X-Key": "wrong-token"})
s, b = req("GET", "/api/pairing", headers={"X-Key": TOKEN}); check("wrong tokens and codes on this computer never lock its window out", s == 200, s)

# ---- Before reading a body: strangers are turned away without the hub reading what they send ----
def head_only(headers: str) -> tuple[float, bytes]:
    """Send only a request's headers, claiming a 50 MB body, and time the reply."""
    with socket.create_connection(("127.0.0.1", PORT), timeout=10) as sock:
        started = time.monotonic()
        sock.sendall(f"POST /api/sync HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nContent-Length: 50000000\r\n{headers}\r\n".encode())
        reply = b""
        while not reply.endswith(b"}"):
            part = sock.recv(4096)
            if not part:
                break
            reply += part
        return time.monotonic() - started, reply


took, reply = head_only("")
check("a stranger's big body isn't read before refusing", took < 3 and b" 401 " in reply.split(b"\r\n")[0], (round(took, 2), reply[:20]))
h, _, _ = sign("POST", "/api/sync", b"x" * 1000, keys=wrong)
took, reply = head_only("".join(f"{k}: {v}\r\n" for k, v in h.items()))
check("a wrong signature is refused before the body is read", took < 3 and b" 401 " in reply.split(b"\r\n")[0], (round(took, 2), reply[:20]))

# ---- From the network: limits per device, slow requests closed, the lock-out, and this computer always served ----
if not LAN:
    print("note: UNTETHERED_LAN isn't set, so the checks from the network were skipped")
else:
    s, b = req("GET", "/", host=LAN); check("the PC app isn't served to the network", s == 404, s)
    s, b = req("GET", "/api/pairing", headers={"X-Key": TOKEN}, host=LAN); check("the PC token only works on the laptop itself", s == 403, s)
    s, b = req("POST", "/api/launch", json.dumps({"code": hub.new_launch_code()}).encode(), host=LAN)
    check("launch codes only work on the laptop itself", s != 200, s)
    s, plain, raw = phone("GET", "/api/hub", host=LAN); check("a phone on the network is served", s == 200 and plain, s)
    idle = [socket.create_connection((LAN, PORT), timeout=5) for _ in range(hub.PER_ADDRESS)]
    time.sleep(0.5)
    extra = socket.create_connection((LAN, PORT), timeout=5)
    try:
        dropped = extra.recv(1) == b""
    except (ConnectionResetError, socket.timeout):
        dropped = True
    extra.close()
    check(f"one device gets at most {hub.PER_ADDRESS} connections at once", dropped)
    s, b = req("GET", "/api/hub"); check("this computer is still served while the network's slots are full", s == 200, s)
    s, b = req("GET", "/api/pairing", headers={"X-Key": TOKEN}); check("the PC window still works then", s == 200, s)
    for c in idle:
        c.close()
    time.sleep(0.5)
    slow = socket.create_connection((LAN, PORT), timeout=60)
    slow.sendall(b"GET /api/hub HTTP/1.1\r\n")
    started, closed = time.monotonic(), False
    while time.monotonic() - started < hub.HEADER_SECONDS + 10:
        try:
            slow.sendall(b"X")  # a byte now and then keeps an ordinary read timeout from ever firing
            time.sleep(2)
        except OSError:
            closed = True
            break
    took = time.monotonic() - started
    slow.close()
    check(f"headers sent too slowly are cut off after {hub.HEADER_SECONDS} s", closed and took < hub.HEADER_SECONDS + 6, round(took, 1))
    # Lock-out last: 10 wrong attempts from this device, then even a correct request is paused for 10 minutes.
    # Each wrong attempt takes a second, so they go five at a time (fewer than the connections a device may have).
    for _ in range(2):
        threads = [threading.Thread(target=phone, args=("GET", "/api/tags"), kwargs={"host": LAN, "keys": wrong}) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    s, plain, raw = phone("GET", "/api/tags", host=LAN); check("lock-out after 10 wrong attempts", s == 429, s)
    s, b = req("GET", "/api/hub", host=LAN); check("plain hub check still answers during lock-out", s == 200, s)
    s, plain, raw = phone("GET", "/api/hub"); check("this computer is never locked out", s == 200 and plain, s)
print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
