"""Your own files as an offline library: PDFs, ebooks (EPUB), text, Markdown and web pages (HTML).

Aislet only reads these files. It never changes, moves or deletes them: the text it reads goes into its
own search index (library-index.db in the hub's data folder), a cache it can rebuild at any time.

The phone does the same in modules/untethered-library (LibraryFiles.kt). Keep the limits and messages in step.
"""
from __future__ import annotations

import hashlib
import html
import os
import posixpath
import re
import sqlite3
import threading
import time
import unicodedata
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Callable
from urllib.parse import unquote

FORMATS = {
    ".pdf": "pdf", ".epub": "epub",
    ".txt": "text", ".text": "text",
    ".md": "markdown", ".markdown": "markdown",
    ".html": "html", ".htm": "html", ".xhtml": "html",
}
# Documents people may expect to work: listed with a clear message instead of being silently ignored.
NOT_YET = {".doc", ".docx", ".odt", ".rtf", ".pages", ".mobi", ".azw", ".azw3", ".djvu"}

MAX_FILES = 2000            # files looked at in one pass
MAX_DEPTH = 3               # folders inside the library folder
MAX_TEXT_FILE = 20 << 20    # text, Markdown and HTML
MAX_BOOK_FILE = 300 << 20   # PDF and EPUB
MAX_PAGES = 3000
MAX_ENTRIES = 5000          # files inside an EPUB
MAX_UNPACKED = 300 << 20    # an EPUB's contents, unpacked
MAX_ENTRY = 30 << 20        # one file inside an EPUB, unpacked
MAX_CHARS = 30_000_000      # text kept from one file
READ_SECONDS = 120
PASSAGE, MAX_PASSAGE = 700, 1200
SCHEMA = "1"


class Problem(Exception):
    """A file that can't be read, with a message for the person."""


def mb(n: int) -> str:
    return f"{n >> 20:,} MB"


# The words people see. Keep them the same on the phone.
EMPTY = "This file is empty."
NOT_TEXT = "This doesn't look like a text file."
NOT_PDF = "This isn't a PDF, or it's damaged."
NOT_EPUB = "This ebook is damaged, or isn't an EPUB."
DRM = "This ebook is copy-protected (DRM), so it can't be read."
NO_TEXT = "This file has no text to search."
PDF_NO_TEXT = "This PDF has no text to search. It may be scanned pages."
TOO_SLOW = "This file took too long to read. It may be very large or damaged."
UNREADABLE = "This file couldn't be opened. Check it isn't still downloading."
DAMAGED = "This file couldn't be read. It may be damaged."
ZIM_ON_PC = "Kiwix libraries can only be searched on a phone for now."


def too_big(limit: int) -> str:
    return f"This file is too big to read (over {mb(limit)})."


def not_yet(ext: str) -> str:
    return f"Aislet can't read {ext} files yet. Save it as a PDF or text file instead."


# ---- Reading files ---------------------------------------------------------------------------

def decode(raw: bytes) -> str:
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8", "replace")
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", "replace")
    if b"\x00" in raw[:8192]:
        raise Problem(NOT_TEXT)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", "replace")


# Hostile files can be built to make pattern matching take hours, so markup is read by a plain left-to-right
# scan (each character looked at a fixed number of times), and patterns only ever run on short, capped pieces.
_SKIP = {"script", "style", "noscript", "svg", "math", "nav", "footer", "button", "head", "template"}
_BLOCKS = {"p", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "dl", "dd", "dt", "tr",
           "table", "blockquote", "pre", "figcaption", "details", "summary"}
_NAME = re.compile(r"\s*(/?)\s*([A-Za-z][A-Za-z0-9:-]*)")
MAX_TAG = 4096  # longer "tags" are treated as text, not parsed


def _close_tag(markup: str, name: str, start: int) -> int:
    """Where `</name` starts (any case) at or after `start`, or -1."""
    j = markup.find("</", start)
    while j >= 0:
        if markup[j + 2:j + 2 + len(name)].lower() == name:
            return j
        j = markup.find("</", j + 2)
    return -1


