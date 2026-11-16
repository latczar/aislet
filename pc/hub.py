"""The laptop hub: a small background service that makes phone and PC work as one app.

- Serves the PC app (dist/) at http://localhost:8766.
- Syncs memory, notes and chats with your paired phone over home Wi-Fi.
- Lets the phone use the laptop's bigger model by passing its requests to Ollama.
- Reads PDFs for both.
- Starts Ollama if it isn't running (for example, just after the computer starts).

Who may do what:
- The PC app is served only to this computer (127.0.0.1). It proves itself with a secret token, which it gets
  by trading a one-time launch code from launch.py, so the token is never in a command line or address.
- A paired phone talks over a private link (pc/link.py): every request and reply is encrypted and
  authenticated with a key made from the pairing code, and a request can't be replayed.
- Anyone else on the network can only ask "is a hub here?". Strangers are refused before their request
  body is read, each address gets a few connections at most, and this computer is always let in.

Data lives in hub.json in the usual folder for app data: %LOCALAPPDATA%\\Aislet on Windows,
~/.local/share/Aislet on Linux ($XDG_DATA_HOME if set) and ~/Library/Application Support/Aislet on a Mac.
Data from the folders of the app's earlier names (Untethered, and on Windows Unplugged and Assistant) is moved over.
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
import urllib.error
import urllib.request
from urllib.parse import unquote, urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import library  # noqa: E402 (pc/library.py, next to this file)
import link  # noqa: E402 (pc/link.py: the phone's private link)

APP = Path(__file__).resolve().parent.parent
DIST = APP / "dist"
PORT = int(os.environ.get("UNTETHERED_PORT", "8766"))
WINDOWS, MAC = os.name == "nt", sys.platform == "darwin"
if not WINDOWS:
    os.umask(0o077)  # the hub's files are for this user only (Windows keeps %LOCALAPPDATA% private already)


def data_dir() -> Path:
    """The usual place for an app's own data on this system."""
    if WINDOWS:
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Aislet"
    if MAC:
        return Path.home() / "Library" / "Application Support" / "Aislet"
    xdg = os.environ.get("XDG_DATA_HOME", "")
    return (Path(xdg) if os.path.isabs(xdg) else Path.home() / ".local" / "share") / "Aislet"


def documents_dir() -> Path:
    """The person's Documents folder (on Windows it may have been moved, for example into OneDrive)."""
    if WINDOWS:
        try:
            import ctypes
            buf = ctypes.create_unicode_buffer(260)
            if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:  # 5: My Documents
                return Path(buf.value)
        except (AttributeError, OSError):
            pass
    xdg = os.environ.get("XDG_DOCUMENTS_DIR", "")
    return Path(xdg) if os.path.isabs(xdg) else Path.home() / "Documents"


DATA_DIR = data_dir()
# Earlier names, newest first; data is moved over on first run.
OLD_DATA_DIRS = [DATA_DIR.parent / name for name in (["Untethered", "Unplugged", "Assistant"] if WINDOWS else ["Untethered"])]
STORE = DATA_DIR / "hub.json"
LOG = DATA_DIR / "hub.log"
LAUNCH = DATA_DIR / "launch.json"  # one-time codes launch.py gives the PC window, stored hashed
# Your own files for answers (PDFs, ebooks, text, web pages): read, never changed. Tests use their own folder.
LIBRARY_DIR = (Path(os.environ["UNTETHERED_LIBRARY"]) if os.environ.get("UNTETHERED_LIBRARY")
               else documents_dir() / "Aislet" / "Libraries")
OLLAMA = ("127.0.0.1", 11434)
# Where Ollama's installer puts it when it isn't on the PATH.
OLLAMA_EXE = (Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Programs" / "Ollama" / "ollama.exe" if WINDOWS
              else Path("/Applications/Ollama.app/Contents/Resources/ollama"))
