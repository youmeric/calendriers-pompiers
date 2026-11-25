from PIL import Image, ImageDraw, ImageFilter
import numpy as np
from collections import deque

def transparent(img, thr=235, seal=9, text_from_x=None):
    """Rend transparent le fond blanc extérieur ; les blancs à l'intérieur du dessin restent opaques."""
    a = np.array(img.convert('RGB')).astype(int)
    h, w = a.shape[:2]
    lum = a.min(axis=2)
    colored = lum < thr
    sealed = np.array(Image.fromarray((colored*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(seal))) > 0
    free = ~sealed
    out = np.zeros((h, w), bool)
    q = deque()
    for y in range(h):
        for x in range(w):
            if (y in (0, h-1) or x in (0, w-1)) and free[y, x] and not out[y, x]:
                out[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
            ny, nx = y+dy, x+dx
            if 0 <= ny < h and 0 <= nx < w and free[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True; q.append((ny, nx))
    grown = np.array(Image.fromarray((out*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(seal + 2))) > 0
    bg = grown & ~colored                      # fond extérieur jusqu'au trait
    alpha = np.where(bg, 0, 255).astype(np.uint8)
    # anti-crénelage : pixels de bord partiellement transparents selon leur clarté
    near = (np.array(Image.fromarray(alpha).filter(ImageFilter.MinFilter(3))) == 0) & ~bg
    soft = np.clip((248 - lum) * 255 / 110, 0, 255).astype(np.uint8)
    alpha = np.where(near, soft, alpha).astype(np.uint8)
    if text_from_x is not None:            # zone texte : tout le blanc devient transparent (intérieur des lettres)
        z = np.zeros((h, w), bool); z[:, text_from_x:] = True
        alpha = np.where(z, soft, alpha).astype(np.uint8); near = near | (z & (soft < 255))
    # couleur des pixels de bord : retirer le blanc (dé-prémultiplication simple)
    rgb = a.astype(float)
    af = alpha[..., None] / 255.0
    rgb = np.where(near[..., None] & (af > 0), np.clip((rgb - 255 * (1 - af)) / np.maximum(af, 1e-3), 0, 255), rgb)
    return Image.fromarray(np.dstack([rgb.astype(np.uint8), alpha]), 'RGBA')

logo = transparent(Image.open('src-logo.webp'), text_from_x=800)
logo.crop(logo.getbbox()).save('logo-complet.png')
mono = transparent(Image.open('src-mono.webp'), text_from_x=800)
mono.crop(mono.getbbox()).save('logo-monochrome.png')

# Logo d'en-tête : symbole + nom (sans le slogan, illisible en petit)
sym = logo.crop((20, 90, 728, 602)); sym = sym.crop(sym.getbbox())
wm = logo.crop((818, 150, 2130, 455)); wm = wm.crop(wm.getbbox())
H = sym.height
wm_h = int(H * 0.62); wm = wm.resize((round(wm.width * wm_h / wm.height), wm_h), Image.LANCZOS)
gap = int(H * 0.10)
canvas = Image.new('RGBA', (sym.width + gap + wm.width, H), (0, 0, 0, 0))
canvas.paste(sym, (0, 0), sym)
canvas.paste(wm, (sym.width + gap, int(H * 0.12)), wm)
canvas.save('logo-entete.png')
sym.save('symbole.png')

# Icône : contenu sur fond marine plein, sans le liseré blanc ni les coins noirs
ic = Image.open('src-icone.webp').convert('RGB')
a = np.array(ic).astype(int)
NAVY = (0, 22, 54)
# zone marine : le carré arrondi intérieur au liseré blanc
inset = 55
inner = ic.crop((inset, inset, ic.width - inset, ic.height - inset))
mask = Image.new('L', inner.size, 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, inner.width-1, inner.height-1), radius=245, fill=255)
mask = mask.filter(ImageFilter.GaussianBlur(2))
bg = Image.new('RGB', inner.size, (0, 25, 63))
bg.paste(inner, (0, 0), mask)
bg.save('icone-plein.png')            # carré plein (iOS / Android arrondissent eux-mêmes)
for s, n in ((512, 'icone-512.png'), (192, 'icone-192.png'), (180, 'apple-touch-180.png')):
    bg.resize((s, s), Image.LANCZOS).save(n)
# Icône arrondie transparente (affichage web)
r = Image.new('L', bg.size, 0)
ImageDraw.Draw(r).rounded_rectangle((0, 0, bg.width-1, bg.height-1), radius=int(bg.width*0.22), fill=255)
rr = bg.convert('RGBA'); rr.putalpha(r); rr.save('icone-arrondie.png')

# Favicon : seulement le casque + calendrier (le nom est illisible à 32 px)
symi = ic.crop((120, 140, 1110, 790))
side = max(symi.size) + 50
fav = Image.new('RGB', (side, side), NAVY)
fav.paste(symi, ((side - symi.width)//2, (side - symi.height)//2))
fm = Image.new('L', fav.size, 0)
ImageDraw.Draw(fm).rounded_rectangle((0, 0, side-1, side-1), radius=int(side*0.22), fill=255)
fav = fav.convert('RGBA'); fav.putalpha(fm)
for s in (32, 64, 192): fav.resize((s, s), Image.LANCZOS).save(f'favicon-{s}.png')
fav.resize((48, 48), Image.LANCZOS).save('favicon.ico', sizes=[(16,16),(32,32),(48,48)])
print('ok', canvas.size, logo.getbbox())
