"""Tests for pc/library.py: your own files as a library on the laptop.

Run from the project folder (needs pypdf, like the hub):  python pc/tests/library_test.py

Everything happens in a temporary folder with made-up files. The most important check is that Aislet
never changes the files it reads: every file is compared, byte for byte and by date, before and after.
"""
from __future__ import annotations

import hashlib
import io
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="aislet-library-test-"))
os.environ["LOCALAPPDATA"] = str(TMP / "appdata")    # the hub's data folder, on Windows
os.environ["XDG_DATA_HOME"] = str(TMP / "appdata")   # and on Linux
os.environ["UNTETHERED_LIBRARY"] = str(TMP / "Libraries")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import hub      # noqa: E402
import library  # noqa: E402
from tests.made_up_files import epub, pdf  # noqa: E402

ROOT = TMP / "Libraries"
results: list[tuple[bool, str]] = []


def check(ok: bool, name: str, detail: str = "") -> None:
    results.append((bool(ok), name))
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f": {detail}"))


# ---- Made-up files ------------------------------------------------------------------------------

def write(rel: str, data: bytes | str) -> Path:
    p = ROOT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data.encode("utf-8") if isinstance(data, str) else data)
    return p


def snapshot(folder: Path) -> dict[str, tuple[str, int, int]]:
    """Every file's content hash, size and date, to prove nothing was changed."""
    return {str(p.relative_to(folder)): (hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_size, p.stat().st_mtime_ns)
            for p in sorted(folder.rglob("*")) if p.is_file() and not p.is_symlink()}


ROOT.mkdir(parents=True)
write("Boiler notes.md", "# Boiler notes\n\nIntro line.\n\n## Pressure\n\nThe made-up boiler, a Zephyrion 9, runs at 1.4 bar when cold.\n\n## Servicing\n\nService it every 14 months.\n")
write("Garden/Seeds.txt", "Plant the made-up quillberry seeds 3 cm deep in late spring. Cafe notes: water them at dusk.\n")
write("Recipe.html", "<html><head><title>Ignore me</title><style>.x{}</style></head><body><nav>Menu</nav><p>Bake the fictional moonbread at 190 &deg;C for 25 minutes.</p><script>alert(1)</script></body></html>")
write("Manual.pdf", pdf(["Welcome to the Glimmerfold 3000 manual.", "Reset the Glimmerfold by holding the amber key for 7 seconds."]))
write("Saga.epub", epub("The Tale of Orrin", [("The Harbour", "Orrin sailed from Velmor harbour at dawn."), ("The Storm", "A storm called the Grey Widow broke the mast.")]))
write("Crème brûlée.txt", "Café crème brûlée needs a blowtorch, said the made-up chef Ysolde.\n")
# Problems, each with its own message.
write("Fake.pdf", "This is not really a PDF.")
write("Binary.txt", b"\x00\x01\x02 not text \x00" * 50)
write("Empty.md", b"")
write("Letter.docx", b"PK\x03\x04 not read")
write("Wikipedia.zim", b"ZIM")
write("Bomb.epub", epub("Bomb", [("Only", "z" * (library.MAX_ENTRY + 10))]))  # tiny packed, huge unpacked
write("Locked.epub", epub("Locked", [("Only", "secret")], {"META-INF/encryption.xml": b'<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>'}))
write("Scanned.pdf", pdf([""]))
write("Copy of Seeds.txt", (ROOT / "Garden/Seeds.txt").read_bytes())  # the same file twice
write(".hidden.txt", "hidden file: the made-up word snorkelwisp")
write("~$Draft.txt", "an Office lock file: snorkelwisp")
try:
    from pypdf import PdfReader, PdfWriter
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf(["Top secret glimmer"]))))
    w.encrypt(user_password="secret", algorithm="RC4-128")
    buf = io.BytesIO()
    w.write(buf)
    write("Password.pdf", buf.getvalue())
    have_locked_pdf = True
except Exception as e:  # pypdf without encryption support
    print(f"note: no password-protected PDF test ({e})")
    have_locked_pdf = False
