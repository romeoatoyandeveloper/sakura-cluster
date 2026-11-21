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
import base64, json, os
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
# Cluster Themes, 1920x720 LCD. GT3: the race-dash look, Barlow Condensed.
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
    ('m_val', 'Barlow-Medium.ttf', 54, DIGITS + ':+-.'),
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
    # Vector: the music panel's song title and artist (any printable ASCII: a song's text is folded to it, hud.js
    # mediaText), the ring gauges' numbers and labels, the track time
    ('v_title', 'BarlowSemiCondensed-SemiBold.ttf', 38, ''.join(chr(i) for i in range(32, 127))),
    ('v_artist', 'Barlow-Medium.ttf', 26, ''.join(chr(i) for i in range(32, 127))),
    ('v_val', 'Michroma-Regular.ttf', 22, DIGITS + '.-+', 1),
    ('v_label', 'BarlowSemiCondensed-SemiBold.ttf', 19, UPPER + LOWER + DIGITS + ' °%/.-'),
    ('v_time', 'Michroma-Regular.ttf', 16, DIGITS + ':-', 1),
    # Minimal: one huge speed, the gear, small print
    ('n_speed', 'BarlowSemiCondensed-Medium.ttf', 260, DIGITS + '-'),
    ('n_gear', 'BarlowSemiCondensed-SemiBold.ttf', 110, DIGITS + 'PRNDSM-'),
    ('n_unit', 'Barlow-Medium.ttf', 34, LOWER + UPPER + '/'),
    # Cruise and Minimal labels (r_label: the Roadster theme's, kept when Roadster was removed in 0.17.8)
    ('r_label', 'BarlowSemiCondensed-SemiBold.ttf', 24, UPPER + LOWER + DIGITS + '/°%.: -'),
    # Drag: the 0-60 clock
    ('timer', 'BarlowCondensed-Bold.ttf', 220, DIGITS + '.-'),
    # Rally: the huge gear and the readouts in the arc
    ('y_gear', 'BarlowCondensed-Bold.ttf', 300, DIGITS + 'PRNDSM-'),
    ('y_val', 'BarlowCondensed-Bold.ttf', 76, DIGITS + '.:-+°', 0, None, None, '°'),
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
            if isinstance(spec[-1], dict): bake(out, *spec[:-1], **spec[-1])
            else: bake(out, *spec)
