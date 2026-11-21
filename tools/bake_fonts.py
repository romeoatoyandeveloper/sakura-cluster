#!/usr/bin/env python3
"""Bake the HUD's bitmap font atlases from the TTFs in tools/fonts-src/ (Barlow, Michroma, Orbitron, DSEG7, Outfit).

    UV_CACHE_DIR=... uv run --no-project --with pillow python tools/bake_fonts.py [app_id ...]

Runs on the Mac only (needs Pillow). The car never rasterizes fonts: it blits
these pre-drawn glyphs (shared/hud_text.js). Each app has its own set (FONTS below); output per
font, in apps/<app_id>/hud/fonts/<name>.json: the metrics plus the atlas as
one alpha byte per pixel (coverage), base64 in "alpha". JSON because the kit's
build packs the app's data folders into hud.pack, which holds JSON only, and
because then the car needs no PNG decoder. Barlow is SIL OFL 1.1; the licence
ships in each app's NOTICE.

Metrics: every glyph cell is the same height, from the highest ink to the lowest
ink across the font's glyph set, so a widget's y is the top of its tallest
character. `ox` shifts a cell from the pen position (ink overhang), `advance`
moves the pen. Digits get one shared advance (tabular), so a changing number
doesn't shift sideways.
"""
import base64, json, math, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'fonts-src')
APPS = os.path.join(HERE, '..', 'apps')

UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
DIGITS = '0123456789'
LOWER = 'abcdefghijklmnopqrstuvwxyz'
# HUD Widgets, fitted to the part of the 800x480 HUD the driver can see (485x278 from the Nov 5 2026 grid
# photo; 560x280 since Nov 9, the sizes stayed): hero 140 -> 96, big 42 -> 34, mid 30 -> 24; label and small stay, BMW's own "mph" is that size.
HUD_FONTS = [
    # name, file, px size, characters
    ('hero', 'BarlowSemiCondensed-SemiBold.ttf', 96, DIGITS + 'PRND-'),
    ('big', 'BarlowSemiCondensed-Medium.ttf', 34, DIGITS + ':.-° PRNDSM'),
    ('mid', 'BarlowSemiCondensed-Medium.ttf', 24, DIGITS + ':.-° ' + UPPER),
    ('label', 'Barlow-Medium.ttf', 15, UPPER + DIGITS + '/.:-°%>· '),
    ('small', 'Barlow-Medium.ttf', 13, UPPER + DIGITS + '/.:-°%>· '),
    # Retro: seven-segment digits (DSEG7 Classic, SIL OFL; the unlit 8s behind are the same font in "track")
    ('d7_hero', 'DSEG7Classic-Bold.ttf', 76, DIGITS + 'PRN-', 0, None, {'R': 'r', 'N': 'n'}),   # r and n: seven segments can't draw R or N
    ('d7_mid', 'DSEG7Classic-Bold.ttf', 26, DIGITS + '-.:'),
    # Vector: now playing (any printable ASCII: a song's text is folded to it, hud.js mediaText)
    ('np_title', 'BarlowSemiCondensed-SemiBold.ttf', 22, ''.join(chr(i) for i in range(32, 127))),
    ('np_small', 'Barlow-Medium.ttf', 16, ''.join(chr(i) for i in range(32, 127))),
]
# Cluster Themes, 1920x720 LCD. The race-dash look (Track; GT3 before 0.21.0), Barlow Condensed.
CLUSTER_FONTS = [
    ('gear', 'BarlowCondensed-Bold.ttf', 330, DIGITS + 'PRND-'),
    ('big', 'BarlowCondensed-Bold.ttf', 124, DIGITS + '.:-'),   # 124: "20.3 PSI" fits a 280 px box beside the hood; ':' for a clock in a readout slot
    ('value', 'BarlowCondensed-Bold.ttf', 92, DIGITS + '.:- PRND°', 0, None, None, '°'),   # °: a readout slot showing a temperature (tucked: the cell keeps its height)
    ('small', 'BarlowCondensed-Bold.ttf', 50, DIGITS + '.:-° '),
    ('unit', 'BarlowCondensed-SemiBold.ttf', 34, UPPER + DIGITS + '/°%>·.: -'),
    ('head', 'BarlowCondensed-SemiBold.ttf', 24, UPPER + DIGITS + '/°%>·.: -'),
    ('scale', 'BarlowCondensed-SemiBold.ttf', 30, DIGITS),
    ('badge', 'BarlowCondensed-SemiBold.ttf', 30, UPPER + LOWER + DIGITS + ' -'),   # the model badge (shared/badges.js)
    # M: the wide squared numbers (Michroma, SIL OFL) and Barlow for the small print
    ('m_num', 'Orbitron[wght].ttf', 36, DIGITS, 0, 'Black', {'0': 'O'}),
    ('m_gear', 'Orbitron[wght].ttf', 125, 'PRNDSM-' + DIGITS, 3, 'Black', {'0': 'O'}),
    ('m_speed', 'Orbitron[wght].ttf', 78, DIGITS + '-', 3, 'Black', {'0': 'O'}),
    ('m_gl', 'Orbitron[wght].ttf', 25, DIGITS + '/.-', 0, 'Black', {'0': 'O'}),
    ('m_mid', 'Orbitron[wght].ttf', 34, DIGITS + ':+-.', 0, 'Bold', {'0': 'O'}),
    ('m_tyre', 'Orbitron[wght].ttf', 25, DIGITS + '.-:', 0, 'Bold', {'0': 'O'}),   # ':' for M's map-view clock (fit)
    ('m_unit', 'Barlow-Medium.ttf', 30, LOWER + UPPER + '°/-.'),
    ('m_label', 'Orbitron[wght].ttf', 20, UPPER + DIGITS + ' -/%°', 0, 'Bold'),   # digits, / % °: the M readout slots' names and units
    ('m_tiny', 'Barlow-Medium.ttf', 26, LOWER + DIGITS + 'CF./ -°'),
    ('m_badge', 'Barlow-Medium.ttf', 26, UPPER + LOWER + DIGITS + ' -'),
    # Sport: BMW Live Cockpit style, the wide numbers in Michroma like BMW's own
    ('s_scale', 'Michroma-Regular.ttf', 27, DIGITS, 1),
    ('s_speed', 'Michroma-Regular.ttf', 74, DIGITS + '-', 3),
    ('s_hero', 'Michroma-Regular.ttf', 132, DIGITS + '-', 3),   # the big speed in the middle while no map shows (Nov 13 2026)
    ('s_gear', 'Michroma-Regular.ttf', 70, DIGITS + 'PRNDSM-', 3),
    ('s_val', 'Michroma-Regular.ttf', 26, DIGITS + ':+-.', 1),
    ('s_unit', 'Barlow-Medium.ttf', 24, LOWER + UPPER + DIGITS + '°/-. '),
    ('s_label', 'BarlowSemiCondensed-SemiBold.ttf', 30, UPPER + DIGITS + ' .'),
    ('s_gl', 'Michroma-Regular.ttf', 21, DIGITS + '/', 1),
    # Cruise's labels (r_label: the Roadster theme's, kept when Roadster was removed in 0.17.8; Vector, Minimal, Drag,
    # Rally and M view and their own fonts went in 0.21.0)
    ('r_label', 'BarlowSemiCondensed-SemiBold.ttf', 24, UPPER + LOWER + DIGITS + '/°%.: -'),
    # Retro 80s: seven-segment digits (DSEG7 Classic, SIL OFL; the unlit 8s behind are the same font in "track")
    ('d7_big', 'DSEG7Classic-Bold.ttf', 170, DIGITS + '-'),
    ('d7_val', 'DSEG7Classic-Bold.ttf', 60, DIGITS + '-.:'),
    ('d7_sm', 'DSEG7Classic-Bold.ttf', 42, DIGITS + '-.:'),
    ('d7_gear', 'DSEG7Classic-Bold.ttf', 190, DIGITS + 'PRN-', 0, None, {'R': 'r', 'N': 'n'}),   # r and n: seven segments can't draw R or N
    # Cruise: calm, light numbers
    ('c_speed', 'BarlowSemiCondensed-Medium.ttf', 150, DIGITS + '-'),
    ('c_val', 'BarlowSemiCondensed-Medium.ttf', 62, DIGITS + '.:-+°'),
    # Ribbon: Outfit (SIL OFL), thin and calm: the huge speed, the side readouts, small spaced labels
    ('b_speed', 'Outfit[wght].ttf', 250, DIGITS + '-', 0, 'ExtraLight'),
    ('b_val', 'Outfit[wght].ttf', 44, DIGITS + '.:-+°% ' + LOWER + UPPER, 0, 'Light'),
    ('b_label', 'Outfit[wght].ttf', 20, UPPER + DIGITS + "' .-", 0, 'SemiBold'),
    ('b_unit', 'Outfit[wght].ttf', 26, UPPER + LOWER + '/', 0, 'Medium'),
    ('b_gear', 'Outfit[wght].ttf', 32, DIGITS + 'PRNDSM-', 0, 'SemiBold'),
    ('b_scale', 'Outfit[wght].ttf', 20, DIGITS, 0, 'Medium'),
    # My Boy: Outfit again, rounder and heavier than Ribbon's: the speed, the gear, the readouts, the bottom row (clock,
    # outside), the units and the small spaced labels
    ('mb_speed', 'Outfit[wght].ttf', 168, DIGITS + '-', 0, 'Medium'),
    ('mb_gear', 'Outfit[wght].ttf', 150, DIGITS + 'PRNDSM-', 0, 'Medium'),
    ('mb_val', 'Outfit[wght].ttf', 50, DIGITS + '.:-+°% ', 0, 'Regular', None, '°'),
    ('mb_row', 'Outfit[wght].ttf', 34, DIGITS + ':.-+° CFAPM', 0, 'Regular', None, '°'),
    ('mb_unit', 'Outfit[wght].ttf', 26, LOWER + UPPER + DIGITS + '/°.-+ ', 0, 'Medium'),
    ('mb_label', 'Outfit[wght].ttf', 21, UPPER + DIGITS + " .-'", 0, 'SemiBold'),
    # Aurora (the canvas's "05 · Aurora", EV glass): Sora (SIL OFL), at the design's sizes; caps spaced .18em
    ('au_gear', 'Sora-300.ttf', 232, DIGITS + 'PRNDSM-'),
    ('au_speed', 'Sora-400.ttf', 64, DIGITS + '-'),
    ('au_val', 'Sora-300.ttf', 40, DIGITS + '.-+°%'),
    ('au_unit', 'Sora-400.ttf', 16, LOWER + UPPER + DIGITS + ' °%/·.:-'),
    ('au_row', 'Sora-400.ttf', 24, LOWER + UPPER + DIGITS + ' °%/.:-'),
    ('au_cap', 'Sora-600.ttf', 13, UPPER + DIGITS + ' ·', 0, None, None, '', {'track': 2}),
    ('au_tick', 'Sora-400.ttf', 14, DIGITS),
    ('au_pill', 'Sora-600.ttf', 16, LOWER + UPPER + DIGITS + ' ·°.-'),
    # Orbital (the canvas's "08 · Orbital", space telemetry): Space Grotesk and Space Mono (SIL OFL); mono caps spaced
    ('ob_gear', 'SpaceGrotesk-300.ttf', 250, DIGITS + 'PRNDSM-'),
    ('ob_speed', 'SpaceGrotesk-300.ttf', 150, DIGITS + '-'),
    ('ob_boost', 'SpaceGrotesk-300.ttf', 72, DIGITS + '.-'),
    ('ob_g', 'SpaceGrotesk-300.ttf', 56, DIGITS + '.-'),
    ('ob_val', 'SpaceGrotesk-400.ttf', 30, DIGITS + '°FC%.-'),
    ('ob_lab', 'SpaceMono-400.ttf', 13, UPPER + DIGITS + ' ·×°.-/', 0, None, None, '', {'track': 3}),
    ('ob_small', 'SpaceMono-400.ttf', 12, UPPER + DIGITS + ' ·×', 0, None, None, '', {'track': 4}),
    ('ob_unit', 'SpaceMono-400.ttf', 15, UPPER + '/', 0, None, None, '', {'track': 3}),
    ('ob_mode', 'SpaceMono-400.ttf', 14, UPPER + DIGITS + ' ', 0, None, None, '', {'track': 5}),
    ('ob_rpm', 'SpaceMono-400.ttf', 14, DIGITS + ' RPM-', 0, None, None, '', {'track': 2}),
    ('ob_row', 'SpaceMono-400.ttf', 18, UPPER + DIGITS + ':°. -', 0, None, None, '', {'track': 4}),
    ('ob_tick', 'SpaceMono-400.ttf', 12, DIGITS),
    ('ob_alert', 'SpaceMono-700.ttf', 16, UPPER + DIGITS + ' ·°.-', 0, None, None, '', {'track': 4}),
    # VFD (the canvas's "T4 · VFD", an 80s vacuum-fluorescent dash): Share Tech Mono (SIL OFL) at the design's sizes, caps
    # spaced .18em; the numbers in seven segments drawn from the design's own geometry (bake_seg, below)
    ('vf_14', 'ShareTechMono-Regular.ttf', 14, UPPER + ' ', 0, None, None, '', {'track': 2.52}),
    ('vf_15', 'ShareTechMono-Regular.ttf', 15, UPPER + DIGITS + ' ½×', 0, None, None, '', {'track': 2.7}),
    ('vf_16', 'ShareTechMono-Regular.ttf', 16, UPPER + ' °', 0, None, None, '', {'track': 2.88}),
    ('vf_17', 'ShareTechMono-Regular.ttf', 17, UPPER + ' °%', 0, None, None, '', {'track': 3.06}),
    ('vf_18', 'ShareTechMono-Regular.ttf', 18, UPPER + ' /', 0, None, None, '', {'track': 3.24}),
    ('vf_20', 'ShareTechMono-Regular.ttf', 20, UPPER + ' ', 0, None, None, '', {'track': 3.6}),
    ('vf_tick', 'ShareTechMono-Regular.ttf', 15, DIGITS),
    # name, '7SEG', segment thickness, digit width, height, cell pitch, glow radius, characters
    ('vf_gear', '7SEG', 26, 140, 226, 170, 6, DIGITS + 'PRND-'),
    ('vf_speed', '7SEG', 14, 66, 104, 82, 4, DIGITS + '-'),
    ('vf_val', '7SEG', 8, 26, 60, 36, 3, DIGITS + '-.'),
    ('vf_row', '7SEG', 5, 20, 36, 28, 2, DIGITS + '-:', True),
    # Sakura: pixel fonts (SIL OFL), drawn without anti-aliasing so every font pixel stays a hard square. Press Start 2P
    # is an 8x8 font: at multiples of 32 px each font pixel is a whole number of the theme's 4 px art pixels.
    # Silkscreen for the English labels, DotGothic16 (16-dot) at 32 px for the Japanese ones (2 px a dot).
    ('sk_gear', 'PressStart2P-Regular.ttf', 192, DIGITS + 'PRNDSM-', 0, None, None, '', {'pixel': True}),
    ('sk_speed', 'PressStart2P-Regular.ttf', 128, DIGITS + '-', 0, None, None, '', {'pixel': True}),
    ('sk_speed96', 'PressStart2P-Regular.ttf', 96, DIGITS + '-', 0, None, None, '', {'pixel': True}),   # 3-digit speeds (fit)
    ('sk_val', 'PressStart2P-Regular.ttf', 64, DIGITS + '.-+°%', 0, None, None, '', {'pixel': True, 'narrow': '.°'}),
    ('sk_row', 'PressStart2P-Regular.ttf', 32, DIGITS + ':.-+° ', 0, None, None, '', {'pixel': True, 'narrow': ':.°'}),
    ('sk_lab', 'Silkscreen-Regular.ttf', 24, UPPER + DIGITS + '/.:-°%!· ', 0, None, None, '', {'pixel': True}),
    # the drive mode and the SHIFT tag: Silkscreen 32 with DotGothic16 32 for the Japanese
    ('sk_mode', 'Silkscreen-Regular.ttf', 32, UPPER + ' +' + '快適スポーツエコ変速', 0, None, None, '',
     {'pixel': True, 'alt': ('DotGothic16-Regular.ttf', 32)}),
    ('sk_jp', 'DotGothic16-Regular.ttf', 32, '油温水温燃料過給速度加航続外気時刻高', 0, None, None, '', {'pixel': True}),
]
FONTS = {'idrive_hud_widgets': HUD_FONTS, 'cluster_themes': CLUSTER_FONTS}
PAD = 2
ATLAS_W = 1024


