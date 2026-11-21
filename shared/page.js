'use strict';
/**
 * page.js - the app's own centre-screen page (both apps), in place of BMW's plain settings list.
 * Look (Nov 21 2026 redesign): plain near-black, white text, one font, no colour except for status (green on,
 * amber fake data, red only for Reset everything). Tabs along the top as plain words; every row says what it
 * does, with a short grey line under it where the name alone isn't enough. White means "picked".
 *
 * Drawn on the kit's canvas screen (kit/runtime/display.js): on the Store's renderer it fills the screen at
 * up to 60 fps and every tap or controller press lands on a target (cv.target); without the renderer the
 * same drawing goes to the HMI as a picture. The kit's own Settings sheet (bar button) stays as the fallback.
 *
 *   new Page(ctx, hud, {
 *       title, what: 'cluster' | 'HUD',
 *       look: { name: 'Theme', style: 'hero' | 'cards', tags: { m: 'M8 style', ... } },
 *       tabs: ['look', 'readouts', 'badge', 'map', 'alerts', 'gmeter', 'settings'],
 *       settings: ['units', 'clock', ...],          // the Settings tab's rows (grouped by SETTING_GROUPS)
 *   }).start();
 *
 * Only the drawing lives here: every tap sets the same setting (ctx.settings) or calls the same engine method
 * (hud.js) as before. The reset buttons only put settings back to their defaults from app.json.
 *
 * Theme pictures: previews.js (shot on the bench by tools/previews.py; the centre screen can't draw our
 * cluster-render themes live). Plain Node 8 (the car's 8.16.2).
 */
const G = require('./kit/gauges');
const themes = require('./kit/themes');
const previews = require('./previews');
const sensors = require('./sensors');
const visible = require('./visible');
const badges = require('./badges');
const tz = require('./tz');

const W = 1600, H = 520;
const A = G.withAlpha;
const C = {
    bg: '#0d0d0e', text: '#f5f5f4', soft: '#c7c7cc', dim: '#a1a1a6', faint: '#6e6e73',
    line: '#26262a', field: '#1a1a1c', panel: '#141416', panelLine: '#2a2a2e', raised: '#1f1f22', border: '#3a3a3e',
    ink: '#0d0d0e', off: '#2a2a2e', green: '#4cd08a', amber: '#f0b44a', red: '#ff6b5e', redFill: '#c93a3a', redLine: '#6b2a26',
};
// the part of the 1600 x 520 drawing the full-screen layout shows is x 12..1588 (display.js FULL.src)
const X0 = 32, X1 = 1568, CW = X1 - X0;
const TAB_Y = 38, TAB_H = 58, CT = 112;          // the tab bar under the kit's header; the content's top
const B = { font: 'bold', literal: true };
const L = { font: 'label', literal: true };
const MODES = [['inComfort', 'Comfort'], ['inSport', 'Sport'], ['inEco', 'Eco Pro']];
const MODE_KEY = { comfort: 'inComfort', sport: 'inSport', eco: 'inEco' };
const TAB = {
    readouts: 'Gauges',
    position: 'Position',
    map: 'Waze map',
    badge: 'Model name',
    alerts: 'Warnings & shift lights',
    gmeter: 'G-meter',
    colours: 'Colours',
    settings: 'Settings',
};

/* ---------- plain words for each setting (the page only; app.json keeps the kit's own list) ---------- */
// [label, the grey line under it]; a function gets the page (for the units)
const LABELS = {
    units: ['Units', 'Speed, temperature and pressure'],
    clock: ['Clock', '12-hour or 24-hour'],
    timeZone: ['Time zone', 'The car\'s clock runs on UTC; set your zone once'],
    tankLitres: ['Fuel tank size', 'Only used if the car doesn\'t send its fuel %'],
    redline: ['Redline', 'Where the red zone starts on the rev scales'],
    shiftBefore: ['Shift lights peak', 'How far before the redline'],
    coldGuard: (p) => ['Shift earlier while the engine is cold', 'Until the oil reaches ' + (p.us() ? '176 °F' : '80 °C') + ', they start at 4,500 rpm'],
    showBoost: (p) => ['Show turbo boost', p.cluster() ? 'The boost readout on themes that have one' : 'On the Sport layout'],
    showClock: ['Show the clock', 'On layouts that have one'],
    showOil: ['Show oil temperature', 'On layouts that have one'],
    showCoolant: ['Show coolant temperature', 'On layouts that have one'],
    nightDim: ['Dim after sunset', 'Easier on the eyes at night'],
    cameraNotch: ['Keep the top centre clear', 'For cars with a driver camera at the top of the cluster'],
    holiday: ['Holiday decorations', 'Lights for Christmas, New Year and more'],
    demo: (p) => ['Fake data while parked', 'Lets you try ' + (p.cluster() ? 'themes' : 'layouts') + ' without driving'],
    navDirections: ['Turn-by-turn directions', 'From CarPlay with Apple Maps; Waze sends no turns'],
};
// the words a choice shows: [name, what it means] (missing: the option's own label from app.json)
const OPTS = {
    units: { us: ['mph, °F, psi'], metric: ['km/h, °C, bar'] },
    clock: { '12h': ['12-hour', 'Like 3:35 PM'], '24h': ['24-hour', 'Like 15:35'] },
    nightDim: { auto: ['Auto', 'After sunset, whites and greys drop to 60 %'], off: ['Off', 'Same brightness day and night'] },
    holiday: {
        auto: ['On holiday dates', 'Turns itself on and off by the date'], off: ['Off', 'Never'],
        xmas: ['Christmas', 'Keep it on'], thanks: ['Thanksgiving', 'Keep it on'],
        newyear: ['New Year', 'Keep it on'], july4: ['Fourth of July', 'Keep it on'],
    },
    demo: { auto: ['Auto', 'Until the car sends real numbers'], on: ['On', 'Always while parked; real data once you drive'], off: ['Off', 'Never'] },
    shiftCue: { countin: ['Timed'], rpm: ['Fixed'] },
    hudTheme: { auto: ['Auto', 'Night after sunset'] },
    navDirections: { route: ['While a route runs'], near: ['Near turns'], off: ['Off'] },
};
const SETTING_GROUPS = [
    ['Units and clock', ['units', 'clock', 'timeZone', 'tankLitres']],
    ['Shift lights', ['redline', 'shiftBefore', 'coldGuard']],
    ['Display', ['showBoost', 'showClock', 'showOil', 'showCoolant', 'nightDim', 'cameraNotch', 'holiday', 'demo']],
];
const WARN_LABEL = { warnOil: 'Oil is hotter than', warnCoolant: 'Coolant is hotter than', warnBoost: 'Boost is higher than' };
const SENSOR_NAME = {
    rpm: 'Engine speed (rpm)', boost: 'Turbo boost', torquePct: 'Torque (% of the engine\'s maximum)',
    powerPct: 'Power (% of the engine\'s maximum)', gLat: 'Cornering force', gLong: 'Braking & acceleration force',
    hvSoc: 'Hybrid battery (plug-in hybrids only)', shiftAt: 'Shift point (where the lights peak)', lastShift: 'Revs at your last shift',
};
const CAT_NAME = { Temps: 'Temperatures', Chassis: 'Speed & g-force' };

// the kit's own chrome (header, bar, Settings sheet, the controller's focus ring) in the page's greys: the kit draws
// white text and white switch knobs on `sel`, so it is a mid grey that white reads on, not the page's white
Object.assign(themes.THEMES.m_tricolour, { sel: '#8e8e93', selText: '#ffffff', accent2: C.soft, bg: C.bg });

class Page {
    constructor(ctx, hud, cfg) {
        this.ctx = ctx; this.hud = hud; this.cfg = cfg;
        this.tab = cfg.tabs[0];
        this.picker = null;              // { key, title, fmt } while a list of choices is open over the page
        this.loop = null;
        this.slotLayout = null;          // Gauges: the layout whose slots are edited (null: the one showing)
        this.slot = null;                // Gauges: the slot picked (its id)
        this.cat = sensors.CATS[0];      // Gauges: the sensor group shown
        this.series = null;              // Model name: the series shown (null: the picked model's)
        this.confirm = null;             // { title, lines, yes, run, danger, no } while a question is open over the page
        this.editMode = null;            // Theme: the drive mode whose theme the gallery sets (null: the car's)
        this.toast = null;               // { text, undo, until } a message at the bottom, with Undo
    }

    start() {
        const ctx = this.ctx;
        this.loop = ctx.loop('MAIN', 10, () => this.render());
        ctx.settings.onChange(() => this.kick());
        ctx.onLayout(() => this.kick());
        this.hud.onStatus(() => this.kick());
        this.render();
    }
    kick() { if (this.loop && this.loop.kick) this.loop.kick(); }

