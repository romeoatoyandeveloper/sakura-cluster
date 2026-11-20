#!/usr/bin/env python3
"""Pack the Sakura themes' pixel art into one RGBA texture each for their shader (shared/shaders.js sakura).

    python3 tools/bake_sakura_art.py

Reads tools/sakura-src/ (the art at 1 art pixel = 1 px; on the cluster each art pixel is 4 x 4) and writes
apps/cluster_themes/hud/art/<theme>.json: { w, h, z, sprites }, z = base64 of the zlib-deflated RGBA rows (JSON because
the kit packs hud/ as JSON only). hud.js uploads it once per connection as an RGBA8 asset with nearest sampling.
Every theme has its own scene and the same sprites: sakura (the first), sakura_line (Blue Hour Line), sakura_moon
(Moon Mirror), sakura_grove (Hanami Grove).

Atlas (art px):  0,0    the scene, 480 x 180 (sky, Fuji, torii, lake, the tree, the rev twig)
                 0,180  the rev blossoms, 9 sprites of 12 x 12: bud, pink half / full, white half / full,
                        red half / full, shift a, shift b
                 112,180 the petals: 3 rows (a, b, c) of 4 frames, 4 x 4 each
                 132,180 the G-meter ring, 40 x 40
                 176,180 the G-meter dot, 4 x 4
                 184,180 the rev numerals 1..7 (Press Start 2P's 8 x 8 font pixels; the shader draws one font
                        pixel as 2 x 2 panel px, white, tinted there)
"""
import base64, json, os, zlib
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'sakura-src')
OUT = os.path.join(HERE, '..', 'apps', 'cluster_themes', 'hud', 'art')
W, H = 480, 220
SCENES = {'sakura': 'scene_composite_480x180.png', 'sakura_line': 'scene_line_480x180.png',
          'sakura_moon': 'scene_moon_480x180.png', 'sakura_grove': 'scene_grove_480x180.png'}
PARTS = [('blossoms', 'blossom_sheet.png', 0, 180, (108, 12)),
         ('petals', 'petals_sheet.png', 112, 180, (16, 12)), ('ring', 'gmeter_ring.png', 132, 180, (40, 40)),
         ('dot', 'gmeter_dot.png', 176, 180, (4, 4))]

sheet = Image.new('RGBA', (W, H), (0, 0, 0, 0))
sprites = {}
for name, f, x, y, size in PARTS:
    im = Image.open(os.path.join(SRC, f)).convert('RGBA')
    assert im.size == size, (f, im.size)
    sheet.paste(im, (x, y))
    sprites[name] = [x, y, size[0], size[1]]
# the rev numerals: Press Start 2P at its own 8 px, no anti-aliasing, the ink in rows 0..6 of each 8 x 8 cell
digits = Image.new('L', (56, 8), 0)
draw = ImageDraw.Draw(digits)
draw.fontmode = '1'
font = ImageFont.truetype(os.path.join(HERE, 'fonts-src', 'PressStart2P-Regular.ttf'), 8)
for i, ch in enumerate('1234567'):
    draw.text((i * 8, 8), ch, font=font, fill=255, anchor='ls')
white = Image.new('RGBA', (56, 8), (255, 255, 255, 0))
white.putalpha(digits)
sheet.paste(white, (184, 180))
sprites['numerals'] = [184, 180, 56, 8]
os.makedirs(OUT, exist_ok=True)
for theme, f in SCENES.items():
    scene = Image.open(os.path.join(SRC, f)).convert('RGBA')
    assert scene.size == (480, 180), (f, scene.size)
    atlas = sheet.copy()
    atlas.paste(scene, (0, 0))
    raw = atlas.tobytes()
    out = os.path.join(OUT, theme + '.json')
    with open(out, 'w') as fh:
        json.dump({'w': W, 'h': H, 'z': base64.b64encode(zlib.compress(raw, 9)).decode('ascii'),
                   'sprites': dict(sprites, scene=[0, 0, 480, 180])}, fh, separators=(',', ':'))
    print('%-13s %dx%d, %d bytes raw, %d bytes in %s' % (theme, W, H, len(raw), os.path.getsize(out), os.path.relpath(out)))
