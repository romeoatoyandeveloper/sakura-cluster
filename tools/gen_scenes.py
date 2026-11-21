#!/usr/bin/env python3
"""Write the scene themes' layouts (apps/cluster_themes/hud/layouts/<name>.json), in panel px. Edit this, not the JSON:

    python3 tools/gen_scenes.py apps/cluster_themes

Each is one "scene" backdrop (shaders.js scene_*: the world and the revs, drawn with no pictures) and its text, in fonts
the app already has: Night Drive (Orbitron, the speed in chrome), Warp (Michroma, the speed inside the rev ring), Paper
(Outfit, ink on paper, the rpm numbers under the inked line) and Light Trails (Michroma); and the canvas designs, Aurora,
Orbital and VFD, in their own fonts. Text is placed by baseline using the baked fonts' metrics.
"""
import json, math, os, sys

APP = sys.argv[1]
FONTS = os.path.join(APP, 'hud', 'fonts')
M = {}


def font(n):
    if n not in M: M[n] = json.load(open(os.path.join(FONTS, n + '.json')))
    return M[n]


KEEP = [1380, 660, 1460, 720]            # BMW's gear letter in its bottom strip stays uncovered


class Layout:
    def __init__(self, name, title, scene, **kw):
        self.name, self.title = name, title
        self.w = [dict({'id': 'scene', 'type': 'scene', 'scene': scene, 'class': 'content', 'z': 0, 'x': 0, 'y': 0, 'w': 1920,
                        'h': 720, 'keep': KEEP}, **kw)]

    def text(self, id, x, y_base, w, txt, f, color, **kw):
        m = font(f)
        d = {'id': id, 'type': 'text', 'z': 5, 'x': x, 'y': y_base - m['baseline'], 'w': w, 'h': m['cellHeight'],
             'text': txt, 'font': f, 'color': color}
        d.update(kw)
        self.w.append(d)

    def write(self):
        out = os.path.join(APP, 'hud', 'layouts', self.name + '.json')
        json.dump({'schemaVersion': 2, 'name': self.title, 'packWaste': 3, 'theme': self.name, 'widgets': self.w},
                  open(out, 'w', encoding='utf8'), indent=2, ensure_ascii=False)
        print('wrote', out, len(self.w), 'widgets')


# Night Drive: the speed left and the gear right of the sun, in Orbitron, the big figures chrome (white to pink)
L = Layout('nightdrive', 'Night Drive', 'synth')
L.text('speed_lab', 150, 186, 200, 'SPEED', 'm_label', 'dim')
L.text('speed_u', 236, 186, 120, '{{u:speedLc}}', 'm_unit', 'dim')
L.text('clock', 380, 190, 180, '{{time}}', 'm_mid', 'sec', align='right')
L.text('speed', 150, 318, 410, '{{speed}}', 'm_gear', 'fg', align='right', color2='pink')
L.text('gear_lab', 1360, 186, 200, 'GEAR', 'm_label', 'dim')
L.text('out', 1590, 186, 180, '{{ambientN}}{{u:temp}}', 'm_label', 'sec', align='right')
L.text('gear', 1360, 318, 410, '{{gear}}', 'm_gear', 'fg', align='left', color2='pink')
L.write()

# Neon Highway: as Night Drive (the speed left and the gear right of the sun, Orbitron, chrome figures)
L = Layout('highway', 'Neon Highway', 'highway')
L.text('speed_lab', 150, 186, 200, 'SPEED', 'm_label', 'dim')
L.text('speed_u', 236, 186, 120, '{{u:speedLc}}', 'm_unit', 'dim')
L.text('clock', 380, 190, 180, '{{time}}', 'm_mid', 'sec', align='right')
L.text('speed', 150, 318, 410, '{{speed}}', 'm_gear', 'fg', align='right', color2='pink')
L.text('gear_lab', 1360, 186, 200, 'GEAR', 'm_label', 'dim')
L.text('out', 1590, 186, 180, '{{ambientN}}{{u:temp}}', 'm_label', 'sec', align='right')
L.text('gear', 1360, 318, 410, '{{gear}}', 'm_gear', 'fg', align='left', color2='pink')
L.write()