    /* ---------- settings ---------- */
    get(k) { return this.hud.setting(k); }
    set(k, v) { if (this.ctx.settings.get(k) !== v) this.ctx.settings.set(k, v); this.kick(); }
    item(k) { return this.ctx.settings.item(k); }
    cluster() { return this.cfg.what === 'cluster'; }
    us() { return this.get('units') === 'us'; }
    optLabel(k, v) {
        const s = this.item(k), o = s && (s.options || []).find((x) => x[0] === v);
        return o ? o[1] : String(v);
    }
    /** a choice's words on the page: [name, what it means or ''] */
    optText(k, v) {
        const o = OPTS[k] && OPTS[k][v];
        return o ? [o[0], o[1] || ''] : [this.optLabel(k, v), ''];
    }
    /** [label, grey line] of a setting on the page */
    labelOf(k) {
        const l = LABELS[k];
        if (typeof l === 'function') return l(this);
        if (l) return l;
        const s = this.item(k);
        return [s ? s.label : k, ''];
    }
    /** a theme's or layout's short name: "Off (BMW's own cluster)" -> "BMW's own" */
    layoutName(v) { return v === 'off' ? "BMW's own" : this.optLabel('hudLayout', v); }
    valueText(k) {
        const s = this.item(k), v = this.get(k);
        if (!s) return '';
        if (s.type === 'bool') return v ? 'On' : 'Off';
        if (s.type === 'number' && WARN_KEYS.indexOf(k) >= 0) return warnText(k, v, this.us());
        if (k === 'timeZone') return v === -9999 ? 'Not set (shows UTC)' : tzText(v);
        if (k === 'tankLitres') return fmtInt(v) + ' L';
        if (k === 'hudScale') return v + ' %';
        if (s.type === 'number') return k === 'shiftBefore' ? (v ? fmtInt(v) + ' rpm before' : 'At the redline') : fmtInt(v) + ' rpm';
        return this.optText(k, v)[0];
    }
    /** the layout showing now, else the one meant to (before cluster-render answers) */
    shownName() { return this.hud.activeName || this.hud._layoutName() || 'off'; }
    /** the layouts a theme card can show (not the calibration ones) */
    looks() { return ((this.item('inSport') || {}).options || []).map((o) => o[0]); }
    /**
     * A theme or layout picked on this page (key: hudLayout or a drive mode's). The cluster panel and the HUD
     * share one screen (screen.js): when the other app is drawing, ask first whether to turn it off; yes takes
     * the screen (the other app steps aside), Cancel changes nothing. Any pick here ends our own stepping aside.
     */
    chooseLayout(key, v) {
        const scr = this.hud.screen;
        if (v === 'off' || !scr || !scr.otherOn()) {
            if (scr) scr.release();
            this.set(key, v);
            return;
        }
        const cluster = this.cluster();
        this.confirm = {
            title: scr.otherName + ' is on',
            lines: ['Your version of cluster-render can\'t show a HUD layout and a cluster theme together. ' +
                (cluster ? 'Turn HUD Widgets off so ' : 'Turn the cluster theme off so ') + this.layoutName(v) + ' shows?'],
            yes: cluster ? 'Turn HUD Widgets off' : 'Turn the theme off',
            no: cluster ? 'Keep the HUD' : 'Keep the theme',
            run: () => { scr.claim(); this.set(key, v); },
        };
        this.kick();
    }
    /** what the Theme tab says while the other app has the screen, else null */
    yieldNote() {
        const scr = this.hud.screen;
        return scr && scr.yielded ? 'Off for now: ' + scr.otherName + ' is using the screen. Tap a ' + (this.cluster() ? 'theme' : 'layout') + ' to take it back.' : null;
    }
    /** the key a tap on a layout card sets (HUD): the drive mode's own while it changes with the drive mode */
    lookKey() {
        const m = this.hud.driveMode;
        return this.get('byMode') === true && MODE_KEY[m] ? MODE_KEY[m] : 'hudLayout';
    }
    /** a message along the bottom for 10 s, with Undo when undo is given */
    showToast(text, undo) {
        this.toast = { text, undo: undo || null, until: Date.now() + 10000 };
        setTimeout(() => this.kick(), 10100);
        this.kick();
    }

    /* ---------- drawing ---------- */
    render() {
        const cv = this.ctx.canvas(W, H);
        const bottom = G.pageBottom(cv);
        cv.clear(C.bg);
        const on = this.hud.activeName && this.hud.activeName !== 'off';
        const dd = this.hud.car && this.hud.car.data(), demo = dd && dd.demo;
        const cluster = this.cluster();
        G.frame(cv, this.theme(), [], -1, [
            demo ? { text: dd.demoShow ? 'Demo playing' : 'Fake data (parked)', color: C.amber } : null,
            { text: on ? (cluster ? 'Theme on' : 'HUD on') : (cluster ? 'Theme off: BMW\'s cluster' : 'HUD off: BMW\'s HUD'), color: on ? C.green : C.dim },
        ]);
        // the page under an open list takes no taps: the list (and a tap beside it to close) does
        const target = cv.target;
        if (this.picker || this.confirm) cv.target = function () { return this; };
        const body = { look: this.lookTab, readouts: this.readoutsTab, position: this.positionTab, map: this.mapTab, colours: this.coloursTab, badge: this.badgeTab, alerts: this.alertsTab, gmeter: this.gmeterTab, settings: this.settingsTab }[this.tab];
        if (body) body.call(this, cv, bottom);
        // the tab bar after the body: its demo button draws a quad, and renderd.js's nativeOps stops converting a
        // frame's pictures (op 18) at the first op it doesn't know (QUAD), so the theme pictures must come first.
        // Its targets still go first: a tap takes the first target it is in, and the controller's knob goes through
        // them in order (display.js), tabs before the page as before.
        const n0 = cv.targets ? cv.targets.length : 0;
        this.tabBar(cv);
        if (cv.targets && cv.targets.length > n0) cv.targets = cv.targets.splice(n0).concat(cv.targets);
        this.drawToast(cv, bottom);
        cv.target = target;
        if (this.picker) this.drawPicker(cv, bottom);
        if (this.confirm) this.drawConfirm(cv, bottom);
        return this.ctx.ui.image('MAIN_GFX', cv);
    }
    theme() { return this.ctx.theme(); }

    /** The tabs as plain words along the top, the picked one white and underlined; the demo button on the right. */
    tabBar(cv) {
        let x = X0;
        const base = TAB_Y + 36;
        this.cfg.tabs.forEach((id) => {
            const name = this.tabName(id), sel = id === this.tab, w = cv.textWidth(name, 18, B);
            cv.text(name, x, base, 18, sel ? C.text : C.dim, sel ? B : L);
            if (sel) cv.fillRect(x, TAB_Y + TAB_H - 5, w, 3, C.text);
            cv.target(x - 14, TAB_Y + 2, w + 28, TAB_H - 4, () => { this.tab = id; this.picker = null; this.kick(); }, 'tab:' + id, 8);
            x += w + 32;
        });
        cv.fillRect(X0, TAB_Y + TAB_H - 1, CW, 1, C.line);
        this.demoButton(cv, x);
    }
    tabName(id) { return id === 'look' ? this.cfg.look.name : TAB[id] || id; }

    /**
     * "Play demo", top right on every tab: about a minute of a scripted drive on the real HUD / cluster
     * (hud.playDemo, demo_script.js), only while the car stands; "Stop demo" while it plays. The grey line
     * under it says what it does, or why it can't now.
     */
    demoButton(cv, minX) {
        const hud = this.hud;
        if (!hud.playDemo) return;
        const playing = hud.demoPlaying(), why = playing ? null : hud.demoBlocked();
        const what = this.cluster() ? 'cluster' : 'HUD';
        const text = playing ? 'Stop demo' : 'Play demo';
        const info = playing ? 'Playing on the ' + what + ' · ' + Math.ceil(hud.demoLeft() / 1000) + ' s left'
            : why === 'moving' ? 'Stop the car to play it' : why === 'off' ? 'Pick a ' + (what === 'HUD' ? 'layout' : 'theme') + ' first'
                : why ? 'The ' + what + ' isn\'t drawing yet' : '60 s on the ' + what + ', parked only';
        const tw = Math.max(cv.textWidth(text, 17, B), cv.textWidth(info, 13, L)), w = tw + 28, x = Math.max(minX, X1 - w);
        const c = why ? C.faint : C.text, ix = x + 6, iy = TAB_Y + 22;
        if (playing) cv.fillRect(ix - 5, iy - 5, 10, 10, c);
        else cv.quad([[ix - 4, iy - 7], [ix + 7, iy], [ix + 7, iy], [ix - 4, iy + 7]], c);
        cv.text(text, x + 24, TAB_Y + 28, 17, c, B);
        cv.text(info, x + 24, TAB_Y + 47, 13, playing ? C.text : C.dim, L);
        if (!why) cv.target(x - 10, TAB_Y + 4, w + 14, TAB_H - 8, () => { if (hud.demoPlaying()) hud.stopDemo(); else hud.playDemo(); this.kick(); }, 'demo:play', 10);
    }

    /** the message along the bottom (Undo on the right); gone after its 10 s */
    drawToast(cv, bottom) {
        const t = this.toast;
        if (!t) return;
        if (Date.now() > t.until) { this.toast = null; return; }
        const h = 48, tw = cv.textWidth(t.text, 16, L), uw = t.undo ? cv.textWidth('Undo', 16, B) + 40 : 0;
        const w = tw + 48 + (t.undo ? uw + 12 : 0), x = Math.round((W - w) / 2), y = bottom - h - 8;
        // what it covers takes no taps while it shows
        if (cv.targets) cv.targets = cv.targets.filter((g) => g.x + g.w <= x || g.x >= x + w || g.y + g.h <= y || g.y >= y + h);
        cv.roundRect(x, y, w, h, h / 2, C.text);
        cv.text(t.text, x + 24, y + 30, 16, C.ink, L);
        if (t.undo) {
            const ux = x + w - uw - 6;
            cv.roundRect(ux, y + 6, uw, h - 12, (h - 12) / 2, C.ink);
            cv.text('Undo', ux + uw / 2, y + 30, 16, C.text, { font: 'bold', align: 'center', literal: true });
            cv.target(ux, y, uw, h, () => { this.toast = null; t.undo(); this.kick(); }, 'toast:undo', h / 2);
        }
    }

    /* ---------- Theme (cluster) / Layouts (HUD) ---------- */
    lookTab(cv, bottom) {
        if (this.cfg.look.style === 'hero') this.lookModes(cv, bottom);
        else this.lookCards(cv, bottom);
    }

