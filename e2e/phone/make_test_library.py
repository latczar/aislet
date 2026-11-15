"""Make e2e/phone/fixtures/e2e-library.zim: a tiny, made-up Kiwix library for the `library` check.

Run it on Linux or in WSL, where the libzim package works (Windows Smart App Control blocks its DLL):
    python3 -m venv /tmp/zim && /tmp/zim/bin/pip install libzim==4.1.0
    /tmp/zim/bin/python e2e/phone/make_test_library.py
"""
from __future__ import annotations

from pathlib import Path

from libzim.writer import Creator, Hint, Item, StringProvider

OUT = Path(__file__).resolve().parent / "fixtures" / "e2e-library.zim"

PAGES = {
    "Lumen-7_lantern": ("Lumen-7 lantern", [
        "E2E check facts. The Lumen-7 lantern is a made-up camping lantern used to test Untethered's libraries.",
        "How long does it run? The Lumen-7 lantern can run for 42 hours on three AA batteries at its lowest setting, "
        "or 9 hours at full brightness. Its batteries sit under a twist-off base.",
    ]),
    "Tidewick_kettle": ("Tidewick kettle", [
        "E2E check facts. The Tidewick kettle is a made-up camping kettle that boils a litre of water in 6 minutes on a small stove.",
    ]),
    "home": ("E2E Test Library", ["A made-up library for Untethered's phone checks. See Lumen-7 lantern and Tidewick kettle."]),
}


class Page(Item):
    def __init__(self, path: str, title: str, paragraphs: list[str]):
        super().__init__()
        self.path, self.title = path, title
        body = "".join(f"<p>{p}</p>" for p in paragraphs)
        self.html = f"<!DOCTYPE html><html><head><title>{title}</title></head><body><h1>{title}</h1>{body}</body></html>"

    def get_path(self) -> str:
        return self.path

    def get_title(self) -> str:
        return self.title

    def get_mimetype(self) -> str:
        return "text/html"

    def get_contentprovider(self):
        return StringProvider(self.html)

    def get_hints(self):
        return {Hint.FRONT_ARTICLE: True}


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.unlink(missing_ok=True)
    with Creator(str(OUT)).config_indexing(True, "eng") as creator:
        creator.set_mainpath("home")
        for key, value in {
            "Name": "untethered_e2e_test", "Title": "E2E Test Library", "Creator": "Untethered", "Publisher": "Untethered",
            "Date": "2026-11-15", "Description": "Made-up pages for Untethered's phone checks", "Language": "eng",
        }.items():
            creator.add_metadata(key, value)
        for path, (title, paragraphs) in PAGES.items():
            creator.add_item(Page(path, title, paragraphs))
    print(f"Wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