# Warp: the speed inside the rev ring, the clock and outside on the left, the gear on the right
L = Layout('warp', 'Warp', 'warp')
L.text('speed', 760, 372, 400, '{{speed}}', 's_hero', 'fg', align='center')
L.text('speed_u', 760, 420, 400, '{{u:speedLc}}', 's_unit', 'dim', align='center')
L.text('time_lab', 150, 236, 360, 'TIME', 's_label', 'dim')
L.text('clock', 150, 290, 360, '{{time}}', 'm_mid', 'fg')
L.text('out', 150, 336, 360, '{{ambientN}}{{u:temp}} outside', 's_unit', 'sec')
L.text('gear_lab', 1410, 236, 360, 'GEAR', 's_label', 'dim', align='right')
L.text('gear', 1410, 330, 360, '{{gear}}', 's_gear', 'fg', align='right')
L.text('mode', 1410, 376, 360, '{{mode}}', 's_label', 'sec', align='right')
L.write()

# Paper: the speed big in the middle, the inked rev line under it with its numbers, the clock and outside on the left, the
# gear and range on the right, the drive mode at the foot of the page
L = Layout('paper', 'Paper', 'paper', nightDim=0.55)
L.text('speed', 560, 430, 800, '{{speed}}', 'b_speed', 'fg', align='center')
L.text('speed_u', 560, 478, 800, '{{u:speedLc}}', 'b_unit', 'dim', align='center')
L.w.append({'id': 'revs', 'type': 'scale', 'z': 5, 'x': 240, 'y': 548, 'w': 1440, 'h': font('b_scale')['cellHeight'],
            'font': 'b_scale', 'color': 'dim', 'redFrom': True})
L.text('time_lab', 240, 196, 300, 'TIME', 'b_label', 'dim')
L.text('clock', 240, 246, 300, '{{time}}', 'b_val', 'fg')
L.text('out_lab', 240, 306, 300, 'OUTSIDE', 'b_label', 'dim')
L.text('out', 240, 356, 300, '{{ambientN}}{{u:temp}}', 'b_val', 'fg')
L.text('gear_lab', 1380, 196, 300, 'GEAR', 'b_label', 'dim', align='right')
L.text('gear', 1380, 330, 300, '{{gear}}', 'mb_gear', 'fg', align='right')
L.text('range', 1380, 396, 300, '{{range}} {{u:distLc}}', 'b_val', 'sec', align='right')
L.text('mode', 560, 650, 800, '{{mode}}', 'b_label', 'dim', align='center')
L.write()

# Light Trails: Michroma, the speed left and the gear right of the road
L = Layout('trails', 'Light Trails', 'trails')
L.text('speed', 120, 300, 440, '{{speed}}', 's_hero', 'fg', align='right')
L.text('speed_u', 120, 346, 440, '{{u:speedLc}}', 's_unit', 'dim', align='right')
L.text('clock', 120, 404, 440, '{{time}}', 'm_mid', 'sec', align='right')
L.text('gear', 1360, 300, 440, '{{gear}}', 's_gear', 'fg')
L.text('mode', 1360, 346, 440, '{{mode}}', 's_label', 'dim')
L.text('out', 1360, 404, 440, '{{ambientN}}{{u:temp}} outside', 's_unit', 'sec')
L.write()

# --- the canvas designs (the "Sakura 桜 cluster theme" canvas: Modern collection, Terminal variants), placed where their CSS puts them
from PIL import ImageFont
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts-src')


def metrics(ttf, size):
    return ImageFont.truetype(os.path.join(SRC, ttf), size).getmetrics()       # (ascent, descent), as CSS's content area


def css_base(top, lh, ttf, size):
    """The baseline of a CSS line box at top, line-height lh (None: normal) in that font."""
    a, d = metrics(ttf, size)
    if lh is None: lh = a + d
    return top + (lh - (a + d)) / 2 + a


def width(ttf, size, s, track=0):
    f = ImageFont.truetype(os.path.join(SRC, ttf), size)
    return f.getlength(s) + track * len(s)


def adv(f, txt):
    """A text's width in a baked font (its tabular digits included), px."""
    g = font(f)['glyphs']
    return sum(g[c]['advance'] for c in txt if c in g)


def T(L, id, x, base, w, txt, f, color, **kw):
    L.text(id, int(round(x)), int(round(base)), int(round(w)), txt, f, color, **kw)