def html_to_text(markup: str) -> str:
    """The readable text of a web page, with paragraphs kept apart (as src/library.ts does for Kiwix)."""
    out, i, n = [], 0, len(markup)
    while i < n:
        lt = markup.find("<", i)
        if lt < 0:
            out.append(markup[i:])
            break
        out.append(markup[i:lt])
        if markup.startswith("<!--", lt):
            end = markup.find("-->", lt + 4)
            i = n if end < 0 else end + 3
            out.append(" ")
            continue
        gt = markup.find(">", lt + 1)
        if gt < 0:
            break  # an unfinished tag: the rest isn't text
        m = _NAME.match(markup[lt + 1:min(gt, lt + 1 + 64)])
        name, closing = (m.group(2).lower(), bool(m.group(1))) if m else ("", False)
        i = gt + 1
        if gt - lt > MAX_TAG:
            continue
        if name in _SKIP and not closing and markup[gt - 1] != "/":
            end = _close_tag(markup, name, i)
            if end < 0:
                break
            close = markup.find(">", end)
            i = n if close < 0 else close + 1
            out.append(" ")
        elif name in ("br", "hr"):
            out.append("\n")
        elif name in _BLOCKS:
            out.append("\n\n")
        elif name in ("td", "th") and closing:
            out.append(" ")
    text = html.unescape("".join(out))
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def first_heading(markup: str) -> str:
    """The first h1 to h3 in a chapter, to name it in answers."""
    m = re.search(r"<h[1-3]\b", markup, re.I)
    if not m:
        return ""
    gt = markup.find(">", m.end())
    end = re.compile(r"</h[1-3]\s*>", re.I).search(markup, gt + 1) if gt >= 0 else None
    if not end:
        return ""
    return re.sub(r"\s+", " ", html_to_text(markup[gt + 1:min(end.start(), gt + 1 + 2000)])).strip()[:120]


def markdown_sections(text: str) -> list[tuple[str, str]]:
    """Split at headings, so an answer can say which part of the file it used."""
    sections, heading, lines = [], "", []
    for line in text.splitlines():
        m = re.match(r"#{1,6}[ \t]+(.+)", line) if line.startswith("#") and len(line) <= 300 else None
        if m:
            if any(s.strip() for s in lines):
                sections.append((heading, "\n".join(lines)))
            heading, lines = m.group(1).rstrip("# \t")[:120], [line]
        else:
            lines.append(line)
    if any(s.strip() for s in lines):
        sections.append((heading, "\n".join(lines)))
    return sections


def tags(xml: str, name: str) -> list[str]:
    """Each `<name ...>` tag in an EPUB's index files (short ones only), found by a plain scan."""
    found, i, low = [], 0, f"<{name}"
    while True:
        lt = xml.find(low, i)
        if lt < 0:
            return found
        after = xml[lt + len(low):lt + len(low) + 1]
        gt = xml.find(">", lt)
        if gt < 0:
            return found
        if after in (" ", "\t", "\n", "\r", "/", ">") and gt - lt <= MAX_TAG:
            found.append(xml[lt:gt + 1])
        i = gt + 1


def attr(tag: str, key: str) -> str:
    m = re.search(r'(?<![\w:-])' + re.escape(key) + r'\s*=\s*"([^"]*)"', tag)
    return m.group(1) if m else ""


def read_bounded(z: zipfile.ZipFile, info: zipfile.ZipInfo, budget: list[int]) -> bytes:
    """One file from inside an EPUB, never trusting the sizes it claims (a "zip bomb" lies about them)."""
    with z.open(info) as f:
        data = f.read(MAX_ENTRY + 1)
    if len(data) > MAX_ENTRY:
        raise Problem("This ebook is too big when unpacked.")
    budget[0] -= len(data)
    if budget[0] < 0:
        raise Problem("This ebook is too big when unpacked.")
    return data


FONT_OBFUSCATION = {"http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"}


