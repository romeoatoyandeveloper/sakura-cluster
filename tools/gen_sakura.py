#!/usr/bin/env python3
"""Write the Sakura layouts (apps/cluster_themes/hud/layouts/sakura*.json) from the designs' specs, in panel px.
Text is placed by baseline using the baked fonts' metrics, so mixed fonts on one row line up. Edit this, not the JSON:

    python3 tools/gen_sakura.py apps/cluster_themes

sakura: the first design (rev blossoms on the tree's twig, tall side plates). sakura_line (Blue Hour Line), sakura_moon
(Moon Mirror) and sakura_grove (Hanami Grove) share the variants' layout: a 28-segment rev bar (Grove: the blossoms),
a slimmer centre plate, wide 420 x 80 side plates with the value on the right and the labels stacked on the left.
"""
import json, os, sys
APP = sys.argv[1]
FONTS = os.path.join(APP, 'hud', 'fonts')
M = {n: json.load(open(os.path.join(FONTS, n + '.json'))) for n in
     ['sk_gear', 'sk_speed', 'sk_speed96', 'sk_val', 'sk_row', 'sk_lab', 'sk_mode', 'sk_jp']}
base = lambda f: M[f]['baseline']
cell = lambda f: M[f]['cellHeight']
LAB = 18                                  # Silkscreen 24: every capital advances 18 px
KEEP = [1380, 660, 1460, 720]             # BMW's gear letter in its bottom strip stays uncovered


class Layout:
    def __init__(self):
        self.w = []

    def text(self, id, x, y_base, w, txt, font, color, **kw):
        d = {'id': id, 'type': 'text', 'z': 5, 'x': x, 'y': y_base - base(font), 'w': w, 'h': cell(font), 'text': txt,
             'font': font, 'color': color}
        d.update(kw)
        self.w.append(d)
        return d

    def warn_label(self, key, jp, warn):
        """The Japanese label gives way to 高温 while the reading is over its limit."""
        jp['showWhen'] = '!warn:' + warn
        self.text(key + '_hot', jp['x'], jp['y'] + base('sk_jp'), 68, '高温', 'sk_jp', 'ink', showWhen='warn:' + warn)

    def centre(self, plate, mode_top, gear_top, speed_top, unit_x):
        x, y, w, h = plate
        self.text('mode', x + 4, mode_top + base('sk_mode'), w - 8, '{{mode}} {{modeJa}}', 'sk_mode', 'sec', align='center', showWhen='!shift', rate=25)
        self.text('shift_tag', x + 4, mode_top + base('sk_mode'), w - 8, 'SHIFT 変速', 'sk_mode', 'shift', align='center', showWhen='shift', rate=25)
        # Press Start 2P draws 7 of its 8 columns: the box sits half a font pixel (12 px) right so the ink is centred
        self.text('gear', 870, gear_top + base('sk_gear'), 204, '{{gearnum}}', 'sk_gear', 'fg', align='center')
        sb = speed_top + base('sk_speed')
        self.text('speed', 784, sb, 364, '{{speed}}', 'sk_speed', 'fg', align='center', fit=['sk_speed96'])
        ink_bottom = sb - 16                # the digits end one font pixel above the baseline
        self.text('speed_unit', unit_x + 10, ink_bottom - 36, 54, '{{u:speed}}', 'sk_lab', 'dim')
        self.text('speed_jp', unit_x, ink_bottom, 66, '速度', 'sk_jp', 'jp')

    def bottom(self, clock_x):
        rb = 668 + base('sk_row')
        self.text('clock_jp', clock_x, rb, 68, '時刻', 'sk_jp', 'jp')
        self.text('clock', clock_x + 72, rb, 160, '{{time}}', 'sk_row', 'sec', align='right')
        self.text('ampm', clock_x + 240, rb, 48, '{{ampm}}', 'sk_lab', 'dim')
        self.text('range_jp', 836, rb, 68, '航続', 'sk_jp', 'jp')
        self.text('range', 908, rb, 128, '{{range}}', 'sk_row', 'sec', align='right')
        self.text('range_u', 1044, rb, 48, '{{u:dist}}', 'sk_lab', 'dim')
        self.text('out_jp', 1500, rb, 68, '外気', 'sk_jp', 'jp')
        self.text('out', 1572, rb, 96, '{{ambientN}}', 'sk_row', 'sec', align='right')
        self.text('out_u', 1676, rb, 48, '{{u:temp}}', 'sk_lab', 'dim')

    def write(self, name, title, theme):
        # connections (8 layers each): the centre stays on the app's own, the left plates, the right plates and the bottom
        # row get one each, so every connection packs its text into a few small sheets
        group = {'oil': 1, 'coolant': 1, 'fuel': 1, 'boost': 2, 'g': 2, 'clock': 3, 'ampm': 3, 'range': 3, 'out': 3}
        for w in self.w:
            k = group.get(w['id'].split('_')[0], 0)
            if w['type'] == 'text' and k: w['conn'] = k
        out = os.path.join(APP, 'hud', 'layouts', name + '.json')
        json.dump({'schemaVersion': 2, 'name': title, 'packWaste': 3, 'theme': theme, 'widgets': self.w},
                  open(out, 'w', encoding='utf8'), indent=2, ensure_ascii=False)
        print('wrote', out, len(self.w), 'widgets')


