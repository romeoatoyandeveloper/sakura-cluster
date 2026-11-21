'use strict';
/**
 * Cluster Themes: redraws the iDrive 7 instrument cluster (the 1920x720 "panel" target) through cluster-render.
 *
 * The center screen is the app's own page (shared/page.js, a canvas screen): the themes with their
 * pictures, which drive mode shows which, and the settings. Each choice is saved in the app's data/settings.json
 * by the kit; the shared engine (hud.js) listens and redraws at once. It keeps running after the page is
 * closed (OAP apps stay up in the background), so the page is only needed for changes. The kit's own
 * settings list stays one tap away (the bar's All settings).
 */
const mgu = require('./kit/mgu');
const HudApp = require('./hud');
const Page = require('./page');

mgu.run({
    start(ctx) {
        let hud;
        try {
            hud = new HudApp(ctx);
        } catch (e) {
            // nothing drawn, but stay up: an exit here would count as a crash on the car
            ctx.log.error('Cluster failed to start: ' + (e && e.stack || e));
            return;
        }
        hud.start();
        new Page(ctx, hud, {
            title: ctx.spec.title, what: 'cluster',
            look: { name: 'Themes', style: 'hero', tags: { m: 'M8 style', sport: 'Live Cockpit', track: 'race dash · tyres', retro80s: '80s digital', cruise: 'calm · trip', ribbon: 'calm · holidays', nightdrive: 'synthwave', warp: 'warp speed', paper: 'e-ink page', trails: 'night highway', evaurora: 'EV glass', orbital: 'space telemetry', vfd: '80s VFD', family: 'canal at dusk' } },
            tabs: ['look', 'readouts', 'badge', 'map', 'alerts', 'gmeter', 'settings'],
            settings: ['units', 'clock', 'timeZone', 'tankLitres', 'redline', 'shiftBefore', 'coldGuard', 'showBoost', 'nightDim', 'cameraNotch', 'holiday', 'demo'],
            // the drive mode check's candidates this app's app.json listens to (issue #8; shared/hud.js modeDiagLines)
            modeCheck: ['HMI', 'MDrive', 'Engine', 'Sport2'],
        }).start();
        process.on('exit', () => { try { hud.stop(); } catch (e) { /* exiting anyway */ } });
    },
});
