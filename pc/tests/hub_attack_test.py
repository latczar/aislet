"""Attack and function tests for pc/hub.py.

Run them against a test hub with its own data folder and port, because the last check locks this
computer out of that hub for 10 minutes. In PowerShell, from the project folder:

    $env:LOCALAPPDATA = "$env:TEMP\\untethered-test"; $env:UNTETHERED_PORT = "8768"
    python pc/hub.py          # leave it running, then in a second window with the same two settings:
    python pc/tests/hub_attack_test.py "$env:TEMP\\untethered-test\\Untethered\\hub.json" pc/tests/good.pdf

Needs Ollama running with qwen3.5:9b, and pypdf. The data it sends is made up and is cleaned up afterwards.

On Linux (or WSL), the data folder follows XDG_DATA_HOME instead. Without Ollama, run the stand-in first:

    python3 pc/tests/fake_ollama.py &
    XDG_DATA_HOME=/tmp/untethered-test UNTETHERED_PORT=8768 python3 pc/hub.py &
    UNTETHERED_PORT=8768 python3 pc/tests/hub_attack_test.py /tmp/untethered-test/Untethered/hub.json pc/tests/good.pdf
"""
import base64, hashlib, hmac, http.client, json, os, secrets, sys, time

store = json.load(open(sys.argv[1], encoding="utf-8"))
CODE, TOKEN = store["code"], store["local_token"]
PORT = int(os.environ.get("UNTETHERED_PORT", "8766"))
results = []
MID, NID = (f"t-{k}-{secrets.token_hex(4)}" for k in ("m", "n"))


def req(method, path, body=b"", headers=None, raw_headers=None):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=120)
    h = {"Host": f"127.0.0.1:{PORT}", "Content-Type": "application/json", **(headers or {})}
    if raw_headers is None:
        c.request(method, path, body=body, headers=h)
    else:
        c.putrequest(method, path, skip_host=True)
        for k, v in {**h, **raw_headers}.items():
            c.putheader(k, v)
        c.endheaders(body)
    r = c.getresponse()
    return r.status, r.read()


def signed(method, path, body=b"", stamp=None, code=CODE):
    t = str(stamp or int(time.time() * 1000))
    nonce = secrets.token_hex(12)
    msg = f"{t}\n{nonce}\n{method}\n{path}\n{hashlib.sha256(body).hexdigest()}".encode()
    return {"X-Time": t, "X-Nonce": nonce, "X-Sig": hmac.new(code.encode(), msg, hashlib.sha256).hexdigest()}


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


s, b = req("GET", "/api/hub"); j = json.loads(b)
check("unpaired /api/hub hides computer name", s == 200 and j["paired"] is False and j["name"] == "")
check("unpaired devices can't start Ollama", j.get("starting") is False)
s, b = req("GET", "/%5C%5C192.0.2.9%5Cs%5Cx"); check("network-share path refused", s == 404, s)
s, b = req("GET", "/..%2F..%2Fpc%2Fhub.py"); check("path traversal gives the app page, not source", b"import secrets" not in b and s in (200, 404))
s, b = req("GET", "/C:%2FWindows%2Fwin.ini"); check("drive path refused", s == 404, s)
s, b = req("GET", "/api/pairing"); check("pairing needs credentials", s == 401, s)
s, b = req("GET", "/api/pairing", headers={"X-Key": TOKEN}); check("PC token can read pairing", s == 200 and json.loads(b)["code"] == CODE)
h = signed("GET", "/api/pairing"); s, b = req("GET", "/api/pairing", headers=h); check("phone can't read pairing code", s == 403, s)
h = signed("GET", "/api/tags"); s, b = req("GET", "/api/tags", headers=h); check("signed phone request works", s == 200 and b"models" in b, s)
s, b = req("GET", "/api/tags", headers=h); check("replayed request refused", s == 401, s)
h = signed("GET", "/api/tags", code="WRONGCOD"); s, b = req("GET", "/api/tags", headers=h); check("wrong code refused", s == 401, s)
h = signed("GET", "/api/tags", stamp=int(time.time() * 1000) - 10 * 60_000); s, b = req("GET", "/api/tags", headers=h); check("stale request refused", s == 401, s)
h = signed("GET", "/api/tags"); h["X-Sig"] = h["X-Sig"][:-1] + ("0" if h["X-Sig"][-1] != "0" else "1")
s, b = req("GET", "/api/tags", headers=h); check("tampered signature refused", s == 401, s)
body = json.dumps({"memories": [{"id": MID, "fact": "Test fact from attack script", "added": "2026-11-14", "category": "about"}],
                   "notes": [{"id": NID, "title": "T", "text": "x", "updated": 9e15}], "chats": [], "deleted": {}}).encode()
h = signed("POST", "/api/sync", body); s, b = req("POST", "/api/sync", body, headers=h); j = json.loads(b)
note = next((n for n in j["notes"] if n["id"] == NID), {})
check("signed sync works", s == 200 and any(m["id"] == MID for m in j["memories"]))
check("far-future timestamps are capped", note.get("updated", 9e15) < time.time() * 1000 + 2 * 86_400_000, note.get("updated"))
nan = b'{"memories": [], "notes": [{"id": "t-nan", "updated": NaN}], "chats": [], "deleted": {}}'
h = signed("POST", "/api/sync", nan); s, b = req("POST", "/api/sync", nan, headers=h); check("NaN in data refused", s == 400, s)
cleanup = json.dumps({"memories": [], "notes": [], "chats": [], "deleted": {MID: time.time() * 1000, NID: time.time() * 1000 + 86_400_000}}).encode()
h = signed("POST", "/api/sync", cleanup); req("POST", "/api/sync", cleanup, headers=h)
s, b = req("POST", "/api/sync", b"", headers={"X-Key": TOKEN}, raw_headers={"Content-Length": "-5"}); check("negative length refused", s == 400, s)
pdf = base64.b64encode(open(sys.argv[2], "rb").read()).decode()
body = json.dumps({"name": "good.pdf", "data": pdf}).encode()
h = signed("POST", "/api/extract", body); s, b = req("POST", "/api/extract", body, headers=h)
check("PDF read in a separate process", s == 200 and b"Rent is due" in b, b[:80])
body = json.dumps({"model": "qwen3.5:9b", "messages": [{"role": "user", "content": "Reply with just: hello"}], "stream": True, "think": False}).encode()
h = signed("POST", "/api/chat", body); s, b = req("POST", "/api/chat", body, headers=h)
check("signed chat streams from the laptop's AI", s == 200 and b.count(b"\n") >= 2, b[:60])
s, b = req("POST", "/api/sync", b"{}", headers={"X-Key": TOKEN, "Origin": "http://evil.example"}); check("cross-site request refused", s == 403, s)
s, b = req("GET", "/api/hub", headers={"Host": f"evil.example:{PORT}"}); check("fake host name refused", s == 403, s)
# Lock-out last: 10 wrong attempts from this address, then even a correct request is paused.
for _ in range(10):
    req("GET", "/api/tags", headers=signed("GET", "/api/tags", code="WRONGCOD"))
s, b = req("GET", "/api/tags", headers=signed("GET", "/api/tags")); check("lock-out after 10 wrong attempts", s == 429, s)
s, b = req("GET", "/api/hub"); check("plain hub check still answers during lock-out", s == 200, s)
print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