    /**
     * Cluster: 1. pick the drive mode to change, 2. tap the theme it shows. "One theme for every mode" is
     * byMode off (the plain theme, hudLayout). Every theme is in one grid, with its picture.
     */
    lookModes(cv, bottom) {
        const by = this.get('byMode') === true, nowKey = MODE_KEY[this.hud.driveMode];
        if (!this.editMode) this.editMode = nowKey || 'inSport';
        const key = by ? this.editMode : 'hudLayout', modeName = (MODES.find((m) => m[0] === this.editMode) || MODES[1])[1];
        // 1. the drive mode
        let y = CT;
        cv.text('1. Drive mode', X0, y + 24, 17, C.text, B);
        cv.text(by ? (nowKey ? 'Pick the mode to change' : 'Drive mode not detected yet') : 'Not used now', X0, y + 44, 14, C.dim, L);
        const sx = X0 + 200;
        if (by) {
            segmented(cv, sx, y, MODES.map((m) => ({
                text: m[1], small: m[0] === nowKey ? ' · in use now' : '', sub: 'Shows ' + this.layoutName(this.get(m[0])),
                on: m[0] === this.editMode, w: 236, key: 'mode:' + m[0], run: () => { this.editMode = m[0]; this.kick(); },
            })), 48);
        } else {
            cv.roundRect(sx, y, 720, 56, 12, C.field);
            cv.text('Comfort, Sport and Eco Pro all show the same theme', sx + 22, y + 34, 16, C.soft, L);
        }
        // the switch: one theme for every mode (byMode off)
        const one = !by, swx = X1 - 52, lab = 'One theme for every mode', hint = one ? 'On: the drive mode buttons don\'t change it' : 'Off: each mode keeps its own';
        const lw = Math.max(cv.textWidth(lab, 17, L), cv.textWidth(hint, 14, L));
        cv.text(lab, swx - 16, y + 24, 17, C.text, { font: 'label', align: 'right', literal: true });
        cv.text(hint, swx - 16, y + 44, 14, C.dim, { font: 'label', align: 'right', literal: true });
        switchCtl(cv, swx, y + 13, one);
        cv.target(swx - 16 - lw, y, lw + 68, 56, () => this.set('byMode', !by), 'set:byMode', 12);
        // 2. the theme, and the off switch for every mode
        y = CT + 72;
        const title = by ? '2. Theme for ' + modeName + ' mode' : '2. Theme for every mode';
        cv.text(title, X0, y + 26, 17, C.text, B);
        const note = this.yieldNote();
        cv.text(note || (by ? 'Tap a picture to use it in ' + modeName : 'Tap a picture to use it all the time'), X0 + cv.textWidth(title, 17, B) + 14, y + 26, 14, note ? C.amber : C.dim, L);
        const offText = 'Show BMW\'s own cluster in every mode', ow = pillW(cv, offText, 15) + 64;
        pill(cv, X1 - ow, y + 2, ow, 40, offText, 'outline', () => this.allOff(), 'look:alloff', 15, 'power');
        // the gallery: 7 across, as big as the room lets them be
        const looks = this.looks(), cols = 7, rows = Math.ceil(looks.length / cols), gy = y + 54, nameH = 24, rowGap = 10;
        const avail = bottom - gy - 6;
        const ih = Math.max(40, Math.min((CW - 6 * 14) / cols * 0.375, (avail - (rows - 1) * rowGap) / rows - nameH));
        const iw = ih / 0.375, gapX = (CW - cols * iw) / (cols - 1);
        const cur = this.get(key);
        looks.forEach((v, i) => {
            const x = X0 + (i % cols) * (iw + gapX), yy = gy + Math.floor(i / cols) * (ih + nameH + rowGap), sel = v === cur;
            this.picture(cv, v, 'small', x, yy, iw, ih);
            if (sel) {
                cv.strokeRoundRect(x - 3, yy - 3, iw + 6, ih + 6, 11, 2.5, C.text);
                checkBadge(cv, x + iw - 15, yy + 15);
            }
            const name = this.layoutName(v);
            cv.text(fit(cv, name, 15, iw, sel ? B : L), x, yy + ih + 19, 15, sel ? C.text : C.soft, sel ? B : L);
            cv.target(x, yy, iw, ih + nameH, () => this.chooseLayout(key, v), 'look:' + v, 8);
        });
    }
    /** "Show BMW's own cluster in every mode": every theme setting to off, with Undo */
    allOff() {
        const prev = {};
        LOOK_KEYS.forEach((k) => { prev[k] = this.get(k); });
        if (this.hud.screen) this.hud.screen.release();
        LOOK_KEYS.forEach((k) => this.set(k, 'off'));
        this.showToast('All themes are off. BMW\'s own cluster shows in every drive mode.', () => LOOK_KEYS.forEach((k) => this.set(k, prev[k])));
    }

    /** HUD: a card per layout with its picture and the drive modes that show it, in two rows. */
    lookCards(cv, bottom) {
        const shown = this.shownName(), note = this.yieldNote();
        cv.text(this.cfg.look.name, X0, CT + 22, 17, C.text, B);
        cv.text(note || 'Tap Comfort, Sport or Eco Pro under a layout to show it in that drive mode', X0 + cv.textWidth(this.cfg.look.name, 17, B) + 14, CT + 22, 14, note ? C.amber : C.dim, L);
        const looks = this.looks(), cols = Math.max(5, Math.ceil(looks.length / 2)), gap = 14, y0 = CT + 38;
        const cw = (CW - gap * (cols - 1)) / cols, ch = (bottom - y0 - 64 - 14 - gap) / 2;
        looks.forEach((v, i) => {
            const x = X0 + (i % cols) * (cw + gap), y = y0 + Math.floor(i / cols) * (ch + gap), sel = v === shown;
            cv.roundRect(x, y, cw, ch, 14, sel ? C.raised : C.panel);
            cv.strokeRoundRect(x, y, cw, ch, 14, sel ? 2 : 1, sel ? C.text : C.panelLine);
            const ih = Math.max(30, Math.min(ch - 76, (cw - 20) * 0.624)), iw = ih / 0.624;
            this.picture(cv, v, 'big', x + (cw - iw) / 2, y + 10, iw, ih);
            const ty = y + 10 + ih + 22;
            cv.text(fit(cv, v === 'off' ? 'BMW\'s own HUD' : this.layoutName(v), 16, cw - 24, B), x + 12, ty, 16, C.text, B);
            if (v === 'off') {
                // the off switch: BMW's own HUD in every drive mode
                cv.target(x, y, cw, ch, () => { this.set('byMode', false); this.chooseLayout('hudLayout', 'off'); }, 'look:off', 14);
                cv.text(sel ? 'The HUD is off' : 'Tap to turn the HUD off', x + 12, ty + 26, 13, sel ? C.text : C.dim, L);
                return;
            }
            cv.target(x, y, cw, ih + 20, () => this.chooseLayout(this.lookKey(), v), 'look:' + v, 14);
            let cx = x + 12;
            MODES.forEach((m) => {
                const lit = this.get(m[0]) === v;
                cx += miniChip(cv, cx, ty + 10, m[1], lit, () => this.chooseLayout(m[0], lit ? 'off' : v), 'mode:' + v + ':' + m[0]) + 6;
            });
        });
        // under the cards: switching with the drive mode, and what shows when it doesn't
        const by = this.get('byMode') === true, ry = y0 + 2 * ch + gap + 12, half = (CW - 32) / 2;
        this.switchRow(cv, X0, ry, half, 'Change layout with the drive mode buttons', by ? 'On: Comfort, Sport and Eco Pro each use their own' : 'Off: the same layout all the time', 'byMode', 58);
        this.pickRow(cv, X0 + half + 32, ry, half, by ? 'Layout until the drive mode is known' : 'Layout for every mode', 'Tap to pick from the list', 'hudLayout', (v) => this.layoutName(v), 58);
    }

    tag(v) { return v === 'off' ? 'stock ' + this.cfg.what : (this.cfg.look.tags || {})[v] || ''; }

    /** A theme's picture (black with its name when there is none: BMW's own, or a build without previews). */
    picture(cv, name, size, x, y, w, h) {
        cv.roundRect(x, y, w, h, 8, '#000000');
        const p = name !== 'off' && previews.get(name, size);
        if (p) cv.image(p.id, x, y, w, h);
        else {
            const t = name === 'off' ? 'No ' + (this.cluster() ? 'theme' : 'layout') + ': stock ' + this.cfg.what : this.layoutName(name), s = h < 90 ? 13 : 16;
            cv.text(fit(cv, t, s, w - 16, L), x + w / 2, y + h / 2 + s * 0.35, s, C.dim, { font: 'label', align: 'center', literal: true });
        }
        cv.strokeRoundRect(x, y, w, h, 8, 1, '#ffffff14');
    }

    /* ---------- Gauges (readout slots) ---------- */
    /** the layouts that have readout slots */
    slotLayouts() { return this.looks().filter((v) => v !== 'off' && this.hud.slotsOf(v).length); }
    /** the layout the Gauges tab edits: the one picked there, else the one showing, else the first with slots */
    editLayout() {
        const ls = this.slotLayouts();
        if (this.slotLayout && ls.indexOf(this.slotLayout) >= 0) return this.slotLayout;
        const shown = this.shownName();
        return ls.indexOf(shown) >= 0 ? shown : ls[0] || null;
    }
    sensorText(sn) {
        if (!sn) return '--';
        const u = this.hud.sensorUnit(sn), v = this.hud.sensorValue(sn);
        return v + (sn.suffix && u.charAt(0) === '°' ? u : u ? ' ' + u.toLowerCase().replace(/^°/, '°') : '');
    }
    sensorName(sn) { return sn ? SENSOR_NAME[sn.id] || sn.name : '--'; }

