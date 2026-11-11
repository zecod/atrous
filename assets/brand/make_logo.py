"""Atrous logo: a jet-black tile and a chunky 8-bit goat ("atrous" is goat in Moroccan Darija): a sturdy
ibex in off-white with grey shading, two ridged horns sweeping back, an eye, a beard and hooves, drawn
on a 20x22 pixel grid. Writes SVGs and every raster size the app needs. Needs Pillow."""
import os
import re
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))
TILE_TOP, TILE_BOT = (30, 31, 36), (9, 9, 11)

# The goat's tones, one character each; "." is empty (the eye is a hole onto the tile).
TONES = {
    "#": "#f3f1ec",  # coat
    "+": "#a3a19c",  # shade
    "=": "#5e5d5a",  # deep shade
    "H": "#5c5c61",  # horn, nose
    "r": "#b8b6b1",  # horn ridge
    "k": "#86847f",  # hoof
}
# The one-colour mark (currentColor) keeps the shading as opacity.
MARK_OPACITY = {"#": 1, "+": 0.62, "=": 0.34, "H": 0.4, "r": 0.75, "k": 0.5}

# The goat, one character per cell. Facing right; horns over its back.
GOAT = """
.......HHrHH........
.....HHHHHHHr.......
.....H.....HHHr.....
.......HHrH..HHr....
.....HHHHHHrH.HH....
.....H....HHH..H#...
............H++###..
..............+#.##.
............##+#####
...........###++###H
.........######+=##.
...############+.##.
.#############++..#.
##+###########+#....
#++############+....
.++############+....
.++#=++++++###++....
.#===++++=##===.....
.##.##....##.##.....
.##.##....##.##.....
.##.##....##.##.....
.kk.kk....kk.kk.....
""".strip().split("\n")

# Copies of the icon elsewhere in the repo (path from the repo root: pixel size), so the app's own
# screens (sidebar, Flow, Help, What's new, onboarding) never show an older mark than the app icon.
ROOT = os.path.dirname(os.path.dirname(OUT))
COPIES = {
    "fedra/home/mods/my-chrome/atrous.png": 256,
    "fedra/home/mods/flow-canvas/atrous.png": 256,
    "defaults/mods/help/atrous.png": 256,
    "defaults/mods/workspace-chrome/atrous.png": 160,
    "defaults/frame/whatsnew/atrous.png": 160,
}
SVG_COPIES = ["fedra/home/mods/onboarding/logo.svg"]
# The DMG window's faint watermark: the goat's silhouette, in the <svg class="mark"> path.
DMG_BACKGROUND = "distribution/macos/dmg/background.html"
# Layout thumbnails draw the goat on their own small tile, scaled from this 1024 grid; each keeps its
# own position (the translate), the goat inside is replaced.
THUMBS = ["fedra/home/layouts/fedra.svg", "fedra/home/layouts/flow.svg"]
THUMB_GOAT = re.compile(r'<(?:path|g) transform="(translate\([^)]*\) scale\(0\.009709\))"(?: d="[^"]*"[^>]*/>|[^>]*>.*?</g>)', re.S)

# Geometry on a 1024 canvas (macOS icon grid: an 824 px tile inset 100 px), the goat centred on it.
T0, TW, TR = 100, 824, 186
CELL = 30
COLS, ROWS = len(GOAT[0]), len(GOAT)
GX, GY = (1024 - COLS * CELL) // 2, (1024 - ROWS * CELL) // 2
assert all(len(line) == COLS for line in GOAT), "every GOAT row must be the same width"
assert set("".join(GOAT)) <= set(TONES) | {"."}, "GOAT uses a tone missing from TONES"


def runs(tones):
    """Each row's runs of cells in `tones` as (x, y, w, tone) in cells: one rectangle per run."""
    for r, line in enumerate(GOAT):
        c = 0
        while c < len(line):
            t = line[c]
            if t in tones:
                s = c
                while c < len(line) and line[c] == t:
                    c += 1
                yield s, r, c - s, t
            else:
                c += 1


def path(tones):
    return "".join(f"M{GX + x * CELL} {GY + y * CELL}h{w * CELL}v{CELL}h-{w * CELL}z" for x, y, w, _ in runs(tones))


def silhouette():
    """The whole goat as one path (every tone), merged per row."""
    line = lambda row: "".join("#" if ch != "." else "." for ch in row)
    rows = [line(row) for row in GOAT]
    out = []
    for r, row in enumerate(rows):
        for m in re.finditer(r"#+", row):
            x, w = m.start(), m.end() - m.start()
            out.append(f"M{GX + x * CELL} {GY + r * CELL}h{w * CELL}v{CELL}h-{w * CELL}z")
    return "".join(out)