# Aurora (05 · AURORA, Modern EV glass): Sora; the glass cards at 180,224 and 1320,224 (420 x 376), the ring round 960,405
L = Layout('evaurora', 'Aurora', 'glass', nightDim=0.8)
S3, S4, S6 = 'Sora-300.ttf', 'Sora-400.ttf', 'Sora-600.ttf'
T(L, 'mode', 660, 239 + metrics(S6, 13)[0], 600, '{{mode}}', 'au_cap', 'sec', align='center')
T(L, 'gear', 760, css_base(282, 184, S3, 232), 400, '{{gearnum}}', 'au_gear', 'fg', align='center')
sb = css_base(482, 64, S4, 64)
grp = width(S4, 64, '45') + 8 + width(S4, 18, 'mph')
nr = 960 + grp / 2 - width(S4, 18, 'mph') - 8
T(L, 'speed', nr - 300, sb, 300, '{{speed}}', 'au_speed', 'fg', align='right')
T(L, 'speed_u', nr + 8, sb, 80, '{{u:speedLc}}', 'au_unit', 'dim')
cap_lh = sum(metrics(S6, 13))
rows = [251 + cap_lh + 22]
rows += [rows[0] + 78, rows[0] + 156]
for (x0, title) in ((211, 'POWERTRAIN'), (1351, 'DYNAMICS')):
    T(L, title.lower() + '_lab', x0, 251 + metrics(S6, 13)[0], 300, title, 'au_cap', 'dim')


def card_row(key, x0, top, label, value, units, unit_txt, warn=None):
    right = x0 + 358
    uw = max(width(S4, 16, u) for u in units)
    vb = css_base(top, 40, S3, 40)
    lb = top + 40 - metrics(S4, 16)[1]
    kw = {'showWhen': '!warn:' + warn} if warn else {}
    T(L, key + '_lab', x0, lb, 200, label, 'au_unit', 'dim', **kw)
    vk = {'warnColor': 'amber', 'warnFlash': False} if warn else {}
    T(L, key, right - uw - 6 - 220, vb, 220, value, 'au_val', 'fg', align='right', **vk)
    T(L, key + '_u', right - uw, vb, uw + 2, unit_txt, 'au_unit', 'dim')
    if warn:
        T(L, key + '_high', x0, top + 40 - metrics(S6, 13)[1], 220, label.upper() + ' · HIGH', 'au_cap', 'amber', showWhen='warn:' + warn)


card_row('oil', 211, rows[0], 'Oil', '{{oil}}°', ['F', 'C'], '{{u:deg}}')
card_row('coolant', 211, rows[1], 'Coolant', '{{coolant}}°', ['F', 'C'], '{{u:deg}}', warn='coolant')
card_row('fuel', 211, rows[2], 'Fuel', '{{fuelPct}}', ['%'], '%')
card_row('boost', 1351, rows[0], 'Boost', '{{boost}}', ['psi', 'bar'], '{{u:boostLc}}')
gtop = rows[0] + 56 + 26
lt = gtop + (150 - (sum(metrics(S4, 16)) + 8 + 40)) / 2
T(L, 'g_lab', 1351, lt + metrics(S4, 16)[0], 200, 'G-force', 'au_unit', 'dim')
gb = css_base(lt + sum(metrics(S4, 16)) + 8, 40, S3, 40)
T(L, 'g', 1351, gb, 160, '{{gNow}}', 'au_val', 'fg')
T(L, 'g_u', 1351 + adv('au_val', '0.0') + 6, gb, 30, 'g', 'au_unit', 'dim')
for i, (x, y) in enumerate([(716.6, 550.5), (679.8, 389.0), (740.3, 234.8), (877.2, 141.5), (1042.8, 141.5), (1179.7, 234.8), (1240.2, 389.0), (1203.4, 550.5)]):
    T(L, 'tick%d' % i, x - 12, y, 24, str(i), 'au_tick', 'red' if i == 7 else 'dim', align='center')
