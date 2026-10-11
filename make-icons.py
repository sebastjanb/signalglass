# Icons for the glasses apps. Usage: make-icons.py <mail|chat> <site dir> <r,g,b>
# Writes the colour icons and the glasses mask (alpha only, tinted by the
# theme colour in .well-known/meta-wearables-manifest.json).
import sys
from PIL import Image, ImageDraw

shape, out, rgb = sys.argv[1], sys.argv[2], tuple(int(v) for v in sys.argv[3].split(','))
SS = 4

def mail(s):
    """Envelope: rounded card with the flap drawn as a cut line."""
    m = Image.new('L', (s, s), 0)
    d = ImageDraw.Draw(m)
    x0, y0, x1, y1 = s * .14, s * .25, s * .86, s * .75
    d.rounded_rectangle([x0, y0, x1, y1], radius=s * .07, fill=255)
    w = int(s * .055)
    pts = [(x0 + s * .05, y0 + s * .07), (s / 2, s * .54), (x1 - s * .05, y0 + s * .07)]
    d.line(pts, fill=0, width=w, joint='curve')
    return m

def chat(s):
    """Speech bubble with a tail and three dots."""
    m = Image.new('L', (s, s), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([s * .13, s * .15, s * .87, s * .79], fill=255)
    d.polygon([(s * .24, s * .66), (s * .17, s * .90), (s * .44, s * .76)], fill=255)
    r = s * .045
    for cx in (.34, .50, .66):
        d.ellipse([s * cx - r, s * .47 - r, s * cx + r, s * .47 + r], fill=0)
    return m

draw = {'mail': mail, 'chat': chat}[shape]

def mask(size):
    im = Image.new('RGBA', (size * SS, size * SS), (255, 255, 255, 0))
    im.putalpha(draw(size * SS))
    return im.resize((size, size), Image.LANCZOS)

def colour(size):
    s = size * SS
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    bg = Image.new('L', (s, s), 0)
    ImageDraw.Draw(bg).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * .225), fill=255)
    im.paste((14, 16, 20, 255), mask=bg)
    inner = draw(int(s * .8))
    pad = (s - inner.width) // 2
    im.paste(rgb + (255,), (pad, pad), mask=inner)
    return im.resize((size, size), Image.LANCZOS)

mask(256).save(out + '/.well-known/icon.png')
for n in (96, 192):
    colour(n).save(f'{out}/icon-{n}.png')