def svg(tile=True):
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
             '  <title>Atrous</title>']
    if tile:
        parts += ['  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">',
                  f'    <stop offset="0" stop-color="rgb{TILE_TOP}"/><stop offset="1" stop-color="rgb{TILE_BOT}"/>',
                  '  </linearGradient></defs>',
                  f'  <rect x="{T0}" y="{T0}" width="{TW}" height="{TW}" rx="{TR}" fill="url(#g)"/>',
                  f'  <rect x="{T0 + 1.5}" y="{T0 + 1.5}" width="{TW - 3}" height="{TW - 3}" rx="{TR - 1.5}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3"/>']
    parts.append('  <g shape-rendering="crispEdges">')
    for t, color in TONES.items():
        fill = f'fill="{color}"' if tile else f'fill="currentColor" fill-opacity="{MARK_OPACITY[t]}"'
        parts.append(f'    <path d="{path(t)}" {fill}/>')
    parts += ['  </g>', '</svg>']
    return "\n".join(parts) + "\n"


def raster(size, tile=True):
    ss = 4
    S = size * ss
    k = S / 1024
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if tile:
        # vertical gradient tile, clipped to a rounded rect
        grad = Image.new("RGBA", (S, S))
        gd = ImageDraw.Draw(grad)
        for y in range(S):
            f = min(1, max(0, (y / k - T0) / TW))
            c = tuple(round(TILE_TOP[i] + (TILE_BOT[i] - TILE_TOP[i]) * f) for i in range(3))
            gd.line([(0, y), (S, y)], fill=c + (255,))
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([T0 * k, T0 * k, (T0 + TW) * k, (T0 + TW) * k], radius=TR * k, fill=255)
        im.paste(grad, (0, 0), mask)
        d.rounded_rectangle([(T0 + 1.5) * k, (T0 + 1.5) * k, (T0 + TW - 1.5) * k, (T0 + TW - 1.5) * k],
                            radius=(TR - 1.5) * k, outline=(255, 255, 255, 20), width=max(1, round(3 * k)))
    for x, y, w, t in runs(TONES):
        x0, y0 = (GX + x * CELL) * k, (GY + y * CELL) * k
        d.rectangle([x0, y0, x0 + w * CELL * k - 1, y0 + CELL * k - 1], fill=TONES[t])
    return im.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    open(os.path.join(OUT, "atrous.svg"), "w", encoding="utf-8").write(svg(True))
    open(os.path.join(OUT, "atrous-mark.svg"), "w", encoding="utf-8").write(svg(False))
    big = raster(1024)
    big.save(os.path.join(OUT, "atrous-1024.png"))
    for s in (512, 256, 128, 64, 32):
        raster(s).save(os.path.join(OUT, f"atrous-{s}.png"))
    # Windows icon: every size drawn on its own (crisper than downscaling the 256)
    ico_sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    raster(256).save(os.path.join(OUT, "atrous.ico"), sizes=[(s, s) for s in ico_sizes],
                     append_images=[raster(s) for s in ico_sizes[:-1]])
    big.save(os.path.join(OUT, "Atrous.icns"))
    for rel, size in COPIES.items():
        raster(size).save(os.path.join(ROOT, rel))
    for rel in SVG_COPIES:
        open(os.path.join(ROOT, rel), "w", encoding="utf-8").write(svg(True))
    def sync(rel, pattern, repl):
        """Replace the goat inside a file that embeds it; exactly one match expected."""
        f = os.path.join(ROOT, rel)
        text, n = re.subn(pattern, repl, open(f, encoding="utf-8").read())
        assert n == 1, f"expected one goat in {rel}, found {n}"
        open(f, "w", encoding="utf-8").write(text)
    sync(DMG_BACKGROUND, r'(<svg class="mark"[^>]*>\s*<path d=")[^"]*(")', lambda m: m.group(1) + silhouette() + m.group(2))
    for rel in THUMBS:
        sync(rel, THUMB_GOAT, lambda m: f'<g transform="{m.group(1)}" shape-rendering="crispEdges">'
             + "".join(f'<path d="{path(t)}" fill="{c}"/>' for t, c in TONES.items()) + "</g>")
    # preview sheet (not kept in the repo): sizes on dark and light
    sheet = Image.new("RGBA", (1200, 330), (40, 42, 46, 255))
    x = 20
    for s in (256, 128, 64, 32, 16):
        sheet.alpha_composite(raster(s), (x, 20 + (256 - s) // 2)); x += s + 30
    light = Image.new("RGBA", (1200, 50), (236, 236, 232, 255))
    xx = 20
    for s in (32, 16):
        light.alpha_composite(raster(s), (xx, 9 if s == 32 else 17)); xx += 60
    sheet.paste(light, (0, 290))
    sheet.save(os.path.join(OUT, "preview.png"))
    print("ok", sorted(os.listdir(OUT)))