def first():
    """The first design: blossoms on the twig, tall side plates (label row, value, bar), the G plate on the right."""
    L = Layout()
    P = {'centre': [712, 212, 496, 416], 'oil': [220, 228, 340, 128], 'coolant': [220, 372, 340, 128],
         'fuel': [220, 516, 340, 128], 'boost': [1432, 228, 340, 128], 'g': [1432, 372, 340, 272]}
    L.w.append({'id': 'scene', 'type': 'sakura', 'class': 'content', 'z': 0, 'x': 0, 'y': 0, 'w': 1920, 'h': 720,
                'plates': [P[k] for k in ['centre', 'oil', 'coolant', 'fuel', 'boost', 'g']], 'ring': [1452, 424], 'keep': KEEP})
    # the rev numerals 1-7 are drawn by the shader (sakura), 28 px under the blossom arc
    L.centre(P['centre'], 228, 272, 484, 1140)

    def plate(key, en, jp, value, warn=None):
        x, y, w, h = P[key]
        lb = y + 40
        en_w = LAB * len(en.replace('{{u:boost}}', 'PSI'))
        d = L.text(key + '_lab', x + 16, lb, en_w + 8, en, 'sk_lab', 'dim')
        j = L.text(key + '_jp', x + 16 + en_w + 12, lb, 68, jp, 'sk_jp', 'jp')
        v = L.text(key, x + 16, y + 44 + base('sk_val'), w - 32, value, 'sk_val', 'fg', warnFlash=False)
        if warn:
            d.update(warnOf=warn, warnColor='ink')
            v['warnColor'] = 'ink'
            L.warn_label(key, j, warn)
    plate('oil', 'OIL', '油温', '{{oil}}°', 'oil')
    plate('coolant', 'COOLANT', '水温', '{{coolant}}°', 'coolant')
    plate('fuel', 'FUEL', '燃料', '{{fuelPct}}%')
    plate('boost', 'BOOST {{u:boost}}', '過給', '{{boost}}', 'boost')
    gx, gy = P['g'][:2]
    L.text('g_lab', gx + 16, gy + 40, 160, 'G-FORCE', 'sk_lab', 'dim')
    L.text('g_jp', gx + 16 + LAB * 7 + 12, gy + 40, 100, '加速度', 'sk_jp', 'jp')
    for i, (tok, lab) in enumerate([('gLat', 'LAT'), ('gLong', 'LONG')]):
        yb = 480 + i * 76
        L.text('g_' + tok, 1628, yb, 132, '{{%s}}' % tok, 'sk_row', 'fg')
        L.text('g_' + tok + '_l', 1628, yb + 26, 132, lab + ' G', 'sk_lab', 'dim')
    L.text('g_best', 1452, 616, 300, 'BEST {{gBest}} G', 'sk_lab', 'dim')
    L.bottom(200)
    L.write('sakura', 'Sakura', 'sakura')