    /** Which layout, its numbered boxes with what each shows (live) on the left; the values to pick from on the right. */
    readoutsTab(cv, bottom) {
        const lay = this.editLayout(), what = this.cluster() ? 'theme' : 'layout';
        if (!lay) {
            cv.text('Gauges', X0, CT + 24, 17, C.text, B);
            cv.text('None of these ' + what + 's has boxes you can change.', X0, CT + 50, 16, C.dim, L);
            return;
        }
        const slots = this.hud.slotsOf(lay), name = this.layoutName(lay);
        if (!slots.some((x) => x.id === this.slot)) this.slot = slots[0].id;
        // which layout, and putting its boxes back
        cv.text(this.cluster() ? 'Theme' : 'Layout', X0, CT + 22, 17, C.text, B);
        cv.text('Only these have boxes', X0, CT + 42, 14, C.dim, L);
        segmented(cv, X0 + 200, CT, this.slotLayouts().map((v) => ({
            text: this.layoutName(v), small: '  ' + this.hud.slotsOf(v).length + ' boxes', on: v === lay, key: 'slots:' + v,
            run: () => { this.slotLayout = v; this.kick(); },
        })), 44);
        const rt = 'Put ' + name + '\'s boxes back', rw = pillW(cv, rt, 15) + 64;
        pill(cv, X1 - rw, CT + 6, rw, 40, rt, 'outline', () => {
            const names = slots.map((x) => this.sensorName(sensors.get(x.default)));
            const defs = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names.join('');
            this.confirm = {
                title: 'Put ' + name + '\'s boxes back?',
                lines: ['The boxes go back to how the app came, in order: ' + defs + '. Other ' + what + 's are not changed.'],
                yes: 'Put them back', run: () => slots.forEach((x) => this.hud.setSlot(lay, x.id, null)),
            };
            this.kick();
        }, 'slots:reset', 15, 'undo');
        // the boxes
        const lw = 640, ly = CT + 68;
        cv.text('Boxes on ' + name, X0, ly + 22, 17, C.text, B);
        cv.text('Tap a box to change what it shows', X0 + cv.textWidth('Boxes on ' + name, 17, B) + 14, ly + 22, 14, C.dim, L);
        const two = slots.length > 6, per = two ? Math.ceil(slots.length / 2) : slots.length, sw = two ? (lw - 10) / 2 : lw;
        const top = ly + 36, rh = Math.max(34, Math.min(56, Math.floor((bottom - top - 28) / per) - 6));
        slots.forEach((sl, i) => {
            const x = X0 + (two && i >= per ? sw + 10 : 0), y = top + (i % per) * (rh + 6);
            const sel = sl.id === this.slot, sn = this.hud.slotSensor(lay, sl.id, slots);
            cv.roundRect(x, y, sw, rh, 12, sel ? C.raised : C.panel);
            cv.strokeRoundRect(x, y, sw, rh, 12, sel ? 1.5 : 1, sel ? C.text : C.panelLine);
            cv.strokeRoundRect(x + 14, y + rh / 2 - 14, 28, 28, 14, 1.5, C.dim);
            cv.text(String(i + 1), x + 28, y + rh / 2 + 5, 14, C.text, { font: 'bold', align: 'center', literal: true });
            const vt = this.sensorText(sn), vw = cv.textWidth(vt, 17, B), tx = x + 56, room = sw - 56 - vw - 50;
            if (rh >= 48 && !two) {
                cv.text(fit(cv, this.sensorName(sn), 17, room, L), tx, y + rh / 2 - 2, 17, C.text, L);
                cv.text('Box ' + (i + 1) + ' · ' + (sl.where || ''), tx, y + rh / 2 + 17, 13, C.dim, L);
            } else cv.text(fit(cv, this.sensorName(sn), 15, room, L), tx, y + rh / 2 + 6, 15, C.text, L);
            cv.text(vt, x + sw - 36, y + rh / 2 + 6, 17, C.text, { font: 'bold', align: 'right', literal: true });
            chevron(cv, x + sw - 18, y + rh / 2, C.dim);
            cv.target(x, y, sw, rh, () => { this.slot = sl.id; if (sn) this.cat = sn.cat; this.kick(); }, 'slot:' + sl.id, 12);
        });
        cv.text('-- means the car has not sent that value yet.', X0, Math.min(bottom - 6, top + per * (rh + 6) + 18), 13, C.dim, L);
        // the values for the picked box
        const px = X0 + lw + 32, pw = X1 - px, py = ly, ph = bottom - py - 4;
        cv.roundRect(px, py, pw, ph, 14, C.panel);
        cv.strokeRoundRect(px, py, pw, ph, 14, 1, C.panelLine);
        const n = slots.findIndex((x) => x.id === this.slot) + 1, slot = slots[n - 1], cur = this.hud.slotSensor(lay, this.slot, slots);
        cv.text('Box ' + n + (slot && slot.where ? ' (' + slot.where + ')' : '') + ' shows', px + 22, py + 30, 17, C.text, B);
        cv.text('Tap a value. The ' + this.cfg.what + ' changes right away.', px + 22, py + 50, 14, C.dim, L);
        let kx = px + 22;
        sensors.CATS.forEach((c) => {
            const t = CAT_NAME[c] || c, on = c === this.cat;
            kx += pill(cv, kx, py + 64, pillW(cv, t, 15) + 24, 34, t, on ? 'primary' : 'outline', () => { this.cat = c; this.kick(); }, 'cat:' + c, 15) + 8;
        });
        const list = sensors.LIST.filter((x) => x.cat === this.cat), ly0 = py + 110, lh = Math.max(26, Math.min(42, Math.floor((ph - 118) / list.length)));
        list.forEach((sn, i) => {
            const y = ly0 + i * lh, sel = cur && cur.id === sn.id, ts = lh < 34 ? 15 : 16;
            if (sel) cv.roundRect(px + 10, y, pw - 20, lh - 2, 9, C.off);
            if (sel) check(cv, px + 32, y + lh / 2 - 1, C.text);
            const vt = this.sensorText(sn), vw = cv.textWidth(vt, 15, L);
            cv.text(fit(cv, this.sensorName(sn), ts, pw - 110 - vw, sel ? B : L), px + 50, y + lh / 2 + 5, ts, C.text, sel ? B : L);
            cv.text(vt, px + pw - 24, y + lh / 2 + 5, 15, C.dim, { font: 'label', align: 'right', literal: true });
            cv.target(px + 10, y, pw - 20, lh - 2, () => { this.hud.setSlot(lay, this.slot, sn.id); this.kick(); }, 'sensor:' + sn.id, 9);
        });
    }

    /* ---------- Position (HUD) ---------- */
    /** The whole HUD on black, the part seen through the windshield dashed, the layout where it sits now; move pad and size. */
    positionTab(cv, bottom) {
        const shown = this.shownName(), p = this.hud.placeInfo();
        cv.text('Where it sits on the glass', X0, CT + 22, 17, C.text, B);
        cv.text('Every tap moves the real HUD right away', X0 + cv.textWidth('Where it sits on the glass', 17, B) + 14, CT + 22, 14, C.dim, L);
        const k = Math.min(0.9, (bottom - CT - 64) / 480), bw = 800 * k, bh = 480 * k, bx = X0, by = CT + 40;
        cv.roundRect(bx, by, bw, bh, 10, '#000000');
        const pic = shown !== 'off' && previews.get(shown, 'full');
        if (pic) {
            // the picture is the whole 800x480 HUD with the layout unmoved: move it, and scale it about the layout's centre
            const b = p.box, cx = b.w ? b.x + b.w / 2 : 400, cy = b.h ? b.y + b.h / 2 : 240, s = p.scale;
            cv.clip(bx, by, bw, bh);
            cv.image(pic.id, bx + (cx * (1 - s) + p.x) * k, by + (cy * (1 - s) + p.y) * k, 800 * k * s, 480 * k * s);
            cv.noclip();
        } else cv.text(shown === 'off' ? 'The HUD is off' : 'No picture', bx + bw / 2, by + bh / 2 + 7, 18, C.dim, { font: 'label', align: 'center', literal: true });
        const v = visible.HUD_WINDOW;
        dashed(cv, bx + v.x * k, by + v.y * k, v.w * k, v.h * k, C.text);
        cv.strokeRoundRect(bx, by, bw, bh, 10, 1, '#ffffff14');
        cv.text('The dashed frame is the part you can see through the windshield.', bx, by + bh + 22, 14, C.dim, L);
        // the pad
        const rx = bx + bw + 64, pad = 76, gap = 10, mx = rx + pad + gap, my = by + 30;
        cv.text('Move it', rx, by + 14, 17, C.text, B);
        const step = (dx, dy) => () => {
            if (dx) this.set('hudX', clampStep(this.item('hudX'), (this.get('hudX') || 0) + dx));
            if (dy) this.set('hudY', clampStep(this.item('hudY'), (this.get('hudY') || 0) + dy));
        };
        padBtn(cv, mx, my, pad, 'up', step(0, -10), 'move:up');
        padBtn(cv, rx, my + pad + gap, pad, 'left', step(-10, 0), 'move:left');
        padBtn(cv, mx, my + pad + gap, pad, 'centre', () => { this.set('hudX', 0); this.set('hudY', 0); }, 'move:centre');
        padBtn(cv, mx + pad + gap, my + pad + gap, pad, 'right', step(10, 0), 'move:right');
        padBtn(cv, mx, my + 2 * (pad + gap), pad, 'down', step(0, 10), 'move:down');
        cv.text('Now ' + p.x + ' px across, ' + p.y + ' px down', rx + 3 * (pad + gap) + 20, my + pad + gap + 44, 14, C.dim, L);
        const sy = my + 3 * (pad + gap) + 8;
        this.stepRow(cv, rx, sy, X1 - rx, 'Size', 'How big the layout is drawn', 'hudScale', 58);
    }

