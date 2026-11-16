"""Make the website's images in site/: logo, favicons, the social-share card and compressed screenshots.

The mark is the same one scripts/make-icons.py draws (a ring with a break at the top right and a free
dot), written here as SVG so it stays sharp at any size. Run from the project folder:

    python scripts/make-site-assets.py                 # screenshots from docs/images
    python scripts/make-site-assets.py --images DIR    # screenshots from another folder

Needs Pillow, and ffmpeg on the PATH for the demo video. The social card uses Segoe UI when it's
installed (Windows) and Pillow's own font otherwise.
"""
import argparse
import math
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / 'site'
sys.path.insert(0, str(ROOT / 'scripts'))
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location('make_icons', ROOT / 'scripts' / 'make-icons.py')
icons = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(icons)

INK = '#18181B'


def mark_svg_parts(unit: float, cx: float, cy: float, colour: str = 'currentColor') -> str:
    """SVG elements for the mark, ring radius `unit`, its whole-mark centre at (cx, cy)."""
    pts = icons._shape_points()
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    ox, oy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    c = (cx - ox * unit, cy - oy * unit)
    a1 = math.radians(icons.GAP_MID + icons.GAP / 2)        # where the ring starts, after the break
    a2 = math.radians(icons.GAP_MID - icons.GAP / 2 + 360)  # where it ends, before the break
    p1 = (c[0] + unit * math.cos(a1), c[1] + unit * math.sin(a1))
    p2 = (c[0] + unit * math.cos(a2), c[1] + unit * math.sin(a2))
    ad = math.radians(icons.GAP_MID)
    dot = (c[0] + icons.DOT_DIST * unit * math.cos(ad), c[1] + icons.DOT_DIST * unit * math.sin(ad))
    f = lambda v: f'{v:.2f}'.rstrip('0').rstrip('.')  # noqa: E731
    return (
        f'<path d="M{f(p1[0])} {f(p1[1])}A{f(unit)} {f(unit)} 0 1 1 {f(p2[0])} {f(p2[1])}" fill="none" '
        f'stroke="{colour}" stroke-width="{f(icons.STROKE * unit)}" stroke-linecap="round"/>'
        f'<circle cx="{f(dot[0])}" cy="{f(dot[1])}" r="{f(icons.DOT_R * unit)}" fill="{colour}"/>'
    )


def mark_extent() -> float:
    """Width (= height) of the mark's bounding box, in ring radii."""
    pts = icons._shape_points()
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def write_svgs() -> None:
    ext = mark_extent()
    # The bare mark: fills a 100 x 100 box, coloured by the text colour around it.
    unit = 100 / ext
    (SITE / 'img' / 'mark.svg').write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">{mark_svg_parts(unit, 50, 50)}</svg>\n')
    # The app icon: white mark on graphite, as on the phone.
    unit = 58 / ext
    (SITE / 'favicon.svg').write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        f'<rect width="100" height="100" rx="22" fill="{INK}"/>{mark_svg_parts(unit, 50, 50, "#fff")}</svg>\n')


def write_pngs() -> None:
    icons.icon(180).save(SITE / 'apple-touch-icon.png', optimize=True)
    icons.icon(192).save(SITE / 'icon-192.png', optimize=True)
    icons.icon(512).save(SITE / 'icon-512.png', optimize=True)
    icons.icon(48).save(SITE / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])


def font(bold: bool, size: int):
    for name in (['seguisb.ttf', 'segoeuib.ttf'] if bold else ['segoeui.ttf']):
        p = Path('C:/Windows/Fonts') / name
        if p.exists():
            return ImageFont.truetype(str(p), size)
    return ImageFont.load_default(size)


def write_og() -> None:
    """The 1200 x 630 card shown when someone shares a link to the site."""
    w, h = 1200, 630
    img = Image.new('RGB', (w, h), (24, 24, 27))
    mark = 150
    m = icons.mark_mask(mark, 1.0)
    img.paste((255, 255, 255), (96, 96), m)
    d = ImageDraw.Draw(img)
    d.text((96, 300), 'Aislet', font=font(True, 96), fill=(255, 255, 255))
    d.text((96, 430), 'A library and an AI in your pocket.', font=font(False, 44), fill=(244, 244, 245))
    d.text((96, 492), 'No signal needed, sources shown.', font=font(False, 44), fill=(161, 161, 170))
    img.save(SITE / 'og.png', optimize=True)


def write_screens(src: Path) -> None:
    out = SITE / 'img'
    for name in ('summarise-pdf', 'settings-ai', 'library-answer'):
        Image.open(src / f'{name}.png').convert('RGB').save(out / f'{name}.webp', quality=86, method=6)
    gif = src / 'demo.gif'
    im = Image.open(gif)
    im.seek(im.n_frames - 1)  # the finished reply: what shows before it plays, or if it never does
    im.convert('RGB').save(out / 'demo-poster.webp', quality=86, method=6)
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        print('ffmpeg not found: skipped demo.mp4')
        return
    subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-i', str(gif), '-movflags', '+faststart',
                    '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264',
                    '-preset', 'slow', '-crf', '24', '-an', str(out / 'demo.mp4')], check=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--images', type=Path, default=ROOT / 'docs' / 'images')
    args = ap.parse_args()
    (SITE / 'img').mkdir(parents=True, exist_ok=True)
    write_svgs()
    write_pngs()
    write_og()
    write_screens(args.images)
    print('wrote site images to', SITE)


if __name__ == '__main__':
    main()
