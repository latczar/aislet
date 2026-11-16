"""Small, valid PDFs and EPUBs with made-up text, for the library tests (pc/tests/library_test.py) and the
phone check (e2e/phone/run.py library_files). Never real documents."""
from __future__ import annotations

import io
import zipfile


def pdf(pages: list[str]) -> bytes:
    """A PDF with one line of text per page (an empty string makes a page with no text)."""
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for text in pages:
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET"
        objects.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {len(objects)} 0 R >>")
        kids.append(f"{len(objects)} 0 R")
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"
    out, offsets = io.BytesIO(), []
    out.write(b"%PDF-1.4\n")
    for i, body in enumerate(objects, 1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n{body}\nendobj\n".encode("latin-1"))
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for o in offsets:
        out.write(f"{o:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def epub(title: str, chapters: list[tuple[str, str]], extra: dict[str, bytes] | None = None) -> bytes:
    """An EPUB whose reading order is the reverse of its file names (to check the order is followed).
    Each chapter has a heading, a paragraph, and script text in its head that must never be read."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
        items = "".join(f'<item id="c{i}" href="text/ch{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(len(chapters)))
        spine = "".join(f'<itemref idref="c{i}"/>' for i in reversed(range(len(chapters))))
        z.writestr("OEBPS/content.opf", f'<package><metadata><dc:title>{title}</dc:title></metadata><manifest>{items}</manifest><spine>{spine}</spine></package>')
        for i, (heading, text) in enumerate(chapters):
            z.writestr(f"OEBPS/text/ch{i}.xhtml", f"<html><head><title>x</title><script>var secret = 'script text';</script></head><body><h1>{heading}</h1><p>{text}</p></body></html>")
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return out.getvalue()