def bake(out, name, file, size, chars, stroke=0, weight=None, subs=None, tuck='', pixel=False, alt=None, narrow='', track=0):
    """stroke: px of extra weight round every glyph (Michroma has one weight). weight: a named instance of a
    variable font (Orbitron: Regular .. Black), for the M theme's squared BMW-style gear, speed and numbers.
    subs: {char: glyph drawn for it} (Orbitron's zero is slashed; the M8's is plain, so its O stands in).
    tuck: characters added to a font after layouts were built on its cell height (° on value / y_val, Nov 7 2026):
    they don't count towards the cell, and one that rises above it is drawn lower so its top meets the cell's.
    pixel: drawn without anti-aliasing (pixel fonts: every font pixel a hard square, alpha 0 or 255).
    alt: (file, px size) of a second font for the CJK characters (U+3000 and up), on the same baseline (Sakura's
    Japanese labels next to Silkscreen capitals).
    track: px added to every advance (CSS letter-spacing: the canvas designs' spaced capitals).
    narrow: characters whose cell is cut to their ink plus one font pixel (an 8x8 pixel font: size / 8 px), so a
    monospaced font's '.', ':' and '°' sit next to the digits instead of in a whole cell of their own."""
    font = ImageFont.truetype(os.path.join(SRC, file), size)
    if weight: font.set_variation_by_name(weight)
    alt_font = ImageFont.truetype(os.path.join(SRC, alt[0]), alt[1]) if alt else None
    fnt = lambda c: alt_font if alt_font and c >= '\u3000' else font
    subs = subs or {}
    glyph = lambda c: subs.get(c, c)
    ink = [c for c in chars if c != ' ']
    boxes = {c: fnt(c).getbbox(glyph(c), anchor='ls', stroke_width=stroke) for c in ink}
    top = min(b[1] for c, b in boxes.items() if c not in tuck)
    bottom = max(b[3] for c, b in boxes.items() if c not in tuck)
    drop = {c: max(0, top - boxes[c][1]) for c in tuck if c in boxes}
    height = bottom - top + 2 * PAD
    tab = (max(font.getlength(glyph(d)) for d in DIGITS if d in chars) + 2 * stroke) if any(d in chars for d in DIGITS) else 0

    cells = []
    for c in chars:
        adv = fnt(c).getlength(glyph(c)) + (2 * stroke if c != ' ' else 0)
        if c == ' ':
            cells.append((c, None, 0, round((adv if adv else size * 0.25) + track)))
            continue
        l, _, r, _ = boxes[c]
        w = r - l + 2 * PAD
        img = Image.new('L', (w, height), 0)
        draw = ImageDraw.Draw(img)
        if pixel: draw.fontmode = '1'
        draw.text((PAD - l, PAD - top + drop.get(c, 0)), glyph(c), font=fnt(c), fill=255, anchor='ls', stroke_width=stroke, stroke_fill=255)
        shift = (tab - adv) / 2 if c in DIGITS else 0
        if c in narrow:
            ink = img.getbbox()
            cells.append((c, img, -ink[0], ink[2] - ink[0] + round(size / 8)))
            continue
        cells.append((c, img, round(l - PAD + shift), round((tab if c in DIGITS else adv) + track)))

    # simple row packing
    x = y = 0
    placed = {}
    for c, img, ox, adv in cells:
        if img is None:
            continue
        if x + img.width > ATLAS_W:
            x, y = 0, y + height
        placed[c] = (x, y)
        x += img.width
    atlas_h = y + height
    atlas = Image.new('L', (ATLAS_W, atlas_h), 0)
    glyphs = {}
    for c, img, ox, adv in cells:
        if img is None:
            glyphs[c] = {'x': 0, 'y': 0, 'w': 0, 'h': 0, 'ox': 0, 'advance': adv}
            continue
        gx, gy = placed[c]
        atlas.paste(img, (gx, gy))
        glyphs[c] = {'x': gx, 'y': gy, 'w': img.width, 'h': img.height, 'ox': ox, 'advance': adv}
    meta = {'source': file, 'size': size, 'cellHeight': height, 'baseline': PAD - top, 'glyphs': glyphs,
            'width': ATLAS_W, 'height': atlas_h, 'alpha': base64.b64encode(atlas.tobytes()).decode('ascii')}
    with open(os.path.join(out, name + '.json'), 'w') as f:
        json.dump(meta, f, separators=(',', ':'), ensure_ascii=False)
    print('%-6s %3dpx  cell height %3d  atlas %dx%d  %d glyphs' % (name, size, height, ATLAS_W, atlas_h, len(glyphs)))