    /* ---------- Waze map (cluster) ---------- */
    mapTab(cv, bottom) {
        const lw = 820;
        this.switchRow(cv, X0, CT, lw, 'Show the Waze map in the theme', 'The Sport and M themes open a window in the middle for the map', 'mapInTheme', 66);
        // live state from waze.js: the map showing, waiting, the Waze app busy, Waze on Cluster missing
        const info = this.hud.waze ? this.hud.waze.info() : { text: 'Not available in this app', up: false, ok: false };
        let st = wazeWords(info.text);
        if (this.get('mapInTheme') && !this.hud.mapLayout && this.hud.activeName !== 'off') {
            st = ['Only the Sport and M themes can show the map', this.layoutName(this.shownName()) + ' is on now, so Waze stays where it normally is.'];
        }
        const sy = CT + 82, sh = 72;
        cv.roundRect(X0, sy, lw, sh, 14, C.panel);
        cv.strokeRoundRect(X0, sy, lw, sh, 14, 1, C.panelLine);
        cv.circle(X0 + 24, sy + 26, 6, info.up ? C.green : info.ok ? C.faint : C.amber);
        cv.text(fit(cv, st[0], 17, lw - 64, L), X0 + 44, sy + 32, 17, C.text, L);
        if (st[1]) cv.text(fit(cv, st[1], 14, lw - 64, L), X0 + 44, sy + 54, 14, C.dim, L);
        let y = sy + sh + 34;
        cv.text('Good to know', X0, y, 17, C.text, B);
        y += 10;
        [
            'Other themes leave Waze where it normally is.',
            'While the map is in the theme, Waze\'s map leaves the HUD. Waze draws one map at a time.',
            'Needs robertnisipeanu\'s Waze on Cluster app on the car.',
            'Turning this off gives Waze its usual place back.',
        ].forEach((t) => {
            wrap(cv, t, 15, lw - 20, L).forEach((ln, j) => {
                y += 24;
                if (j === 0) cv.text('·', X0 + 2, y, 15, C.dim, L);
                cv.text(ln, X0 + 18, y, 15, C.soft, L);
            });
        });
        // right: where the map goes, on the Sport theme's picture
        const rx = X0 + lw + 48, rw = X1 - rx;
        cv.text('Where the map goes', rx, CT + 22, 17, C.text, B);
        const ih = rw * 0.375, iy = CT + 36;
        this.picture(cv, 'sport', 'big', rx, iy, rw, ih);
        cv.fillRect(rx, iy, rw, ih, '#0d0d0e80');
        const mx = rx + rw * 0.33, my = iy + ih * 0.14, mw = rw * 0.34, mh = ih * 0.64;
        cv.roundRect(mx, my, mw, mh, 10, '#0d0d0ef0');
        dashed(cv, mx, my, mw, mh, C.text);
        cv.text('The Waze map shows here', mx + mw / 2, my + mh / 2 + 6, 16, C.text, { font: 'bold', align: 'center', literal: true });
        let ny = iy + ih + 24;
        wrap(cv, 'The Sport theme with its map window. M works the same way. When the map goes away, the theme fills back in.', 14, rw, L).forEach((ln) => { cv.text(ln, rx, ny, 14, C.dim, L); ny += 21; });
    }

    /* ---------- Model name (cluster badge) ---------- */
    /** 1. the series, 2. that series' models to tap; right: what the cluster shows, BMW in front, none. */
    badgeTab(cv, bottom) {
        const model = this.get('badge'), lw = 880;
        const series = this.series || badges.seriesOf(model) || 'X';
        cv.text('1. Series', X0, CT + 22, 17, C.text, B);
        cv.text('Tap your car\'s series', X0 + cv.textWidth('1. Series', 17, B) + 14, CT + 22, 14, C.dim, L);
        let cx = X0;
        badges.SERIES.forEach((s) => {
            const t = s[0] === 'ALPINA' ? 'Alpina' : s[0], w = Math.max(50, pillW(cv, t, 16) + 26);
            cx += pill(cv, cx, CT + 36, w, 40, t, s[0] === series ? 'primary' : 'outline', () => { this.series = s[0]; this.kick(); }, 'series:' + s[0], 16) + 8;
        });
        cv.text('2. Your model', X0, CT + 110, 17, C.text, B);
        cv.text('Tap it to show it on the cluster', X0 + cv.textWidth('2. Your model', 17, B) + 14, CT + 110, 14, C.dim, L);
        const list = (badges.SERIES.find((s) => s[0] === series) || [null, []])[1];
        const cw = (lw - 20) / 3, top = CT + 124, rows = Math.ceil(list.length / 3), rh = Math.max(34, Math.min(50, Math.floor((bottom - top) / rows) - 8));
        list.forEach((m, i) => {
            const x = X0 + (i % 3) * (cw + 10), y = top + Math.floor(i / 3) * (rh + 8), sel = m === model;
            cv.roundRect(x, y, cw, rh, 10, sel ? C.text : C.panel);
            cv.strokeRoundRect(x, y, cw, rh, 10, 1, sel ? C.text : C.panelLine);
            cv.text(m, x + 18, y + rh / 2 + 6, 17, sel ? C.ink : C.text, sel ? B : L);
            if (sel) check(cv, x + cw - 26, y + rh / 2, C.ink);
            cv.target(x, y, cw, rh, () => this.set('badge', m), 'badge:' + m, 10);
        });
        // right: what shows, BMW in front, none
        const rx = X0 + lw + 48, rw = X1 - rx, bmw = this.get('badgeBMW') === true, shown = badges.text(model, bmw);
        cv.text('What the cluster shows', rx, CT + 22, 17, C.text, B);
        cv.roundRect(rx, CT + 36, rw, 104, 14, '#000000');
        cv.strokeRoundRect(rx, CT + 36, rw, 104, 14, 1, C.panelLine);
        cv.text(shown || 'No model name', rx + rw / 2, CT + 36 + 52 + (shown ? 12 : 7), shown ? 34 : 18, shown ? C.text : C.dim, { font: shown ? 'bold' : 'label', align: 'center', literal: true });
        let y = CT + 162;
        wrap(cv, 'Only the Sport and M themes show it, at the bottom in the middle, in the theme\'s own font.', 14, rw, L).forEach((ln) => { cv.text(ln, rx, y, 14, C.dim, L); y += 20; });
        const sample = model && model !== 'none' ? model : 'X3 M40i';
        y = this.switchRow(cv, rx, y - 2, rw, 'Write "BMW" in front', 'Shows "BMW ' + sample + '" instead of "' + sample + '"', 'badgeBMW', 64);
        const none = model === 'none', nh = 50;
        y += 12;
        cv.roundRect(rx, y, rw, nh, 10, none ? C.text : C.panel);
        cv.strokeRoundRect(rx, y, rw, nh, 10, 1, none ? C.text : C.border);
        cv.text('Show no model name', rx + 18, y + nh / 2 + 6, 17, none ? C.ink : C.text, none ? B : L);
        if (none) check(cv, rx + rw - 26, y + nh / 2, C.ink);
        cv.target(rx, y, rw, nh, () => this.set('badge', 'none'), 'badge:none', 10);
    }

    /* ---------- Warnings & shift lights (both) ---------- */
    /** Warning limits (the readout flashes red over one), the shift lights and the shift-light test. */
    alertsTab(cv, bottom) {
        const lw = 700, what = this.cfg.what;
        cv.text('Warnings', X0, CT + 22, 17, C.text, B);
        cv.text('A value flashes red on the ' + what + ' when it goes over its limit', X0, CT + 42, 14, C.dim, L);
        let y = CT + 54;
        WARN_KEYS.forEach((k) => { if (this.item(k)) y = this.stepRow(cv, X0, y, lw, WARN_LABEL[k], '', k, 60); });
        cv.text('To turn a warning off, press the minus button until it says Off.', X0, y + 22, 14, C.dim, L);
        const defs = WARN_KEYS.filter((k) => this.item(k)).map((k) => { const t = warnText(k, this.item(k).default, this.us()); return k.replace('warn', '').toLowerCase() + ' ' + (t === 'Off' ? 'off' : t); }).join(', ');
        const rt = 'Put warnings back: ' + defs, rbw = pillW(cv, rt, 15) + 64;
        pill(cv, X0, y + 40, Math.min(lw, rbw), 40, rt, 'outline', () => {
            const prev = {};
            WARN_KEYS.forEach((k) => { if (this.item(k)) { prev[k] = this.get(k); this.set(k, this.item(k).default); } });
            this.showToast('The warnings are back to how the app came.', () => Object.keys(prev).forEach((k) => this.set(k, prev[k])));
        }, 'warn:reset', 15, 'undo');
        // right: the shift lights, the test, temperatures, directions
        const rx = X0 + lw + 56, rw = X1 - rx;
        y = CT;
        if (this.item('shiftCue')) {
            cv.text('Shift lights', rx, y + 22, 17, C.text, B);
            cv.text('The lights that tell you when to shift up', rx + cv.textWidth('Shift lights', 17, B) + 14, y + 22, 14, C.dim, L);
            y += 34;
            cv.text('How they light up', rx, y + 30, 17, C.text, L);
            const cue = this.get('shiftCue');
            const sw = 2 * 130 + 8;
            segmented(cv, X1 - sw, y + 2, ['countin', 'rpm'].map((v) => ({
                text: this.optText('shiftCue', v)[0], on: cue === v, w: 130, key: 'cue:' + v, run: () => this.set('shiftCue', v),
            })), 40);
            y += 52;
            cv.text(cue === 'rpm' ? 'They fill from a set rpm up to the shift point, the same every time.'
                : 'They fill up over the last second before the shift point and flash a little early, so you shift on time.', rx, y + 16, 14, C.dim, L);
            y += 28;
            cv.fillRect(rx, y, rw, 1, C.line);
        }
        // the test (both apps)
        const testing = this.hud.shiftTesting && this.hud.shiftTesting();
        const d = this.hud.car && this.hud.car.data(), moving = d && !d.demo && d.speed > 3;
        const bt = testing ? 'Testing...' : moving ? 'Stop the car first' : 'Start test', live = !testing && !moving;
        const bw = pillW(cv, bt, 15) + 36;
        twoLine(cv, rx, y, 64, 'Test the shift lights', 'Runs them up to the shift point for 4 seconds. Parked only.', rw - bw - 16);
        pill(cv, X1 - bw, y + 12, bw, 40, bt, live ? 'primary' : 'muted', live ? () => {
            if (this.hud.testShift()) { this.kick(); setTimeout(() => this.kick(), 4000); }
        } : null, 'test:shift', 15);
        y += 64;
        cv.fillRect(rx, y, rw, 1, C.line);
        if (this.item('smartTemps')) {
            cv.text('Temperatures', rx, y + 30, 17, C.text, B);
            y += 40;
            y = this.switchRow(cv, rx, y, rw, 'Hide oil and coolant when they are normal',
                'They show only while cold, warming up or too hot. Outside turns blue at ' + (this.us() ? '37 °F.' : '3 °C.'), 'smartTemps', 64);
        }
        if (this.item('navDirections')) {
            cv.text('Directions', rx, y + 28, 17, C.text, B);
            y += 36;
            const l = this.labelOf('navDirections');
            this.pickRow(cv, rx, y, rw, l[0], l[1], 'navDirections', null, 60);
        }
    }

