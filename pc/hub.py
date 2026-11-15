"""The laptop hub: a small background service that makes phone and PC work as one app.

- Serves the PC app (dist/) at http://localhost:8766.
- Syncs memory, notes and chats with your paired phone over home Wi-Fi.
- Lets the phone use the laptop's bigger model by passing its requests to Ollama.
- Reads PDFs for both.
- Starts Ollama if it isn't running (for example, just after the computer starts).

Who may do what:
- The PC app proves itself with a secret token that launch.py passes to it (it never leaves this computer).
- A paired phone signs every request with the pairing code (HMAC-SHA256), so the code itself never
  crosses the network and a captured request can't be replayed.
- Anyone else on the network can only ask "is a hub here?".

Data lives in hub.json in the usual folder for app data: %LOCALAPPDATA%\\Untethered on Windows,
~/.local/share/Untethered on Linux ($XDG_DATA_HOME if set) and ~/Library/Application Support/Untethered on a Mac.
Errors go to hub.log next to it.
Run:  pythonw pc/hub.py      (python3 on Linux and Mac; it starts at login once install_shortcuts.py has run)
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import re
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

APP = Path(__file__).resolve().parent.parent
DIST = APP / "dist"
PORT = int(os.environ.get("UNTETHERED_PORT", "8766"))
WINDOWS, MAC = os.name == "nt", sys.platform == "darwin"


def data_dir() -> Path:
    """The usual place for an app's own data on this system."""
    if WINDOWS:
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Untethered"
    if MAC:
        return Path.home() / "Library" / "Application Support" / "Untethered"
    xdg = os.environ.get("XDG_DATA_HOME", "")
    return (Path(xdg) if os.path.isabs(xdg) else Path.home() / ".local" / "share") / "Untethered"


DATA_DIR = data_dir()
# Earlier names (Windows only); data is moved over on first run.
OLD_DATA_DIRS = [DATA_DIR.parent / "Unplugged", DATA_DIR.parent / "Assistant"] if WINDOWS else []
STORE = DATA_DIR / "hub.json"
LOG = DATA_DIR / "hub.log"
OLLAMA = ("127.0.0.1", 11434)
# Where Ollama's installer puts it when it isn't on the PATH.
OLLAMA_EXE = (Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Programs" / "Ollama" / "ollama.exe" if WINDOWS
              else Path("/Applications/Ollama.app/Contents/Resources/ollama"))
OLLAMA_GRACE = 90  # seconds Ollama gets to start before the hub tries again
TOMBSTONE_DAYS = 90
SIGNATURE_WINDOW_MS = 5 * 60_000      # a signed request must be this fresh
MAX_FAILURES, FAILURE_WINDOW = 10, 600  # wrong attempts per device before a 10-minute pause
MAX_CONNECTIONS = 48
MAX_BODY = 60_000_000
DAY_MS = 86_400_000
TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml",
    ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json",
}

lock = threading.Lock()
ollama_lock = threading.Lock()
ollama_launched = 0.0  # when the hub last started Ollama
failures: dict[str, list[float]] = {}  # device address -> times of wrong attempts
seen_signatures: dict[str, float] = {}  # signature -> when it can be forgotten


def log(message: str) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if LOG.exists() and LOG.stat().st_size > 1_000_000:
            LOG.unlink()
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass


def _no_nan(value: str):
    raise ValueError("Numbers like NaN or Infinity aren't allowed.")


def parse_json(raw: bytes):
    return json.loads(raw or b"{}", parse_constant=_no_nan)


def dump_json(data) -> str:
    return json.dumps(data, ensure_ascii=False, allow_nan=False)


# ---- Stored data -------------------------------------------------------------------------

def new_code() -> str:
    return "".join(secrets.choice("ABCDEFGHJKMNPQRSTUVWXYZ23456789") for _ in range(8))


def load_store() -> dict:
    try:
        data = parse_json(STORE.read_bytes())
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError) as e:
        log(f"hub.json unreadable, keeping a copy and starting fresh: {e}")
        STORE.replace(STORE.with_suffix(f".broken-{int(time.time())}.json"))
        data = {}
    data.setdefault("code", new_code())
    data.setdefault("local_token", secrets.token_urlsafe(32))
    for key in ("memories", "notes", "chats"):
        data.setdefault(key, [])
    data.setdefault("deleted", {})
    return data