SEG7 = {'0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg',
        '9': 'abcdfg', '-': 'g', 'P': 'abefg', 'R': 'eg', 'N': 'ceg', 'D': 'bcdeg'}   # R and N as r and n: seven segments can't draw R or N
SEG_SKEW = 0.105104   # tan 6 degrees: the VFD design's skewX(-6deg) round each digit's bottom-left corner


def seg_polys(t, W, H):
    """The VFD design's (T4 · VFD on the canvas) seven segments, digit-local px (y down, unskewed): hexagons with 45 degree
    tips, tips 0.68 t in from the corners, 0.18 t either side of the middle (its numbers: t 26, W 140, H 226 the gear)."""
    tip, h, Lv = 0.68 * t, t / 2, (H / 2 - 0.86 * t) / 2
    def hor(yc): return [(tip, yc), (tip + h, yc - h), (W - tip - h, yc - h), (W - tip, yc), (W - tip - h, yc + h), (tip + h, yc + h)]
    def ver(xc, y0, y1): return [(xc, y0), (xc + h, y0 + h), (xc + h, y1 - h), (xc, y1), (xc - h, y1 - h), (xc - h, y0 + h)]
    up, lo = (tip, tip + 2 * Lv), (H - tip - 2 * Lv, H - tip)
    return {'a': hor(h), 'g': hor(H / 2), 'd': hor(H - h), 'f': ver(h, *up), 'b': ver(W - h, *up), 'e': ver(h, *lo), 'c': ver(W - h, *lo)}