def read_epub(path: Path, started: float) -> tuple[str, list[tuple[str, str]]]:
    with open(path, "rb") as f:
        if f.read(4) != b"PK\x03\x04":
            raise Problem(NOT_EPUB)
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        raise Problem(NOT_EPUB) from None
    with z:
        infos = z.infolist()
        if len(infos) > MAX_ENTRIES:
            raise Problem(f"This ebook has more than {MAX_ENTRIES:,} files inside.")
        by_name = {i.filename: i for i in infos}
        budget = [MAX_UNPACKED]

        def read(name: str) -> str:
            info = by_name.get(name)
            if info is None:
                raise Problem(NOT_EPUB)
            try:
                return decode(read_bounded(z, info, budget))
            except (zipfile.BadZipFile, RuntimeError, OSError, EOFError, ValueError) as e:  # damaged or password-protected
                if isinstance(e, Problem):
                    raise
                raise Problem(NOT_EPUB) from None

        if "META-INF/encryption.xml" in by_name:
            algorithms = {attr(t, "Algorithm") for t in tags(read("META-INF/encryption.xml"), "EncryptionMethod")}
            if algorithms - FONT_OBFUSCATION - {""}:
                raise Problem(DRM)
        rootfiles = [attr(t, "full-path") for t in tags(read("META-INF/container.xml"), "rootfile")]
        if not rootfiles or not rootfiles[0]:
            raise Problem(NOT_EPUB)
        opf_name = rootfiles[0]
        opf = read(opf_name)
        title = ""
        tm = re.search(r"<dc:title\b", opf, re.I)
        if tm:
            gt = opf.find(">", tm.end())
            end = re.compile(r"</dc:title\s*>", re.I).search(opf, gt + 1) if gt >= 0 else None
            if end:
                title = re.sub(r"\s+", " ", html_to_text(opf[gt + 1:min(end.start(), gt + 1 + 2000)])).strip()[:200]
        manifest = {}
        for item in tags(opf, "item"):
            if attr(item, "id") and attr(item, "href"):
                manifest[attr(item, "id")] = (attr(item, "href"), attr(item, "media-type"))
        base = posixpath.dirname(opf_name)
        order = []
        for ref in tags(opf, "itemref"):
            href, kind = manifest.get(attr(ref, "idref"), ("", ""))
            if href and ("html" in kind or href.lower().endswith((".html", ".htm", ".xhtml"))):
                order.append(posixpath.normpath(posixpath.join(base, unquote(href.split("#")[0]))))
        if not order:  # no reading order: take the pages in name order
            order = sorted(n for n in by_name if n.lower().endswith((".html", ".htm", ".xhtml")))
        sections = []
        for name in dict.fromkeys(order):
            if name not in by_name:
                continue
            if time.monotonic() - started > READ_SECONDS:
                raise Problem(TOO_SLOW)
            markup = read(name)
            text = html_to_text(markup)
            if text:
                sections.append((first_heading(markup), text))
        return title, sections


def read_file(path: Path, fmt: str, size: int, read_pdf: Callable[[Path], list[str]]) -> tuple[str, int, list[tuple[str, str]]]:
    """(title, parts, sections) for one file, where parts are pages, chapters or sections. Raises Problem."""
    started = time.monotonic()
    title = path.stem
    if fmt == "pdf":
        with open(path, "rb") as f:
            if b"%PDF-" not in f.read(1024):
                raise Problem(NOT_PDF)
        pages = read_pdf(path)
        sections = [(f"page {i}", t) for i, t in enumerate(pages, 1) if t.strip()]
        if not sections:
            raise Problem(PDF_NO_TEXT)
        return title, len(pages), sections
    if fmt == "epub":
        book_title, sections = read_epub(path, started)
        return book_title or title, len(sections), sections
    with open(path, "rb") as f:
        raw = f.read(MAX_TEXT_FILE + 1)
    if len(raw) > MAX_TEXT_FILE:
        raise Problem(too_big(MAX_TEXT_FILE))
    text = decode(raw)
    if fmt == "html":
        sections = [("", html_to_text(text))]
    elif fmt == "markdown":
        sections = markdown_sections(text)
    else:
        sections = [("", text)]
    sections = [(h, t) for h, t in sections if t.strip()]
    return title, len(sections), sections