def save_store(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(dump_json(data), encoding="utf-8")
    tmp.replace(STORE)


def _items(value) -> list[dict]:
    return [v for v in value if isinstance(v, dict) and isinstance(v.get("id"), str)] if isinstance(value, list) else []


def _strip_images(chat: dict) -> dict:
    """Photos stay on the device that took them; sync only carries the words."""
    messages = [{k: v for k, v in m.items() if k != "images"} for m in chat.get("messages", []) if isinstance(m, dict)]
    return {**chat, "messages": messages}


def _stamp(value, now: float) -> float:
    """A device's clock can be wrong: never trust a time more than a day ahead."""
    return min(float(value), now + DAY_MS) if isinstance(value, (int, float)) else 0


def merge(store: dict, incoming: dict) -> dict:
    """Combine a device's data with the hub's. Newest wins; deletions win over older copies."""
    now = time.time() * 1000
    deleted: dict[str, float] = {k: _stamp(v, now) for k, v in store["deleted"].items()
                                 if now - _stamp(v, now) < TOMBSTONE_DAYS * DAY_MS}
    for k, v in (incoming.get("deleted") or {}).items():
        if isinstance(k, str) and isinstance(v, (int, float)):
            deleted[k] = max(_stamp(v, now), deleted.get(k, 0))

    memories, seen = [], set()
    by_id = {m["id"]: m for m in _items(store["memories"])}
    for m in _items(incoming.get("memories")):
        by_id.setdefault(m["id"], m)
    for m in sorted(by_id.values(), key=lambda m: str(m.get("added", ""))):
        fact = str(m.get("fact", "")).strip()
        if not fact or m["id"] in deleted or fact.lower() in seen:
            continue
        seen.add(fact.lower())
        memories.append(m)

    def newest(mine: list[dict], theirs: list[dict]) -> list[dict]:
        merged = {x["id"]: {**x, "updated": _stamp(x.get("updated", 0), now)} for x in _items(mine)}
        for x in _items(theirs):
            x = {**x, "updated": _stamp(x.get("updated", 0), now)}
            if x["updated"] > merged.get(x["id"], {}).get("updated", -1):
                merged[x["id"]] = x
        alive = [x for x in merged.values() if deleted.get(x["id"], -1) < x["updated"]]
        return sorted(alive, key=lambda x: x["updated"], reverse=True)

    store.update(
        memories=memories,
        notes=newest(store["notes"], incoming.get("notes")),
        chats=[_strip_images(c) for c in newest(store["chats"], incoming.get("chats"))],
        deleted=deleted,
    )
    return store


# PDF text is read in a separate, time-limited process, so a hostile PDF can't hang or exhaust the hub.
_PDF_READER = r"""
import io, sys
from pypdf import PdfReader
reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()), strict=False)
if reader.is_encrypted:
    sys.exit(3)
sys.stdout.buffer.write("\n\n".join((p.extract_text() or "").strip() for p in reader.pages).encode("utf-8"))
"""


def read_document(name: str, raw: bytes) -> str:
    if not name.lower().endswith(".pdf"):
        return raw.decode("utf-8", errors="replace")
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(  # -E ignores Python environment variables; runs in our own data folder
            [sys.executable, "-E", "-c", _PDF_READER], input=raw, capture_output=True, timeout=60, cwd=str(DATA_DIR),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        raise ValueError("That PDF took too long to read. It may be very large or damaged.") from None
    if result.returncode == 3:
        raise ValueError("That PDF is password-protected, so it can't be read.")
    if result.returncode != 0:
        if b"No module named 'pypdf'" in result.stderr:
            raise ValueError("The laptop can't read PDFs yet. Run: python -m pip install --user --upgrade pypdf")
        raise ValueError("That PDF couldn't be read. It may be damaged.")
    return result.stdout.decode("utf-8", errors="replace").strip()


# ---- Ollama: the laptop's AI ---------------------------------------------------------------

def ollama_running(timeout: float = 2) -> bool:
    try:
        conn = http.client.HTTPConnection(*OLLAMA, timeout=timeout)
        conn.request("GET", "/api/version")
        return conn.getresponse().status == 200
    except OSError:
        return False


def ollama_command() -> list[str] | None:
    """Ollama's server on its own, with no window. (The Ollama app opens its chat window when started,
    which would pop up over Untethered; it still works normally if opened later.)"""
    exe = str(OLLAMA_EXE) if OLLAMA_EXE.is_file() else shutil.which("ollama")
    return [exe, "serve"] if exe else None


def start_ollama() -> bool:
    """Start Ollama when it isn't running. True while it's starting; False if it isn't installed.
    Starts it at most once every OLLAMA_GRACE seconds, however often it's asked."""
    global ollama_launched
    with ollama_lock:
        if time.time() - ollama_launched < OLLAMA_GRACE:
            return True
        command = ollama_command()
        if not command:
            return False
        try:
            subprocess.Popen(  # a fixed program with no input from requests
                command, cwd=str(Path(command[0]).parent), close_fds=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
                start_new_session=not WINDOWS,  # keeps running if the hub stops
            )
        except OSError as e:
            log(f"Couldn't start Ollama: {e}")
            return False
        ollama_launched = time.time()
        log("Ollama wasn't running, so the hub started it")
        return True


def ollama_at_login(wait: float = 30) -> None:
    """Ollama starts itself at login too; give it a head start, then start it if it still isn't up."""
    time.sleep(wait)
    if not ollama_running():
        start_ollama()


def lan_addresses() -> list[str]:
    found = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except OSError:
        pass
    # Linux often names only 127.0.1.1 for the computer's own name, so also ask which address it would use on
    # the network. Connecting a UDP socket sends nothing.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.254.254.254", 9))
            found.add(s.getsockname()[0])
    except OSError:
        pass
    ips = [ipaddress.ip_address(a) for a in found]
    home = [ip for ip in ips if ip.is_private and not ip.is_loopback and not ip.is_unspecified and not ip.is_link_local
            and ip not in ipaddress.ip_network("100.64.0.0/10")
            and not str(ip).startswith("172.")]  # skip Tailscale and WSL/Docker
    home.sort(key=lambda ip: (not str(ip).startswith("192.168."), str(ip)))
    return [str(ip) for ip in home]


# ---- The PC app's files: only real files inside dist/ are ever served ------------------------

_files: dict[str, Path] = {}
_files_scanned = 0.0


# Built files whose names carry a content hash (index-<md5>.js, Inter_400Regular.<md5>.ttf) never change, so the
# browser may keep them; a rebuild gives them new names. Everything else (index.html) is checked each time.
HASHED_NAME = re.compile(r"[.-][0-9a-f]{32}\.[A-Za-z0-9]+$")


def app_file(path: str) -> Path | None:
    """Exact match against the list of files in dist/. Never builds a path from the request,
    so tricks like \\\\other-computer\\share can't make Windows reach out to another machine."""
    global _files, _files_scanned
    if any(c in path for c in "\\:\x00"):
        return None
    rel = path.lstrip("/") or "index.html"
    if rel not in _files and time.time() - _files_scanned > 2:  # the app may have been rebuilt
        _files = {p.relative_to(DIST).as_posix(): p for p in DIST.rglob("*") if p.is_file()} if DIST.is_dir() else {}
        _files_scanned = time.time()
    return _files.get(rel) or _files.get("index.html")


# ---- Web server ----------------------------------------------------------------------------

class Server(ThreadingHTTPServer):
    daemon_threads = True
    slots = threading.BoundedSemaphore(MAX_CONNECTIONS)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):  # too many connections at once: drop this one
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "UntetheredHub/1"
    timeout = 120  # seconds a quiet connection may stay open

    def log_message(self, *args):
        pass

    def host_allowed(self) -> bool:
        """Block web pages that try to reach the hub through a fake domain name (DNS rebinding)."""
        host = urlsplit("//" + self.headers.get("Host", "")).hostname or ""
        if host == "localhost":
            return True
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            return False

    def who(self, body: bytes) -> str | None:
        """'pc', 'phone', or None. Counts a failure only when credentials were actually presented."""
        token, sig, stamp = self.headers.get("X-Key", ""), self.headers.get("X-Sig", ""), self.headers.get("X-Time", "")
        nonce = self.headers.get("X-Nonce", "")
        if not (token or sig):
            return None
        address, now = self.client_address[0], time.time()
        with lock:
            recent = [t for t in failures.get(address, []) if now - t < FAILURE_WINDOW]
            failures[address] = recent
            if len(recent) >= MAX_FAILURES:
                raise PermissionError("Too many wrong attempts from this device. Wait 10 minutes, then try again.")
            store = load_store()
            role = None
            if token and secrets.compare_digest(token, store["local_token"]):
                role = "pc"
            elif sig and stamp.isdigit() and 8 <= len(nonce) <= 64 and abs(now * 1000 - int(stamp)) <= SIGNATURE_WINDOW_MS:
                message = f"{stamp}\n{nonce}\n{self.command}\n{self.path}\n{hashlib.sha256(body).hexdigest()}".encode()
                expected = hmac.new(store["code"].encode(), message, hashlib.sha256).hexdigest()
                for s, expiry in list(seen_signatures.items()):
                    if expiry < now:
                        del seen_signatures[s]
                if secrets.compare_digest(sig, expected) and sig not in seen_signatures:
                    seen_signatures[sig] = now + SIGNATURE_WINDOW_MS / 1000 * 2  # can't be replayed
                    role = "phone"
            if role is None:
                failures[address].append(now)
        if role is None:
            time.sleep(1)  # slows down guessing
        return role

    def send_json(self, data, status: int = 200) -> None:
        body = dump_json(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("Bad request.") from None
        if length < 0 or length > MAX_BODY:
            raise ValueError("That's too big to send.")
        return self.rfile.read(length) if length else b""

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def route(self, method: str) -> None:
        try:
            if not self.host_allowed():
                return self.send_json({"error": "Unknown host."}, 403)
            path = unquote(urlsplit(self.path).path)
            if not path.startswith("/api/"):
                return self.static(path) if method == "GET" else self.send_json({"error": "Not found."}, 404)
            origin = self.headers.get("Origin")
            if method == "POST" and origin and urlsplit(origin).netloc != self.headers.get("Host"):
                return self.send_json({"error": "Blocked: request came from another site."}, 403)
            body = self.read_body() if method == "POST" else b""
            role = self.who(body)
            if path == "/api/hub":
                return self.hub_info(role)
            if role is None:
                return self.send_json({"error": "This device isn't paired. Check the code in the laptop app's Settings."}, 401)
            if path in ("/api/pairing", "/api/pairing/new"):
                if role != "pc":
                    return self.send_json({"error": "Only available on the laptop."}, 403)
                with lock:
                    store = load_store()
                    if path.endswith("/new") and method == "POST":
                        store["code"] = new_code()  # paired phones must enter the new code
                        save_store(store)
                return self.send_json({"code": store["code"], "urls": [f"http://{ip}:{PORT}" for ip in lan_addresses()]})
            if path == "/api/sync" and method == "POST":
                incoming = parse_json(body)
                with lock:
                    store = merge(load_store(), incoming if isinstance(incoming, dict) else {})
                    save_store(store)
                return self.send_json({k: store[k] for k in ("memories", "notes", "chats", "deleted")})
            if path == "/api/extract" and method == "POST":
                data = parse_json(body)
                text = read_document(str(data.get("name", "")), base64.b64decode(str(data.get("data", ""))))
                return self.send_json({"text": text[:300_000]})
            if path in ("/api/chat", "/api/embed") and method == "POST" or path == "/api/tags" and method == "GET":
                return self.proxy(method, path, body if method == "POST" else None)
            return self.send_json({"error": "Not found."}, 404)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout):
            pass
        except PermissionError as e:
            self.send_json({"error": str(e)}, 429)
        except ValueError as e:
            self.send_json({"error": str(e)}, 400)
        except Exception:
            log(traceback.format_exc())
            try:
                self.send_json({"error": "Something went wrong on the laptop. Details are in hub.log."}, 500)
            except OSError:
                pass

    def hub_info(self, role: str | None):
        ok = ollama_running()
        starting = not ok and role is not None and start_ollama()  # only paired devices can start it
        # Unpaired devices only learn that a hub is here, not the computer's name.
        self.send_json({"app": "untethered", "name": socket.gethostname() if role else "", "paired": role is not None,
                        "ollama": ok, "starting": starting})

    def proxy(self, method: str, path: str, body: bytes | None) -> None:
        """Pass a request to Ollama and stream its reply straight back."""
        try:
            conn = http.client.HTTPConnection(*OLLAMA, timeout=900)
            conn.request(method, path, body=body, headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
        except OSError:
            if ollama_running(1):
                return self.send_json({"error": "The laptop's AI didn't answer. Try again."}, 502)
            if start_ollama():
                return self.send_json({"error": "The laptop's AI is starting. Try again in a few seconds."}, 503)
            return self.send_json({"error": "Ollama isn't installed on the laptop. Get it from ollama.com."}, 502)
        self.send_response(resp.status)
        self.send_header("Content-Type", resp.getheader("Content-Type", "application/json"))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.close_connection = True
        while True:
            line = resp.readline()
            if not line:
                break
            self.wfile.write(line)
            self.wfile.flush()

    def static(self, path: str) -> None:
        file = app_file(path)
        if file is None:
            return self.send_json({"error": "Not found."}, 404)
        if not file.is_file():
            return self.send_json({"error": "The PC app hasn't been built. Run: npm run build:pc"}, 404)
        body = file.read_bytes()
        if HASHED_NAME.search(file.name):
            cache, etag = "public, max-age=31536000, immutable", None
        else:
            cache, etag = "no-cache", '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
            if self.headers.get("If-None-Match") == etag:  # unchanged since the browser last fetched it
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", cache)
                self.end_headers()
                return
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(file.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        if etag:
            self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(body)


def migrate_old_data() -> None:
    for old in OLD_DATA_DIRS:
        if old.joinpath("hub.json").exists() and not STORE.exists():
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            STORE.write_bytes(old.joinpath("hub.json").read_bytes())
            log(f"Moved data from the earlier {old.name} folder")


def main() -> int:
    migrate_old_data()
    with lock:
        save_store(load_store())  # creates the pairing code and the PC app's token on first run
    try:
        server = Server(("0.0.0.0", PORT), Handler)
    except OSError as e:
        log(f"Couldn't start on port {PORT} (already running?): {e}")
        return 1
    log(f"Hub started on port {PORT}")
    threading.Thread(target=ollama_at_login, daemon=True).start()
    print(f"Hub running: http://localhost:{PORT}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
