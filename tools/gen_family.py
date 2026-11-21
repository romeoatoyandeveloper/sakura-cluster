#!/usr/bin/env python3
"""Write the My Family layouts (apps/cluster_themes/hud/layouts/family.json and family_sakura.json), in panel px. Edit
this, not the JSON:

    python3 tools/gen_family.py apps/cluster_themes

The family (tools/photo-src/family.png, baked by tools/bake_photo_art.py) stands in the middle of the scene, their feet
just above BMW's bottom strip (y 656): on a Dutch canal quay at blue hour between two street lamps (My Family,
shaders.js scene_canal, fairy lights for the revs), or by a lake at night under cherry blossom, Mount Fuji
and a pagoda across the water (My Family: Sakura, scene_hanami, paper lanterns for the revs). Around them, as My Boy: the drive mode and the speed on the left, the gear
on the right, two readouts a side over the water and the bottom row, the clock and the outside temperature. Text is
placed by baseline using the baked fonts' metrics, as tools/gen_myboy.py.
"""
import json, os, sys
from PIL import Image

APP = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(APP, 'hud', 'fonts')
M = {n: json.load(open(os.path.join(FONTS, n + '.json'))) for n in ['mb_speed', 'mb_gear', 'mb_val', 'mb_row', 'mb_label']}
base = lambda f: M[f]['baseline']
cell = lambda f: M[f]['cellHeight']
KEEP = [1380, 660, 1460, 720]             # BMW's gear letter in its bottom strip stays uncovered
PW, PH = Image.open(os.path.join(HERE, 'photo-src', 'family.png')).size
PHOTO = [960 - PW // 2, 656 - PH]         # centred, their feet on the quay just above BMW's strip
L_X, R_X, COL_W = 70, 1394, 456           # the side columns (the right one mirrors the left), as My Boy's


def text(widgets, id, x, y_base, w, txt, font, color, **kw):
    d = {'id': id, 'type': 'text', 'z': 5, 'x': x, 'y': y_base - base(font), 'w': w, 'h': cell(font), 'text': txt,
         'font': font, 'color': color}
    d.update(kw)
    widgets.append(d)


def layout(name, title, scene):
    widgets = [{'id': 'scene', 'type': 'scene', 'scene': scene, 'class': 'content', 'z': 0, 'x': 0, 'y': 0, 'w': 1920,
                'h': 720, 'keep': KEEP, 'art': 'family', 'photo': PHOTO, 'nightDim': 0.85}]
    t = lambda *a, **kw: text(widgets, *a, **kw)
    t('mode', L_X, 200, COL_W, '{{mode}}', 'mb_label', 'dim', align='center')
    t('speed', L_X, 372, COL_W, '{{speed}}', 'mb_speed', 'fg', align='center')
    t('speed_u', L_X, 418, COL_W, '{{u:speedLc}}', 'mb_label', 'dim', align='center')
    t('gear_lab', R_X, 200, COL_W, 'GEAR', 'mb_label', 'dim', align='center')
    t('gear', R_X, 372, COL_W, '{{gear}}', 'mb_gear', 'fg', align='center')

    def readout(key, x, w, label, value, **kw):
        t(key + '_lab', x, 556, w, label, 'mb_label', 'dim', align='center', **({'warnOf': kw['warn']} if 'warn' in kw else {}))
        t(key, x, 614, w, value, 'mb_val', 'fg', align='center')

    half = COL_W // 2
    readout('oil', L_X, half, 'OIL', '{{oil}}°', warn='oil')
    readout('coolant', L_X + half, half, 'COOLANT', '{{coolant}}°', warn='coolant')
    readout('fuel', R_X, half, 'FUEL', '{{fuelPct}}%')
    readout('range', R_X + half, half, 'RANGE {{u:dist}}', '{{range}}')
    t('clock', L_X, 694, COL_W, '{{time}} {{ampm}}', 'mb_row', 'sec', align='center')
    t('out', 1470, 694, 2 * (R_X + COL_W // 2 - 1470), '{{ambientN}}{{u:temp}}', 'mb_row', 'sec', align='center')
    out = os.path.join(APP, 'hud', 'layouts', name + '.json')
    json.dump({'schemaVersion': 2, 'name': title, 'packWaste': 3, 'theme': name, 'widgets': widgets},
              open(out, 'w', encoding='utf8'), indent=2, ensure_ascii=False)
    print('wrote', out, len(widgets), 'widgets; the family at', PHOTO, PW, 'x', PH)


layout('family', 'My Family', 'canal')
layout('family_sakura', 'My Family: Sakura', 'hanami')
