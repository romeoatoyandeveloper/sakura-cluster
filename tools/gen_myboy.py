#!/usr/bin/env python3
"""Write the My Boy layout (apps/cluster_themes/hud/layouts/myboy.json), in panel px. Edit this, not the JSON:

    python3 tools/gen_myboy.py apps/cluster_themes

His photo (tools/photo-src/myboy.png, baked by tools/bake_photo_art.py) stands in the middle on a night-blue sky, his
face centred on the panel, his head under the driver camera's notch (y 110) and his romper running off the bottom edge.
The speed on the left, the gear on the right (a small heart under it, breathing while the car stands), under each a
checker rev strip in the romper's blue and cream (both fill from the outer end towards him), then two readouts a side
and the bottom row: the clock and the outside temperature. Three layers on one connection. Text is placed by baseline
using the baked fonts' metrics, as tools/gen_sakura.py.
"""
import json, os, sys
from PIL import Image

APP = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(APP, 'hud', 'fonts')
M = {n: json.load(open(os.path.join(FONTS, n + '.json'))) for n in
     ['mb_speed', 'mb_gear', 'mb_val', 'mb_row', 'mb_unit', 'mb_label']}
base = lambda f: M[f]['baseline']
cell = lambda f: M[f]['cellHeight']
KEEP = [1380, 660, 1460, 720]             # BMW's gear letter in its bottom strip stays uncovered
PW, PH = Image.open(os.path.join(HERE, 'photo-src', 'myboy.png')).size
FACE_X = 441                              # his face's middle in the photo (x of the cheeks' midpoint)
PHOTO = [960 - FACE_X, 720 - PH]          # face on the panel's centre line, the photo's bottom on the panel's
SQ = 24
L_X, R_X, COL_W = 70, 1394, 456           # the side columns: x, width (the right one mirrors the left)
STRIP_Y = 452

widgets = []


def text(id, x, y_base, w, txt, font, color, **kw):
    d = {'id': id, 'type': 'text', 'z': 5, 'x': x, 'y': y_base - base(font), 'w': w, 'h': cell(font), 'text': txt,
         'font': font, 'color': color}
    d.update(kw)
    widgets.append(d)
    return d


widgets.append({'id': 'scene', 'type': 'photo', 'class': 'content', 'z': 0, 'x': 0, 'y': 0, 'w': 1920, 'h': 720,
                'art': 'myboy', 'photo': PHOTO, 'halo': [960, 300, 330, 300], 'sq': SQ,
                'strips': [[L_X, STRIP_Y, COL_W, 2 * SQ], [R_X, STRIP_Y, COL_W, 2 * SQ]], 'keep': KEEP,
                'heart': [R_X + COL_W // 2, 406, 30]})

# left: the drive mode, the speed and its unit
text('mode', L_X, 200, COL_W, '{{mode}}', 'mb_label', 'dim', align='center')
text('speed', L_X, 372, COL_W, '{{speed}}', 'mb_speed', 'fg', align='center')
text('speed_u', L_X, 418, COL_W, '{{u:speedLc}}', 'mb_unit', 'dim', align='center')
# right: the gear, and under it the heart (drawn by the backdrop) where the left has the unit
text('gear_lab', R_X, 200, COL_W, 'GEAR', 'mb_label', 'dim', align='center')
text('gear', R_X, 372, COL_W, '{{gear}}', 'mb_gear', 'fg', align='center')


def readout(key, x, w, label, value, **kw):
    text(key + '_lab', x, 556, w, label, 'mb_label', 'dim', align='center', **({'warnOf': kw['warn']} if 'warn' in kw else {}))
    text(key, x, 614, w, value, 'mb_val', 'fg', align='center')


half = COL_W // 2
readout('oil', L_X, half, 'OIL', '{{oil}}°', warn='oil')
readout('coolant', L_X + half, half, 'COOLANT', '{{coolant}}°', warn='coolant')
readout('fuel', R_X, half, 'FUEL', '{{fuelPct}}%')
readout('range', R_X + half, half, 'RANGE {{u:dist}}', '{{range}}')
# the bottom row: the clock on the left (clear of the belt light at x 587), outside on the right (right of BMW's gear
# letter at x 1380..1460)
text('clock', L_X, 694, COL_W, '{{time}} {{ampm}}', 'mb_row', 'sec', align='center')
text('out', 1470, 694, 2 * (R_X + COL_W // 2 - 1470), '{{ambientN}}{{u:temp}}', 'mb_row', 'sec', align='center')   # centred under the gear
out = os.path.join(APP, 'hud', 'layouts', 'myboy.json')
json.dump({'schemaVersion': 2, 'name': 'My Boy', 'packWaste': 3, 'theme': 'myboy', 'widgets': widgets},
          open(out, 'w', encoding='utf8'), indent=2, ensure_ascii=False)
print('wrote', out, len(widgets), 'widgets; photo at', PHOTO, PW, 'x', PH)