outside = TMP / "Outside"
outside.mkdir()
(outside / "Private.txt").write_text("outside the library: the made-up word snorkelwisp")
try:
    os.symlink(outside, ROOT / "Link to outside", target_is_directory=True)
    os.symlink(outside / "Private.txt", ROOT / "Link.txt")
    have_links = True
except OSError:
    print("note: no link test (this account can't make symlinks)")
    have_links = False

before = snapshot(ROOT)
before_outside = snapshot(outside)
pdf_reads: list[str] = []


def counting_reader(path: Path) -> list[str]:
    pdf_reads.append(path.name)
    return hub.read_pdf_pages(path)


lib = library.FileLibrary(TMP / "appdata" / "index.db", [ROOT], counting_reader)

# ---- Listing ------------------------------------------------------------------------------------
listed = lib.books()
by_name = {Path(b["path"]).name: b for b in listed["books"]}
check(all(b.get("pending") for n, b in by_name.items() if Path(n).suffix in library.FORMATS), "new files are listed as waiting to be read",
      str([n for n, b in by_name.items() if not b.get("pending")]))
check(not pdf_reads, "listing reads no file contents", str(pdf_reads))
check(".hidden.txt" not in by_name and "~$Draft.txt" not in by_name, "hidden and lock files are skipped")
check("Link.txt" not in by_name and not any("Private" in n for n in by_name), "links are not followed", str(list(by_name)))

# ---- Reading ------------------------------------------------------------------------------------
result = lib.index()
books = {Path(b["path"]).name: b for b in result["books"]}


def problem(name: str) -> str:
    return books.get(name, {}).get("problem", "")


check(books["Boiler notes.md"]["searchable"] and books["Boiler notes.md"]["articles"] == 3, "Markdown is read in sections", str(books["Boiler notes.md"]))
check(books["Manual.pdf"]["searchable"] and books["Manual.pdf"]["articles"] == 2, "a PDF is read page by page", str(books["Manual.pdf"]))
check(books["Saga.epub"]["title"] == "The Tale of Orrin" and books["Saga.epub"]["articles"] == 2, "an EPUB's title and chapters are read", str(books["Saga.epub"]))
check(books["Recipe.html"]["searchable"] and books["Crème brûlée.txt"]["searchable"], "HTML and text files are read")
check(problem("Fake.pdf") == library.NOT_PDF, "a file pretending to be a PDF is refused", problem("Fake.pdf"))
check(problem("Binary.txt") == library.NOT_TEXT, "a binary file pretending to be text is refused", problem("Binary.txt"))
check(problem("Empty.md") == library.EMPTY, "an empty file is reported", problem("Empty.md"))
check(problem("Letter.docx") == library.not_yet(".docx"), "Word files get a clear message", problem("Letter.docx"))
check(problem("Wikipedia.zim") == library.ZIM_ON_PC, "Kiwix files on the laptop get a clear message", problem("Wikipedia.zim"))
check("too big when unpacked" in problem("Bomb.epub"), "a zip bomb inside an EPUB is stopped", problem("Bomb.epub"))
check(problem("Locked.epub") == library.DRM, "a copy-protected EPUB is reported", problem("Locked.epub"))
check(problem("Scanned.pdf") == library.PDF_NO_TEXT, "a PDF with no text is reported", problem("Scanned.pdf"))
if have_locked_pdf:
    check("password-protected" in problem("Password.pdf"), "a password-protected PDF is reported", problem("Password.pdf"))
dupes = [b for b in result["books"] if b.get("sameAs")]
check(len(dupes) == 1 and dupes[0]["sameAs"] in ("Seeds", "Copy of Seeds") and dupes[0]["sameAs"] != dupes[0]["title"],
      "the same file twice is read once", str(dupes))

# ---- Searching ----------------------------------------------------------------------------------


def search(q: str, limit: int = 5) -> list[dict]:
    return lib.search(q, limit)


hits = search("Glimmerfold reset amber key")
check(hits and hits[0]["title"] == "page 2" and hits[0]["bookTitle"] == "Manual" and "7 seconds" in hits[0]["text"],
      "a PDF answer names its page", str(hits[:1]))