    /* ---------- G-meter (both) ---------- */
    /** The range, the trail, which way it draws, the bests with a clear, and a live copy of the meter. */
    gmeterTab(cv, bottom) {
        const lw = 900, g = this.hud.gState ? this.hud.gState() : null;
        let y = CT;
        y = this.segRow(cv, X0, y, lw, 'Circle edge', 'The dot reaches the edge at this force. Lower makes it move more.', 'gRange', 70);
        y = this.segRow(cv, X0, y, lw, 'Tail behind the dot', 'How long the dot leaves a fading line behind it', 'gTrail', 70);
        y = this.switchRow(cv, X0, y, lw, 'Flip left and right', 'Turn on if the dot goes the wrong way in turns', 'gFlipLat', 58);
        y = this.switchRow(cv, X0, y, lw, 'Show braking at the top', 'Off: braking is at the bottom, speeding up at the top', 'gFlipLong', 58);
        // the bests this drive (the car's left / right: gFlipLat turns its sign round)
        y += 12;
        const bh = Math.min(92, bottom - y - 4);
        cv.roundRect(X0, y, lw, bh, 14, C.panel);
        cv.strokeRoundRect(X0, y, lw, bh, 14, 1, C.panelLine);
        cv.text('Most g this drive', X0 + 20, y + 26, 16, C.text, B);
        const b = g ? g.best : null, sw = this.get('gFlipLat') === true;
        const cols = [['Left turns', b && (sw ? b.right : b.left)], ['Right turns', b && (sw ? b.left : b.right)], ['Speeding up', b && b.accel], ['Braking', b && b.brake], ['Highest', b && b.total]];
        cols.forEach((c, i) => {
            const x = X0 + 20 + i * 112;
            cv.text(c[1] > 0 ? c[1].toFixed(2) : '--', x, y + bh - 30, 24, C.text, B);
            cv.text(c[0], x, y + bh - 10, 13, C.dim, L);
        });
        const ct = 'Clear this drive\'s best g', cbw = pillW(cv, ct, 15) + 32;
        pill(cv, X0 + lw - cbw - 18, y + (bh - 40) / 2, cbw, 40, ct, 'outline', () => { if (this.hud.resetG) this.hud.resetG(); this.kick(); }, 'g:reset', 15);
        // right: the meter as the layout draws it, live
        const rx = X0 + lw + 56, rw = X1 - rx, r = Math.max(60, Math.min(rw / 2 - 20, (bottom - CT - 104) / 2)), cx = rx + rw / 2, cy = CT + 34 + r;
        cv.text('Now', rx, CT + 22, 17, C.text, B);
        if (g) this.gPreview(cv, cx, cy, r, g);
        const now = g && g.live ? (Math.sqrt(g.x * g.x + g.y * g.y)).toFixed(2) + ' g' : 'No g reading yet';
        cv.text(now, cx, cy + r + 30, 20, g && g.live ? C.text : C.dim, { font: 'bold', align: 'center', literal: true });
        cv.text('From the car\'s own sensor. Level ground reads 0.00; hills add a little.', cx, Math.min(bottom - 4, cy + r + 52), 13, C.dim, { font: 'label', align: 'center', literal: true });
    }
    /** The page's copy of the G-meter shader (shaders.js gmeter): bezel, rings, envelope, trail, dot. */
    gPreview(cv, cx, cy, r, g) {
        const max = g.max, step = max > 1.2 ? 0.5 : 0.25, k = (r - 6) / max;
        const ring = (rr, w, c) => cv.arc(cx, cy, Math.max(0, rr - w / 2), rr + w / 2, 0, 360, c);
        cv.circle(cx, cy, r, '#08080a');
        ring(r - 1, 2.5, '#c3cad6');
        for (let v = step; v < max - 0.01; v += step) ring(v * k, 1, Math.abs(v / 0.5 - Math.round(v / 0.5)) < 0.01 ? '#ffffff55' : '#ffffff26');
        cv.line(cx - r + 8, cy, cx + r - 8, cy, 1, '#ffffff30');
        cv.line(cx, cy - r + 8, cx, cy + r - 8, 1, '#ffffff30');
        cv.text(max.toFixed(1) + ' g', cx + r * 0.72 + 4, cy - r * 0.72 - 2, 14, C.dim, L);
        const flipL = this.get('gFlipLong') === true, lab = { font: 'bold', align: 'center', spacing: 1, literal: true };
        cv.text(flipL ? 'BRAKING' : 'SPEEDING UP', cx, cy - r + 28, 13, C.dim, lab);
        cv.text(flipL ? 'SPEEDING UP' : 'BRAKING', cx, cy + r - 16, 13, C.dim, lab);
        cv.text('LEFT', cx - r + 30, cy - 8, 13, C.dim, lab);
        cv.text('RIGHT', cx + r - 32, cy - 8, 13, C.dim, lab);
        const P = (x, y) => { const m = Math.sqrt(x * x + y * y), s = m > max ? max / m : 1; return [cx + x * s * k, cy + y * s * k]; };
        // the envelope: drawn sector m at m * 7.5 degrees, + y up
        const n = g.env.length;
        for (let m = 0; m < n; m++) {
            const a = g.env[m], b = g.env[(m + 1) % n];
            if (!(a > 0.04 || b > 0.04)) continue;
            const t0 = m * 2 * Math.PI / n, t1 = (m + 1) * 2 * Math.PI / n;
            const p0 = P(Math.cos(t0) * a, -Math.sin(t0) * a), p1 = P(Math.cos(t1) * b, -Math.sin(t1) * b);
            cv.line(p0[0], p0[1], p1[0], p1[1], 2, '#eef2f8cc');
        }
        if (!g.live) return;
        const heat = (v) => (v >= 0.8 ? '#ff4b3e' : v >= 0.5 ? '#ffb028' : '#ffffff');
        const pts = [[g.x, g.y]].concat(g.trail);
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = P(pts[i][0], pts[i][1]), b = P(pts[i + 1][0], pts[i + 1][1]), f = i / 15;
            cv.line(a[0], a[1], b[0], b[1], 4 - 3 * f, A(heat(Math.sqrt(g.x * g.x + g.y * g.y)), 0.85 - 0.75 * f));
        }
        const d = P(g.x, g.y), c = heat(Math.sqrt(g.x * g.x + g.y * g.y));
        cv.circle(d[0], d[1], 18, A(c, 0.25));
        cv.circle(d[0], d[1], 10, c);
    }

    /* ---------- Colours (HUD) ---------- */
    coloursTab(cv) {
        cv.text('Colours on the glass', X0, CT + 22, 17, C.text, B);
        cv.text('The HUD is a projector: bright, solid colours read best', X0 + cv.textWidth('Colours on the glass', 17, B) + 14, CT + 22, 14, C.dim, L);
        let y = CT + 34;
        y = this.segRow(cv, X0, y, 1100, 'Colours', 'Auto switches to Night after sunset', 'hudTheme', 70);
        if (this.get('hudTheme') === 'auto') this.segRow(cv, X0, y, 1100, 'In daylight', 'The colours Auto uses before sunset', 'dayTheme', 70);
    }

    /* ---------- Settings ---------- */
    /** Every setting in its group, in two columns; help and the reset under them. */
    settingsTab(cv, bottom) {
        const keys = this.cfg.settings.filter((k) => this.item(k));
        const groups = SETTING_GROUPS.map((g) => [g[0], g[1].filter((k) => keys.indexOf(k) >= 0)]);
        const rest = keys.filter((k) => !SETTING_GROUPS.some((g) => g[1].indexOf(k) >= 0));
        groups[2][1] = groups[2][1].concat(rest);
        const left = [groups[0], groups[1]].filter((g) => g[1].length);
        const right = [groups[2]].filter((g) => g[1].length).concat([['Help and reset', ['@details', '@reset']]]);
        const rowsOf = (col) => col.reduce((n, g) => n + g[1].length, 0);
        const headH = 32, maxRows = Math.max(rowsOf(left), rowsOf(right)), maxHeads = Math.max(left.length, right.length);
        const rh = Math.max(38, Math.min(56, Math.floor((bottom - CT - maxHeads * headH - 4) / maxRows)));
        const colW = (CW - 64) / 2;
        [left, right].forEach((col, ci) => {
            const x = X0 + ci * (colW + 64);
            let y = CT - 6;
            col.forEach((g) => {
                cv.text(g[0], x, y + headH - 8, 15, C.dim, B);
                y += headH;
                g[1].forEach((k) => { y = this.settingRow(cv, x, y, colW, k, rh); });
            });
        });
    }
    /** One Settings row: a switch, a stepper, a list to pick from, or one of the two help buttons. */
    settingRow(cv, x, y, w, k, h) {
        if (k === '@details') {
            this.actionRow(cv, x, y, w, h, 'Details for bug reports', 'Drive mode signals and what the app is doing', 'Show details', false, () => {
                const diag = this.hud.modeDiagLines ? this.hud.modeDiagLines(this.cfg.modeCheck || []) : [];
                this.confirm = {
                    title: 'Details for bug reports',
                    lines: diag.concat(['', 'What the app is doing: ' + (this.hud.lastStatus || 'nothing reported yet'), '', 'If something looks wrong on your car, open an issue and include these lines.']),
                    no: 'Close',
                };
                this.kick();
            }, 'details');
            return y + h;
        }
        if (k === '@reset') {
            this.actionRow(cv, x, y, w, h, 'Reset everything', 'Every setting back to how the app came', 'Reset...', true, () => {
                const look = this.cluster() ? 'theme' : 'layout';
                this.confirm = {
                    title: 'Reset everything?',
                    lines: ['Every setting goes back to how the app came: the ' + look + ' for each drive mode, gauges, warnings, shift lights, G-meter' +
                        (this.cluster() ? ', model name, Waze map' : ', position, colours') + ', units, clock and time zone.', '',
                        this.cluster() ? 'Out of the box, Sport mode shows Track. To see BMW\'s own cluster instead, use "Show BMW\'s own cluster in every mode" on the Theme tab.'
                            : 'Out of the box, Comfort mode shows Daily.'],
                    yes: 'Reset everything', danger: true, run: () => this.resetAll(),
                };
                this.kick();
            }, 'reset');
            return y + h;
        }
        const s = this.item(k), l = this.labelOf(k), sub = h >= 46 ? l[1] : '';
        if (s.type === 'bool') return this.switchRow(cv, x, y, w, l[0], sub, k, h);
        if (s.type === 'number') return this.stepRow(cv, x, y, w, l[0], sub, k, h, 220);
        return this.pickRow(cv, x, y, w, l[0], sub, k, null, h);
    }
    /** "Reset everything": every setting to its app.json default, every readout box back to its own */
    resetAll() {
        const scr = this.hud.screen;
        if (scr && !scr.otherOn()) scr.release();
        ((this.ctx.spec && this.ctx.spec.settings) || []).forEach((s) => { if (s && s.key && s.default !== undefined) this.set(s.key, s.default); });
        this.slotLayouts().forEach((lay) => this.hud.slotsOf(lay).forEach((x) => this.hud.setSlot(lay, x.id, null)));
        this.editMode = null; this.series = null; this.slotLayout = null; this.slot = null;
        this.showToast('Everything is back to how the app came.', null);
    }

    /* ---------- rows ---------- */
    /** label and grey line, vertically centred in a row of height h; the label cut to maxW */
    rowText(cv, x, y, h, label, sub, maxW) {
        twoLine(cv, x, y, h, label, sub, maxW);
    }
    switchRow(cv, x, y, w, label, sub, key, h) {
        h = h || 56;
        const on = this.get(key) === true;
        twoLine(cv, x, y, h, label, sub, w - 80);
        switchCtl(cv, x + w - 52, y + (h - 30) / 2, on);
        cv.fillRect(x, y + h - 1, w, 1, C.line);
        cv.target(x, y, w, h, () => this.set(key, !on), 'set:' + key, 8);
        return y + h;
    }
    pickRow(cv, x, y, w, label, sub, key, fmt, h) {
        h = h || 56;
        const v = this.get(key), text = fmt ? fmt(v) : this.valueText(key), tw = cv.textWidth(text, 17, B);
        twoLine(cv, x, y, h, label, sub, w - tw - 60);
        cv.text(text, x + w - 30, y + h / 2 + 6, 17, C.text, { font: 'bold', align: 'right', literal: true });
        chevron(cv, x + w - 12, y + h / 2, C.dim);
        cv.fillRect(x, y + h - 1, w, 1, C.line);
        cv.target(x, y, w, h, () => { this.picker = { key, title: label, fmt }; this.kick(); }, 'set:' + key, 8);
        return y + h;
    }
    stepRow(cv, x, y, w, label, sub, key, h, minW) {
        h = h || 56;
        const s = this.item(key), steps = s.steps || [], i = steps.indexOf(this.get(key));
        const text = this.valueText(key), vw = Math.max(minW || 120, cv.textWidth(text, 17, B) + 20), bs = Math.min(40, h - 12);
        const bx = x + w - bs, ax = bx - vw - 2 * 8 - bs, by = y + (h - bs) / 2;
        twoLine(cv, x, y, h, label, sub, ax - x - 16);
        stepBtn(cv, ax, by, bs, '-', i > 0, () => this.set(key, steps[i - 1]), 'dn:' + key);
        cv.text(text, ax + bs + 8 + vw / 2, y + h / 2 + 6, 17, C.text, { font: 'bold', align: 'center', literal: true });
        stepBtn(cv, bx, by, bs, '+', i < steps.length - 1, () => this.set(key, steps[i + 1]), 'up:' + key);
        cv.fillRect(x, y + h - 1, w, 1, C.line);
        return y + h;
    }
    /** a row whose choices are side by side (the G-meter's, the HUD colours) */
    segRow(cv, x, y, w, label, sub, key, h) {
        const s = this.item(key), v = this.get(key), opts = (s && s.options) || [];
        const iw = opts.reduce((m, o) => Math.max(m, cv.textWidth(this.optText(key, o[0])[0], 16, B) + 30), 66);
        const sw = opts.length * iw + 8;
        twoLine(cv, x, y, h, label, sub, w - sw - 24);
        segmented(cv, x + w - sw, y + (h - 48) / 2, opts.map((o) => ({
            text: this.optText(key, o[0])[0], on: o[0] === v, w: iw, key: 'opt:' + key + ':' + o[0], run: () => this.set(key, o[0]),
        })), 40);
        cv.fillRect(x, y + h - 1, w, 1, C.line);
        return y + h;
    }
    actionRow(cv, x, y, w, h, label, sub, btn, danger, run, key) {
        const bw = pillW(cv, btn, 15) + 34;
        twoLine(cv, x, y, h, label, h >= 46 ? sub : '', w - bw - 16, danger ? C.red : C.text);
        pill(cv, x + w - bw, y + (h - 38) / 2, bw, 38, btn, danger ? 'danger' : 'outline', run, key, 15);
        cv.fillRect(x, y + h - 1, w, 1, C.line);
    }

    /** A list of a setting's choices over the page; a tap on one sets it, Close or a tap beside it closes. */
    drawPicker(cv, bottom) {
        const p = this.picker, s = this.item(p.key), opts = s.type === 'number' ? (s.steps || []).map((v) => [v, null]) : s.options || [];
        cv.fillRect(0, 36, W, bottom + 20, '#000000b8');
        const words = (o) => (p.fmt ? [p.fmt(o[0]), ''] : o[1] !== null ? this.optText(p.key, o[0]) : [fmtInt(o[0]) + ' rpm', '']);
        const hasDesc = opts.some((o) => words(o)[1]);
        const rh = hasDesc ? 56 : 46, maxH = bottom - 60, per = Math.max(1, Math.floor((maxH - 136) / rh)), cols = Math.ceil(opts.length / per);
        const colW = cols > 1 ? 340 : 600, w = cols * colW + 48, rows = Math.min(per, opts.length), h = 136 + rows * rh;
        const x = Math.round((W - w) / 2), y = Math.max(52, Math.round((bottom + 44 - h) / 2));
        cv.roundRect(x, y, w, h, 18, C.field);
        cv.strokeRoundRect(x, y, w, h, 18, 1, C.panelLine);
        cv.text(p.title, x + 24, y + 40, 21, C.text, B);
        const v = this.get(p.key);
        opts.forEach((o, i) => {
            const c = Math.floor(i / per), r = i % per, ox = x + 24 + c * colW, ry = y + 58 + r * rh, sel = o[0] === v, wd = words(o);
            if (sel) cv.roundRect(ox - 8, ry, colW - 8, rh - 4, 10, C.off);
            cv.text(fit(cv, wd[0], 18, colW - 60, sel ? B : L), ox + 8, wd[1] ? ry + 24 : ry + rh / 2 + 4, 18, C.text, sel ? B : L);
            if (wd[1]) cv.text(fit(cv, wd[1], 14, colW - 60, L), ox + 8, ry + 44, 14, C.dim, L);
            if (sel) check(cv, ox + colW - 34, ry + (rh - 4) / 2, C.text);
            cv.target(ox - 8, ry, colW - 8, rh - 4, () => {
                this.picker = null;
                if (LOOK_KEYS.indexOf(p.key) >= 0) this.chooseLayout(p.key, o[0]); else this.set(p.key, o[0]);
            }, 'pick:' + p.key + ':' + o[0], 10);
        });
        // the list's own targets first: a tap takes the first target it is in (display.js), a tap beside the list closes it
        const close = () => { this.picker = null; this.kick(); };
        pill(cv, x + 24, y + h - 60, 140, 44, 'Close', 'outline', close, 'pick:done', 16);
        cv.target(0, 36, W, bottom, close, 'pick:close');
    }

    /** A question over the page (or, with no "yes", a note): the answer button, Cancel / Close, a tap beside it cancels. */
    drawConfirm(cv, bottom) {
        const q = this.confirm, close = () => { this.confirm = null; this.kick(); };
        cv.fillRect(0, 36, W, bottom + 20, '#000000b8');
        const w = 760, lines = [];
        q.lines.forEach((s) => { if (!s) lines.push(''); else wrap(cv, s, 17, w - 64, L).forEach((ln) => lines.push(ln)); });
        const h = 92 + lines.length * 26 + 84, x = (W - w) / 2, y = Math.max(52, (bottom + 44 - h) / 2);
        cv.roundRect(x, y, w, h, 18, C.field);
        cv.strokeRoundRect(x, y, w, h, 18, 1, C.panelLine);
        cv.text(q.title, x + 32, y + 50, 24, C.text, B);
        lines.forEach((s, i) => { if (s) cv.text(s, x + 32, y + 88 + i * 26, 17, C.soft, L); });
        const bh = 48, by = y + h - bh - 24;
        let bx = x + 32;
        if (q.yes) {
            const yw = pillW(cv, q.yes, 17) + 48;
            pill(cv, bx, by, yw, bh, q.yes, q.danger ? 'dangerFill' : 'primary', () => { this.confirm = null; q.run(); this.kick(); }, 'confirm:yes', 17);
            bx += yw + 12;
        }
        const nt = q.no || (q.yes ? 'Cancel' : 'Close');
        pill(cv, bx, by, pillW(cv, nt, 17) + 48, bh, nt, 'outline', close, 'confirm:no', 17);
        // last: a tap takes the first target it is in (display.js), so the buttons come before the backdrop
        cv.target(0, 36, W, bottom, close, 'confirm:close');
    }
}