rb = 668 + metrics(S4, 24)[0]
tr = 180 + width(S4, 24, '12:00')
T(L, 'clock', tr - 140, rb, 140, '{{time}}', 'au_row', 'fg', align='right')
T(L, 'ampm', tr + 8, rb, 60, '{{ampm}}', 'au_unit', 'dim')
cg = width(S4, 24, '238 mi') + 8 + width(S4, 16, 'range')
cr = 960 + cg / 2 - width(S4, 16, 'range') - 8
T(L, 'range', cr - 200, rb, 200, '{{range}} {{u:distLc}}', 'au_row', 'fg', align='right')
T(L, 'range_l', cr + 8, rb, 80, 'range', 'au_unit', 'dim')
T(L, 'out', 1500, rb, 110, '{{ambientN}}°{{u:deg}}', 'au_row', 'fg')
T(L, 'out_l', 1500 + adv('au_row', '54°F') + 8, rb, 90, 'outside', 'au_unit', 'dim')
pb = 570 + 1 + 8 + metrics(S6, 16)[0]
T(L, 'shift_up', 941, pb, 120, 'Shift up', 'au_pill', 'orange', showWhen='shift', rate=25)
T(L, 'warn_pill', 824, pb, 320, 'Coolant temperature high · {{coolant}}°{{u:deg}}', 'au_pill', 'amber', showWhen='warn:coolant', warnFlash=False)
L.write()

# Orbital (08 · ORBITAL, Space telemetry): Space Grotesk and Space Mono; the orbit round 960,392, the globe at 1540,408.
# The design's rpm label rides beside the satellite; here it stays put above the orbit (a text can't move on the cluster).
L = Layout('orbital', 'Orbital', 'orbital', nightDim=0.8)
G3, G4, M4, M7 = 'SpaceGrotesk-300.ttf', 'SpaceGrotesk-400.ttf', 'SpaceMono-400.ttf', 'SpaceMono-700.ttf'
T(L, 'rpm', 840, css_base(184, 18, M4, 14), 240, '{{rpmSp}} RPM', 'ob_rpm', 'fg', align='center', hotWhen='now')
T(L, 'mode', 660, css_base(246, 18, M4, 14), 600, '{{mode}}', 'ob_mode', 'sec', align='center')
T(L, 'gear', 810, css_base(292, 200, G3, 250), 300, '{{gearnum}}', 'ob_gear', 'fg', align='center')
T(L, 'scale', 660, css_base(506, 16, M4, 12), 600, 'RPM × 1000', 'ob_small', 'dim', align='center')
T(L, 'vel_lab', 180, css_base(232, 17, M4, 13), 200, 'VELOCITY', 'ob_lab', 'dim')
T(L, 'speed', 176, css_base(254, 120, G3, 150), 380, '{{speed}}', 'ob_speed', 'fg')
T(L, 'speed_u', 184, css_base(382, 19, M4, 15), 120, '{{u:speed}}', 'ob_unit', 'dim')
for key, lt_, vt, label, val, warn in (('oil', 462, 452, 'OIL TEMP', '{{oil}}°{{u:deg}}', None), ('coolant', 518, 508, 'COOLANT', '{{coolant}}°{{u:deg}}', 'coolant'),
                                       ('fuel', 574, 564, 'FUEL', '{{fuelPct}}%', None)):
    lb = css_base(lt_, 16, M4, 12)
    if warn:
        T(L, key + '_lab', 180, lb, 150, label, 'ob_lab', 'dim', showWhen='!warn:' + warn)
        T(L, key + '_warn', 180, lb, 80, label, 'ob_lab', 'amber', showWhen='warn:' + warn)
        T(L, key + '_badge', 263, lb, 76, 'ANOMALY', 'ob_small', 'ink', showWhen='warn:' + warn)
    else:
        T(L, key + '_lab', 180, lb, 150, label, 'ob_lab', 'dim')
    vk = {'warnColor': 'amber', 'warnFlash': False} if warn else {}
    T(L, key, 340, css_base(vt, 34, G4, 30), 200, val, 'ob_val', 'fg', align='right', **vk)
