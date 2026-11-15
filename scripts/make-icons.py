"""Draw Aislet's logo and write every icon file in assets/.

The mark is a ring with a break at the top right and a small dot that has come free of it: a loop
that isn't tied down. White on near-black. Run from the project folder:  python scripts/make-icons.py
(needs Pillow). Each shape is drawn four times larger, then scaled down, for smooth edges.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parent.parent / 'assets'
INK = (24, 24, 27)           # #18181B, the app's primary colour
INK_TOP = (36, 36, 41)       # a touch lighter at the top, for depth
WHITE = (255, 255, 255)
SS = 4                       # supersampling

# The mark, in units of the ring's radius.
STROKE = 0.40                # ring thickness
GAP_MID, GAP = -45.0, 86.0   # break centred at the top right, degrees wide (0° = right, clockwise)
DOT_R, DOT_DIST = 0.27, 1.62  # the free dot: radius and distance from the ring's centre


def _shape_points():
    """Points on the outline of the mark (unit radius), to find its extent."""
    pts = []
    for deg in range(0, 360, 2):
        if abs(((deg - GAP_MID + 180) % 360) - 180) < GAP / 2:
            continue
        a = math.radians(deg)
        pts.append(((1 + STROKE / 2) * math.cos(a), (1 + STROKE / 2) * math.sin(a)))
    a = math.radians(GAP_MID)
    cx, cy = DOT_DIST * math.cos(a), DOT_DIST * math.sin(a)
    for deg in range(0, 360, 10):
        b = math.radians(deg)
        pts.append((cx + DOT_R * math.cos(b), cy + DOT_R * math.sin(b)))
    return pts


def mark_mask(size: int, fit: float, by: str = 'box') -> Image.Image:
    """A white-on-black mask of the mark. `fit` is the share of the canvas it fills: its bounding box
    ('box') or, for Android's round safe zone, its farthest point from the middle ('radius')."""
    pts = _shape_points()
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    ox, oy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2  # centre the whole mark, dot included
    if by == 'box':
        unit = fit * size / max(max(xs) - min(xs), max(ys) - min(ys))
    else:
        unit = fit * size / 2 / max(math.hypot(x - ox, y - oy) for x, y in pts)
    big = size * SS
    u = unit * SS
    c = (big / 2 - ox * u, big / 2 - oy * u)
    m = Image.new('L', (big, big), 0)
    d = ImageDraw.Draw(m)

    def circle(x, y, r, fill):
        d.ellipse([x - r, y - r, x + r, y + r], fill=fill)

    circle(*c, (1 + STROKE / 2) * u, 255)                      # ring
    circle(*c, (1 - STROKE / 2) * u, 0)
    wedge = [c]                                                # cut the break
    for i in range(41):
        a = math.radians(GAP_MID - GAP / 2 + GAP * i / 40)
        wedge.append((c[0] + 2 * u * math.cos(a), c[1] + 2 * u * math.sin(a)))
    d.polygon(wedge, fill=0)
    for edge in (GAP_MID - GAP / 2, GAP_MID + GAP / 2):        # round ends
        a = math.radians(edge)
        circle(c[0] + u * math.cos(a), c[1] + u * math.sin(a), STROKE / 2 * u, 255)
    a = math.radians(GAP_MID)                                  # the free dot
    circle(c[0] + DOT_DIST * u * math.cos(a), c[1] + DOT_DIST * u * math.sin(a), DOT_R * u, 255)
    return m.resize((size, size), Image.LANCZOS)


def backdrop(size: int) -> Image.Image:
    """Near-black square, very slightly lighter at the top."""
    bg = Image.new('RGBA', (size, size))
    px = bg.load()
    for y in range(size):
        t = y / max(1, size - 1)
        col = tuple(round(INK_TOP[i] * (1 - t) + INK[i] * t) for i in range(3)) + (255,)
        for x in range(size):
            px[x, y] = col
    return bg


def icon(size: int, fit: float = 0.58) -> Image.Image:
    img = backdrop(size)
    img.paste(Image.new('RGBA', (size, size), WHITE + (255,)), (0, 0), mark_mask(size, fit))
    return img


def on_clear(size: int, fit: float, colour=WHITE) -> Image.Image:
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    img.paste(Image.new('RGBA', (size, size), colour + (255,)), (0, 0), mark_mask(size, fit, 'radius'))
    return img


def main() -> None:
    icon(1024).save(ASSETS / 'icon.png')
    icon(512).save(ASSETS / 'splash-icon.png')
    icon(48).save(ASSETS / 'favicon.png')
    icon(256).save(ASSETS / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    Image.new('RGBA', (512, 512), INK + (255,)).save(ASSETS / 'android-icon-background.png')
    # Android masks the icon to a circle or squircle; keep the mark inside its safe zone.
    on_clear(1024, 0.58).save(ASSETS / 'android-icon-foreground.png')
    on_clear(1024, 0.58).save(ASSETS / 'android-icon-monochrome.png')
    print('wrote icons to', ASSETS)


if __name__ == '__main__':
    main()
