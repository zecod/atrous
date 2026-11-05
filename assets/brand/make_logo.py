"""Atrous logo: a jet-black tile, a bold off-white Λ (an A without its bar) and one bright dot
where the bar would be: "à trous", with a hole. Writes SVGs and every raster size the app needs."""
import os
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))
INK = "#f3f1ec"      # the Λ
DOT = "#3ddc97"      # the hole / accent
TILE_TOP, TILE_BOT = (30, 31, 36), (9, 9, 11)

# Geometry on a 1024 canvas (macOS icon grid: an 824 px tile inset 100 px).
T0, TW, TR = 100, 824, 186
APEX, LEFT, RIGHT, STROKE = (512, 292), (322, 724), (702, 724), 112
DOTC, DOTR = (512, 624), 54


def svg(tile=True):
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
             '  <title>Atrous</title>']
    if tile:
        parts += ['  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">',
                  f'    <stop offset="0" stop-color="rgb{TILE_TOP}"/><stop offset="1" stop-color="rgb{TILE_BOT}"/>',
                  '  </linearGradient></defs>',
                  f'  <rect x="{T0}" y="{T0}" width="{TW}" height="{TW}" rx="{TR}" fill="url(#g)"/>',
                  f'  <rect x="{T0 + 1.5}" y="{T0 + 1.5}" width="{TW - 3}" height="{TW - 3}" rx="{TR - 1.5}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3"/>']
    ink = INK if tile else "currentColor"
    parts += [f'  <path d="M{LEFT[0]} {LEFT[1]} L{APEX[0]} {APEX[1]} L{RIGHT[0]} {RIGHT[1]}" fill="none" stroke="{ink}" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round"/>',
              f'  <circle cx="{DOTC[0]}" cy="{DOTC[1]}" r="{DOTR}" fill="{DOT}"/>',
              '</svg>']
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
    w = round(STROKE * k)
    pts = [tuple(c * k for c in p) for p in (LEFT, APEX, RIGHT)]
    d.line(pts, fill=INK, width=w, joint="curve")
    for p in (pts[0], pts[2]):  # round caps
        d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=INK)
    d.ellipse([(DOTC[0] - DOTR) * k, (DOTC[1] - DOTR) * k, (DOTC[0] + DOTR) * k, (DOTC[1] + DOTR) * k], fill=DOT)
    return im.resize((size, size), Image.LANCZOS)


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
# preview sheet: sizes on dark and light
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