T(L, 'boost_lab', 1400, css_base(232, 17, M4, 13), 200, 'BOOST', 'ob_lab', 'dim')
bb = css_base(254, 64, G3, 72)
T(L, 'boost', 1398, bb, 220, '{{boost}}', 'ob_boost', 'fg')
T(L, 'boost_u', 1398 + adv('ob_boost', '18.6') + 8, bb, 80, '{{u:boost}}', 'ob_unit', 'dim')
T(L, 'g_lab', 1400, css_base(384, 17, M4, 13), 240, 'G · ATTITUDE', 'ob_lab', 'dim')
gb = css_base(470, 50, G3, 56)
T(L, 'g', 1398, gb, 130, '{{gNow}}', 'ob_g', 'fg')
T(L, 'g_u', 1398 + adv('ob_g', '0.0') + 6, gb, 30, 'G', 'ob_unit', 'dim')
for i, (x, y) in enumerate([(617.5, 497.5), (580.0, 332.2), (721.3, 242.0), (878.9, 209.8), (1040.3, 209.7), (1198.1, 241.8), (1339.7, 331.8), (1302.9, 497.1)]):
    T(L, 'tick%d' % i, x - 12, y, 24, str(i), 'ob_tick', 'red' if i == 7 else 'dim', align='center')
rb = css_base(670, 22, M4, 18)
tw = width(M4, 18, '12:00', 3.6)
T(L, 'clock', 180, rb, tw + 4, '{{time}}', 'ob_row', 'fg', align='right')
T(L, 'ampm', 180 + tw + 12, rb, 60, '{{ampm}}', 'ob_row', 'dim')
T(L, 'range_l', 760, rb, 160 - 8, 'RANGE', 'ob_row', 'dim', align='right')
T(L, 'range', 920, rb, 80, '{{range}}', 'ob_row', 'fg', align='center')
T(L, 'range_u', 1008, rb, 80, '{{u:dist}}', 'ob_row', 'dim')
T(L, 'out_l', 1500, rb, 70, 'EXT', 'ob_row', 'dim')
T(L, 'out', 1500 + width(M4, 18, 'EXT ', 3.6), rb, 140, '{{ambientN}}°{{u:deg}}', 'ob_row', 'fg')
tb = 128 + 1 + 6 + metrics(M7, 16)[0]
T(L, 'shift_tag', 913, tb, 90, 'SHIFT', 'ob_alert', 'orange', showWhen='shift', rate=25)
T(L, 'warn_tag', 800, tb, 360, 'COOLANT ANOMALY · {{coolant}}°{{u:deg}}', 'ob_alert', 'amber', showWhen='warn:coolant', warnFlash=False)
L.write()

# VFD (T4 · VFD, the "Terminal variants" page: an 80s vacuum-fluorescent dash) in three phosphors at once: the middle
# cyan, the left panel and the clock amber, the right panel and the outside green (the design's three filters). Share
# Tech Mono labels at the design's sizes; every number in seven segments (vf_gear / vf_speed / vf_val / vf_row, drawn from
# the design's own segment geometry) over the ghost 8s the shader draws in the same slots. A number's box ends 2 glow
# radii past its last slot (bake_seg's DELTA): slot x + slots x pitch + DELTA, right-aligned, so each digit lands in its slot.
L = Layout('vfd', 'VFD', 'vfd', nightDim=0.8)
STM = 'ShareTechMono-Regular.ttf'


def lab(id, x, top, lh, size, txt, color='dim', **kw):
    T(L, id, x, css_base(top, lh, STM, size), kw.pop('w', 200), txt, 'vf_%d' % size, color, **kw)


def seg(id, f, x0, top, slots, pitch, glow, txt, room=1, **kw):
    """Seven-segment text in `slots` digit slots from x0, top (the design's slot origin: before the slant, so the digits'
    bottom-left), `room` slots more to the left for a longer value (a minus, a fourth digit). The cell keeps 2 + 2 glow px
    round the ink (bake_seg), so the box starts that much above the digits' top."""
    pad = 2 + 2 * glow
    right, left = x0 + slots * pitch + 2 * glow, x0 - room * pitch - pad
    L.text(id, int(left), int(top + font(f)['baseline'] - pad), int(right - left), txt, f, kw.pop('color', 'fg'), align='right',
           glow=True, **kw)


lab('rpm_l', 400, 182, 19, 15, 'RPM')
lab('rpm_x', 1420, 182, 19, 15, '×1000')
tick = font('vf_tick')['glyphs']['0']['advance']
L.w.append({'id': 'rpm_scale', 'type': 'scale', 'z': 5, 'x': int(round(516 - tick / 2)), 'w': int(round(880 + tick)),
            'y': int(round(css_base(210, 19, STM, 15) - font('vf_tick')['baseline'])), 'h': font('vf_tick')['cellHeight'],
            'font': 'vf_tick', 'color': 'dim', 'redFrom': True})