def bake_seg(out, name, t, W, H, pitch, glow, chars, colon=False):
    """A seven-segment font drawn from the VFD design's geometry (no TTF): every digit cell `pitch` wide, `.` a square in the
    gap after the digit before it (no advance), `:` two squares (the clock's, unskewed) in a 3.6 t gap. The cluster's text
    glow is a blur of radius size / 24, so `size` is 24 x `glow` and the cell keeps 2 glow radii of room round the ink.
    A digit is drawn DELTA px right of its pen: a right-aligned box ends DELTA px after its last cell, so the glow isn't
    cut there; the layout puts the box's right edge at the first slot + n x pitch + DELTA."""
    S, pad, k = 4, 2 + 2 * glow, SEG_SKEW
    DELTA = 2 * glow
    polys = seg_polys(t, W, H)
    cw = int(math.ceil(W + k * H)) + 2 * pad
    ch = H + 2 * pad
    def render(shapes, x0, w, skew=True):
        img = Image.new('L', (w * S, ch * S), 0)
        d = ImageDraw.Draw(img)
        for p in shapes:
            d.polygon([((x + (k * (H - y) if skew else 0) - x0 + pad) * S, (y + pad) * S) for x, y in p], fill=255)
        return img.resize((w, ch), Image.BOX)
    cells = []
    for c in chars:
        if c == ' ':
            cells.append((c, None, 0, pitch))
        elif c == '.':
            x0 = W + 0.175 * t
            sq = [(x0, H - t), (x0 + 0.9 * t, H - t), (x0 + 0.9 * t, H - 0.1 * t), (x0, H - 0.1 * t)]
            w = int(math.ceil(0.9 * t + k * t)) + 2 * pad
            cells.append((c, render([sq], x0, w), round(x0 - pad - pitch - DELTA), 0))
        elif c == ':':
            sq = lambda y: [(0.8 * t, y), (1.8 * t, y), (1.8 * t, y + t), (0.8 * t, y + t)]
            w = int(math.ceil(t)) + 2 * pad
            cells.append((c, render([sq(0.222 * H), sq(0.667 * H)], 0.8 * t, w, skew=False), round(0.8 * t - pad - DELTA), round(3.6 * t)))
        else:
            cells.append((c, render([polys[s] for s in SEG7[c]], 0, cw), -pad - DELTA, pitch))
    x = y = 0
    glyphs, imgs = {}, []
    for c, img, ox, adv in cells:
        if img is None:
            glyphs[c] = {'x': 0, 'y': 0, 'w': 0, 'h': 0, 'ox': 0, 'advance': adv}
            continue
        if x + img.width > ATLAS_W: x, y = 0, y + ch
        glyphs[c] = {'x': x, 'y': y, 'w': img.width, 'h': img.height, 'ox': ox, 'advance': adv}
        imgs.append((x, y, img))
        x += img.width
    atlas = Image.new('L', (ATLAS_W, y + ch), 0)
    for gx, gy, img in imgs: atlas.paste(img, (gx, gy))
    meta = {'source': 'seven segments (tools/bake_fonts.py bake_seg)', 'size': 24 * glow, 'cellHeight': ch, 'baseline': pad + H,
            'glyphs': glyphs, 'width': ATLAS_W, 'height': y + ch, 'alpha': base64.b64encode(atlas.tobytes()).decode('ascii')}
    with open(os.path.join(out, name + '.json'), 'w') as f:
        json.dump(meta, f, separators=(',', ':'), ensure_ascii=False)
    print('%-8s seven segments %dx%d  cell height %3d  %d glyphs' % (name, W, H, ch, len(glyphs)))


if __name__ == '__main__':
    import sys
    # --only PREFIX: bake just the fonts whose name starts with it (a new theme's fonts without re-baking the rest)
    args = sys.argv[1:]
    only = ''
    if '--only' in args:
        i = args.index('--only')
        only = args[i + 1]
        args = args[:i] + args[i + 2:]
    for app in args or sorted(FONTS):
        out = os.path.join(APPS, app, 'hud', 'fonts')
        os.makedirs(out, exist_ok=True)
        print(app)
        for spec in FONTS[app]:
            if not spec[0].startswith(only): continue
            if spec[1] == '7SEG': bake_seg(out, spec[0], *spec[2:])
            elif isinstance(spec[-1], dict): bake(out, *spec[:-1], **spec[-1])
            else: bake(out, *spec)