OLLAMA_GRACE = 90  # seconds Ollama gets to start before the hub tries again
TOMBSTONE_DAYS = 90
SIGNATURE_WINDOW_MS = 5 * 60_000      # a signed request must be this fresh
MAX_FAILURES, FAILURE_WINDOW = 10, 600  # wrong attempts per device before a 10-minute pause
MAX_CONNECTIONS = 48       # at once from the network, of which
PER_ADDRESS = 8            # from any one device
LOCAL_CONNECTIONS = 32     # this computer's own, counted apart so the network can never use them up
HEADER_SECONDS = 15        # a device on the network must send its request's headers within this
BODY_SECONDS = 300         # and its body (up to MAX_BODY) within this
MAX_BODY = 80_000_000      # a sealed body is base64, a third bigger than what it holds
SMALL_BODY = 65_536        # a refused request's body is read and dropped only up to this
LAUNCH_SECONDS = 120       # a launch code must be used within this
OLD_PHONE = "Update Aislet on this phone to keep using it with your laptop."
# "Search the web" in the PC window: the hub fetches DuckDuckGo's results page, since the window can't read
# another site. Always this one address, with only the search words: the hub is never a general web proxy.
SEARCH_URL = "https://html.duckduckgo.com/html/"
SEARCH_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
DAY_MS = 86_400_000
TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml",
    ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json",
}

lock = threading.Lock()
ollama_lock = threading.Lock()
ollama_launched = 0.0  # when the hub last started Ollama
failures: dict[str, list[float]] = {}  # device address -> times of wrong attempts (never this computer's own)
seen_nonces: dict[str, float] = {}  # a phone request's nonce -> when it can be forgotten
_link_keys: dict[tuple[str, str], link.Keys] = {}  # (code, salt) -> keys, so PBKDF2 runs once per code


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
    """Ten characters: with PBKDF2, guessing one from a recorded request would take a GPU centuries."""
    return "".join(secrets.choice(link.CODE_LETTERS) for _ in range(10))


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
    data.setdefault("salt", secrets.token_hex(16))  # public: phones fetch it to turn the code into the link key
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


def link_keys(store: dict) -> link.Keys:
    """The phone link's keys for the current code. Call with the lock held."""
    ident = (store["code"], store["salt"])
    if ident not in _link_keys:
        _link_keys.clear()
        _link_keys[ident] = link.Keys(link.link_key(store["code"], bytes.fromhex(store["salt"])))
    return _link_keys[ident]


def is_loopback(address: str) -> bool:
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return False