# the drive modes light in their own colours: Comfort cyan, Sport orange, Eco Pro green
for id, x, mode, lc in (('m_comfort', 760, 'COMFORT', 'fg'), ('m_sport', 900, 'SPORT', 'orange'), ('m_eco', 1010, 'ECO PRO', 'green')):
    lab(id, x, 244, 24, 20, mode, 'ghost', w=112, glow='lit', lit={'when': 'mode:' + mode, 'color': lc})
lab('m_shift', 1130, 244, 24, 20, 'SHIFT', 'ghost', w=90, glow='lit', rate=25, lit={'when': 'shift', 'color': 'orange', 'blink': 125})
lab('gear_l', 730, 282, 19, 15, 'GEAR')
seg('gear', 'vf_gear', 890, 284, 1, 170, 6, '{{gearnum}}', room=0)
L.w[-1]['h'] -= 2                       # clear of the speed's box (a box overlapping another goes on a sheet of its own)
seg('speed', 'vf_speed', 843, 532, 3, 82, 4, '{{speed}}', room=0)
lab('speed_u', 1104, 612, 22, 18, '{{u:speed}}', w=90)
warn = lambda r: {'warnFlash': False, 'rate': 100, 'lit': {'when': 'warn:' + r, 'color': 'red', 'blink': 500}}
for key, top, label, val in (('oil', 266, 'OIL TEMP', '{{oil}}'), ('coolant', 370, 'COOLANT', '{{coolant}}'), ('fuel', 474, 'FUEL', '{{fuelPct}}')):
    lab(key + '_l', 204, top, 21, 17, label, 'adim')
    if key == 'fuel':
        seg('fuel', 'vf_val', 204, top + 26, 3, 36, 3, val, color='amber')
        lab('fuel_u', 312, top + 52, 21, 17, '%', 'adim', w=24)
    else:
        seg(key, 'vf_val', 204, top + 26, 3, 36, 3, val, color='amber', **warn(key))
        lab(key + '_u', 330, top + 52, 21, 17, '{{u:temp}}', 'adim', w=40)
        lab(key + '_hot', 574, top, 21, 17, 'HOT', 'aghost', w=56, glow='lit', rate=100, lit={'when': 'warn:' + key, 'color': 'red', 'blink': 500})
lab('fuel_e', 204, 604, 19, 15, 'E', 'adim', w=20)
lab('fuel_h', 404, 604, 19, 15, '½', 'adim', w=20)
lab('fuel_f', 612, 604, 19, 15, 'F', 'adim', w=20)
lab('boost_l', 1294, 266, 21, 17, 'BOOST', 'gdim')
seg('boost', 'vf_val', 1294, 292, 3, 36, 3, '{{boost}}', color='green')
lab('boost_u', 1440, 318, 21, 17, '{{u:boost}}', 'gdim', w=60)
lab('g_l', 1294, 392, 21, 17, 'G LOAD', 'gdim')
seg('g', 'vf_val', 1294, 420, 2, 36, 3, '{{gNow}}', color='green')
lab('g_u', 1376, 454, 21, 17, 'G', 'gdim', w=24)
seg('clock', 'vf_row', 206, 664, 2, 28, 2, '{{time}}', room=0, color='amber')
L.w[-1].update({'x': 190, 'w': 280 + 2 * 28 + 4 - 190})       # hours in two slots from 206, the colon, minutes from 280
lab('am', 350, 664, 19, 15, 'AM', 'aghost', w=40, glow='lit', lit={'when': 'ampm:AM', 'color': 'amber'})
lab('pm', 350, 682, 19, 15, 'PM', 'aghost', w=40, glow='lit', lit={'when': 'ampm:PM', 'color': 'amber'})
lab('range_l', 810, 680, 18, 14, 'RANGE', w=60)
seg('range', 'vf_row', 898, 664, 3, 28, 2, '{{range}}')
lab('range_u', 992, 680, 20, 16, '{{u:dist}}', w=40)
lab('out_l', 1500, 680, 18, 14, 'EXT', 'gdim', w=40)
seg('out', 'vf_row', 1556, 664, 2, 28, 2, '{{ambientN}}', room=0, color='green')
lab('out_u', 1620, 680, 20, 16, '{{u:temp}}', 'gdim', w=40)
L.write()
