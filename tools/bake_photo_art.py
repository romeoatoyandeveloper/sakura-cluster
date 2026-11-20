#!/usr/bin/env python3
"""The photo themes' art (shared/shaders.js photo): a cut-out photo, drawn 1:1 on the cluster.

    python3 tools/bake_photo_art.py prep <photo.jpg> <name> <x0,y0,x1,y1> <width>   # once, from the original photo
    python3 tools/bake_photo_art.py                                                 # bake every tools/photo-src/*.png

prep: crops the original (a cut-out on pure black, as a phone's "lift subject" gives) to the box, scales it to <width>
panel px wide and writes tools/photo-src/<name>.png with the cut-out as alpha: the black background thresholded,
gaps in dark hair closed, holes filled, the edge feathered 1.6 px. Light only: a touch brighter (6 %) and clearer
(contrast 4 %, a soft unsharp mask), nothing retouched. The original stays out of the repo; the prepared PNG is
the source.

bake: writes apps/cluster_themes/hud/art/<name>.json, { w, h, z, sprites }, z = base64 of the zlib-deflated RGBA rows
(JSON because the kit packs hud/ as JSON only), as tools/bake_sakura_art.py. hud.js uploads it once per connection as
an RGBA8 asset; it costs w x h x 8 bytes of cluster-render's 16 MiB pixel memory (the service counts it twice).
"""
import base64, json, os, sys, zlib
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'photo-src')
OUT = os.path.join(HERE, '..', 'apps', 'cluster_themes', 'hud', 'art')


def prep(photo, name, box, width):
    im = Image.open(photo).convert('RGB').crop(box)
    height = round(im.height * width / im.width)
    # the cut-out: the background is pure black (r + g + b under ~40 in a JPEG), so anything brighter is him
    m = im.convert('L').point(lambda v: 255 if v > 12 else 0)
    m = m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))    # close gaps in dark hair
    m = m.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))    # drop JPEG specks
    f = m.copy()
    ImageDraw.floodfill(f, (0, 0), 128)                                          # the background, from a corner
    m = f.point(lambda v: 0 if v == 128 else 255)                                # the rest is him, holes filled
    im = im.resize((width, height), Image.LANCZOS)
    m = m.resize((width, height), Image.LANCZOS).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.6))
    im = ImageEnhance.Brightness(im).enhance(1.06)
    im = ImageEnhance.Contrast(im).enhance(1.04)
    im = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=40, threshold=2))
    out = im.convert('RGBA')
    out.putalpha(m)
    os.makedirs(SRC, exist_ok=True)
    path = os.path.join(SRC, name + '.png')
    out.save(path, optimize=True)
    print('%s: %dx%d' % (os.path.relpath(path), width, height))


def bake():
    os.makedirs(OUT, exist_ok=True)
    for f in sorted(os.listdir(SRC)):
        if not f.endswith('.png'): continue
        im = Image.open(os.path.join(SRC, f)).convert('RGBA')
        w, h = im.size
        # premultiply nothing: the shader mixes by alpha. Fully see-through texels are zeroed so they deflate well.
        px = bytearray(im.tobytes())
        for i in range(3, len(px), 4):
            if px[i] == 0: px[i - 3] = px[i - 2] = px[i - 1] = 0
        out = os.path.join(OUT, f[:-4] + '.json')
        with open(out, 'w') as fh:
            json.dump({'w': w, 'h': h, 'z': base64.b64encode(zlib.compress(bytes(px), 9)).decode('ascii'),
                       'sprites': {'photo': [0, 0, w, h]}}, fh, separators=(',', ':'))
        print('%-10s %dx%d, %.1f MiB of pixel memory, %d bytes in %s' % (f[:-4], w, h, w * h * 8 / 1048576,
                                                                         os.path.getsize(out), os.path.relpath(out)))


if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == 'prep':
        prep(a[1], a[2], tuple(int(v) for v in a[3].split(',')), int(a[4]))
    else:
        bake()
