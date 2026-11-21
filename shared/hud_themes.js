'use strict';
/**
 * HUD colour themes. Layouts name colour *roles* ("fg", "dim", "arc", ...) and
 * the active theme fills them in, so every layout works in every theme.
 *
 * HUD rule (Nov 7 2026, from road photos: greys were hard to see even at night): the HUD is a projector, so a dim or
 * see-through colour comes out faint on the glass. Every HUD role is opaque and no lit colour is darker than
 * about 70 % brightness; only "track" (the unlit part of a bar) stays partly see-through, at 96..110 of 255.
 *
 * Colours are [r, g, b, a] 0-255. On the HUD, black is see-through glass, so a
 * theme only ever adds light. Dark blue is the weakest colour on a HUD in sun;
 * M's mid blue is kept brighter than the paint-chip M blue for that reason.
 *
 * bar: the shift bar's three zones. lowColor up to midAt, midColor up to the
 * red zone, highColor from there. midAt: 'shift' = where the shift zone starts
 * (redline - 1500), or a fraction of the bar (M climbs light blue -> blue at 50%).
 */
const THEMES = {
    classic: {
        name: 'Classic',
        fg: [243, 246, 250, 255], dim: [200, 208, 220, 255], track: [243, 246, 250, 96], arc: [243, 246, 250, 255],
        glow: 0.35, stripe: false,
        bar: { low: [243, 246, 250], mid: [255, 154, 60], high: [255, 75, 62], midAt: 'shift' },
        rev: { from: [185, 192, 204], to: [243, 246, 250] },
    },
    m: {
        name: 'M',
        fg: [243, 246, 250, 255], dim: [170, 205, 255, 255], track: [80, 150, 255, 110], arc: [79, 180, 255, 255],
        glow: 0.4, stripe: true,
        bar: { low: [79, 180, 255], mid: [51, 102, 255], high: [232, 38, 45], midAt: 0.5 },
        rev: { from: [51, 102, 255], to: [110, 170, 255] },
    },
    night: {
        name: 'Night',
        fg: [255, 179, 71, 255], dim: [235, 165, 70, 255], track: [255, 179, 71, 96], arc: [255, 179, 71, 255],
        glow: 0.3, stripe: false,
        bar: { low: [255, 179, 71], mid: [255, 179, 71], high: [255, 75, 62], midAt: 'shift' },
        rev: { from: [205, 135, 55], to: [255, 179, 71] },
    },
    // Cluster theme (a layout's own "theme"). The cluster is an LCD, not glass: black is solid black there,
    // and it covers BMW's gauges under it. Extra roles: bg (the screen), panel (box inside), line (box
    // frame), head (box header strip), ink (text on a header), accent (a highlighted header).
    // The car brightens dark tints (Nov 5 2026: a navy backdrop came out light steel blue), so until that curve
    // is measured every large area (bg, panel, well) is pure black in all the cluster themes.
    gt3: {
        name: 'GT3',
        fg: [244, 244, 244, 255], dim: [150, 154, 160, 255], track: [255, 255, 255, 26], arc: [244, 244, 244, 255],
        glow: 0, stripe: false,
        bar: { low: [57, 222, 72], mid: [255, 196, 0], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [57, 222, 72], to: [57, 222, 72] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [205, 208, 214, 255], head: [226, 228, 232, 255],
        ink: [12, 12, 14, 255], accent: [255, 196, 0, 255], well: [0, 0, 0, 255], wellLine: [70, 74, 80, 255],
    },
    // Sport (layout sport.json): BMW's Live Cockpit Sport view, blue speed and red revs round the map.
    // Extra roles: sblue / spink (the speed and rpm scale numbers), sred (the rpm caption).
    sportdash: {
        name: 'Sport',
        fg: [244, 247, 252, 255], dim: [150, 170, 205, 255], track: [70, 80, 100, 255], arc: [60, 215, 255, 255],
        glow: 0, stripe: false,
        bar: { low: [60, 215, 255], mid: [60, 215, 255], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [224, 26, 56], to: [224, 26, 56] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [60, 215, 255, 255], head: [226, 228, 232, 255],
        ink: [12, 12, 14, 255], accent: [60, 215, 255, 255], well: [0, 0, 0, 255], faint: [96, 110, 135, 255],
        sblue: [120, 170, 245, 255], spink: [236, 140, 140, 255], sred: [235, 60, 70, 255],
    },
    // M cluster look (layout m.json, after design/photos/ref-m8-cluster.png): black, white numbers with a chrome
    // fade, M red needles and setup bars. Extra roles: redTrack, chrome (bottom of a chrome fade), grey / grey2
    // (the dim gear number's fade), faint.
    mdash: {
        name: 'M',
        fg: [238, 241, 246, 255], dim: [132, 140, 152, 255], track: [104, 110, 120, 255], arc: [226, 36, 44, 255],
        glow: 0, stripe: false,
        bar: { low: [226, 36, 44], mid: [226, 36, 44], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [226, 36, 44], to: [226, 36, 44] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [196, 202, 212, 255], head: [226, 228, 232, 255],
        ink: [12, 12, 14, 255], accent: [226, 36, 44, 255], well: [0, 0, 0, 255], redTrack: [90, 16, 20, 255],
        chrome: [182, 188, 198, 255], grey: [160, 166, 176, 255], grey2: [104, 110, 122, 255], faint: [96, 104, 118, 255],
    },
    // Vector (layout vector.json, design/gen_vector.py): black with grey bracket lines, white numbers, coloured rings.
    vector: {
        name: 'Vector',
        fg: [238, 241, 246, 255], dim: [140, 148, 160, 255], track: [40, 43, 50, 255], arc: [238, 241, 246, 255],
        glow: 0, stripe: false,
        bar: { low: [238, 241, 246], mid: [238, 241, 246], high: [242, 31, 36], midAt: 'shift' },
        rev: { from: [242, 31, 36], to: [242, 31, 36] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [128, 135, 148, 255], head: [226, 228, 232, 255],
        ink: [12, 12, 14, 255], accent: [242, 31, 36, 255], well: [0, 0, 0, 255], faint: [96, 104, 118, 255],
    },
    // Minimal (layout minimal.json): white on black, nothing but the speed, the gear and a fuel line.
    minimal: {
        name: 'Minimal',
        fg: [240, 243, 248, 255], dim: [128, 134, 146, 255], track: [44, 48, 56, 255], arc: [240, 243, 248, 255],
        glow: 0, stripe: false,
        bar: { low: [240, 243, 248], mid: [240, 243, 248], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [240, 243, 248], to: [240, 243, 248] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [70, 74, 82, 255], head: [226, 228, 232, 255],
        ink: [12, 12, 14, 255], accent: [240, 243, 248, 255], well: [0, 0, 0, 255],
    },
    // Track (layout track.json): the race-dash frame of GT3 with amber headers, tyres and temps round a big gear.
    track: {
        name: 'Track',
        fg: [244, 244, 244, 255], dim: [150, 154, 160, 255], track: [255, 255, 255, 30], arc: [244, 244, 244, 255],
        glow: 0, stripe: false,
        bar: { low: [57, 222, 72], mid: [255, 196, 0], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [57, 222, 72], to: [57, 222, 72] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [205, 208, 214, 255], head: [255, 176, 0, 255],
        ink: [12, 12, 14, 255], accent: [226, 228, 232, 255], well: [0, 0, 0, 255],
    },
    // Drag (layout drag.json): a full-width shift bar, the 0-60 timer, green for go.
    drag: {
        name: 'Drag',
        fg: [244, 246, 250, 255], dim: [140, 148, 160, 255], track: [255, 255, 255, 30], arc: [80, 230, 110, 255],
        glow: 0, stripe: false,
        bar: { low: [80, 230, 110], mid: [255, 205, 0], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [80, 230, 110], to: [80, 230, 110] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [190, 196, 206, 255], head: [226, 228, 232, 255],
        ink: [12, 12, 14, 255], accent: [80, 230, 110, 255], well: [0, 0, 0, 255], go: [80, 230, 110, 255],
    },
    // Rally (layout rally.json): a sweeping rev arc over a huge gear, a G-meter, rally yellow.
    rally: {
        name: 'Rally',
        fg: [246, 246, 246, 255], dim: [160, 164, 170, 255], track: [255, 255, 255, 34], arc: [255, 210, 0, 255],
        glow: 0, stripe: false,
        bar: { low: [246, 246, 246], mid: [255, 210, 0], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [246, 246, 246], to: [255, 210, 0] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [205, 208, 214, 255], head: [255, 210, 0, 255],
        ink: [12, 12, 14, 255], accent: [255, 210, 0, 255], well: [0, 0, 0, 255],
    },
    // Sakura (layout sakura.json): pixel-art cherry blossoms at night. The scene, petals, blossoms and plates are one
    // shader (shaders.js sakura, colours there); these are its text colours: values, secondary values, English labels,
    // Japanese labels, the rpm numerals and the warning ink on the amber plate.
    sakura: {
        name: 'Sakura',
        fg: [255, 246, 250, 255], dim: [180, 172, 219, 255], sec: [230, 224, 245, 255], jp: [229, 143, 180, 255],
        num: [143, 134, 192, 255], numRed: [255, 51, 68, 255], shift: [255, 45, 85, 255], ink: [26, 15, 0, 255],
        track: [38, 32, 73, 255], arc: [255, 127, 175, 255], glow: 0, stripe: false,
        bar: { low: [255, 127, 175], mid: [255, 221, 235], high: [255, 51, 68], midAt: 'shift' },
        rev: { from: [255, 127, 175], to: [255, 51, 68] },
        bg: [8, 7, 15, 255], panel: [14, 11, 30, 255], line: [38, 32, 73, 255], head: [180, 172, 219, 255],
        accent: [229, 143, 180, 255], well: [8, 7, 15, 255],
    },
    // Retro (layouts retro80s.json, HUD retro.json): an 80s digital dash, amber seven-segment digits over their
    // unlit 8s, green-amber-red bar graphs. Kept bright enough for the HUD rule above.
    retro: {
        name: 'Retro',
        fg: [255, 178, 36, 255], dim: [226, 156, 40, 255], track: [255, 170, 40, 100], arc: [80, 255, 120, 255],
        glow: 0, stripe: false,
        bar: { low: [80, 255, 120], mid: [255, 178, 36], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [80, 255, 120], to: [255, 178, 36] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [255, 178, 36, 255], head: [80, 255, 120, 255],
        ink: [12, 12, 14, 255], accent: [80, 255, 120, 255], well: [0, 0, 0, 255],
        green: [80, 255, 120, 255], ghost: [255, 170, 40, 40],
    },
    // Cruise (layouts cruise.json): calm and quiet for the highway, soft white and a cool teal, no reds until needed.
    cruise: {
        name: 'Cruise',
        fg: [228, 234, 242, 255], dim: [176, 188, 204, 255], track: [255, 255, 255, 100], arc: [120, 212, 222, 255],
        glow: 0, stripe: false,
        bar: { low: [120, 212, 222], mid: [228, 234, 242], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [120, 212, 222], to: [120, 212, 222] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [96, 110, 126, 255], head: [120, 212, 222, 255],
        ink: [12, 12, 14, 255], accent: [120, 212, 222, 255], well: [0, 0, 0, 255],
    },
    // Dyno (layout dyno.json, Nov 8 2026): readout tiles in BMW M's colours: near-black tiles with an M light-blue
    // strip, bars light blue -> dark blue -> red (bar1, bar2, hot), a tile goes M red (warn) over its warning limit
    dyno: {
        name: 'Dyno',
        fg: [242, 245, 250, 255], dim: [150, 164, 184, 255], track: [255, 255, 255, 28], arc: [0, 150, 224, 255],
        glow: 0, stripe: false,
        bar: { low: [0, 150, 224], mid: [40, 92, 200], high: [226, 39, 46], midAt: 'shift' },
        rev: { from: [0, 150, 224], to: [0, 150, 224] },
        bg: [0, 0, 0, 255], panel: [14, 17, 23, 255], line: [46, 56, 72, 255], head: [0, 150, 224, 255],
        ink: [12, 12, 14, 255], accent: [0, 150, 224, 255], well: [0, 0, 0, 255],
        bar1: [0, 150, 224, 255], bar2: [40, 92, 200, 255], warn: [226, 39, 46, 255],
    },
    // Ribbon (layout ribbon.json, Nov 13 2026): calm and premium. One ribbon of light under the hood line fills with the
    // revs (cool white, warming to amber, red at the top), a huge thin speed, thin side columns. Extra roles: gear (the
    // gear number), ribbon (the line's gradient), greeting (the {{holiday}} text). holidays: true = the holiday
    // editions below (ribbon_<key>, shared/holidays.js) replace it while the "holiday" setting picks one.
    ribbon: {
        name: 'Ribbon',
        fg: [244, 241, 234, 255], dim: [107, 122, 140, 255], track: [29, 39, 51, 255], arc: [201, 180, 138, 255],
        glow: 0, stripe: false,
        bar: { low: [159, 211, 255], mid: [255, 196, 107], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [159, 211, 255], to: [255, 196, 107] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [107, 122, 140, 255], head: [201, 180, 138, 255],
        ink: [12, 12, 14, 255], accent: [201, 180, 138, 255], well: [0, 0, 0, 255], gear: [233, 215, 173, 255],
        ribbon: { stops: [[159, 211, 255], [255, 255, 255], [255, 196, 107], [255, 90, 60], [255, 42, 42]], at: [0.55, 0.8, 0.93, 1] },
        holidays: true,
        deco: 0,
        greeting: '',
    },
    ribbon_xmas: {
        name: 'Ribbon · Christmas',
        fg: [246, 241, 230, 255], dim: [127, 154, 136, 255], track: [29, 39, 51, 255], arc: [232, 194, 90, 255],
        glow: 0, stripe: false,
        bar: { low: [255, 58, 58], mid: [255, 211, 107], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [255, 58, 58], to: [255, 211, 107] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [127, 154, 136, 255], head: [232, 194, 90, 255],
        ink: [12, 12, 14, 255], accent: [232, 194, 90, 255], well: [0, 0, 0, 255], gear: [232, 194, 90, 255],
        ribbon: { stops: [[255, 58, 58], [47, 220, 106], [255, 211, 107], [79, 163, 255], [255, 26, 26]], at: [0.5, 0.8, 0.86, 1] },
        bulbs: true,
        wire: [31, 58, 42],
        deco: 1,
        decoColors: [[255, 255, 255], [255, 255, 255], [255, 255, 255]],
        greeting: 'MERRY CHRISTMAS',
    },
    ribbon_thanks: {
        name: 'Ribbon · Thanksgiving',
        fg: [251, 238, 221, 255], dim: [160, 138, 112, 255], track: [29, 39, 51, 255], arc: [224, 135, 58, 255],
        glow: 0, stripe: false,
        bar: { low: [201, 162, 74], mid: [255, 154, 60], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [201, 162, 74], to: [255, 154, 60] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [160, 138, 112, 255], head: [224, 135, 58, 255],
        ink: [12, 12, 14, 255], accent: [224, 135, 58, 255], well: [0, 0, 0, 255], gear: [224, 135, 58, 255],
        ribbon: { stops: [[201, 162, 74], [255, 217, 160], [255, 154, 60], [224, 69, 31], [255, 42, 26]], at: [0.5, 0.8, 0.93, 1] },
        deco: 5,
        decoColors: [[224, 135, 58], [201, 80, 42], [217, 164, 65]],
        greeting: 'HAPPY THANKSGIVING',
    },
    ribbon_newyear: {
        name: 'Ribbon · New Year',
        fg: [255, 248, 232, 255], dim: [154, 146, 126, 255], track: [29, 39, 51, 255], arc: [242, 207, 114, 255],
        glow: 0, stripe: false,
        bar: { low: [185, 162, 106], mid: [255, 210, 74], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [185, 162, 106], to: [255, 210, 74] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [154, 146, 126, 255], head: [242, 207, 114, 255],
        ink: [12, 12, 14, 255], accent: [242, 207, 114, 255], well: [0, 0, 0, 255], gear: [242, 207, 114, 255],
        ribbon: { stops: [[185, 162, 106], [255, 244, 214], [255, 210, 74], [255, 106, 58], [255, 42, 42]], at: [0.5, 0.8, 0.93, 1] },
        deco: 4,
        decoColors: [[242, 207, 114], [255, 255, 255], [217, 176, 74]],
        greeting: 'HAPPY NEW YEAR',
    },
    ribbon_july4: {
        name: 'Ribbon · Fourth of July',
        fg: [244, 246, 255, 255], dim: [125, 140, 171, 255], track: [29, 39, 51, 255], arc: [255, 75, 75, 255],
        glow: 0, stripe: false,
        bar: { low: [58, 107, 255], mid: [255, 128, 128], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [58, 107, 255], to: [255, 128, 128] },
        bg: [0, 0, 0, 255], panel: [0, 0, 0, 255], line: [125, 140, 171, 255], head: [255, 75, 75, 255],
        ink: [12, 12, 14, 255], accent: [255, 75, 75, 255], well: [0, 0, 0, 255], gear: [255, 75, 75, 255],
        ribbon: { stops: [[58, 107, 255], [255, 255, 255], [255, 128, 128], [255, 51, 51], [255, 26, 26]], at: [0.5, 0.8, 0.93, 1] },
        deco: 3,
        decoColors: [[255, 75, 75], [111, 149, 255], [255, 255, 255]],
        greeting: 'FOURTH OF JULY',
    },
};
// every theme: the shift-point red, used by "hot" (the gear and SHIFT at the shift point, the rev bar past it)
// The Sakura variants (layouts sakura_line, sakura_moon, sakura_grove): the first Sakura's text colours, with the plates
// ("panel" fill, "line" border), unlit segments ("track") and labels taken from each scene's own palette.
THEMES.sakura_line = Object.assign({}, THEMES.sakura, {        // Blue Hour Line: navy dusk, the train, the railing
    name: 'Sakura Line', dim: [160, 180, 220, 255], sec: [226, 234, 250, 255],
    panel: [10, 18, 48, 255], line: [52, 90, 140, 255], track: [26, 42, 82, 255], bg: [7, 12, 28, 255], well: [7, 12, 28, 255],
});
THEMES.sakura_moon = Object.assign({}, THEMES.sakura, {        // Moon Mirror: violet night, the moon tree, wind
    name: 'Sakura Moon', dim: [196, 170, 228, 255], jp: [236, 150, 200, 255],
    panel: [16, 6, 36, 255], line: [74, 42, 128, 255], track: [42, 20, 80, 255], bg: [16, 6, 36, 255], well: [16, 6, 36, 255],
});
THEMES.sakura_grove = Object.assign({}, THEMES.sakura, {       // Hanami Grove: two trees, plum dusk, fallen petals
    name: 'Sakura Grove', dim: [210, 176, 214, 255], jp: [240, 150, 190, 255],
    panel: [23, 12, 44, 255], line: [78, 42, 94, 255], track: [46, 24, 68, 255], bg: [23, 12, 44, 255], well: [23, 12, 44, 255],
});
// My Boy (layout myboy.json): his photo on a night-blue sky, in his romper's colours. The backdrop is one shader (shaders.js
// photo): "bg" to "well" the sky, "blue" and "cream" the romper's checks (its slate blue lifted for the LCD) in the rev
// strips and the halo, "pink" their red zone. The text: values, secondary values, labels.
THEMES.myboy = {
    name: 'My Boy',
    fg: [250, 246, 238, 255], dim: [146, 166, 206, 255], sec: [226, 230, 242, 255],
    blue: [124, 152, 208, 255], cream: [240, 232, 220, 255], pink: [255, 96, 124, 255],
    track: [40, 52, 84, 255], arc: [124, 152, 208, 255], glow: 0, stripe: false,
    bar: { low: [124, 152, 208], mid: [240, 232, 220], high: [255, 96, 124], midAt: 'shift' },
    rev: { from: [124, 152, 208], to: [255, 96, 124] },
    bg: [12, 17, 38, 255], well: [3, 4, 10, 255], panel: [12, 17, 38, 255], line: [40, 52, 84, 255],
    head: [146, 166, 206, 255], ink: [12, 12, 14, 255], accent: [124, 152, 208, 255],
};
// The scene themes (layouts nightdrive, warp, neoncity, jethud, paper, seasons; shaders.js scene_*): the backdrop's colours
// are the roles c1..c4 (each shader's header says what they are); fg, dim and sec are the text.
function sceneTheme(name, text, c) {
    return Object.assign({
        name, glow: 0, stripe: false, track: c[0].concat(255), arc: c[1].concat(255),
        bar: { low: c[1], mid: c[3], high: [255, 72, 84], midAt: 'shift' }, rev: { from: c[1], to: [255, 72, 84] },
        bg: c[0].concat(255), panel: c[0].concat(255), line: text.dim, head: text.dim, ink: [12, 12, 14, 255],
        accent: c[1].concat(255), well: c[0].concat(255),
        c1: c[0].concat(255), c2: c[1].concat(255), c3: c[2].concat(255), c4: c[3].concat(255),
    }, text);
}
THEMES.nightdrive = sceneTheme('Night Drive', { fg: [255, 244, 252, 255], dim: [255, 150, 220, 255], sec: [190, 240, 255, 255], pink: [255, 70, 175, 255] },
    [[18, 6, 48], [255, 48, 160], [255, 216, 88], [40, 232, 255]]);
THEMES.warp = sceneTheme('Warp', { fg: [235, 245, 255, 255], dim: [130, 190, 255, 255], sec: [200, 225, 255, 255] },
    [[2, 3, 12], [120, 160, 255], [60, 220, 255], [255, 70, 100]]);
THEMES.neoncity = sceneTheme('Neon City', { fg: [255, 236, 250, 255], dim: [255, 96, 196, 255], sec: [120, 230, 255, 255], pink: [255, 60, 180, 255] },
    [[14, 10, 34], [255, 46, 170], [40, 220, 255], [255, 50, 60]]);
THEMES.jethud = sceneTheme('Jet HUD', { fg: [90, 255, 156, 255], dim: [52, 196, 116, 255], sec: [200, 255, 224, 255] },
    [[60, 255, 140], [210, 255, 230], [255, 70, 70], [2, 10, 8]]);
THEMES.paper = sceneTheme('Paper', { fg: [26, 26, 28, 255], dim: [118, 112, 104, 255], sec: [64, 62, 60, 255] },
    [[244, 240, 230], [28, 28, 30], [196, 40, 40], [160, 156, 150]]);
THEMES.chrono = sceneTheme('Chronograph', { fg: [236, 240, 246, 255], dim: [150, 166, 190, 255], sec: [210, 218, 232, 255], ink: [20, 22, 28, 255] },
    [[16, 20, 30], [206, 210, 218], [22, 44, 92], [228, 56, 52]]);
THEMES.aurora = sceneTheme('Northern Lights', { fg: [240, 250, 255, 255], dim: [150, 230, 200, 255], sec: [210, 200, 255, 255] },
    [[6, 14, 30], [70, 255, 170], [170, 100, 255], [255, 70, 80]]);
THEMES.trails = sceneTheme('Light Trails', { fg: [255, 248, 240, 255], dim: [255, 190, 160, 255], sec: [220, 228, 255, 255] },
    [[8, 10, 22], [255, 238, 205], [255, 48, 40], [255, 168, 70]]);
THEMES.falls = sceneTheme('Neon Falls', { fg: [150, 236, 255, 255], dim: [110, 232, 255, 255], sec: [255, 140, 226, 255] },
    [[22, 14, 58], [96, 228, 255], [255, 72, 206], [64, 206, 128]]);
THEMES.swim = sceneTheme('Cosmic Swim', { fg: [246, 196, 255, 255], dim: [255, 150, 220, 255], sec: [170, 200, 255, 255] },
    [[8, 6, 26], [255, 70, 190], [80, 110, 255], [255, 60, 70]]);
THEMES.train = sceneTheme('Night Train', { fg: [255, 226, 160, 255], dim: [170, 196, 236, 255], sec: [236, 240, 255, 255] },
    [[16, 22, 52], [255, 206, 110], [150, 34, 42], [24, 64, 56]]);
THEMES.rain = sceneTheme('Rainy Window', { fg: [255, 200, 150, 255], dim: [200, 150, 220, 255], sec: [150, 200, 255, 255] },
    [[30, 18, 56], [255, 176, 100], [255, 70, 170], [70, 160, 255]]);
THEMES.orbit = sceneTheme('Station Window', { fg: [120, 236, 255, 255], dim: [80, 180, 200, 255], sec: [255, 214, 150, 255] },
    [[44, 52, 68], [30, 90, 200], [90, 230, 255], [255, 214, 150]]);
THEMES.evaurora = sceneTheme('Aurora', { fg: [244, 246, 250, 255], dim: [138, 147, 166, 255], sec: [92, 242, 201, 255],
    orange: [255, 138, 61, 255], amber: [255, 194, 77, 255], red: [255, 84, 112, 255] },
    [[92, 242, 201], [142, 124, 255], [255, 138, 61], [255, 84, 112]]);
THEMES.orbital = sceneTheme('Orbital', { fg: [238, 243, 255, 255], dim: [114, 130, 168, 255], sec: [125, 249, 255, 255],
    orange: [255, 159, 67, 255], amber: [255, 200, 87, 255], red: [255, 92, 122, 255], ink: [2, 3, 10, 255] },
    [[125, 249, 255], [255, 159, 67], [255, 200, 87], [255, 92, 122]]);
// VFD (the canvas's T4 · VFD, an 80s vacuum-fluorescent dash) in its three phosphors at once: cyan in the middle (fg,
// its labels dim, unlit ghost), amber on the left (amber, adim, aghost), green on the right (green, gdim, gghost); an unlit
// label is its phosphor at 16 % as the shader's unlit segments; the warning red and the shift flash orange
THEMES.vfd = sceneTheme('VFD', { fg: [111, 255, 233, 255], dim: [62, 124, 116, 255], ghost: [18, 41, 37, 255], sec: [111, 255, 233, 255],
    amber: [255, 193, 74, 255], adim: [138, 106, 48, 255], aghost: [41, 31, 12, 255],
    green: [140, 255, 107, 255], gdim: [78, 122, 64, 255], gghost: [22, 41, 17, 255],
    red: [255, 75, 43, 255], orange: [255, 157, 59, 255], glow: 0.9 },
    [[111, 255, 233], [18, 41, 37], [255, 75, 43], [255, 157, 59]]);
THEMES.seasons = sceneTheme('Four Seasons', { fg: [255, 255, 255, 255], dim: [222, 232, 246, 255], sec: [240, 246, 255, 255] },
    [[18, 24, 38], [255, 255, 255], [255, 70, 70], [44, 46, 54]]);
Object.keys(THEMES).forEach((k) => { THEMES[k].hot = [255, 42, 42, 255]; });

// Redline layout (after cauliflowermossgrape's Redline app): rev bar segments ramp rev.from -> rev.to up to
// the shift point; the shift lights run green -> yellow -> red in every theme; grade badges by verdict.
const LIGHTS = { green: [47, 210, 122], yellow: [255, 194, 26], red: [255, 42, 42], blue: [40, 110, 255] };
const VERDICT = {
    'SPOT ON': [47, 210, 122, 255], EARLY: [255, 194, 26, 255], LATE: [255, 138, 26, 255],
    LIMITER: [255, 42, 42, 255], 'COLD REV': [61, 139, 255, 255], COLD: [61, 139, 255, 255],
};

// The M tricolour stripe: light blue, dark blue, red (brightened for the HUD).
const M_STRIPE = [[79, 180, 255, 255], [47, 91, 216, 255], [232, 38, 45, 255]];

/** A colour from a role name ("fg") or a literal [r,g,b,a]. */
function color(theme, c) {
    if (Array.isArray(c)) return c;
    return theme[c] || theme.fg;
}

module.exports = { THEMES, M_STRIPE, LIGHTS, VERDICT, color };