hits = search("Zephyrion boiler bar")
check(hits and hits[0]["title"] == "Pressure" and "1.4 bar" in hits[0]["text"], "a Markdown answer names its heading", str(hits[:1]))
hits = search("Grey Widow storm mast")
check(hits and hits[0]["bookTitle"] == "The Tale of Orrin" and hits[0]["title"] == "The Storm", "an EPUB answer names its chapter", str(hits[:1]))
check(not search("alert secret"), "script and style text isn't searched")
check(search("moonbread") and not search("Menu Ignore"), "a web page's text is searched, not its menus or title")
check(any("Ysolde" in h["text"] for h in search("creme brulee cafe")), "accents don't matter: creme finds crème")
check(len(search("quillberry seeds")) == 1, "a file and its copy give one answer, not two", str(search("quillberry seeds")))
check(not search("snorkelwisp"), "hidden files and linked files are never searched")
for bad in ['"', '" OR 1=1 --', "NEAR(a b)", "*", "-x", "a" * 600, "", "boiler) OR (", "\u0000"]:
    try:
        r = search(bad)
        ok = isinstance(r, list)
    except Exception as e:  # noqa: BLE001
        ok, r = False, e
    check(ok, f"a strange search is handled safely: {bad[:20]!r}", repr(r))

# ---- Changes ------------------------------------------------------------------------------------
pdf_reads.clear()
lib.index()
check(not pdf_reads, "files that haven't changed aren't read again", str(pdf_reads))
check(snapshot(ROOT) == before and snapshot(outside) == before_outside, "no file was changed, moved or deleted by reading")
check(not any(p.suffix in (".db", ".db-wal", ".db-shm") for p in ROOT.rglob("*")), "the index is kept outside the library folder")

# The person edits and removes files themselves: the index follows.
(ROOT / "Garden/Seeds.txt").write_text("Plant the made-up frostplum seeds in autumn.\n")
os.utime(ROOT / "Garden/Seeds.txt", (1, 1_700_000_000))
(ROOT / "Recipe.html").unlink()
lib.index()
check(search("frostplum"), "an edited file is read again")
check(not search("moonbread"), "a removed file is forgotten")
check(any("quillberry" in h["text"] for h in search("quillberry seeds")), "the remaining copy takes over when the first one changes")

# A damaged index is Aislet's own cache: it's rebuilt, and the files are untouched.
(TMP / "appdata" / "index.db").write_bytes(b"this is not a database" * 100)
for suffix in ("-wal", "-shm"):
    Path(f"{TMP / 'appdata' / 'index.db'}{suffix}").unlink(missing_ok=True)
lib2 = library.FileLibrary(TMP / "appdata" / "index.db", [ROOT], hub.read_pdf_pages)
lib2.index()
check(lib2.search("Glimmerfold amber", 3), "a damaged index is rebuilt")

# Limits.
saved = library.MAX_FILES
library.MAX_FILES = 3
listed = lib2.books()
library.MAX_FILES = saved
check(len(listed["books"]) == 3 and listed["skipped"] > 0, "only the first files are read when there are too many", str(listed["skipped"]))
saved = library.MAX_TEXT_FILE
library.MAX_TEXT_FILE = 10
write("Long.txt", "This text file is longer than ten bytes.")
lib2.index()
library.MAX_TEXT_FILE = saved
check(problem_text := next((b.get("problem", "") for b in lib2.books()["books"] if b["path"].endswith("Long.txt")), ""),
      "a file over the size limit is reported, not read")
check("too big" in problem_text, "the size message says why", problem_text)

