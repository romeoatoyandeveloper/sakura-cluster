'use strict';
/**
 * PSX: PlayStation games on the centre screen, parked only, played with a PS4 or PS5 controller.
 *
 * The emulator itself is psx-core (native/psx-core, a Store tool that runs as root: only root can read a game
 * controller and reach the sound). This app is its screen: the games, a check page (controllers, pairing, sound),
 * and while a game runs, its picture in the middle of the screen, drawn from the frames psx-core leaves in shared
 * memory (/dev/shm/psx-core/frame) as a pixel image (record.js setImage), once per screen refresh.
 *
 *   /dev/shm/psx-core/ctl.sock   commands to psx-core (status, list, load <path>, unload, pause, resume, reset,
 *                                pair, tone) and its JSON lines back (psx_core.c says which)
 *
 * The PS button opens the pause menu; the d-pad and cross / circle work the menus, as do touch and the iDrive
 * controller. When the car moves (setting "parkedOnly", on by default) the game pauses and the menu says why.
 * Plain Node 8 (the car's 8.16.2).
 */
const fs = require('fs');
const net = require('net');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const rec = require('./kit/record');
const parkedWatch = require('./kit/parked');

const W = 1600, H = 520;
const RUN = process.env.PSX_RUN || '/dev/shm/psx-core';
const SOCK = RUN + '/ctl.sock', FRAME = RUN + '/frame';
const HDR = 64, SLOT = 1024 * 512 * 4;
const IMG = 0x50530001;                 // our pixel image id ('PS'), clear of the kit's
const C = {
    bg: '#05070a', text: '#f2f4f8', dim: '#8d97a8', line: '#ffffff14', field: '#ffffff0d', fieldOn: '#ffffff26',
    green: '#4cd08a', amber: '#f2b33d', red: '#ff5a5a', ink: '#05070a', border: '#ffffff40', blue: '#3f7cff',
};
const B = { font: 'bold', literal: true };
const L = { font: 'label', literal: true };
const X0 = 32, CT = 112, TAB_Y = 38, TAB_H = 58;
// joypad bits (psx_core.c: libretro's order, PS = 16)
const PAD = { CROSS: 1 << 0, UP: 1 << 4, DOWN: 1 << 5, LEFT: 1 << 6, RIGHT: 1 << 7, CIRCLE: 1 << 8, PS: 1 << 16 };

class Psx {
    constructor(ctx) {
        this.ctx = ctx; this.log = ctx.log;
        this.parked = parkedWatch.watch(ctx, ctx.log);
        this.tab = 'games';
        this.st = null;                 // psx-core's last status
        this.games = null;              // its last game list
        this.sel = 0;                   // the row the gamepad is on (games list, pause menu)
        this.menu = false;              // the pause menu over a running game
        this.note = null;               // { text, color, until }
        this.pairText = null; this.toneText = null;
        this.sock = null; this.buf = '';
        this.fd = null; this.head = Buffer.alloc(32); this.px = [null, null]; this.pi = 0; this.seq = -1; this.frame = null;
        this.lastPad = 0;
    }

    start() {
        const ctx = this.ctx;
        this.loop = ctx.loop('MAIN', 10, () => this.render());
        ctx.onTap(() => this.kick());
        ctx.ui.onVisible((name, v) => { if (name === 'MAIN' && !v && this.playing()) { this.send('pause'); this.menu = true; } });
        this.connect();
        setInterval(() => this.watchCar(), 500);
    }
    kick() { if (this.loop && this.loop.kick) this.loop.kick(); }
    playing() { return !!(this.st && this.st.running); }
    flash(text, color, ms) { this.note = { text, color: color || C.text, until: Date.now() + (ms || 6000) }; this.kick(); }