/* ---------- small pieces ---------- */
const LOOK_KEYS = ['hudLayout', 'inComfort', 'inSport', 'inEco'];
const WARN_KEYS = ['warnOil', 'warnCoolant', 'warnBoost'];
/** A warning limit as the page shows it, in the display units: "266 °F", "1.2 bar", "Off". */
function warnText(k, v, us) {
    if (!(v > 0)) return 'Off';
    if (k === 'warnBoost') return us ? Math.round(v * 14.5038) + ' psi' : v.toFixed(1) + ' bar';
    return us ? Math.round(v * 9 / 5 + 32) + ' °F' : v + ' °C';
}
/** waze.js's status line in plain words: [what is happening, what to do] */
function wazeWords(t) {
    const W8 = {
        'Waze on Cluster isn\'t running': ['The Waze on Cluster app isn\'t running', 'Open it on the car, then come back. The map appears by itself.'],
        'Waze on Cluster: this car isn\'t supported': ['Waze on Cluster doesn\'t support this car', 'The map can\'t move into the theme here.'],
        'Waze map is turned off in the Waze app': ['The map is turned off in the Waze app', 'Turn the cluster map on in Waze, then come back.'],
        'Off. Waze shows the map in BMW\'s own map view': ['Off: Waze shows its map in BMW\'s own map view', 'Turn the switch on to put it inside the Sport or M theme.'],
        'Waze app is open, retrying': ['The Waze app is open', 'It tries again by itself.'],
        'Moving the map into the theme': ['Moving the map into the theme', 'This takes a moment.'],
        'Map showing in the theme': ['The map is showing in the theme', ''],
        'Map frozen, waiting for the phone': ['The map is frozen, waiting for the phone', 'It comes back when the phone sends the map again.'],
        'Waze on Cluster reports an error': ['Waze on Cluster reports an error', ''],
        'Waiting for the map': ['Waiting for the map', 'It appears when Waze sends it.'],
        'Not available in this app': ['Not available in this app', ''],
    };
    if (W8[t]) return W8[t];
    if (/^Can't reach Waze on Cluster/.test(t)) return [t, 'It tries again by itself.'];
    return [t, ''];
}
/** a "timeZone" setting value as the row shows it (shared/tz.js) */
function tzText(v) { return tz.name(v); }
function fmtInt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
/** text cut to maxW with an ellipsis */
function fit(cv, s, size, maxW, opts) {
    s = String(s);
    if (maxW <= 0 || cv.textWidth(s, size, opts) <= maxW) return s;
    while (s.length > 1 && cv.textWidth(s + '…', size, opts) > maxW) s = s.slice(0, -1);
    return s.replace(/\s+$/, '') + '…';
}
/** a paragraph broken into lines of at most maxW */
function wrap(cv, s, size, maxW, opts) {
    const out = [];
    let line = '';
    String(s).split(' ').forEach((word) => {
        const t = line ? line + ' ' + word : word;
        if (line && cv.textWidth(t, size, opts) > maxW) { out.push(line); line = word; } else line = t;
    });
    if (line) out.push(line);
    return out;
}
/** a row's name (17) and its grey line (14), centred in height h */
function twoLine(cv, x, y, h, label, sub, maxW, color) {
    if (sub) {
        cv.text(fit(cv, label, 17, maxW, L), x, y + h / 2 - 3, 17, color || C.text, L);
        cv.text(fit(cv, sub, 14, maxW, L), x, y + h / 2 + 16, 14, C.dim, L);
    } else cv.text(fit(cv, label, 17, maxW, L), x, y + h / 2 + 6, 17, color || C.text, L);
}
/** an on / off switch, 52 x 30: white with a dark knob on the right when on */
function switchCtl(cv, x, y, on) {
    cv.roundRect(x, y, 52, 30, 15, on ? C.text : C.off);
    cv.circle(on ? x + 37 : x + 15, y + 15, 11, on ? C.ink : C.dim);
}
/**
 * Choices side by side in one dark field; the picked one white. items: { text, small (after the text), sub (a
 * second line), on, w (else the text's width), key, run }. h: the items' height. Returns the field's width.
 */
function segmented(cv, x, y, items, h) {
    const ws = items.map((it) => it.w || cv.textWidth(it.text, 16, B) + cv.textWidth(it.small || '', 13, L) + 36);
    const total = ws.reduce((a, b) => a + b, 0) + 8;
    cv.roundRect(x, y, total, h + 8, 12, C.field);
    let ix = x + 4;
    items.forEach((it, i) => {
        const w = ws[i], on = it.on, iy = y + 4;
        if (on) cv.roundRect(ix, iy, w, h, 9, C.text);
        const fg = on ? C.ink : C.text, fgSub = on ? '#4a4a4f' : C.dim;
        if (it.sub) {
            cv.text(it.text, ix + 16, iy + h / 2 - 3, 16, fg, B);
            if (it.small) cv.text(it.small, ix + 16 + cv.textWidth(it.text, 16, B), iy + h / 2 - 3, 13, fgSub, L);
            cv.text(fit(cv, it.sub, 13, w - 28, L), ix + 16, iy + h / 2 + 15, 13, fgSub, L);
        } else {
            const tw = cv.textWidth(it.text, 16, B) + (it.small ? cv.textWidth(it.small, 13, L) : 0), tx = ix + (w - tw) / 2;
            cv.text(it.text, tx, iy + h / 2 + 6, 16, fg, B);
            if (it.small) cv.text(it.small, tx + cv.textWidth(it.text, 16, B), iy + h / 2 + 6, 13, fgSub, L);
        }
        cv.target(ix, iy, w, h, it.run, it.key, 9);
        ix += w;
    });
    return total;
}
function pillW(cv, text, size) { return cv.textWidth(text, size, B); }
/**
 * A rounded button: 'primary' (white), 'outline', 'danger' (red outline), 'dangerFill' (red), 'muted' (greyed,
 * no tap). icon: 'undo' | 'power' (drawn before the text). Returns its width.
 */
function pill(cv, x, y, w, h, text, kind, run, key, size, icn) {
    size = size || 16;
    const r = h / 2;
    let fg = C.text;
    if (kind === 'primary') { cv.roundRect(x, y, w, h, r, C.text); fg = C.ink; }
    else if (kind === 'dangerFill') { cv.roundRect(x, y, w, h, r, C.redFill); fg = '#ffffff'; }
    else if (kind === 'muted') { cv.roundRect(x, y, w, h, r, C.off); fg = C.dim; }
    else { cv.strokeRoundRect(x, y, w, h, r, 1, kind === 'danger' ? C.redLine : C.border); fg = kind === 'danger' ? C.red : C.text; }
    let tx = x + w / 2;
    if (icn) {
        const tw = cv.textWidth(text, size, B), ix = x + (w - tw - 26) / 2 + 6, iy = y + h / 2;
        if (icn === 'undo') {
            cv.arc(ix, iy, 6, 7.8, 40, 330, fg);
            cv.quad([[ix - 9, iy - 9], [ix - 1, iy - 7], [ix - 6, iy - 2], [ix - 6, iy - 2]], fg);
        } else if (icn === 'power') {
            cv.arc(ix, iy + 1, 6, 7.8, 40, 320, fg);
            cv.line(ix, iy - 8, ix, iy, 1.8, fg);
        }
        tx = ix + 20 + tw / 2;
    }
    cv.text(text, tx, y + h / 2 + size * 0.36, size, fg, { font: 'bold', align: 'center', literal: true });
    if (run) cv.target(x, y, w, h, run, key, r);
    return w;
}
/** A small chip (the HUD cards' drive modes): white when that mode shows this layout. */
function miniChip(cv, x, y, text, on, run, key) {
    const w = cv.textWidth(text, 13, B) + 20, h = 28;
    if (on) cv.roundRect(x, y, w, h, h / 2, C.text);
    else cv.strokeRoundRect(x, y, w, h, h / 2, 1, C.border);
    cv.text(text, x + w / 2, y + 19, 13, on ? C.ink : C.soft, { font: 'bold', align: 'center', literal: true });
    cv.target(x, y, w, h, run, key, h / 2);
    return w;
}
/** a round minus / plus button, s across; greyed (no tap) at the end of the steps */
function stepBtn(cv, x, y, s, sign, live, run, key) {
    cv.strokeRoundRect(x, y, s, s, s / 2, 1, live ? C.border : '#ffffff14');
    const c = live ? C.text : '#ffffff30', m = s / 2, a = s * 0.22;
    cv.fillRect(x + m - a, y + m - 1, 2 * a, 2, c);
    if (sign === '+') cv.fillRect(x + m - 1, y + m - a, 2, 2 * a, c);
    if (live) cv.target(x - 4, y - 4, s + 8, s + 8, run, key, s / 2);
}
/** the picked mark: a white disc with a dark tick */
function checkBadge(cv, x, y) {
    cv.circle(x, y, 11, C.text);
    cv.line(x - 5, y, x - 1.5, y + 3.5, 2.2, C.ink);
    cv.line(x - 1.5, y + 3.5, x + 5, y - 3.5, 2.2, C.ink);
}
function clampStep(s, v) {
    const st = (s && s.steps) || [v];
    return st.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), st[0]);
}
function dashed(cv, x, y, w, h, c) {
    const d = 10, g = 7;
    for (let t = 0; t < w; t += d + g) { const l = Math.min(d, w - t); cv.fillRect(x + t, y, l, 2, c); cv.fillRect(x + t, y + h - 2, l, 2, c); }
    for (let t = 0; t < h; t += d + g) { const l = Math.min(d, h - t); cv.fillRect(x, y + t, 2, l, c); cv.fillRect(x + w - 2, y + t, 2, l, c); }
}
function padBtn(cv, x, y, s, what, run, key) {
    cv.roundRect(x, y, s, s, 14, C.panel);
    cv.strokeRoundRect(x, y, s, s, 14, 1, C.border);
    const cx = x + s / 2, cy = y + s / 2, a = 12, c = C.text;
    if (what === 'up') cv.quad([[cx, cy - a], [cx + a, cy + a * 0.7], [cx, cy + a * 0.7], [cx - a, cy + a * 0.7]], c);
    else if (what === 'down') cv.quad([[cx, cy + a], [cx - a, cy - a * 0.7], [cx, cy - a * 0.7], [cx + a, cy - a * 0.7]], c);
    else if (what === 'left') cv.quad([[cx - a, cy], [cx + a * 0.7, cy - a], [cx + a * 0.7, cy], [cx + a * 0.7, cy + a]], c);
    else if (what === 'right') cv.quad([[cx + a, cy], [cx - a * 0.7, cy + a], [cx - a * 0.7, cy], [cx - a * 0.7, cy - a]], c);
    else cv.text('Centre', cx, cy + 6, 15, C.text, { font: 'bold', align: 'center', literal: true });
    cv.target(x, y, s, s, run, key, 14);
}
function chevron(cv, x, y, c) { cv.line(x - 4, y - 7, x + 3, y, 2.5, c); cv.line(x + 3, y, x - 4, y + 7, 2.5, c); }
function check(cv, x, y, c) { cv.line(x - 9, y, x - 3, y + 6, 3, c); cv.line(x - 3, y + 6, x + 9, y - 7, 3, c); }

module.exports = Page;