# ---- Hostile files: built so that careless pattern matching would take hours. Each must take seconds. ----
HOSTILE = TMP / "Hostile"
HOSTILE.mkdir()
(HOSTILE / "Angles.html").write_text("<" * 2_000_000 + "<script" * 200_000 + "<!--" * 200_000 + "<h1" * 200_000, encoding="utf-8")
(HOSTILE / "Unclosed.html").write_text("<p>Start of the made-up page.</p><script>" + "x" * 5_000_000, encoding="utf-8")
(HOSTILE / "Spaces.md").write_text("# " + " " * 5_000_000 + "x\n" + ("#" + " " * 250 + "\n") * 20_000, encoding="utf-8")
(HOSTILE / "Entities.txt").write_text("&" + "a" * 5_000_000 + " &#" * 300_000, encoding="utf-8")
bomb_opf = io.BytesIO()
with zipfile.ZipFile(bomb_opf, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("META-INF/container.xml", '<rootfile full-path="o.opf"/>' + '<rootfile full-path="' * 100_000)
    z.writestr("META-INF/encryption.xml", 'Algorithm="' * 200_000)
    z.writestr("o.opf", "<dc:title" * 100_000 + "<item " + "a" * 3_000_000 + "<itemref idref=\"" * 100_000 + "<item" * 300_000)
(HOSTILE / "Opf.epub").write_bytes(bomb_opf.getvalue())
hostile = library.FileLibrary(TMP / "appdata" / "hostile.db", [HOSTILE], hub.read_pdf_pages)
started = time.monotonic()
hostile_books = hostile.index()["books"]
took = time.monotonic() - started
check(took < 30 and len(hostile_books) == 5, f"hostile files are read or refused in seconds, not hours ({took:.1f} s)",
      str([(Path(b["path"]).name, b.get("problem", "ok")) for b in hostile_books]))
check(any("Start of the made-up page" in h["text"] for h in hostile.search("made up page start", 3)),
      "text before an unclosed script is still found")

# ---- An EPUB's list of files is checked before the zip is opened (opening reads the whole list) ----
LISTS = TMP / "Lists"
LISTS.mkdir()


def claims(entries: int, central: int, zip64: bool = False) -> bytes:
    """A small real EPUB whose end record claims a different number of files or size of list."""
    data = bytearray(epub("Claims", [("Only", "text")]))
    at = data.rfind(b"PK\x05\x06")
    data[at + 8:at + 12] = entries.to_bytes(2, "little") * 2
    data[at + 12:at + 16] = central.to_bytes(4, "little")
    if zip64:
        data[at:at] = b"PK\x06\x07" + bytes(16)
    return bytes(data)


(LISTS / "Many.epub").write_bytes(claims(60_000, 3_000_000))
(LISTS / "Long list.epub").write_bytes(claims(10, 50_000_000))
(LISTS / "Zip64.epub").write_bytes(claims(10, 100, zip64=True))
(LISTS / "No end.epub").write_bytes(b"PK\x03\x04" + b"x" * 100)
lists = {Path(b["path"]).name: b.get("problem", "")
         for b in library.FileLibrary(TMP / "appdata" / "lists.db", [LISTS], hub.read_pdf_pages).index()["books"]}
check("more than 5,000 files" in lists["Many.epub"], "an EPUB claiming too many files is refused before opening", lists["Many.epub"])
check("more than 5,000 files" in lists["Long list.epub"], "an EPUB with a huge list of files is refused before opening", lists["Long list.epub"])
check(lists["Zip64.epub"] == library.NOT_EPUB and lists["No end.epub"] == library.NOT_EPUB, "ZIP64 and broken EPUBs are refused", str(lists))

# ---- A file that stopped the hub part-way is reported, not read again on every refresh ----
STOP = TMP / "Stop"
STOP.mkdir()
(STOP / "Heavy.txt").write_text("The made-up word quorlix is in here.", encoding="utf-8")
real_read = library.read_file


def stops(*args, **kwargs):
    raise SystemExit("the hub stopped")  # like the process ending part-way through reading


library.read_file = stops
try:
    library.FileLibrary(TMP / "appdata" / "stop.db", [STOP], hub.read_pdf_pages).index()
except SystemExit:
    pass
reads: list[int] = []
library.read_file = lambda *a, **k: reads.append(1) or real_read(*a, **k)
again = library.FileLibrary(TMP / "appdata" / "stop.db", [STOP], hub.read_pdf_pages)  # the hub starting again
stopped = again.index()["books"][0]
check(stopped.get("problem") == library.STOPPED and not reads, "a file that stopped the hub isn't read again", str(stopped))
(STOP / "Heavy.txt").write_text("Changed: the made-up word quorlix is fine now.", encoding="utf-8")
check(again.index()["books"][0].get("searchable") and reads, "once the file changes, it's read again")
library.read_file = real_read

failed = [n for ok, n in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