    /* ---------- psx-core ---------- */
    connect() {
        const s = net.connect(SOCK);
        s.setEncoding('utf8');
        s.on('connect', () => { this.sock = s; this.buf = ''; this.log.info('psx-core: connected'); this.send('status'); this.send('list'); this.kick(); });
        s.on('data', (d) => {
            this.buf += d;
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
                try { this.onEvent(JSON.parse(line)); } catch (e) { this.log.warn('psx-core: bad line ' + line.slice(0, 80)); }
            }
        });
        const gone = () => {
            if (this.sock === s) { this.sock = null; this.st = null; this.log.info('psx-core: not reachable'); this.kick(); }
            setTimeout(() => this.connect(), 3000);
        };
        s.on('error', () => {});
        s.on('close', gone);
    }
    send(cmd) { if (this.sock) this.sock.write(cmd + '\n'); }

    onEvent(e) {
        if (e.ev === 'status') {
            const was = this.st && this.st.running;
            this.st = e;
            if (!e.running) { this.menu = false; this.frame = null; }
            if (e.running && !was) { this.menu = false; this.sel = 0; }
        } else if (e.ev === 'games') { this.games = e; this.sel = Math.min(this.sel, Math.max(0, e.games.length - 1)); }
        else if (e.ev === 'loaded') { if (!e.ok) this.flash('Couldn\'t start it: ' + e.text, C.red); }
        else if (e.ev === 'pair') { this.pairText = { text: e.text, color: e.busy ? C.amber : e.ok ? C.green : C.red }; }
        else if (e.ev === 'tone') { this.toneText = { text: e.text, color: e.ok ? C.green : C.red }; }
        else if (e.ev === 'message') this.flash(e.text, C.dim, 4000);
        else if (e.ev === 'menu') { if (this.playing()) this.toggleMenu(); }
        else if (e.ev === 'pad') this.onPad(e.b);
        this.kick();
    }

    toggleMenu() {
        if (!this.playing()) return;
        this.menu = !this.menu || this.blocked();
        this.sel = 0;
        this.send(this.menu ? 'pause' : 'resume');
    }
    blocked() { return this.ctx.settings.get('parkedOnly') !== false && this.parked.moving(); }
    watchCar() {
        if (this.playing() && !this.menu && this.blocked()) { this.menu = true; this.send('pause'); this.flash('Paused: the car is moving. PSX plays parked only.', C.amber); }
    }

    /* the gamepad in the menus: up / down move, cross picks, circle goes back */
    onPad(b) {
        const down = b & ~this.lastPad;
        this.lastPad = b;
        if (!down) return;
        const items = this.menuItems();
        if (down & PAD.UP) this.sel = Math.max(0, this.sel - 1);
        if (down & PAD.DOWN) this.sel = Math.min(items.length - 1, this.sel + 1);
        if ((down & (PAD.LEFT | PAD.RIGHT)) && !this.playing()) { this.tab = this.tab === 'games' ? 'check' : 'games'; this.sel = 0; }
        if ((down & PAD.CROSS) && items[this.sel]) items[this.sel].run();
        if ((down & PAD.CIRCLE) && this.menu) this.toggleMenu();
    }
    /** what the gamepad can pick now: the pause menu's buttons, or the games */
    menuItems() {
        if (this.playing() && this.menu) return this.pauseItems();
        if (this.tab === 'games') return ((this.games && this.games.games) || []).map((g) => ({ run: () => this.play(g) }));
        return [{ run: () => this.send('pair') }, { run: () => this.send('tone') }];
    }
    pauseItems() {
        return [
            { text: 'Resume', run: () => { if (this.blocked()) this.flash('Not while the car is moving.', C.amber); else this.toggleMenu(); } },
            { text: 'Restart the game', run: () => { this.send('reset'); if (!this.blocked()) this.toggleMenu(); } },
            { text: 'Quit to the games', run: () => { this.send('unload'); this.menu = false; this.send('list'); } },
        ];
    }
    play(g) {
        if (this.blocked()) { this.flash('PSX plays parked only.', C.amber); return; }
        this.flash('Starting ' + g.name + '...', C.dim, 3000);
        this.send('load ' + g.path);
    }

    /* ---------- the newest frame from shared memory ---------- */
    readFrame() {
        try {
            if (this.fd === null) this.fd = fs.openSync(FRAME, 'r');
            fs.readSync(this.fd, this.head, 0, 32, 0);
            const magic = this.head.readUInt32LE(0), seq = this.head.readUInt32LE(4), slot = this.head.readUInt32LE(8) & 1;
            const w = this.head.readUInt32LE(12), h = this.head.readUInt32LE(16);
            if (magic !== 0x46585350 || !w || !h || w > 1024 || h > 512) return;
            if (seq === this.seq) return;
            this.seq = seq;
            const n = w * h * 4, i = this.pi ^= 1;
            if (!this.px[i] || this.px[i].length !== n) this.px[i] = Buffer.alloc(n);
            fs.readSync(this.fd, this.px[i], 0, n, HDR + slot * SLOT);
            rec.setImage(IMG, w, h, this.px[i]);
            this.frame = { w, h };
        } catch (e) {
            if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (x) { /* gone */ } }
            this.fd = null;
        }
    }

    /* ---------- drawing ---------- */
    render() {
        const cv = this.ctx.canvas(W, H);
        cv.clear(C.bg);
        const play = this.playing();
        if (play) this.readFrame();
        // the game's picture first: the renderer's conversion of pictures stops at the first quad (renderd.js)
        if (play && this.frame) this.gameView(cv);
        G.frame(cv, this.ctx.theme(), [], -1, [
            !this.sock ? { text: 'Core not running', color: C.red } : play ? { text: this.menu ? 'Paused' : 'Playing', color: this.menu ? C.amber : C.green } : null,
        ]);
        if (play) this.gameSide(cv);
        else {
            this.tabBar(cv);
            if (!this.sock) this.noCore(cv);
            else if (this.tab === 'games') this.gamesTab(cv);
            else this.checkTab(cv);
        }
        if (play && this.menu) this.pauseMenu(cv);
        if (this.note && Date.now() < this.note.until) {
            const w = cv.textWidth(this.note.text, 17, L) + 48, x = (W - w) / 2, y = H - 64;
            cv.roundRect(x, y, w, 44, 22, '#1b2230');
            cv.text(this.note.text, W / 2, y + 28, 17, this.note.color, { font: 'label', literal: true, align: 'center' });
        }
        return this.ctx.ui.image('MAIN_GFX', cv);
    }

    tabBar(cv) {
        let x = X0;
        [['games', 'Games'], ['check', 'Controller & sound']].forEach(([id, name]) => {
            const sel = id === this.tab, w = cv.textWidth(name, 18, B);
            cv.text(name, x, TAB_Y + 36, 18, sel ? C.text : C.dim, sel ? B : L);
            if (sel) cv.fillRect(x, TAB_Y + TAB_H - 5, w, 3, C.text);
            cv.target(x - 14, TAB_Y + 2, w + 28, TAB_H - 4, () => { this.tab = id; this.sel = 0; if (id === 'games') this.send('list'); else this.send('status'); this.kick(); }, 'tab:' + id, 8);
            x += w + 40;
        });
        cv.fillRect(X0, TAB_Y + TAB_H, W - 2 * X0, 1, C.line);
    }

    noCore(cv) {
        cv.text('The PSX core isn\'t running', X0, CT + 60, 26, C.text, B);
        [
            'PSX needs its emulator, psx-core: a Store tool next to this app.',
            '1. In the Store, install psx-core.',
            '2. Restart the head unit once: the core starts with it.',
            'This page finds it by itself once it runs.',
        ].forEach((t, i) => cv.text(t, X0, CT + 110 + i * 34, 18, i ? C.text : C.dim, L));
    }

    gamesTab(cv) {
        const list = (this.games && this.games.games) || [];
        if (!list.length) {
            cv.text('No games found', X0, CT + 50, 24, C.text, B);
            [
                'Put your game files (.cue with its .bin, .chd, .pbp, .iso) on a USB stick, in any folder,',
                'or copy them to ' + ((this.games && this.games.dir) || '/var/opt/psx/games') + ' on the head unit.',
                'A copy of your own disc: PSX can\'t download games. The core has a built-in BIOS; your own (scph1001.bin) in /var/opt/psx/bios helps some games.',
            ].forEach((t, i) => cv.text(t, X0, CT + 92 + i * 30, 16, i === 2 ? C.dim : C.text, L));
            pill(cv, X0, CT + 200, 220, 46, 'Look again', 'outline', () => this.send('list'), 'rescan');
            return;
        }
        const rowH = 52, top = CT + 8, maxRows = Math.floor((H - 84 - top) / rowH);
        const first = Math.max(0, Math.min(this.sel - maxRows + 1, list.length - maxRows));
        list.slice(first, first + maxRows).forEach((g, k) => {
            const i = first + k, y = top + k * rowH, on = i === this.sel;
            cv.roundRect(X0, y, W - 2 * X0, rowH - 8, 10, on ? C.fieldOn : C.field);
            cv.text(g.name, X0 + 20, y + 29, 18, C.text, on ? B : L);
            cv.text(g.path.replace(/\/[^/]*$/, ''), X0 + 620, y + 29, 14, C.dim, L);
            cv.text(g.mb ? g.mb + ' MB' : '', W - X0 - 150, y + 29, 14, C.dim, L);
            cv.text('Play', W - X0 - 60, y + 29, 16, C.text, B);
            cv.target(X0, y, W - 2 * X0, rowH - 8, () => { this.sel = i; this.play(g); }, 'game:' + i, 10);
        });
        cv.text('PS button: pause menu while playing. D-pad and cross pick a game; touch and the iDrive controller work too.', X0, H - 18, 14, C.dim, L);
    }

    checkTab(cv) {
        const st = this.st || {}, pads = st.pads || [], snd = st.sound || {}, bt = st.bt || {};
        const colW = (W - 2 * X0 - 48) / 2, xr = X0 + colW + 48;
        let y = CT + 18;
        const head = (t, x, yy) => cv.text(t, x, yy, 15, C.dim, B);
        head('Controllers', X0, y);
        let yl = y + 34;
        if (!pads.length) {
            cv.text('None connected', X0, yl, 18, C.amber, B);
            ['Plug a PS4 or PS5 controller in with its USB cable, or pair it over Bluetooth:',
                'hold PS + Share (PS4) or PS + Create (PS5) until the light flashes, then tap Pair.'].forEach((t, i) => cv.text(t, X0, yl + 30 + i * 24, 15, C.text, L));
            yl += 92;
        } else {
            pads.forEach((p) => { cv.text('Player ' + p.player + ': ' + p.name, X0, yl, 18, C.green, B); cv.text(p.via, X0 + colW - 160, yl, 14, C.dim, L); yl += 32; });
            yl += 6;
        }
        const pairing = bt.pairing || (this.pairText && this.pairText.color === C.amber);
        pill(cv, X0, yl, 240, 46, pairing ? 'Looking... (20 s)' : 'Pair a controller', pairing ? 'muted' : 'primary', () => this.send('pair'), 'pair');
        if (this.sel === 0) cv.strokeRoundRect(X0 - 4, yl - 4, 248, 54, 27, 2, C.blue);
        if (this.pairText) wrap(cv, this.pairText.text, 15, colW).forEach((t, i) => cv.text(t, X0, yl + 76 + i * 22, 15, this.pairText.color, L));
        y = CT + 18;
        head('Sound', xr, y);
        cv.text(snd.player ? 'Through ' + snd.player : (snd.pacat || snd.aplay) ? 'Player found: ' + (snd.pacat ? 'pacat' : 'aplay') : 'No sound player found', xr, y + 34, 18, snd.player || snd.pacat || snd.aplay ? C.text : C.amber, B);
        wrap(cv, snd.state || '', 15, colW).forEach((t, i) => cv.text(t, xr, y + 62 + i * 22, 15, C.dim, L));
        pill(cv, xr, y + 108, 200, 46, 'Test sound', 'outline', () => this.send('tone'), 'tone');
        if (this.sel === 1) cv.strokeRoundRect(xr - 4, y + 104, 208, 54, 27, 2, C.blue);
        if (this.toneText) wrap(cv, this.toneText.text, 15, colW).forEach((t, i) => cv.text(t, xr, y + 180 + i * 22, 15, this.toneText.color, L));
        y = CT + 262;
        head('Bluetooth', xr, y);
        cv.text((bt.adapters || 0) + ' adapter' + (bt.adapters === 1 ? '' : 's') + ', BlueZ ' + (bt.bluez ? 'running' : 'not found') + ', bluetoothctl ' + (bt.bluetoothctl ? 'yes' : 'no'), xr, y + 30, 15, C.text, L);
        cv.text('psx-core ' + (st.version || '?') + (this.parked.speed() !== null ? '   speed ' + Math.round(this.parked.speed()) + ' km/h' : ''), xr, y + 58, 14, C.dim, L);
    }

    gameView(cv) {
        // 4:3 whatever the game's resolution, as big as the page allows
        const h = H - 20, w = Math.round(h * 4 / 3), x = (W - w) / 2, y = 10;
        cv.image(IMG, x, y, w, h);
        this.view = { x, y, w, h };
    }
    gameSide(cv) {
        const v = this.view || { x: 0, w: 0 };
        const name = this.st.game || '', side = v.x - 40;
        if (side < 120) return;
        cv.text(name, 24, 92, 20, C.text, B);
        cv.text((this.st.fps ? this.st.fps.toFixed(0) + ' fps' : '') , 24, 120, 14, C.dim, L);
        const pads = this.st.pads || [];
        (pads.length ? pads.map((p) => 'P' + p.player + ' ' + p.name) : ['No controller']).forEach((t, i) => cv.text(t, 24, 170 + i * 24, 14, pads.length ? C.dim : C.amber, L));
        cv.text('PS button: menu', 24, H - 24, 14, C.dim, L);
        pill(cv, v.x + v.w + 30, 76, 150, 44, 'Menu', 'outline', () => this.toggleMenu(), 'menu');
    }

    pauseMenu(cv) {
        const items = this.pauseItems(), w = 420, h = 90 + items.length * 62, x = (W - w) / 2, y = (H - h) / 2;
        cv.fillRect(0, 0, W, H, '#000000a0');
        cv.roundRect(x, y, w, h, 18, '#141a24');
        cv.text(this.blocked() ? 'Paused: the car is moving' : 'Paused', x + 28, y + 46, 22, this.blocked() ? C.amber : C.text, B);
        items.forEach((it, i) => {
            const yy = y + 72 + i * 62;
            pill(cv, x + 28, yy, w - 56, 48, it.text, i === this.sel ? 'primary' : 'outline', () => { this.sel = i; it.run(); }, 'pause:' + i);
        });
    }
}

/* ---------- small drawing helpers ---------- */
function pill(cv, x, y, w, h, text, kind, run, key) {
    let fg = C.text;
    if (kind === 'primary') { cv.roundRect(x, y, w, h, h / 2, C.text); fg = C.ink; }
    else if (kind === 'muted') { cv.roundRect(x, y, w, h, h / 2, '#ffffff1a'); fg = C.dim; }
    else cv.strokeRoundRect(x, y, w, h, h / 2, 1, C.border);
    cv.text(text, x + w / 2, y + h / 2 + 6, 16, fg, { font: 'bold', literal: true, align: 'center' });
    if (run && kind !== 'muted') cv.target(x, y, w, h, run, key, h / 2);
}
function wrap(cv, text, size, maxW) {
    const out = [];
    let line = '';
    String(text).split(/\s+/).forEach((word) => {
        const t = line ? line + ' ' + word : word;
        if (cv.textWidth(t, size, L) > maxW && line) { out.push(line); line = word; } else line = t;
    });
    if (line) out.push(line);
    return out.slice(0, 4);
}

mgu.run({
    start(ctx) {
        new Psx(ctx).start();
    },
});
