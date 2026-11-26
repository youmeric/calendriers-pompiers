"""Logo pour fond foncé (pied de page de la vitrine…) : symbole et nom tirés de l'icône (nom en blanc)."""
from PIL import Image, ImageFilter
import numpy as np
from collections import deque

from PIL import ImageDraw
ic = Image.open('src-icone.webp').convert('RGB')
# on efface le liseré blanc arrondi de l'icône (tout ce qui est hors du carré marine intérieur)
navy = Image.new('RGB', ic.size, (0, 20, 50))
m = Image.new('L', ic.size, 0)
ImageDraw.Draw(m).rounded_rectangle((78, 78, ic.width - 79, ic.height - 79), radius=230, fill=255)
ic = Image.composite(ic, navy, m)
crop = ic.crop((90, 110, 1164, 1075))
a = np.array(crop).astype(int)
h, w = a.shape[:2]
r, g, b = a[..., 0], a[..., 1], a[..., 2]
bg = (r < 45) & (g < 65) & (b < 115) & (b >= g)
out = np.zeros((h, w), bool); q = deque()
for y in range(h):
    for x in (0, w - 1):
        if bg[y, x] and not out[y, x]: out[y, x] = True; q.append((y, x))
for x in range(w):
    for y in (0, h - 1):
        if bg[y, x] and not out[y, x]: out[y, x] = True; q.append((y, x))
while q:
    y, x = q.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < h and 0 <= nx < w and bg[ny, nx] and not out[ny, nx]:
            out[ny, nx] = True; q.append((ny, nx))
# trous entourés de blanc (intérieur des lettres) : fond aussi
lum = a.max(axis=2)
alpha = np.where(out, 0, 255).astype(np.uint8)
near = (np.array(Image.fromarray(alpha).filter(ImageFilter.MaxFilter(3))) > 0) & out
soft = np.clip((lum - 70) * 255 / 140, 0, 255).astype(np.uint8)
alpha = np.where(near, soft, alpha).astype(np.uint8)
img = Image.fromarray(np.dstack([a.astype(np.uint8), alpha]), 'RGBA')
sym = img.crop((0, 0, w, 792 - 110)); sym = sym.crop(sym.getbbox())
wm = img.crop((0, 796 - 110, w, 1066 - 110)); wm = wm.crop(wm.getbbox())
# intérieur des lettres (marine enfermé) -> transparent
wa = np.array(wm).astype(int)
rr, gg, bb = wa[..., 0], wa[..., 1], wa[..., 2]
dark = (rr < 45) & (gg < 65) & (bb < 115)
wa[..., 3] = np.where(dark, 0, wa[..., 3])
wm = Image.fromarray(wa.astype(np.uint8), 'RGBA')
H = sym.height
wm_h = int(H * 0.56); wm = wm.resize((round(wm.width * wm_h / wm.height), wm_h), Image.LANCZOS)
gap = int(H * 0.08)
c = Image.new('RGBA', (sym.width + gap + wm.width, H), (0, 0, 0, 0))
c.paste(sym, (0, 0), sym); c.paste(wm, (sym.width + gap, int(H * 0.22)), wm)
c.save('logo-fond-fonce.png')
c.resize((int(c.width * 132 / c.height), 132), Image.LANCZOS).save('web-logo-fond-fonce.png', optimize=True)
prev = Image.new('RGB', (c.width + 80, c.height + 80), (11, 22, 48)); prev.paste(c, (40, 40), c)
prev.resize((prev.width // 2, prev.height // 2)).save('check-fonce.png')
print(c.size)