def split_passages(text: str) -> list[str]:
    """Pieces of about PASSAGE characters, broken between paragraphs where possible."""
    out, current = [], ""
    for para in (p.strip() for p in re.split(r"\n\s*\n", text)):
        while len(para) > MAX_PASSAGE:
            cut = max(para.rfind(". ", PASSAGE // 2, MAX_PASSAGE) + 1, para.rfind(" ", PASSAGE // 2, MAX_PASSAGE))
            if cut <= 0:
                cut = MAX_PASSAGE
            if current:
                out.append(current)
                current = ""
            out.append(para[:cut].strip())
            para = para[cut:].strip()
        if not para:
            continue
        if current and len(current) + len(para) + 2 > MAX_PASSAGE:
            out.append(current)
            current = ""
        current = f"{current}\n\n{para}" if current else para
        if len(current) >= PASSAGE:
            out.append(current)
            current = ""
    if current:
        out.append(current)
    return out


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fold(text: str) -> str:
    """Lower case without accents, so "cafe" finds "Café"."""
    return "".join(c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c))


def query_terms(query: str) -> list[str]:
    """Plain words only, so nothing in a question can change how the search works."""
    words = re.findall(r"[^\W_]+", fold(query[:500]))
    return list(dict.fromkeys(w for w in words if len(w) > 1))[:12]


# ---- The library -------------------------------------------------------------------------------

class FileLibrary:
    """Files in `roots`, read into a search index at `db_path`. Only `index()` reads file contents."""

    def __init__(self, db_path: Path, roots: list[Path], read_pdf: Callable[[Path], list[str]], kiwix_here: bool = False):
        self.db_path = db_path
        self.roots = roots
        self.read_pdf = read_pdf
        self.kiwix_here = kiwix_here  # True where .zim files are handled elsewhere (the phone)
        self.index_lock = threading.Lock()
        self.visible: set[int] = set()  # documents in the last look at the folders: only these are searched

    # The index is Aislet's own cache: if it's damaged or from another version, it's rebuilt.
    @contextmanager
    def connect(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            db = self._open()
        except sqlite3.DatabaseError:
            for suffix in ("", "-wal", "-shm"):
                Path(f"{self.db_path}{suffix}").unlink(missing_ok=True)
            db = self._open()
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def _open(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.db_path, timeout=10)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
            row = db.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
            if not row or row[0] != SCHEMA:
                db.executescript("DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS passages;")
                db.execute(
                    "CREATE TABLE docs(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, size INTEGER NOT NULL, "
                    "modified INTEGER NOT NULL, hash TEXT NOT NULL, format TEXT NOT NULL, title TEXT NOT NULL, "
                    "parts INTEGER NOT NULL, problem TEXT NOT NULL DEFAULT '', same_as INTEGER)"
                )
                try:
                    db.execute("CREATE VIRTUAL TABLE passages USING fts4(doc, section, text, notindexed=doc, tokenize=unicode61 \"remove_diacritics=1\")")
                except sqlite3.OperationalError:
                    db.execute("CREATE VIRTUAL TABLE passages USING fts4(doc, section, text, notindexed=doc)")
                db.execute("INSERT OR REPLACE INTO meta VALUES ('schema', ?)", (SCHEMA,))
                db.commit()
            db.execute("SELECT count(*) FROM docs").fetchone()
            return db
        except sqlite3.DatabaseError:
            db.close()
            raise

    def scan(self) -> tuple[list[tuple[Path, os.stat_result, str]], int]:
        """Files in the library folders: (path, details, extension), and how many more were left out.
        Hidden files and links are skipped, so nothing outside the folders is read."""
        found, skipped = [], 0

        def walk(folder: Path, depth: int) -> None:
            nonlocal skipped
            try:
                with os.scandir(folder) as listing:
                    entries = sorted(listing, key=lambda e: e.name.lower())
            except OSError:
                return
            for e in entries:
                if e.name.startswith((".", "~$")) or e.is_symlink():
                    continue
                if e.is_dir(follow_symlinks=False):
                    if depth < MAX_DEPTH:
                        walk(Path(e.path), depth + 1)
                    continue
                ext = os.path.splitext(e.name)[1].lower()
                if ext not in FORMATS and ext not in NOT_YET and not (ext == ".zim" and not self.kiwix_here):
                    continue
                if len(found) >= MAX_FILES:
                    skipped += 1
                    continue
                try:
                    found.append((Path(e.path), e.stat(follow_symlinks=False), ext))
                except OSError:
                    continue

        for root in self.roots:
            walk(root, 0)
        return found, skipped

    def books(self) -> dict:
        """Every file found, with what's known about it. Quick: reads no file contents."""
        found, skipped = self.scan()
        with self.connect() as db:
            known = {r[0]: r for r in db.execute(
                "SELECT path, size, modified, format, title, parts, problem, same_as, id FROM docs")}
            titles = {r[8]: r[4] for r in known.values()}
        books, visible = [], set()
        for path, st, ext in found:
            book = {"path": str(path), "title": path.stem, "description": "", "articles": 0, "size": st.st_size,
                    "searchable": False, "format": FORMATS.get(ext, ext.lstrip("."))}
            row = known.get(str(path))
            if ext in NOT_YET:
                book["problem"] = not_yet(ext)
            elif ext == ".zim":
                book["problem"] = ZIM_ON_PC
            elif row and row[1] == st.st_size and row[2] == st.st_mtime_ns // 1_000_000:
                book.update(title=row[4], articles=row[5])
                if row[6]:
                    book["problem"] = row[6]
                elif row[7] is not None:
                    book["sameAs"] = titles.get(row[7], "another file")
                else:
                    book["searchable"] = True
                    visible.add(row[8])
            else:
                book["pending"] = True
            books.append(book)
        self.visible = visible
        return {"books": books, "skipped": skipped}

    def index(self) -> dict:
        """Read new and changed files into the index, and forget ones that have gone. One pass at a time."""
        with self.index_lock:
            found, _ = self.scan()
            here = {str(p): (st, ext) for p, st, ext in found if ext in FORMATS}
            with self.connect() as db:
                # Forget files that have gone or changed, and copies of them: those still here are read again.
                for doc_id, path, size, modified in db.execute("SELECT id, path, size, modified FROM docs").fetchall():
                    st = here.get(path, (None,))[0]
                    if st is None and os.path.exists(path):
                        continue  # still there, just past the file limit this time
                    if st is None or st.st_size != size or st.st_mtime_ns // 1_000_000 != modified:
                        self._forget(db, doc_id)
                db.commit()
                known = {r[0] for r in db.execute("SELECT path FROM docs")}
                for path_str, (st, ext) in here.items():
                    if path_str not in known:
                        self._read_one(db, Path(path_str), st.st_size, st.st_mtime_ns // 1_000_000, FORMATS[ext])
                        db.commit()
        return self.books()

    @staticmethod
    def _forget(db: sqlite3.Connection, doc_id: int) -> None:
        """Drop a file from the index, with any copies of it (they're read again if still there)."""
        copies = [r[0] for r in db.execute("SELECT id FROM docs WHERE same_as = ?", (doc_id,))]
        db.execute("DELETE FROM passages WHERE doc = ?", (doc_id,))
        db.execute("DELETE FROM docs WHERE id = ?", (doc_id,))
        for copy_id in copies:
            FileLibrary._forget(db, copy_id)

    def _read_one(self, db: sqlite3.Connection, path: Path, size: int, modified: int, fmt: str) -> None:
        title, parts, problem, digest, same_as, sections = path.stem, 0, "", "", None, []
        limit = MAX_BOOK_FILE if fmt in ("pdf", "epub") else MAX_TEXT_FILE
        try:
            if size == 0:
                raise Problem(EMPTY)
            if size > limit:
                raise Problem(too_big(limit))
            digest = file_hash(path)
            twin = db.execute("SELECT id, parts FROM docs WHERE hash = ? AND problem = '' AND same_as IS NULL",
                              (digest,)).fetchone()
            if twin:  # the same file is already here: search it once, but keep this file's own name
                same_as, parts = twin
            else:
                title, parts, sections = read_file(path, fmt, size, self.read_pdf)
                if not sections:
                    raise Problem(NO_TEXT)
        except Problem as e:
            problem = str(e)
        except OSError:
            problem = UNREADABLE
        except Exception:  # anything else odd in one file never stops the others being read
            problem = DAMAGED
        cur = db.execute(
            "INSERT INTO docs(path, size, modified, hash, format, title, parts, problem, same_as) VALUES (?,?,?,?,?,?,?,?,?)",
            (str(path), size, modified, digest, fmt, title, parts, problem, same_as),
        )
        doc_id, kept = cur.lastrowid, 0
        for section, text in sections:
            for passage in split_passages(text):
                if kept + len(passage) > MAX_CHARS:
                    return
                kept += len(passage)
                db.execute("INSERT INTO passages(doc, section, text) VALUES (?,?,?)", (doc_id, section, passage))

    def search(self, query: str, limit: int) -> list[dict]:
        """The passages that best match, as library pages (see LibraryPage in src/library.ts)."""
        terms = query_terms(query)
        visible = self.visible
        if not terms or not visible:
            return []
        rows: dict[int, tuple] = {}
        with self.connect() as db:
            for joiner in (" ", " OR "):
                match = joiner.join(f'"{t}"' for t in terms)
                for r in db.execute(
                    "SELECT passages.rowid, CAST(passages.doc AS INTEGER), passages.section, passages.text, docs.title, docs.path "
                    "FROM passages JOIN docs ON docs.id = CAST(passages.doc AS INTEGER) WHERE passages MATCH ? LIMIT 400",
                    (match,),
                ):
                    if r[1] in visible:
                        rows.setdefault(r[0], r)
                if len(rows) >= limit * 2 or len(terms) == 1:
                    break

        def score(r: tuple) -> float:
            words = set(re.findall(r"[^\W_]+", fold(f"{r[4]} {r[2]} {r[3]}")))
            return sum(t in words for t in terms) / len(terms)

        best = sorted(rows.values(), key=lambda r: (-score(r), r[0]))[:limit]
        return [{"book": r[5], "bookTitle": r[4], "path": f"#{r[0]}", "title": r[2], "rank": i, "text": r[3]}
                for i, r in enumerate(best)]