def _launch_codes() -> dict[str, float]:
    try:
        codes = json.loads(LAUNCH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(codes, dict):
        return {}
    now = time.time()
    return {k: v for k, v in codes.items() if isinstance(k, str) and isinstance(v, (int, float)) and v > now}


def _save_launch_codes(codes: dict[str, float]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LAUNCH.with_suffix(f".{secrets.token_hex(4)}.tmp")
    tmp.write_text(json.dumps(codes), encoding="utf-8")
    tmp.replace(LAUNCH)


def new_launch_code() -> str:
    """For launch.py (run by this user only): a code the PC window trades once for the hub's token."""
    code = secrets.token_urlsafe(24)
    codes = _launch_codes()
    codes[hashlib.sha256(code.encode()).hexdigest()] = time.time() + LAUNCH_SECONDS
    _save_launch_codes(codes)
    return code


def use_launch_code(code: str) -> bool:
    with lock:
        codes = _launch_codes()
        found = codes.pop(hashlib.sha256(code.encode()).hexdigest(), None) is not None
        if found:
            _save_launch_codes(codes)
    return found


def make_private() -> None:
    """Linux and Mac: hub data only for this user, including files made by earlier versions."""
    if WINDOWS:
        return
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        DATA_DIR.chmod(0o700)
        for p in DATA_DIR.iterdir():
            p.chmod(0o700 if p.is_dir() else 0o600)
    except OSError as e:
        log(f"Couldn't make the data folder private: {e}")


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
# With "pages", a file path and a page limit, it reads that file and gives each page's text separately, as JSON.
_PDF_READER = r"""
import io, json, sys
from pypdf import PdfReader
pages_mode = len(sys.argv) > 3 and sys.argv[1] == "pages"
reader = PdfReader(sys.argv[2] if pages_mode else io.BytesIO(sys.stdin.buffer.read()), strict=False)
if reader.is_encrypted:
    try:
        if not reader.decrypt(""):  # many PDFs are locked only against editing, with no password to open them
            sys.exit(3)
    except Exception:
        sys.exit(3)
if pages_mode and len(reader.pages) > int(sys.argv[3]):
    sys.exit(4)
texts = [(p.extract_text() or "").strip() for p in reader.pages]
sys.stdout.buffer.write((json.dumps(texts) if pages_mode else "\n\n".join(texts)).encode("utf-8"))
"""


def run_pdf_reader(args: list[str], raw: bytes | None, timeout: int, error: type[Exception] = ValueError,
                   subject: str = "That PDF") -> str:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(  # -E ignores Python environment variables; runs in our own data folder
            [sys.executable, "-E", "-c", _PDF_READER, *args], input=raw, capture_output=True, timeout=timeout,
            cwd=str(DATA_DIR), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            **({} if raw is not None else {"stdin": subprocess.DEVNULL}),
        )
    except subprocess.TimeoutExpired:
        raise error(f"{subject} took too long to read. It may be very large or damaged.") from None
    if result.returncode == 3:
        raise error(f"{subject} is password-protected, so it can't be read.")
    if result.returncode == 4:
        raise error(f"{subject} has more than {library.MAX_PAGES:,} pages.")
    if result.returncode != 0:
        if b"No module named 'pypdf'" in result.stderr:
            raise error("The laptop can't read PDFs yet. Run: python -m pip install --user --upgrade pypdf")
        raise error(f"{subject} couldn't be read. It may be damaged.")
    return result.stdout.decode("utf-8", errors="replace")


def read_document(name: str, raw: bytes) -> str:
    if not name.lower().endswith(".pdf"):
        return raw.decode("utf-8", errors="replace")
    return run_pdf_reader([], raw, 60).strip()


def read_pdf_pages(path: Path) -> list[str]:
    """Each page's text from a PDF in the library folder (a path the hub found itself, never one sent to it)."""
    out = run_pdf_reader(["pages", str(path), str(library.MAX_PAGES)], None, library.READ_SECONDS, library.Problem, "This PDF")
    try:
        pages = json.loads(out)
    except ValueError:
        raise library.Problem(library.NOT_PDF) from None
    return [str(p) for p in pages] if isinstance(pages, list) else []


files = library.FileLibrary(DATA_DIR / "library-index.db", [LIBRARY_DIR], read_pdf_pages)


def open_folder(folder: Path) -> None:
    """Show the library folder in Explorer, Finder or the file manager, making it first if needed."""
    try:
        folder.mkdir(parents=True, exist_ok=True)
        if WINDOWS:
            os.startfile(str(folder))  # a fixed folder of our own, never a path sent to the hub
        else:
            subprocess.Popen(["open" if MAC else "xdg-open", str(folder)], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        raise ValueError(f"Couldn't open the folder. It's at {folder}") from None


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
    which would pop up over Aislet; it still works normally if opened later.)"""
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

class Refused(Exception):
    """A request turned away before its body is read. The reply is plain: there's no key to seal it with."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Server(ThreadingHTTPServer):
    """Limits connections per device, always lets this computer in, and closes connections from the network
    that are too slow to send their request (so a few devices can't hold every connection open)."""
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self.counts_lock = threading.Lock()
        self.per_address: dict[str, int] = {}
        self.network = self.local = 0
        self.deadlines: dict[socket.socket, float] = {}
        self.deadlines_lock = threading.Lock()
        super().__init__(*args, **kwargs)
        threading.Thread(target=self.close_late, daemon=True).start()

    def process_request(self, request, client_address):
        address = client_address[0]
        local = is_loopback(address)
        with self.counts_lock:
            full = (self.local >= LOCAL_CONNECTIONS if local
                    else self.network >= MAX_CONNECTIONS or self.per_address.get(address, 0) >= PER_ADDRESS)
            if not full:
                if local:
                    self.local += 1
                else:
                    self.network += 1
                    self.per_address[address] = self.per_address.get(address, 0) + 1
        if full:  # too many at once: drop this one
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            address = client_address[0]
            with self.counts_lock:
                if is_loopback(address):
                    self.local -= 1
                else:
                    self.network -= 1
                    left = self.per_address.get(address, 1) - 1
                    if left > 0:
                        self.per_address[address] = left
                    else:
                        self.per_address.pop(address, None)

    def watch(self, conn: socket.socket, seconds: float) -> None:
        with self.deadlines_lock:
            self.deadlines[conn] = time.time() + seconds

    def unwatch(self, conn: socket.socket) -> None:
        with self.deadlines_lock:
            self.deadlines.pop(conn, None)

    def close_late(self) -> None:
        while True:
            time.sleep(1)
            now = time.time()
            with self.deadlines_lock:
                late = [c for c, t in self.deadlines.items() if t < now]
                for c in late:
                    del self.deadlines[c]
            for c in late:
                try:
                    c.shutdown(socket.SHUT_RDWR)  # the handler's read ends, and its thread finishes
                except OSError:
                    pass


class Handler(BaseHTTPRequestHandler):
    server_version = "AisletHub/2"
    timeout = 120  # seconds a quiet connection may stay open

    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.local = is_loopback(self.client_address[0])
        self.link: tuple[link.Keys, str] | None = None  # a phone's request: its keys and signature
        if not self.local:
            self.server.watch(self.connection, HEADER_SECONDS)

    def finish(self):
        try:
            super().finish()
        finally:
            self.server.unwatch(self.connection)

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

    def content_length(self) -> int:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("Bad request.") from None
        if length < 0 or length > MAX_BODY:
            raise ValueError("That's too big to send.")
        return length

    def authenticate(self) -> str | None:
        """'pc', 'phone', or None when no credentials were sent. Reads only the headers, never the body.
        Raises Refused for wrong, stale, replayed or old-style credentials."""
        h = self.headers
        token, sig = h.get("X-Key", ""), h.get("X-Aislet-Sig", "")
        if h.get("X-Sig") and not sig:
            raise Refused(426, OLD_PHONE)  # signed the old way (before the private link)
        if not (token or sig):
            return None
        if token and not self.local:
            raise Refused(403, "Only available on the laptop.")
        address, now = self.client_address[0], time.time()
        role = None
        with lock:
            if not self.local:
                recent = [t for t in failures.get(address, []) if now - t < FAILURE_WINDOW]
                failures[address] = recent
                if len(recent) >= MAX_FAILURES:
                    raise Refused(429, "Too many wrong attempts from this device. Wait 10 minutes, then try again.")
            store = load_store()
            if token:
                role = "pc" if secrets.compare_digest(token, store["local_token"]) else None
            else:
                stamp, nonce = h.get("X-Aislet-Time", ""), h.get("X-Aislet-Nonce", "")
                length = self.content_length()
                fresh = stamp.isdigit() and len(stamp) <= 16 and abs(now * 1000 - int(stamp)) <= SIGNATURE_WINDOW_MS
                if fresh and link.NONCE.fullmatch(nonce) and link.SIG.fullmatch(sig) and nonce not in seen_nonces:
                    keys = link_keys(store)
                    expected = link.request_signature(keys, stamp, nonce, self.command, self.path, length)
                    if hmac.compare_digest(sig, expected):
                        for n, expiry in list(seen_nonces.items()):
                            if expiry < now:
                                del seen_nonces[n]
                        seen_nonces[nonce] = now + SIGNATURE_WINDOW_MS / 1000 * 2  # can't be replayed
                        role, self.link = "phone", (keys, sig)
            if role is None and not self.local:
                failures[address].append(now)
        if role is None:
            if not self.local:
                time.sleep(1)  # slows down guessing
            raise Refused(401, "This device isn't paired. Pair it again in Settings → Home.")
        return role

    def send_json(self, data, status: int = 200) -> None:
        body = dump_json(data).encode("utf-8")
        kind = "application/json; charset=utf-8"
        if self.link:  # a phone's request: seal the reply to it
            keys, sig = self.link
            body, kind = link.reply_frame(keys, sig, status, 0, True, body, secrets.token_bytes(link.IV_BYTES)), "text/plain"
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self) -> bytes:
        length = self.content_length()
        if not self.local:
            self.server.watch(self.connection, BODY_SECONDS)
        body = self.rfile.read(length) if length else b""
        if len(body) < length:
            raise ConnectionAbortedError
        self.server.unwatch(self.connection)
        return body

    def drop_body(self) -> None:
        """Before refusing a request: read a small body so the reply isn't lost; never a big one."""
        self.close_connection = True
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if 0 < length <= SMALL_BODY:
                self.rfile.read(length)
        except (ValueError, OSError):
            pass

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def route(self, method: str) -> None:
        try:
            if not self.host_allowed():
                self.drop_body()
                return self.send_json({"error": "Unknown host."}, 403)
            path = unquote(urlsplit(self.path).path)
            if not path.startswith("/api/"):
                if not self.local:  # the PC app is only for this computer's own window
                    return self.send_json({"error": "Open Aislet on the laptop itself."}, 404)
                return self.static(path) if method == "GET" else self.send_json({"error": "Not found."}, 404)
            origin = self.headers.get("Origin")
            if method == "POST" and origin and urlsplit(origin).netloc != self.headers.get("Host"):
                self.drop_body()
                return self.send_json({"error": "Blocked: request came from another site."}, 403)
            role = self.authenticate()
            if role:
                self.server.unwatch(self.connection)  # a paired device's request may take a while (read_body sets its own limit)
            if path == "/api/hub" and method == "GET":
                return self.hub_info(role)
            if path == "/api/launch" and method == "POST" and role is None and self.local:
                return self.launch()
            if role is None:
                self.drop_body()
                return self.send_json({"error": "This device isn't paired. Pair it in Settings → Home."}, 401)
            body = self.read_body() if method == "POST" else b""
            if role == "phone" and body:
                body = link.open_request_body(*self.link, body)
                if body is None:
                    raise ValueError("The request was damaged on the way. Try again.")
            if path in ("/api/pairing", "/api/pairing/new"):
                if role != "pc":
                    return self.send_json({"error": "Only available on the laptop."}, 403)
                with lock:
                    store = load_store()
                    if path.endswith("/new") and method == "POST":
                        store["code"] = new_code()  # paired phones must pair again
                        store["salt"] = secrets.token_hex(16)
                        save_store(store)
                return self.send_json({"code": store["code"], "salt": store["salt"],
                                       "urls": [f"http://{ip}:{PORT}" for ip in lan_addresses()]})
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
            if path.startswith("/api/library/"):
                return self.library(role, path, method, body)
            if path == "/api/search" and method == "POST":
                return self.search(role, body)
            if path in ("/api/chat", "/api/embed") and method == "POST" or path == "/api/tags" and method == "GET":
                return self.proxy(method, path, body if method == "POST" else None)
            return self.send_json({"error": "Not found."}, 404)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout):
            pass
        except Refused as e:
            self.link = None
            self.drop_body()
            self.send_json({"error": str(e)}, e.status)
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

    def launch(self) -> None:
        """The PC window trades launch.py's one-time code for the hub's token. A wrong code changes nothing."""
        length = self.content_length()
        if length > 1000:
            raise ValueError("Bad request.")
        data = parse_json(self.rfile.read(length) if length else b"")
        code = data.get("code") if isinstance(data, dict) else None
        if not isinstance(code, str) or not use_launch_code(code):
            return self.send_json({"error": "This window's link has expired. Close it and open Aislet again."}, 403)
        with lock:
            token = load_store()["local_token"]
        return self.send_json({"token": token})

    def library(self, role: str, path: str, method: str, body: bytes) -> None:
        """The laptop's own library folder. Only the laptop's window may use it: phones search their own."""
        if role != "pc":
            return self.send_json({"error": "Only available on the laptop."}, 403)
        if method != "POST":
            return self.send_json({"error": "Not found."}, 404)
        if path == "/api/library/books":
            return self.send_json({"folder": str(LIBRARY_DIR), **files.books()})
        if path == "/api/library/index":
            return self.send_json({"folder": str(LIBRARY_DIR), **files.index()})
        if path == "/api/library/search":
            data = parse_json(body)
            query, limit = (data.get("query"), data.get("limit", 8)) if isinstance(data, dict) else (None, None)
            if (not isinstance(query, str) or len(query) > 500 or not isinstance(limit, int) or isinstance(limit, bool)
                    or not 1 <= limit <= 20):
                raise ValueError("Bad request.")
            return self.send_json({"pages": files.search(query, limit)})
        if path == "/api/library/open":
            open_folder(LIBRARY_DIR)
            return self.send_json({"ok": True})
        return self.send_json({"error": "Not found."}, 404)

    def search(self, role: str, body: bytes) -> None:
        """One DuckDuckGo search for the PC window. Phones search by themselves."""
        if role != "pc":
            return self.send_json({"error": "Only available on the laptop."}, 403)
        data = parse_json(body)
        query = data.get("query") if isinstance(data, dict) else None
        if not isinstance(query, str) or not query.strip() or len(query) > 300:
            raise ValueError("Bad request.")
        request = urllib.request.Request(SEARCH_URL, data=urlencode({"q": query.strip()}).encode(), headers={
            "User-Agent": SEARCH_AGENT, "Accept": "text/html", "Accept-Language": "en"})
        try:
            with urllib.request.urlopen(request, timeout=15) as reply:
                html = reply.read(2_000_000).decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return self.send_json({"error": f"DuckDuckGo replied with an error ({e.code})."}, 502)
        except (urllib.error.URLError, OSError):
            return self.send_json({"error": "Couldn't reach DuckDuckGo. Check the laptop is online."}, 502)
        return self.send_json({"html": html})

    def hub_info(self, role: str | None):
        if role is None:  # anyone may ask whether a hub is here; they learn nothing else
            with lock:
                salt = load_store()["salt"]
            return self.send_json({"app": "untethered",  # the id from before the rename: phones of every version look for it
                                   "v": link.VERSION, "salt": salt, "paired": False})
        ok = ollama_running()
        starting = not ok and start_ollama()  # only paired devices can start it
        # Sealed to a phone's request, this also proves the hub knows the phone's key.
        self.send_json({"app": "untethered", "v": link.VERSION, "name": socket.gethostname(), "paired": True,
                        "ollama": ok, "starting": starting})

    def proxy(self, method: str, path: str, body: bytes | None) -> None:
        """Pass a request to Ollama and stream its reply back: to a phone, one sealed frame per line."""
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
        self.send_header("Content-Type", "text/plain" if self.link else resp.getheader("Content-Type", "application/json"))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.close_connection = True
        index = 0
        while True:
            line = resp.readline()
            if self.link:
                keys, sig = self.link
                # The last frame is empty and marked last: a reply cut short can't pass for a whole one.
                self.wfile.write(link.reply_frame(keys, sig, resp.status, index, not line, line,
                                                  secrets.token_bytes(link.IV_BYTES)))
                index += 1
            elif line:
                self.wfile.write(line)
            self.wfile.flush()
            if not line:
                break

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
    make_private()
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