def variant(name, title, theme, bar, petals=None):
    """The variants' layout: the revs over a slimmer centre plate, 420 x 80 side plates (labels stacked left, the value
    and its bar on the right, the ! block after the Japanese label), the G plate under boost with the ring on its left."""
    L = Layout()
    P = {'centre': [728, 204, 464, 416], 'oil': [160, 400, 420, 80], 'coolant': [160, 488, 420, 80],
         'fuel': [160, 576, 420, 80], 'boost': [1340, 400, 420, 80], 'g': [1340, 488, 420, 168]}
    scene = {'id': 'scene', 'type': 'sakura', 'class': 'content', 'z': 0, 'x': 0, 'y': 0, 'w': 1920, 'h': 720, 'art': name,
             'plates': [P[k] for k in ['centre', 'oil', 'coolant', 'fuel', 'boost', 'g']], 'ring': [1356, 492], 'keep': KEEP,
             'plateBar': {'x': 208, 'y': 68, 'seg': 16}, 'bang': [88, 40]}
    if bar: scene['revbar'] = {'x': 680, 'y': 128, 'w': 16, 'h': 8, 'pitch': 20, 'count': 28, 'numY': 144}
    if petals: scene['petals'] = petals
    L.w.append(scene)
    L.centre(P['centre'], 220, 264, 476, 1124)

    def plate(key, en, jp, value, warn=None):
        x, y, w, h = P[key]
        d = L.text(key + '_lab', x + 16, y + 30, LAB * 10, en, 'sk_lab', 'dim')
        j = L.text(key + '_jp', x + 16, y + 68, 68, jp, 'sk_jp', 'jp')
        # the value's ink from y + 8 to y + 64 (Press Start 2P: 8 px over the baseline), right-aligned over the bar
        v = L.text(key, x + 180, y + 72, w - 196, value, 'sk_val', 'fg', align='right', warnFlash=False)
        if warn:
            d.update(warnOf=warn, warnColor='ink')
            v['warnColor'] = 'ink'
            L.warn_label(key, j, warn)
    plate('oil', 'OIL', '油温', '{{oil}}°', 'oil')
    plate('coolant', 'COOLANT', '水温', '{{coolant}}°', 'coolant')
    plate('fuel', 'FUEL', '燃料', '{{fuelPct}}%')
    plate('boost', 'BOOST {{u:boost}}', '過給', '{{boost}}', 'boost')
    x0 = 1524                            # right of the ring
    L.text('g_lab', x0, 518, LAB * 7 + 4, 'G-FORCE', 'sk_lab', 'dim')
    L.text('g_jp', x0 + 134, 520, 100, '加速度', 'sk_jp', 'jp')
    for i, (tok, lab) in enumerate([('gLat', 'LAT'), ('gLong', 'LONG')]):
        yb = 566 + i * 40
        L.text('g_' + tok, x0, yb, 124, '{{%s}}' % tok, 'sk_row', 'fg')
        L.text('g_' + tok + '_l', x0 + 132, yb - 4, LAB * 4 + 4, lab, 'sk_lab', 'dim')
    L.text('g_best', x0, 642, LAB * 12, 'BEST {{gBest}} G', 'sk_lab', 'dim')
    L.bottom(160)
    L.write(name, title, theme)


first()
variant('sakura_line', 'Sakura Blue Hour Line', 'sakura_line', bar=True)
# Moon Mirror: the petals leave the moon tree and blow left with the wind streaks (-280 px a loop)
variant('sakura_moon', 'Sakura Moon Mirror', 'sakura_moon', bar=True,
        petals={'x0': [1170 + (i * 7 % 16) * 26 for i in range(16)], 'y0': [130 + (i * 5 % 16) * 18 for i in range(16)], 'drift': -280})
variant('sakura_grove', 'Sakura Hanami Grove', 'sakura_grove', bar=False)
