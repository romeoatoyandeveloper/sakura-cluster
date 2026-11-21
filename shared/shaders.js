'use strict';
/**
 * The HUD's GLSL ES 1.00 fragment shaders for cluster-render "effect" layers, drawn on the
 * car's GPU. Kept as JS strings because the kit's build ships an app's top-level .js files
 * as they are (a data folder becomes a JSON-only pack). hud.js sends the uniforms.
 */
const SHIFTBAR = `// Segmented shift bar for a cluster-render "effect" layer (GLSL ES 1.00).
// v_uv is 0..1 across the layer, (0,0) at the top-left as on the car. Uniforms come from hud.js:
//   u_value   0..1, how much of the bar is lit (rpm / bar max)
//   u_size    layer size in px (w, h), for round corners and gaps in pixels
//   u_segs    segment count
//   u_low, u_mid, u_high   zone colours (rgb 0..1)
//   u_midAt, u_highAt      where the mid and high zones start (0..1 of the bar)
//   u_track   unlit segment colour (rgba, straight alpha)
//   u_flash   1 = at the redline: every lit segment shows the high colour
//   u_skip    driver camera wings: px from the layer's left (from, to) left empty; then u_segs segments on each
//             side, mirrored, filling from the outer ends in towards the gap. to <= from: one bar as usual
// Output is straight alpha. Whether cluster-render blends effect layers as
// straight or premultiplied alpha is not confirmed yet: check the edges on the car.
precision mediump float;
varying vec2 v_uv;
uniform float u_value;
uniform vec2 u_size;
uniform float u_segs;
uniform vec3 u_low;
uniform vec3 u_mid;
uniform vec3 u_high;
uniform float u_midAt;
uniform float u_highAt;
uniform vec4 u_track;
uniform float u_flash;
uniform vec2 u_skip;

void main() {
    float gapPx = 3.0;
    float px = v_uv.x * u_size.x;
    float slot = u_size.x / u_segs;                 // px per segment incl. gap
    float local = px;                               // px from where the fill starts
    if (u_skip.y > u_skip.x) {                      // wings: left from its left end, right mirrored from its right end
        if (px >= u_skip.x && px < u_skip.y) { gl_FragColor = vec4(0.0); return; }
        if (px < u_skip.x) slot = u_skip.x / u_segs;
        else { slot = (u_size.x - u_skip.y) / u_segs; local = u_size.x - px; }
    }
    float idx = floor(local / slot);
    float inSeg = local - idx * slot;               // px into this slot
    float segW = slot - gapPx;
    float py = v_uv.y * u_size.y;           // px from the top

    // rounded-rect coverage for this segment, radius 2px, 1px soft edge
    vec2 hs = vec2(segW, u_size.y) * 0.5;
    vec2 p = vec2(inSeg, py) - hs;
    vec2 q = abs(p) - (hs - vec2(2.0));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 2.0;
    float cover = clamp(0.5 - d, 0.0, 1.0);
    if (inSeg > segW) cover = 0.0;
    if (cover <= 0.0) { gl_FragColor = vec4(0.0); return; }

    float pos = (idx + 0.5) / u_segs;               // segment centre, 0..1
    bool lit = pos <= u_value;
    vec3 c = pos >= u_highAt ? u_high : (pos >= u_midAt ? u_mid : u_low);
    if (u_flash > 0.5) c = u_high;
    gl_FragColor = lit ? vec4(c, cover) : vec4(u_track.rgb, u_track.a * cover);
}
`;

const ARC = `// Thin open arc gauge for a cluster-render "effect" layer (GLSL ES 1.00).
// u_start / u_sweep (radians, clockwise from 12 o'clock; a negative sweep runs anticlockwise), round
// ends, filled from the start. hud.js default: 270 degrees from the lower left, the gap at the bottom.
// Uniforms from hud.js:
//   u_value  0..1 of the sweep
//   u_size   layer size in px (w, h)
//   u_color  lit arc (rgb 0..1)
//   u_track  unlit arc (rgba, straight alpha)
//   u_width  stroke width in px
// Output is straight alpha (same open question as the shift bar shader above).
precision mediump float;
varying vec2 v_uv;
uniform float u_value;
uniform vec2 u_size;
uniform vec3 u_color;
uniform vec4 u_track;
uniform float u_width;
uniform float u_start;
uniform float u_sweep;
uniform float u_peak;    // peak hold 0..1 of the sweep, a bright dot on the stroke (below 0: none)
uniform vec3 u_peakC;

const float PI = 3.14159265359;

// distance from point p (centred, px) to the arc from angle a0 sweeping s, radius r
float arcDist(vec2 p, float r, float a0, float s) {
    float a = atan(p.x, p.y);           // clockwise from 12 o'clock, -PI..PI
    float rel = mod(a - a0 + 4.0 * PI, 2.0 * PI);
    if (rel <= s) return abs(length(p) - r);
    vec2 e0 = r * vec2(sin(a0), cos(a0));
    vec2 e1 = r * vec2(sin(a0 + s), cos(a0 + s));
    return min(length(p - e0), length(p - e1));   // round end caps
}

void main() {
    vec2 p = vec2(v_uv.x - 0.5, 0.5 - v_uv.y) * u_size;   // px from centre, +y up (v_uv is top-left)
    float start = u_start, sweep = u_sweep;
    if (sweep < 0.0) { p.x = -p.x; start = -start; sweep = -sweep; }   // anticlockwise = mirrored clockwise
    float r = min(u_size.x, u_size.y) * 0.5 - u_width * 0.5 - 1.0;
    float hw = u_width * 0.5;
    float dTrack = arcDist(p, r, start, sweep) - hw;
    float lit = clamp(u_value, 0.0, 1.0) * sweep;
    float dLit = lit > 0.001 ? arcDist(p, r, start, lit) - hw : 1e5;
    float cLit = clamp(0.5 - dLit, 0.0, 1.0);
    float cTrack = clamp(0.5 - dTrack, 0.0, 1.0);
    if (u_peak >= 0.0) {
        float pa = start + clamp(u_peak, 0.0, 1.0) * sweep;
        float dp = length(p - r * vec2(sin(pa), cos(pa))) - hw * 1.35;
        float cp = clamp(0.5 - dp, 0.0, 1.0);
        if (cp > 0.0) { gl_FragColor = vec4(u_peakC, cp); return; }
    }
    if (cLit > 0.0) gl_FragColor = vec4(u_color, cLit);
    else gl_FragColor = vec4(u_track.rgb, u_track.a * cTrack);
}
`;

const REVBAR = `// G20 Live Cockpit style rev bar for a cluster-render "effect" layer (GLSL ES 1.00), after
// cauliflowermossgrape's Redline app (MIT). From the top of the layer: u_top px for the shift-point and
// redline marks, then the bar (u_barH px, slanted: its top edge is u_slant px right of its bottom
// edge), then the scale ticks. The bar fills left to right in 500 rpm segments; each lit segment
// takes the ramp colour of its position up to the shift point (u_from -> u_to), all u_hot from the
// shift point on. Unlit: u_track, and u_hot faint past the redline. A white needle leads the fill;
// a thin slanted line holds the peak. Uniforms (rpm values are rpm, not 0..1):
//   u_size, u_top, u_barH, u_slant   px
//   u_max, u_value, u_shift, u_red, u_peak   rpm
//   u_from, u_to, u_hot   rgb 0..1;  u_track, u_tick, u_fg   rgba (straight alpha)
//   u_shiftNow   1 = at or past the shift point
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_top;
uniform float u_barH;
uniform float u_slant;
uniform float u_max;
uniform float u_value;
uniform float u_shift;
uniform float u_red;
uniform float u_peak;
uniform vec3 u_from;
uniform vec3 u_to;
uniform vec3 u_hot;
uniform vec4 u_track;
uniform vec4 u_tick;
uniform vec4 u_fg;
uniform float u_shiftNow;

vec4 over(vec4 top, vec4 under) {           // straight-alpha "top over under"
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}

void main() {
    float px = v_uv.x * u_size.x;
    float py = v_uv.y * u_size.y;   // px from the top
    float bw = u_size.x - u_slant;            // bar length along the bottom edge
    float perRpm = bw / u_max;
    vec4 c = vec4(0.0);

    // marks above the bar: shift point (amber) and redline (red), at the bar's top edge
    if (py < u_top - 2.0) {
        float ds = abs(px - (u_shift * perRpm + u_slant));
        float dr = abs(px - (u_red * perRpm + u_slant));
        if (ds < 2.0) c = vec4(1.0, 0.76, 0.1, clamp(2.0 - ds, 0.0, 1.0));
        if (dr < 2.0) c = vec4(u_hot, clamp(2.0 - dr, 0.0, 1.0));
        gl_FragColor = c; return;
    }

    float by = py - u_top;                    // px down from the bar's top edge
    if (by <= u_barH) {
        float off = u_slant * (u_barH - by) / u_barH;
        float s = px - off;                   // px along the bar at this height
        float rpm = s / perRpm;
        float inside = clamp(s + 0.5, 0.0, 1.0) * clamp(bw - s + 0.5, 0.0, 1.0)
            * clamp(by + 0.5, 0.0, 1.0) * clamp(u_barH - by + 0.5, 0.0, 1.0);
        // slanted 3 px gap every 500 rpm
        float seg = floor(rpm / 500.0);
        float dGap = abs(s - floor(rpm / 500.0 + 0.5) * 500.0 * perRpm);
        float gap = rpm > 250.0 && rpm < u_max - 250.0 ? clamp(dGap - 1.0, 0.0, 1.0) : 1.0;
        vec4 bar;
        if (rpm <= u_value) {
            float f = clamp((seg * 500.0 + 250.0) / u_shift, 0.0, 1.0);
            vec3 col = u_shiftNow > 0.5 ? u_hot : mix(u_from, u_to, f);
            bar = vec4(col, 1.0);
        } else if (rpm >= u_red) bar = vec4(u_hot, 0.3);
        else bar = u_track;
        c = vec4(bar.rgb, bar.a * inside * gap);
        // peak: a thin slanted line where the rpm last peaked (only above the current rpm)
        if (u_peak > u_value + 60.0) {
            float dp = abs(s - u_peak * perRpm);
            vec3 pc = u_peak >= u_shift ? u_hot : mix(u_from, u_to, clamp(u_peak / u_shift, 0.0, 1.0));
            c = over(vec4(pc, clamp(1.5 - dp, 0.0, 1.0) * inside), c);
        }
        // needle: the bright leading edge of the fill
        if (u_value > 50.0) {
            float dn = abs(s - min(u_value, u_max) * perRpm);
            c = over(vec4(1.0, 1.0, 1.0, clamp(2.5 - dn, 0.0, 1.0) * clamp(by + 2.5, 0.0, 1.0) * clamp(u_barH - by + 2.5, 0.0, 1.0)), c);
        }
        gl_FragColor = c; return;
    }

    // scale ticks under the bar: every 500 rpm, longer every 1000, red from the redline
    float ty = by - u_barH - 4.0;
    if (ty >= 0.0) {
        float rpm = px / perRpm;
        float k = floor(rpm / 500.0 + 0.5);
        float d = abs(px - k * 500.0 * perRpm);
        bool major = mod(k, 2.0) < 0.5;
        float len = major ? 10.0 : 5.0;
        float hw = major ? 1.25 : 0.75;
        float a = clamp(hw + 0.5 - d, 0.0, 1.0) * (ty <= len ? 1.0 : 0.0);
        vec4 tc = k * 500.0 >= u_red ? vec4(u_hot, 1.0) : (major ? u_fg : u_tick);
        c = vec4(tc.rgb, tc.a * a);
    }
    gl_FragColor = c;
}
`;

const LIGHTS = `// Shift lights for a cluster-render "effect" layer (GLSL ES 1.00), after cauliflowermossgrape's Redline
// app (MIT): u_n rounded lights in a row, green -> yellow -> red from left to right. u_lit of them are
// on (they fill from a start rpm up to the shift point); u_strobe 1 = at the shift point: all red.
// The last u_tail lights are blue instead (the GT3 dash look; 0 = none). u_round 1 = round lights; 2 = a string of
// holiday bulbs: round, coloured red, green, yellow (gold), blue in turn by their own uniforms (hud_holiday.js).
//   u_size px, u_n count, u_lit count (0..u_n), u_tail count, u_strobe 0/1, u_green/u_yellow/u_red/u_blue rgb,
//   u_off (alpha when off), u_skip driver camera wings: px from the layer's left (from, to) left empty, then u_n
//   lights on each side, mirrored, filling from the outer ends in towards the gap (to <= from: one row as usual)
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_n;
uniform float u_lit;
uniform float u_tail;
uniform float u_round;
uniform float u_strobe;
uniform vec3 u_green;
uniform vec3 u_yellow;
uniform vec3 u_red;
uniform vec3 u_blue;
uniform float u_off;
uniform vec2 u_skip;

void main() {
    float gapPx = 6.0;
    float slot = (u_size.x + gapPx) / u_n;
    float px = v_uv.x * u_size.x;
    float py = v_uv.y * u_size.y;
    float local = px;                               // px from where the fill starts
    if (u_skip.y > u_skip.x) {                      // wings: left from its left end, right mirrored from its right end
        if (px >= u_skip.x && px < u_skip.y) { gl_FragColor = vec4(0.0); return; }
        if (px < u_skip.x) slot = (u_skip.x + gapPx) / u_n;
        else { slot = (u_size.x - u_skip.y + gapPx) / u_n; local = u_size.x - px; }
    }
    float idx = floor(local / slot);
    float inSeg = local - idx * slot;
    float segW = slot - gapPx;
    if (inSeg > segW || idx >= u_n) { gl_FragColor = vec4(0.0); return; }
    vec2 hs = vec2(segW, u_size.y) * 0.5;
    vec2 p = vec2(inSeg, py) - hs;
    float r = u_round > 0.5 ? min(hs.x, hs.y) : min(4.0, hs.y);
    if (u_round > 0.5) hs = vec2(r);
    p = vec2(inSeg, py) - vec2(segW, u_size.y) * 0.5;
    vec2 q = abs(p) - (hs - vec2(r));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    float cover = clamp(0.5 - d, 0.0, 1.0);
    float nMain = max(1.0, u_n - u_tail);
    float f = idx / max(1.0, nMain - 1.0);
    vec3 col = idx >= nMain ? u_blue : (f < 0.42 ? u_green : (f < 0.75 ? u_yellow : u_red));
    if (u_round > 1.5) {
        float b = mod(idx, 4.0);
        col = b < 0.5 ? u_red : (b < 1.5 ? u_green : (b < 2.5 ? u_yellow : u_blue));
    }
    bool on = idx < u_lit;
    if (u_strobe > 0.5) { col = u_red; on = true; }
    gl_FragColor = vec4(col, cover * (on ? 1.0 : u_off));
}
`;

const FILL = `// Solid fill for a cluster-render "effect" layer (GLSL ES 1.00): u_color everywhere, except a
// see-through rounded hole u_hole (x, y, w, h px from the layer's top left; w = 0: no hole), radius u_holeR.
// On the cluster, an opaque fill hides BMW's own gauges under it; the hole lets the map window show.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_color;
uniform vec4 u_hole;
uniform float u_holeR;

void main() {
    vec2 p = vec2(v_uv.x * u_size.x, v_uv.y * u_size.y);
    float a = u_color.a;
    if (u_hole.z > 0.0) {
        vec2 hs = u_hole.zw * 0.5;
        vec2 q = abs(p - (u_hole.xy + hs)) - (hs - vec2(u_holeR));
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_holeR;
        a *= clamp(d + 0.5, 0.0, 1.0);
    }
    gl_FragColor = vec4(u_color.rgb, a);
}
`;

const BOX = `// Framed box for a cluster-render "effect" layer (GLSL ES 1.00), the race-dash readout box: a rounded
// frame u_border px wide in u_line, filled u_fill, with a header strip u_headH px tall in u_head across the
// top (0 = none). Colours rgba, straight alpha. u_size, u_border, u_headH, u_radius in px.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_fill;
uniform vec4 u_line;
uniform vec4 u_head;
uniform float u_headH;
uniform float u_border;
uniform float u_radius;

void main() {
    vec2 p = vec2(v_uv.x * u_size.x, v_uv.y * u_size.y);
    vec2 hs = u_size * 0.5;
    vec2 q = abs(p - hs) - (hs - vec2(u_radius));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;   // < 0 inside
    float outer = clamp(0.5 - d, 0.0, 1.0);
    if (outer <= 0.0) { gl_FragColor = vec4(0.0); return; }
    vec4 c = p.y < u_headH ? u_head : u_fill;
    float edge = clamp(d + u_border + 0.5, 0.0, 1.0);                       // 1 within the frame
    vec4 col = mix(c, u_line, edge);
    gl_FragColor = vec4(col.rgb, col.a * outer);
}
`;

const BOXES = `// The GT3 race dash's frame in one cluster-render "effect" layer (GLSL ES 1.00): the background u_bg over the
// whole layer, a see-through rounded hole for BMW's map (u_hole x, y, w, h in layer px, already inset; w 0 = none;
// corner radius u_holeR) and up to 12 framed readout boxes from the layout: each a rounded frame in u_line, filled
// u_fill, with a header strip across its top in u_head (or u_accent). Array uniforms (sent with type vec4):
//   u_box[i]       x, y, w, h in layer px
//   u_boxStyle[i]  header height px, border px, corner radius px, header kind (0 u_head, 1 u_accent)
//   u_n            boxes in use (the rest are skipped). Boxes must not overlap each other or the hole.
// Colours rgba, straight alpha. The loop bound is constant and the arrays are indexed by the loop counter only,
// as GLSL ES 1.00 requires.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_bg;
uniform vec4 u_hole;
uniform float u_holeR;
uniform float u_n;
uniform vec4 u_box[12];
uniform vec4 u_boxStyle[12];
uniform vec4 u_fill;
uniform vec4 u_line;
uniform vec4 u_head;
uniform vec4 u_accent;

// signed distance to the rounded rect r (x, y, w, h), radius rad; < 0 inside
float sdBox(vec2 p, vec4 r, float rad) {
    vec2 hs = r.zw * 0.5;
    vec2 q = abs(p - (r.xy + hs)) - (hs - vec2(rad));
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
vec4 over(vec4 top, vec4 under) {           // straight-alpha "top over under"
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}

void main() {
    vec2 p = v_uv * u_size;
    vec4 c = u_bg;
    if (u_hole.z > 0.0) c.a *= clamp(sdBox(p, u_hole, u_holeR) + 0.5, 0.0, 1.0);
    for (int i = 0; i < 12; i++) {
        if (float(i) >= u_n) break;
        vec4 b = u_box[i];
        vec4 s = u_boxStyle[i];
        if (p.x < b.x - 1.0 || p.x > b.x + b.z + 1.0 || p.y < b.y - 1.0 || p.y > b.y + b.w + 1.0) continue;
        float d = sdBox(p, b, s.z);
        float outer = clamp(0.5 - d, 0.0, 1.0);
        if (outer <= 0.0) continue;
        vec4 inner = p.y < b.y + s.x ? (s.w > 0.5 ? u_accent : u_head) : u_fill;
        float edge = clamp(d + s.y + 0.5, 0.0, 1.0);               // 1 within the frame
        vec4 col = mix(inner, u_line, edge);
        c = over(vec4(col.rgb, col.a * outer), c);
    }
    gl_FragColor = c;
}
`;

const GRID = `// Calibration grid for a cluster-render "effect" layer (GLSL ES 1.00): a line every u_step px, a brighter
// one every u_major steps, a frame round the edge. v_uv (0,0) is the top-left.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_step;
uniform float u_major;
uniform vec4 u_minor;
uniform vec4 u_majorC;

void main() {
    vec2 p = v_uv * u_size;
    vec2 m = mod(p, u_step);
    vec2 big = mod(p, u_step * u_major);
    bool edge = p.x < 2.0 || p.y < 2.0 || p.x > u_size.x - 2.0 || p.y > u_size.y - 2.0;
    if (edge || big.x < 2.0 || big.y < 2.0) gl_FragColor = u_majorC;
    else if (m.x < 1.0 || m.y < 1.0) gl_FragColor = u_minor;
    else gl_FragColor = vec4(0.0);
}
`;

const SEGBAR = `// Segmented level bar for a cluster-render "effect" layer (GLSL ES 1.00): u_segs segments, the first
// u_lit of them lit (brightening left to right), each slanted u_slant px. v_uv (0,0) is the top-left.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_segs;
uniform float u_lit;
uniform vec4 u_on;
uniform vec4 u_offC;
uniform float u_slant;

void main() {
    vec2 p = v_uv * u_size;
    float x = p.x - u_slant * (1.0 - v_uv.y);
    float gap = 8.0;
    float slot = (u_size.x - u_slant + gap) / u_segs;
    float i = floor(x / slot);
    float fx = x - i * slot;
    float a = clamp(fx + 0.5, 0.0, 1.0) * clamp(slot - gap - fx + 0.5, 0.0, 1.0);
    if (i < 0.0 || i >= u_segs || a <= 0.0) { gl_FragColor = vec4(0.0); return; }
    vec4 col = i < u_lit ? vec4(u_on.rgb * mix(0.72, 1.0, fx / (slot - gap)), u_on.a) : u_offC;
    gl_FragColor = vec4(col.rgb, col.a * a);
}
`;

const MDASH = `// The M theme's whole backdrop in one cluster-render "effect" layer (GLSL ES 1.00), traced off a photo of a current
// M8's cluster (design/photos/ref-m8-cluster.png, warped to 1920x720): black, with a near-black card either side whose
// inner edge follows the rev blade, whose top edge is the photo's curve and whose bottom outer corner is a big round;
// the centre line with its bright end caps, the tyre block's car glyph and dividers (the eight values are text widgets),
// the two side dials over the cards (the photo's thin glass bracket, hatched bezel, red level line), the tricolour mark
// and the four setup level bars (slanted segments, the one at the level red, the rest grey, as the M8 draws them).
// Positions in target px from the layout (hud.js). v_uv (0,0) is the top-left.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_card;      // left card: outer edge x, bottom y, bottom-outer corner radius, top-outer corner rounding (the right card is its mirror)
uniform vec3 u_cardCutR;  // the right card's lower outer corner, cut back on a circle (mirrored frame: cx, cy, r; r 0 = none): the M8's
                          // right card is cut further than its left one, so the oil dial's numbers sit on black
uniform vec3 u_cardTop;   // the left card's top edge, y = a x^2 + b x + c (traced off the M8 photo)
uniform float u_cardFill; // the card's grey level 0..1 (0 = black, outline only)
uniform vec4 u_blade;     // the left rev blade's outer edge: x at the bend, y of the bend, x per y px above / below it
uniform vec2 u_bladeB;    // the bend's roundness px, the card's gap from the blade px
uniform vec4 u_line;      // centre line x0, y, x1, cap length
uniform vec3 u_tyre;      // the tyre block's car glyph: centre x, y, scale (0 = none)
uniform vec4 u_gaugeL;    // left gauge centre x, y, radius, value 0..1
uniform vec4 u_gaugeR;    // right gauge
uniform vec3 u_mark;      // tricolour mark x, y, scale (0 = none)
uniform vec3 u_red;
uniform vec4 u_seg0;      // setup level bars x, y, w, h (a height of 0: none)
uniform vec4 u_seg1;
uniform vec4 u_seg2;
uniform vec4 u_seg3;
uniform vec4 u_segLit;    // the level per bar (1-based; 0 = none lit)
uniform vec4 u_segMax;    // segments per bar
uniform float u_segSlant; // px each segment leans
uniform vec4 u_hole;      // the map window x, y, w, h px, already inset (w 0 = none): cut see-through over the map
uniform float u_holeR;    // its corner radius px

const float PI = 3.14159265;

float cov(float d) { return clamp(0.5 - d, 0.0, 1.0); }
vec4 over(vec4 top, vec4 under) {
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}
float segD(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }

float sdRoundBox(vec2 p, vec4 r, float rad) {
    vec2 c = r.xy + r.zw * 0.5;
    vec2 q = abs(p - c) - r.zw * 0.5 + rad;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
float angOf(vec2 d) { float a = atan(d.x, -d.y); return a < 0.0 ? a + 2.0 * PI : a; }
// the left blade's outer edge x at y (mtach's curve)
float bladeX(float y) {
    float dy = y - u_blade.y;
    float k = dy < 0.0 ? u_blade.z : u_blade.w;
    return u_blade.x + k * (sqrt(dy * dy + u_bladeB.x * u_bladeB.x) - u_bladeB.x);
}
// smooth intersection of two signed distances (rounds the corner where they meet)
float smax(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0); return mix(b, a, h) + k * h * (1.0 - h); }
// the left card as the M8 draws it: a wedge whose top edge is the traced curve, outer edge at u_card.x, bottom at
// u_card.y, inner side along the blade; the bottom-outer corner is a big round (the fuel dial sits over it); < 0 inside
float cardD(vec2 p, float right) {
    float fx = u_cardTop.x * p.x * p.x + u_cardTop.y * p.x + u_cardTop.z;
    float slope = 2.0 * u_cardTop.x * p.x + u_cardTop.y;
    float dTop = (fx - p.y) / sqrt(1.0 + slope * slope);
    float dLeft = u_card.x - p.x;
    float dBot = p.y - u_card.y;
    float d = smax(dTop, dLeft, u_card.w);
    d = max(d, dBot);
    vec2 cc = vec2(u_card.x + u_card.z, u_card.y - u_card.z);
    if (p.x < cc.x && p.y > cc.y) d = max(d, length(p - cc) - u_card.z);
    d = max(d, p.x - (bladeX(p.y) - u_bladeB.y));
    if (right > 0.5 && u_cardCutR.z > 0.0) d = max(d, length(p - u_cardCutR.xy) - u_cardCutR.z);
    return d;
}
// the card: near-black (the panel brightens every dark tint, so the fill stays tiny), a shade lighter and bluer at
// the top, with a faint lighter rim
vec4 card(vec2 p, vec2 dial, float right, vec4 c) {
    float d = cardD(p, right);
    if (d > 2.0) return c;
    float top = u_cardTop.z - u_cardTop.y * u_cardTop.y / (4.0 * u_cardTop.x);   // the curve's lowest y (its vertex)
    float fy = clamp((p.y - top) / max(u_card.y - top, 1.0), 0.0, 1.0);
    float grey = u_cardFill * mix(1.3, 0.75, fy);
    c = over(vec4(vec3(grey, grey, grey * 1.18), cov(d)), c);
    // the rim stops inside the dial's area (as on the M8, where the dial covers the card's edge), so no label sits on it;
    // 118..130 px at the photo's dial size (r 120), scaled with the layout's
    float kd = u_gaugeL.z / 120.0;
    float hide = 1.0 - smoothstep(118.0 * kd, 130.0 * kd, length(p - dial));
    c = over(vec4(0.5, 0.53, 0.58, 0.3 * cov(abs(d + 1.2) - 0.9) * (1.0 - hide)), c);
    return c;
}
// the tyre block: the car seen from above (outline body, four wheels) between the four readouts,
// a divider under each front pair, a tick above and below the car
vec4 tyreBlock(vec2 p, vec4 c) {
    if (u_tyre.z <= 0.0) return c;
    vec2 q = (p - u_tyre.xy) / u_tyre.z;
    if (abs(q.x) > 80.0 || abs(q.y) > 70.0) return c;
    float body = abs(sdRoundBox(q, vec4(-11.0, -20.0, 22.0, 40.0), 7.0)) - 1.1;
    vec2 a = vec2(abs(q.x) - 13.5, abs(q.y) - 11.0);
    float wheel = max(abs(a.x) - 2.2, abs(a.y) - 4.5);
    float hl = min(segD(q, vec2(-68.0, 0.0), vec2(-28.0, 0.0)), segD(q, vec2(28.0, 0.0), vec2(68.0, 0.0))) - 0.9;
    float vt = min(segD(q, vec2(0.0, -62.0), vec2(0.0, -42.0)), segD(q, vec2(0.0, 42.0), vec2(0.0, 62.0))) - 0.9;
    c = over(vec4(0.72, 0.76, 0.82, cov(min(body, min(hl, vt)) * u_tyre.z)), c);
    c = over(vec4(0.36, 0.78, 0.42, cov(wheel * u_tyre.z)), c);
    return c;
}
// a setup level bar: s.y segments slanted, number lit (1-based) red, the rest grey
vec4 segbar(vec2 p, vec4 b, vec2 s, vec4 c) {
    if (b.w <= 0.0 || p.y < b.y - 1.0 || p.y > b.y + b.w + 1.0 || p.x < b.x - 1.0 || p.x > b.x + b.z + 1.0) return c;
    float fy = (p.y - b.y) / b.w;
    float x = p.x - b.x - u_segSlant * (1.0 - fy);
    float gap = 10.0;
    float slot = (b.z - u_segSlant + gap) / s.y;
    float i = floor(x / slot);
    float fx = x - i * slot;
    float a = clamp(fx + 0.5, 0.0, 1.0) * clamp(slot - gap - fx + 0.5, 0.0, 1.0) * clamp(p.y - b.y + 0.5, 0.0, 1.0) * clamp(b.y + b.w - p.y + 0.5, 0.0, 1.0);
    if (i < 0.0 || i >= s.y || a <= 0.0) return c;
    bool on = abs(i + 1.0 - s.x) < 0.5;
    vec3 col = on ? u_red * mix(0.85, 1.0, fx / (slot - gap)) : vec3(0.5, 0.53, 0.58);
    return over(vec4(col, (on ? 1.0 : 0.8) * a), c);
}

// a side dial as the M8 draws it, traced off the photo: not a round gauge but a tall thin bracket cut from big
// circles. The glass lies inside a circle of radius 120 round the anchor g.xy and outside one of radius 180 round
// (57, -68), so it is ~6 px wide at the top and widens to ~12 at the bottom end; a hatched chrome bezel (an arc between
// radii 113 and 124 round (-13, 11)) runs down its outer side. The level reads by height: the glass is lit from the
// bottom up to the level, a faint glass with a thin outline above it, and a crisp red line across the glass marks the
// level (Nov 14 2026 clean-up after car close-ups: the glowing streaks stuck out past the glass, the unlit glass was a
// sliver, the glass and the bezel ended on different cuts). Both end on the same lines: y -10 at the top, a ray from
// the bezel's centre at the bottom (fuel 75 degrees, through the glass's old end at x 14; oil 100, shorter), corners
// rounded 2 px. Units are the photo's px with g.z = 120 there. Drawn in the left frame; the right dial comes through
// the mirror.
float rIn(float a, float b, float r) {          // two "inside" distances (positive inside) intersected, corner rounded r
    return -(min(-r, max(-a, -b)) + length(max(vec2(r - a, r - b), 0.0)));
}
vec4 gauge(vec2 p, vec4 g, float zones, vec4 c) {
    float k = g.z / 120.0;
    vec2 q = (p - g.xy) / k;
    if (q.x < -140.0 || q.x > 70.0 || q.y < -22.0 || q.y > 140.0) return c;
    float v = clamp(g.w, 0.0, 1.0);
    // the shared end cuts: the top at y -10, the bottom along a ray from the bezel's centre
    vec2 qb = q - vec2(-13.0, 11.0);
    float ae = radians(zones > 0.5 ? 100.0 : 75.0);
    float ends = min(q.y + 10.0, dot(qb, vec2(-sin(ae), cos(ae))));            // positive on the dial's side of both cuts
    // the bezel: double-edged and hatched
    float rb = length(qb);
    float bez = rIn(min(rb - 112.5, 124.0 - rb), ends, 2.0);
    if (bez > -1.5) {
        float ab = atan(qb.y, qb.x);
        float hatch = step(0.5, fract(ab * 30.0));
        float edge = cov(abs(bez) * k - 0.8);
        c = over(vec4(0.8, 0.82, 0.88, min(1.0, cov(-bez * k) * (0.4 + 0.35 * hatch) + 0.7 * edge)), c);
    }
    // the glass
    float dOut = 120.0 - length(q);
    float dIn = length(q - vec2(57.0, -68.0)) - 180.0;
    float inside = rIn(min(dOut, dIn), ends, 2.0);
    if (inside > -1.5) {
        float f = clamp(dOut / max(dOut + max(dIn, 0.0), 1.0), 0.0, 1.0);        // 0 at the outer edge, 1 at the inner
        float yv = zones > 0.5 ? mix(97.0, 7.0, v) : mix(100.0, 2.0, v);
        float lit = clamp((q.y - yv) * k + 0.5, 0.0, 1.0);                        // below the level line
        vec4 dark = vec4(0.55, 0.57, 0.63, 0.16);
        vec4 bright = vec4(mix(vec3(0.96, 0.97, 0.99), vec3(0.55, 0.57, 0.63), f), mix(1.0, 0.55, f));
        vec4 glass = mix(dark, bright, lit);
        float a = cov(-inside * k);
        c = over(vec4(glass.rgb, glass.a * a), c);
        c = over(vec4(0.85, 0.87, 0.92, 0.45 * cov(abs(inside * k) - 0.6) * (1.0 - lit)), c);   // the unlit glass's outline
        c = over(vec4(u_red, a * cov(abs(q.y - yv) * k - 1.2)), c);                              // the level, inside the glass only
    }
    return c;
}

void main() {
    vec2 p = v_uv * u_size;
    vec2 pm = vec2(u_size.x - p.x, p.y);        // the right half, mirrored into the left frame
    vec4 c = vec4(0.0, 0.0, 0.0, 1.0);           // black, as the M8

    // the two cards: the left one as laid out, the right one its mirror
    c = card(p, u_gaugeL.xy, 0.0, c);
    c = card(pm, vec2(u_size.x - u_gaugeR.x, u_gaugeR.y), 1.0, c);

    // centre line, bright caps at both ends
    if (abs(p.y - u_line.y) < 6.0) {
        c = over(vec4(0.62, 0.66, 0.73, 0.8 * cov(segD(p, u_line.xy, u_line.zy) - 1.6)), c);
        float l = segD(p, u_line.xy + vec2(6.0, 0.0), u_line.xy + vec2(u_line.w, 0.0)) - 2.0 - 1.2 * clamp((p.x - u_line.x) / u_line.w, 0.0, 1.0);
        float r = segD(p, u_line.zy - vec2(u_line.w, 0.0), u_line.zy - vec2(6.0, 0.0)) - 2.0 - 1.2 * clamp((u_line.z - p.x) / u_line.w, 0.0, 1.0);
        c = over(vec4(0.95, 0.96, 0.98, cov(min(l, r))), c);
    }

    c = tyreBlock(p, c);

    // the side dials, traced off the M8 photo: the glass crescent, the fuel one as laid out, the oil one its mirror
    c = gauge(p, u_gaugeL, 0.0, c);
    c = gauge(pm, vec4(u_size.x - u_gaugeR.x, u_gaugeR.yzw), 1.0, c);

    c = segbar(p, u_seg0, vec2(u_segLit.x, u_segMax.x), c);
    c = segbar(p, u_seg1, vec2(u_segLit.y, u_segMax.y), c);
    c = segbar(p, u_seg2, vec2(u_segLit.z, u_segMax.z), c);
    c = segbar(p, u_seg3, vec2(u_segLit.w, u_segMax.w), c);

    // the map window between the rev blades ("Show Waze map inside the theme"): a rounded see-through hole
    if (u_hole.z > 0.0) {
        vec2 hs = u_hole.zw * 0.5;
        vec2 q = abs(p - (u_hole.xy + hs)) - (hs - vec2(u_holeR));
        float hd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_holeR;
        c.a *= clamp(hd + 0.5, 0.0, 1.0);
    }

    // tricolour mark: three slanted bars
    if (u_mark.z > 0.0) {
        vec2 m = (p - u_mark.xy) / u_mark.z;
        if (m.y > -1.0 && m.y < 21.0 && m.x > -2.0 && m.x < 60.0) {
            float lx = m.x - 7.0 * (1.0 - m.y / 20.0);
            float i = floor(lx / 16.0);
            float fx = lx - i * 16.0;
            float inside = cov((max(abs(fx - 6.5) - 6.5, abs(m.y - 10.0) - 10.0)) * u_mark.z);
            vec3 mc = i < 0.5 ? vec3(0.31, 0.71, 1.0) : (i < 1.5 ? vec3(0.17, 0.29, 0.78) : vec3(0.9, 0.13, 0.17));
            if (i >= 0.0 && i <= 2.0) c = over(vec4(mc, inside), c);
        }
    }
    gl_FragColor = c;
}
`;
const MTACH = `// The M theme's rev bar (GLSL ES 1.00), after the M8's: a bowed glass blade (the curve bends at u_geoA.z with a
// large roundness, so it reads as one arc), wide at 0 rpm and narrow at the top, with a bright silver outer
// edge and bright ticks running in from it every 1000 rpm. The part below the rpm is lit dim grey, a glowing red
// block rides the blade at the rpm (the M8's marker), an outlined grey foot block fills the bottom 20 px, orange dashes sit before
// the redline and a solid red line past it. Drawn as the left bar; u_side 1 mirrors it. v_uv (0,0) is the top-left.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_side;
uniform vec4 u_geoA;      // y at 0 rpm, y at max, y of the bend, outer-edge x at the bend (layer px, left frame)
uniform vec3 u_geoB;      // slope above the bend, slope below it, bend roundness px
uniform vec3 u_wid;       // blade width at 0 rpm, at max, extra at the bend
uniform float u_ticks;    // max / 1000
uniform float u_value;    // 0..1
uniform float u_orange;   // 0..1, orange dashes from here
uniform float u_redFrom;  // 0..1, red dashes from here (the redline)
uniform float u_shiftNow;
uniform vec3 u_red;

float cov(float d) { return clamp(0.5 - d, 0.0, 1.0); }
vec4 over(vec4 top, vec4 under) {
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}
float segD(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }

void main() {
    vec2 p = v_uv * u_size;
    if (u_side > 0.0) p.x = u_size.x - p.x;
    float y0 = u_geoA.x, y8 = u_geoA.y, ym = u_geoA.z, xm = u_geoA.w;
    float dy = p.y - ym;
    float k = dy < 0.0 ? u_geoB.x : u_geoB.y;
    float sq = sqrt(dy * dy + u_geoB.z * u_geoB.z);
    float xo = xm + k * (sq - u_geoB.z);
    float slope = k * dy / sq;
    float d = (p.x - xo) / sqrt(1.0 + slope * slope);      // + = into the blade, towards the middle
    float t = (y0 - p.y) / (y0 - y8);
    float w = mix(u_wid.x, u_wid.y, clamp(t, 0.0, 1.0)) + u_wid.z * exp(-dy * dy / 22000.0);
    vec4 c = vec4(0.0);
    if (t >= 0.0 && t <= 1.0) {
        float inBand = clamp(d + 0.5, 0.0, 1.0) * clamp(w - d + 0.5, 0.0, 1.0);
        float across = clamp(d / w, 0.0, 1.0);
        float yn = y0 - u_value * (y0 - y8);
        vec4 g = vec4(0.62, 0.67, 0.74, mix(0.42, 0.06, across));          // empty glass (bright at the outer edge, as the M8's)
        if (p.y > yn) g = u_shiftNow > 0.5 ? vec4(u_red * 0.8, 0.6) : vec4(mix(vec3(0.86, 0.88, 0.92), vec3(0.6, 0.63, 0.68), across), mix(0.34, 0.22, across));
        // the foot: the bottom 20 px as an outlined grey block, as the M8 draws it
        if (p.y > y0 - 20.0) g = over(vec4(0.7, 0.72, 0.78, 0.22), g);
        g = over(vec4(0.9, 0.92, 0.95, 0.7 * cov(min(abs(p.y - (y0 - 19.0)), abs(p.y - (y0 - 1.5))) - 0.8)), g);
        // the marker: a red block at the rpm with a glow either side of it
        float dm = abs(p.y - yn);
        g = over(vec4(u_red, 0.5 * exp(-dm / 26.0)), g);
        g = over(vec4(mix(u_red, vec3(1.0, 0.45, 0.4), 0.35 * cov(dm - 5.0)), cov(dm - 14.0)), g);
        c = vec4(g.rgb, g.a * inBand);
        c = over(vec4(0.93, 0.95, 0.98, cov(abs(d) - 1.6)), c);               // outer edge
        c = over(vec4(1.0, 1.0, 1.0, 0.3 * cov(abs(d - 4.0) - 0.6)), c);       // its bevel
        c = over(vec4(0.66, 0.7, 0.76, 0.75 * cov(abs(d - w) - 0.8)), c);      // inner edge
        // BMW's marks: a solid red line from the redline, a few orange dashes in the run-up to it
        bool redM = t >= u_redFrom && d > 6.0 && d < 11.0;
        bool orM = t >= u_orange && t < u_redFrom - 0.01 && d > 6.0 && d < 11.0 && mod(p.y, 20.0) < 7.0;
        if (redM || orM) {
            c = over(vec4(redM ? u_red : vec3(1.0, 0.6, 0.1), 0.95), c);
        }
    }
    // ticks every 1000 rpm: bright, from the outer edge 24 px into the glass, as the M8 draws them
    float kk = floor(t * u_ticks + 0.5);
    float yk = y0 - kk / u_ticks * (y0 - y8);
    if (kk >= 0.0 && kk <= u_ticks && d > -2.0 && d < 24.0) {
        float ty = abs(p.y - yk) - 1.5;
        c = over(vec4(0.93, 0.95, 0.98, cov(ty)), c);
    }
    gl_FragColor = c;
}
`;
const SDASH = `// The Sport theme in one cluster-render "effect" layer (GLSL ES 1.00), after BMW's Live Cockpit Sport view:
// a blue speed bracket left and a red rev bracket right (the left one mirrored). Each is a thin bright outer
// line, a band that fills from the bottom (white marker at the value), a dark gap and a thin inner line round a
// black middle: plain black, or the map through a see-through rounded hole (u_hole; only the bottom strip draws
// over it, the fuel and oil bars are off while it is open). Two-tone fuel and oil bars inside the brackets, a blue / red strip at the bottom. v_uv (0,0) is
// the top-left. The backdrop is pure black: the car brightens dark tints (seen Nov 5 2026), so no dark panels.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_geo;       // outer line: y at the top, y at the bend, y at the bottom, x at the bend (left side)
uniform vec3 u_k;         // x per y px above the bend, below it, bend roundness px
uniform float u_w;        // band width
uniform float u_inner;    // the inner line's distance from the outer line
uniform vec2 u_scale;     // y of the scale's 0 and of its top mark
uniform vec2 u_ticks;     // marks left (speed), right (rpm)
uniform float u_speed;    // 0..1 along the scale
uniform float u_rpm;      // 0..1
uniform float u_redFrom;  // 0..1 (the redline)
uniform float u_orange;   // 0..1, yellow marks from here to the redline
uniform float u_fuel;     // 0..1
uniform float u_oil;      // 0..1
uniform vec4 u_fuelSeg;   // full end x, y, empty end x, y
uniform vec4 u_oilSeg;
uniform vec4 u_hole;      // map window x, y, w, h, already inset (w 0 = none)
uniform float u_holeR;    // the hole's corner radius px
uniform vec4 u_strip;     // bottom strip: left end x, top y, height, slant px
uniform float u_topEnd;   // the top lines run from the bracket to this x (left; mirrored on the right)
uniform vec4 u_road;      // the road in the middle (BMW's own Sport view draws one): horizon y, px scale, dash phase 0..1, on

const vec3 BLUE_LINE = vec3(0.36, 0.62, 1.0);
const vec3 BLUE_BAND = vec3(0.13, 0.3, 0.78);
const vec3 BLUE_LIT = vec3(0.62, 0.86, 1.0);
const vec3 BLUE_IN = vec3(0.2, 0.45, 0.98);
const vec3 RED_LINE = vec3(0.95, 0.12, 0.16);
const vec3 RED_BAND = vec3(0.33, 0.06, 0.1);
const vec3 RED_LIT = vec3(0.93, 0.1, 0.15);
const vec3 RED_IN = vec3(0.86, 0.08, 0.13);

float cov(float d) { return clamp(0.5 - d, 0.0, 1.0); }
vec4 over(vec4 top, vec4 under) {
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}
float segD(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float segH(vec2 p, vec2 a, vec2 b) { vec2 ba = b - a; return clamp(dot(p - a, ba) / dot(ba, ba), 0.0, 1.0); }

float outerX(float y) {
    float dy = y - u_geo.y;
    float k = dy < 0.0 ? u_k.x : u_k.y;
    return u_geo.w + k * (sqrt(dy * dy + u_k.z * u_k.z) - u_k.z);
}
float outerSlope(float y) {
    float dy = y - u_geo.y;
    float k = dy < 0.0 ? u_k.x : u_k.y;
    return k * dy / sqrt(dy * dy + u_k.z * u_k.z);
}
// px from the outer line, inwards (perpendicular)
float dIn(vec2 q) { return (q.x - outerX(q.y)) / sqrt(1.0 + outerSlope(q.y) * outerSlope(q.y)); }

// one bracket in the left frame (q mirrored for the right one)
vec4 bracket(vec2 q, float val, float redFrom, float orange, float ticks, vec3 line, vec3 band, vec3 lit, vec3 inner, vec4 c) {
    float d = dIn(q);
    float yTopI = u_geo.x + 8.0;                              // the inner line's top run
    float t = (u_scale.x - q.y) / (u_scale.x - u_scale.y);    // 0 at the scale's 0
    bool inY = q.y > u_geo.x + 5.0 && q.y < u_geo.z - 4.0;
    // the band: lit up to the value, white marker on top
    float inB = (inY ? 1.0 : 0.0) * cov(-(d - 5.0)) * cov(d - 5.0 - u_w);
    if (inB > 0.0) {
        vec3 col = band;
        float a = 0.96;
        if (t <= val) col = mix(lit, mix(lit, vec3(1.0), 0.25), clamp((d - 5.0) / u_w, 0.0, 1.0)) * mix(0.8, 1.0, clamp(t / max(val, 0.01), 0.0, 1.0));
        c = over(vec4(col, a * inB), c);
        float yv = u_scale.x - val * (u_scale.x - u_scale.y);
        if (val > 0.002) c = over(vec4(1.0, 1.0, 1.0, inB * cov(abs(q.y - yv) - 2.0)), c);
        // marks at every label, on the band's outer half
        float kk = floor(t * ticks + 0.5);
        float yk = u_scale.x - kk / ticks * (u_scale.x - u_scale.y);
        if (kk >= 0.0 && kk <= ticks && d > 7.0 && d < 19.0) c = over(vec4(line, 0.9 * cov(abs(q.y - yk) - 1.2)), c);
        // redline: yellow dashes, then a solid red line, on the outer edge of the band
        if (redFrom < 1.5 && d > 8.0 && d < 13.0) {
            if (t >= redFrom && t <= 1.02) c = over(vec4(1.0, 0.2, 0.2, 1.0), c);
            else if (t >= orange && t < redFrom && mod(q.y, 16.0) < 7.0) c = over(vec4(1.0, 0.85, 0.1, 1.0), c);
        }
    }
    // the outer line, its top run and its bottom run
    float o = inY || abs(q.y - u_geo.x) < 6.0 || abs(q.y - u_geo.z) < 6.0 ? cov(abs(d - 1.0) - 1.8) : 0.0;
    vec2 tl = vec2(outerX(u_geo.x), u_geo.x), bl = vec2(outerX(u_geo.z), u_geo.z);
    o = max(o, cov(segD(q, tl, vec2(u_topEnd, u_geo.x)) - 2.2));
    o = max(o, cov(segD(q, bl, bl + vec2(u_inner + 40.0, 0.0)) - 2.2));
    c = over(vec4(line, 0.35 * exp(-abs(d) / 5.0) * (inY ? 1.0 : 0.0) * step(d, 0.0)), c);
    c = over(vec4(line, o), c);
    // the inner line: down the bracket from its top run to the bottom
    float il = (q.y > yTopI && q.y < u_geo.z - 6.0) ? cov(abs(d - u_inner) - 1.6) : 0.0;
    float xi = outerX(yTopI) + u_inner * sqrt(1.0 + outerSlope(yTopI) * outerSlope(yTopI));
    il = max(il, cov(segD(q, vec2(xi, yTopI), vec2(u_topEnd - 14.0, yTopI)) - 1.6));
    c = over(vec4(inner, 0.95 * il), c);
    return c;
}

// a two-tone slanted bar from the empty end b to the full end a, with a thin rail beside it
vec4 bar(vec2 p, vec4 s, float val, float zones, vec4 c) {
    vec2 a = s.xy, b = s.zw;
    float h = 1.0 - segH(p, a, b);
    vec2 dir = normalize(a - b), nrm = vec2(-dir.y, dir.x);
    float side = dot(p - b, nrm);
    float along = segD(p, a, b);
    if (along > 26.0) return c;
    float body = cov(abs(side) - 7.0) * cov(segD(p, a, b) - 7.5);
    vec3 col = vec3(0.92, 0.94, 0.97);
    if (zones > 0.5 && h > 0.88) col = vec3(1.0, 0.2, 0.22);
    if (zones > 0.5 && h < 0.1) col = vec3(0.25, 0.5, 1.0);
    c = over(vec4(0.36, 0.38, 0.44, 0.9 * body), c);
    c = over(vec4(col, body * step(h, val) * step(0.001, val)), c);
    c = over(vec4(0.5, 0.52, 0.58, 0.8 * cov(abs(side + 12.0) - 1.0) * cov(segD(p, a, b) - 13.0)), c);
    return c;
}

void main() {
    vec2 p = v_uv * u_size;
    vec2 pm = vec2(u_size.x - p.x, p.y);
    vec4 c = vec4(0.0, 0.0, 0.0, 1.0);

    c = bracket(p, u_speed, 2.0, 2.0, u_ticks.x, BLUE_LINE, BLUE_BAND, BLUE_LIT, BLUE_IN, c);
    c = bracket(pm, u_rpm, u_redFrom, u_orange, u_ticks.y, RED_LINE, RED_BAND, RED_LIT, RED_IN, c);
    // the map window: a rounded hole cut out of the backdrop and brackets, so the map shows clean; the fuel and
    // oil bars come off while it is open (they ran across the map, car photos Nov 7 2026), the bottom strip stays
    if (u_hole.z > 0.0) {
        vec2 hs = u_hole.zw * 0.5;
        vec2 q = abs(p - (u_hole.xy + hs)) - (hs - vec2(u_holeR));
        float hd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_holeR;
        c.a *= clamp(hd + 0.5, 0.0, 1.0);
    } else {
        // the road while no map shows: a soft blue surface, solid outer lines and dashed lane lines in perspective
        // from the horizon to the bottom line; the dashes run towards the driver with the speed (u_road.z)
        if (u_road.w > 0.5 && p.y > u_road.x + 1.0 && p.y < u_geo.z - 3.0) {
            float dy = p.y - u_road.x;
            float xw = (p.x - u_size.x * 0.5) * u_road.y / dy;          // across, lanes 1 wide
            float px = dy / u_road.y;                                   // screen px per lane
            float fade = smoothstep(0.0, 70.0, dy) * (1.0 - smoothstep(-30.0, 0.0, p.y - u_geo.z + 3.0) * 0.5);
            c = over(vec4(0.16, 0.36, 0.95, 0.5 * fade * cov((abs(xw) - 1.75) * px) * mix(0.55, 1.0, dy / (u_geo.z - u_road.x))), c);
            float hw = 1.2 + dy * 0.012;                                // line half width px, wider nearer
            float edge = cov(abs(abs(xw) - 1.5) * px - hw);
            float dash = step(fract(u_road.y * 120.0 / dy + u_road.z), 0.5);
            float lane = cov(abs(abs(xw) - 0.5) * px - hw) * dash;
            c = over(vec4(0.85, 0.93, 1.0, fade * max(edge, lane)), c);
        }
        c = bar(p, u_fuelSeg, u_fuel, 0.0, c);
        c = bar(p, u_oilSeg, u_oil, 1.0, c);
    }
    // the bottom line between the brackets
    if (abs(p.y - u_geo.z) < 3.0 && abs(p.x - u_size.x * 0.5) < u_size.x * 0.5 - outerX(u_geo.z))
        c = over(vec4(mix(BLUE_LINE, RED_LINE, step(u_size.x * 0.5, p.x)) * 0.8, cov(abs(p.y - u_geo.z) - 1.2)), c);

    // bottom strip: slanted ends, blue left of the middle, red right, thin dividers
    float sy = p.y - u_strip.y;
    if (sy > -2.0 && sy < u_strip.z + 2.0) {
        float xl = u_strip.x + (u_strip.z - sy) / u_strip.z * u_strip.w;     // left end leans in at the top
        float dx = abs(p.x - u_size.x * 0.5), xe = u_size.x * 0.5 - xl;
        float inside = cov(dx - xe) * cov(-sy) * cov(sy - u_strip.z);
        float f = dx / xe;
        vec3 sc = p.x < u_size.x * 0.5 ? mix(vec3(0.06, 0.2, 0.62), vec3(0.15, 0.36, 0.92), f) : mix(vec3(0.4, 0.05, 0.1), vec3(0.85, 0.1, 0.16), f);
        c = over(vec4(sc, 0.95 * inside), c);
        float div = cov(abs(mod(p.x - (u_strip.z - sy) * 0.45, 150.0) - 75.0) - 73.8);
        c = over(vec4(0.02, 0.03, 0.08, 0.5 * inside * div), c);
        c = over(vec4(1.0, 1.0, 1.0, 0.25 * inside * cov(abs(sy) - 1.0)), c);
    }
    gl_FragColor = c;
}
`;


const ATEXT = `// Atlas text for a cluster-render "effect" layer (GLSL ES 1.00): u_cells equal cells across the layer, each
// showing one glyph of the R8 glyph atlas bound to u_font (u_grid.x columns by u_grid.y rows of cells), picked
// by the codes in u_text (32 codes, 4 to a vec4; below 0 = empty). A new value is one uniform message, no
// pixels. After robertnisipeanu/idrive-apps js/showcase.js (TEXT_FS). v_uv (0,0) is the top-left.
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_font;
uniform vec4 u_text[8];
uniform float u_cells;
uniform vec2 u_grid;
uniform vec4 u_color;

float code(float cell) {
    float slot = floor(cell / 4.0), lane = cell - slot * 4.0;
    vec4 v = u_text[0];
    for (int i = 1; i < 8; i++) if (float(i) == slot) v = u_text[i];
    return lane < 0.5 ? v.x : lane < 1.5 ? v.y : lane < 2.5 ? v.z : v.w;
}

void main() {
    float x = v_uv.x * u_cells;
    float c = code(floor(x));
    float col = mod(c, u_grid.x), row = floor(c / u_grid.x);
    vec2 uv = vec2((col + fract(x)) / u_grid.x, (row + v_uv.y) / u_grid.y);
    float ink = c < 0.0 ? 0.0 : texture2D(u_font, uv).r;
    gl_FragColor = vec4(u_color.rgb, u_color.a * ink);
}
`;

const METER = `// A segmented bar meter for a cluster-render "effect" layer (GLSL ES 1.00): u_segs segments along the layer's
// width (or its height when u_vertical is 1, filling upward), the first u_value of the way lit. A lit segment takes
// u_c1 below u_at.x of the bar, u_c2 up to u_at.y, u_c3 from there (the retro green / amber / red, or warm-up blue /
// white / red); unlit ones u_track. u_peak 0..1 lights the segment it falls in u_peakC (below 0: none). u_gap px
// between segments. v_uv (0,0) is the top-left.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_value;
uniform float u_segs;
uniform float u_gap;
uniform float u_vertical;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform vec2 u_at;
uniform vec4 u_track;
uniform float u_peak;
uniform vec3 u_peakC;

void main() {
    vec2 p = v_uv * u_size;
    float len = u_vertical > 0.5 ? u_size.y : u_size.x;
    float x = u_vertical > 0.5 ? u_size.y - p.y : p.x;
    float slot = (len + u_gap) / u_segs;
    float i = floor(x / slot);
    float fx = x - i * slot;
    float a = clamp(fx + 0.5, 0.0, 1.0) * clamp(slot - u_gap - fx + 0.5, 0.0, 1.0);
    if (i < 0.0 || i >= u_segs || a <= 0.0) { gl_FragColor = vec4(0.0); return; }
    float f = (i + 0.5) / u_segs;
    vec3 c = f < u_at.x ? u_c1 : (f < u_at.y ? u_c2 : u_c3);
    float lit = (i + 0.5) / u_segs <= u_value + 0.5 / u_segs ? 1.0 : 0.0;
    if (u_value <= 0.0) lit = 0.0;
    if (u_peak >= 0.0 && i == floor(min(u_peak, 0.9999) * u_segs) && lit < 0.5) { gl_FragColor = vec4(u_peakC, a); return; }
    if (lit > 0.5) gl_FragColor = vec4(c, a);
    else gl_FragColor = vec4(u_track.rgb, u_track.a * a);
}
`;

const GMETER = `// A G-meter for a cluster-render "effect" layer (GLSL ES 1.00): a bezel with ticks every 30 degrees, rings every
// u_geo.w g out to u_geo.z (each 0.5 g a little brighter), a crosshair, the grip envelope (the furthest g reached in
// each of 48 directions, as an outline round a faint fill), a fading trail of the last moments, and the dot,
// white (u_c1), then amber from 0.5 g, then red (u_c3) from 0.8 g (pinned to the bezel past u_geo.z). Positions in g
// as drawn: + x right, + y down (hud.js maps the car's signs).
// 14 uniform vectors (HUD rule: 20 at most; it was 32 before Nov 13 2026): scalars packed into vec4s, the amber and
// its two thresholds are constants here, and the envelope is an R8 asset instead of 12 vec4s:
//   u_geo       layer w, h px, range u_max g, ring step g
//   u_dot       the dot's g (x, y), trail points in use (0..16), envelope on (0 / 1)
//   u_trail[i]  two trail points (x, y, x, y), newest first (sent with type vec4)
//   u_env       64 x 1 R8 asset: texel k (0..47) = sector k's radius / u_max, sector k centred on k * 7.5 degrees
//               counter-clockwise from + x; read at texel centres, so nearest or bilinear sampling reads the same
// The loops have constant bounds and the arrays are indexed by the loop counter only, as GLSL ES 1.00 requires.
// The dial fills the smaller side of the layer. v_uv (0,0) is the top-left.
precision mediump float;
varying vec2 v_uv;
uniform vec4 u_geo;
uniform vec4 u_dot;
uniform vec4 u_line;
uniform vec3 u_c1;
uniform vec3 u_c3;
uniform vec3 u_envC;
uniform vec4 u_trail[8];
uniform sampler2D u_env;

const float TAU = 6.2831853;
const vec3 AMBER = vec3(1.0, 0.6901961, 0.1568627);      // [255, 176, 40]: the dot between 0.5 and 0.8 g
const vec2 AT = vec2(0.5, 0.8);                           // amber from, red from (g)

float envAt(float k) {
    return texture2D(u_env, vec2((k + 0.5) / 64.0, 0.5)).r * u_geo.z;
}
vec2 trailAt(float j) {
    float slot = floor(j / 2.0);
    vec4 v = u_trail[0];
    for (int i = 1; i < 8; i++) if (float(i) == slot) v = u_trail[i];
    return j - slot * 2.0 < 0.5 ? v.xy : v.zw;
}
vec3 heat(float g) {
    vec3 c = mix(u_c1, AMBER, smoothstep(AT.x - 0.1, AT.x, g));
    return mix(c, u_c3, smoothstep(AT.y - 0.08, AT.y, g));
}
vec4 over(vec4 top, vec4 under) {
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}

void main() {
    vec2 size = u_geo.xy;
    float u_max = u_geo.z, u_step = u_geo.w;
    vec2 p = vec2(v_uv.x - 0.5, 0.5 - v_uv.y) * size;     // px from the centre, +y up
    float R = min(size.x, size.y) * 0.5 - 2.0;
    float d = length(p);
    if (d > R + 1.5) { gl_FragColor = vec4(0.0); return; }
    float k = (R - 5.0) / u_max;                           // px per g (the scale ends inside the bezel)
    vec4 col = vec4(0.0);
    // the bezel and its ticks (longer at 12, 3, 6 and 9 o'clock)
    float bez = clamp(1.8 - abs(d - (R - 1.0)), 0.0, 1.0);
    float ang = atan(p.y, p.x);
    float t30 = abs(fract(ang / (TAU / 12.0) + 0.5) - 0.5) * (TAU / 12.0) * d;   // px from the nearest tick line
    float t90 = abs(fract(ang / (TAU / 4.0) + 0.5) - 0.5) * (TAU / 4.0) * d;
    float tick = d > R - 9.0 ? clamp(1.3 - t30, 0.0, 1.0) * 0.8 : 0.0;
    if (d > R - 15.0) tick = max(tick, clamp(1.6 - t90, 0.0, 1.0));
    col = vec4(u_line.rgb, u_line.a * max(bez, tick));
    // rings every u_step g; the 0.5 g ones brighter
    for (int i = 1; i <= 10; i++) {
        float g = float(i) * u_step;
        if (g > u_max - 0.01) break;
        float half_ = abs(fract(g / 0.5 + 0.5) - 0.5) < 0.01 ? 1.0 : 0.0;
        float c = clamp(1.0 - abs(d - g * k), 0.0, 1.0) * (half_ > 0.5 ? 0.7 : 0.38);
        col = max(col, vec4(u_line.rgb, u_line.a * c));
    }
    // the crosshair, with a gap round the centre
    float cx = clamp(1.2 - abs(p.x), 0.0, 1.0), cy = clamp(1.2 - abs(p.y), 0.0, 1.0);
    if (d > 6.0) col = max(col, vec4(u_line.rgb, u_line.a * 0.4 * max(cx, cy)));
    // the grip envelope: radius between the two nearest sectors
    if (u_dot.w > 0.5) {
        float f = fract(ang / TAU + 1.0) * 48.0;
        float k0 = floor(f), k1 = k0 + 1.0;
        if (k1 > 47.5) k1 = 0.0;
        float r0 = envAt(k0), r1 = envAt(k1);          // stored capped at u_max
        if (r0 > 0.04 || r1 > 0.04) {
            // a direction not reached yet is 0 g, so the outline runs in towards the centre there (a radar
            // chart); the distance is divided by the slope so the steep parts keep their width
            float re = mix(r0, r1, f - k0) * k;
            float slope = (r1 - r0) * k * 48.0 / TAU / max(d, 1.0);
            float dist = abs(d - re) / sqrt(1.0 + slope * slope);
            float edge = clamp(1.4 - dist, 0.0, 1.0) * 0.9;
            float fill = clamp(re - d + 0.5, 0.0, 1.0) * 0.10;
            col = over(vec4(u_envC, max(edge, fill)), col);
        }
    }
    // the trail: fading, thinning segments from the dot back
    float tA = 0.0;
    for (int j = 0; j < 15; j++) {
        float fj = float(j);
        if (fj + 1.0 >= u_dot.z) break;
        vec2 a = clamp(trailAt(fj), vec2(-u_max), vec2(u_max)) * vec2(k, -k);
        vec2 b = clamp(trailAt(fj + 1.0), vec2(-u_max), vec2(u_max)) * vec2(k, -k);
        vec2 ab = b - a;
        float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 0.001), 0.0, 1.0);
        float dd = length(p - a - ab * h);
        float age = (fj + h) / 15.0;
        float wdt = mix(3.2, 0.8, age);
        tA = max(tA, clamp(wdt - dd, 0.0, 1.0) * mix(0.85, 0.08, age));
    }
    vec2 g = u_dot.xy;
    float gm = length(g);
    if (tA > 0.0) col = over(vec4(heat(gm), tA), col);
    // the dot with a soft glow, pinned to the bezel past u_max
    if (gm > u_max) g = g * (u_max / gm);
    vec2 dp = g * vec2(k, -k);
    float dd = length(p - dp);
    vec3 dc = heat(gm);
    float glow = clamp(1.0 - (dd - 7.0) / 13.0, 0.0, 1.0) * 0.4;
    float dt = clamp(8.0 - dd, 0.0, 1.0);
    col = over(vec4(dc, glow), col);
    col = over(vec4(mix(dc, vec3(1.0), clamp(3.5 - dd, 0.0, 1.0) * 0.6), dt), col);
    gl_FragColor = col;
}
`;

const REVARC = `// A segmented rev arc for a cluster-render "effect" layer (GLSL ES 1.00), the Rally theme's: a band from u_r - u_w
// to u_r round u_center (layer px, y down), from u_start sweeping u_sweep (radians, clockwise from 12 o'clock), in
// u_segs segments, the first u_value of it lit: u_low below u_midAt, u_mid up to u_highAt, u_high past it;
// unlit u_track. u_flash 1: everything lit flashes white (at the redline). v_uv (0,0) is the top-left.
// u_wing > 0: driver camera wings: the middle 2 x u_wing radians stay empty and u_segs segments sit on each side,
// mirrored, filling from the two ends in towards the middle.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec2 u_center;
uniform float u_r;
uniform float u_w;
uniform float u_start;
uniform float u_sweep;
uniform float u_segs;
uniform float u_value;
uniform vec3 u_low;
uniform vec3 u_mid;
uniform vec3 u_high;
uniform float u_midAt;
uniform float u_highAt;
uniform vec4 u_track;
uniform float u_flash;
uniform float u_wing;

const float PI = 3.14159265359;

void main() {
    vec2 d = v_uv * u_size - u_center;
    float rr = length(d);
    float inner = u_r - u_w;
    float edge = clamp(rr - inner + 0.5, 0.0, 1.0) * clamp(u_r - rr + 0.5, 0.0, 1.0);
    if (edge <= 0.0) { gl_FragColor = vec4(0.0); return; }
    float a = atan(d.x, -d.y);                      // clockwise from 12 o'clock
    float rel = mod(a - u_start + 4.0 * PI, 2.0 * PI);
    if (rel > u_sweep) { gl_FragColor = vec4(0.0); return; }
    float slot = u_sweep / u_segs;
    if (u_wing > 0.0) {
        float mid = u_sweep * 0.5;
        if (abs(rel - mid) < u_wing) { gl_FragColor = vec4(0.0); return; }
        if (rel > mid) rel = u_sweep - rel;         // the right wing, mirrored
        slot = (mid - u_wing) / u_segs;
    }
    float i = floor(rel / slot);
    float gap = 5.0 / rr;                           // a 5 px gap between segments at this radius
    float fx = rel - i * slot;
    float a1 = clamp((fx) * rr + 0.5, 0.0, 1.0) * clamp((slot - gap - fx) * rr + 0.5, 0.0, 1.0);
    float fc = (i + 0.5) / u_segs;
    vec3 c = fc < u_midAt ? u_low : (fc < u_highAt ? u_mid : u_high);
    bool lit = u_value > 0.0 && fc <= u_value + 0.5 / u_segs;
    if (lit && u_flash > 0.5) c = vec3(1.0);
    if (lit) gl_FragColor = vec4(c, edge * a1);
    else gl_FragColor = vec4(u_track.rgb, u_track.a * edge * a1);
}
`;

const TILES = `// The Dyno theme's tiles in one cluster-render "effect" layer (GLSL ES 1.00): the background u_bg and up to 14
// rounded readout tiles, each filled u_fill (u_warn while its readout is over its warning limit), framed u_line,
// with a thin u_accent strip along the top and an optional bar along the bottom: track u_track, lit from the left
// to the tile's value, coloured by where along the bar it is (u_c1 below u_at.x, u_c2 to u_at.y, u_c3 past it) or
// all u_c1 for a plain bar. Array uniforms (sent with type vec4):
//   u_tile[i]   x, y, w, h in layer px
//   u_tileV[i]  bar value 0..1 (< 0: no bar), warning (0 / 1), zoned bar (0 / 1), unused
//   u_n         tiles in use. u_geo: corner radius, border px, accent strip px, bar height px.
// Colours rgba (fills) or rgb, straight alpha. The loop bound is constant and the arrays are indexed by the loop
// counter only, as GLSL ES 1.00 requires. v_uv (0,0) is the top-left.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_bg;
uniform float u_n;
uniform vec4 u_tile[14];
uniform vec4 u_tileV[14];
uniform vec4 u_geo;
uniform vec4 u_fill;
uniform vec4 u_warn;
uniform vec4 u_line;
uniform vec4 u_track;
uniform vec3 u_accent;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform vec2 u_at;

float sdBox(vec2 p, vec4 r, float rad) {
    vec2 hs = r.zw * 0.5;
    vec2 q = abs(p - (r.xy + hs)) - (hs - vec2(rad));
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
vec4 over(vec4 top, vec4 under) {
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}

void main() {
    vec2 p = v_uv * u_size;
    vec4 c = u_bg;
    for (int i = 0; i < 14; i++) {
        if (float(i) >= u_n) break;
        vec4 b = u_tile[i];
        if (p.x < b.x - 1.0 || p.x > b.x + b.z + 1.0 || p.y < b.y - 1.0 || p.y > b.y + b.w + 1.0) continue;
        vec4 v = u_tileV[i];
        float d = sdBox(p, b, u_geo.x);
        float outer = clamp(0.5 - d, 0.0, 1.0);
        if (outer <= 0.0) continue;
        vec4 col = v.y > 0.5 ? u_warn : u_fill;
        // the accent strip along the top, inside the frame
        if (p.y < b.y + u_geo.z + u_geo.y) col = vec4(v.y > 0.5 ? vec3(1.0) : u_accent, 1.0);
        // the bar: inset 16 px a side, its bottom 12 px over the tile's
        if (v.x >= 0.0) {
            float bx0 = b.x + 16.0, bw = b.z - 32.0, by1 = b.y + b.w - 12.0, by0 = by1 - u_geo.w;
            if (p.x >= bx0 && p.x <= bx0 + bw && p.y >= by0 && p.y <= by1) {
                float f = (p.x - bx0) / bw;
                vec3 lit = v.z > 0.5 ? (f < u_at.x ? u_c1 : (f < u_at.y ? u_c2 : u_c3)) : u_c1;
                if (v.y > 0.5) lit = vec3(1.0);
                col = f <= v.x ? vec4(lit, 1.0) : over(u_track, col);
            }
        }
        float edge = clamp(d + u_geo.y + 0.5, 0.0, 1.0);
        col = mix(col, v.y > 0.5 ? vec4(1.0, 1.0, 1.0, 0.85) : u_line, edge);
        c = over(vec4(col.rgb, col.a * outer), c);
    }
    gl_FragColor = c;
}
`;

const RIBBON = `// The Ribbon theme's rev line (GLSL ES 1.00): one smooth curve under the hood line that fills with the revs, glowing.
// In panel px (y down; u_org is the layer's top-left on the panel): y(x) = a u^2 + b u + c + dip (1 - u^2), u = (x - cx) / half,
// u_curve (a, b, c, dip), u_span (x0, x1, cx, half). dip > 0 (the driver camera setting) lowers the middle under the camera
// and keeps the ends. Lit from x0 up to u_value of the span, coloured by the five-stop gradient u_c0..u_c4 (u_at: where
// stops 1..4 sit, 0..1), with a soft glow; unlit u_track. Under it u_n + 1 dots at every thousand rpm (the last two in
// u_red). u_bulbs 1: a string of Christmas bulbs on a wire (u_wire) instead, every 40 px, cycling u_c0..u_c3, the ones
// past u_at.z in u_red, lit up to u_value. u_flash 1: everything lit in u_red (at the redline).
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec2 u_org;
uniform vec4 u_curve;
uniform vec4 u_span;
uniform float u_value;
uniform float u_flash;
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform vec3 u_c4;
uniform vec4 u_at;
uniform vec4 u_track;
uniform vec3 u_dot;
uniform vec3 u_red;
uniform vec3 u_wire;
uniform float u_n;
uniform float u_bulbs;

float cy(float x) {
    float u = (x - u_span.z) / u_span.w;
    return u_curve.x * u * u + u_curve.y * u + u_curve.z + u_curve.w * (1.0 - u * u);
}
// distance from p to the curve between x0 and x1 (round ends)
float dist(vec2 p, float x0, float x1) {
    float x = clamp(p.x, x0, x1);
    if (x != p.x) return length(p - vec2(x, cy(x)));
    float u = (x - u_span.z) / u_span.w;
    float s = (2.0 * (u_curve.x - u_curve.w) * u + u_curve.y) / u_span.w;
    return abs(p.y - cy(x)) / sqrt(1.0 + s * s);
}
vec3 grad(float t) {
    if (t < u_at.x) return mix(u_c0, u_c1, t / u_at.x);
    if (t < u_at.y) return mix(u_c1, u_c2, (t - u_at.x) / (u_at.y - u_at.x));
    if (t < u_at.z) return mix(u_c2, u_c3, (t - u_at.y) / (u_at.z - u_at.y));
    return mix(u_c3, u_c4, clamp((t - u_at.z) / (u_at.w - u_at.z), 0.0, 1.0));
}
vec4 over(vec4 dst, vec3 c, float a) { return vec4(mix(dst.rgb, c, a), a + dst.a * (1.0 - a)); }

void main() {
    vec2 p = v_uv * u_size + u_org;
    float x0 = u_span.x, x1 = u_span.y, len = x1 - x0;
    float xe = x0 + u_value * len;
    vec4 o = vec4(0.0);
    // thousand dots under the line
    float k = floor((p.x - x0) / len * u_n + 0.5);
    if (k >= 0.0 && k <= u_n) {
        float xk = x0 + k / u_n * len;
        float dd = length(p - vec2(xk, cy(xk) + 28.0));
        o = over(o, k >= u_n - 1.0 ? u_red : u_dot, clamp(3.5 - dd, 0.0, 1.0));
    }
    if (u_bulbs > 0.5) {
        o = over(o, u_wire, clamp(2.5 - dist(p, x0, x1), 0.0, 1.0));
        float j = floor((p.x - x0) / 40.0 + 0.5), bx = x0 + j * 40.0;
        if (j >= 0.0 && bx <= x1) {
            float f = (bx - x0) / len, by = cy(bx);
            bool on = u_value > 0.0 && f <= u_value;
            vec3 c = j - 4.0 * floor(j / 4.0) < 0.5 ? u_c0 : (j - 4.0 * floor(j / 4.0) < 1.5 ? u_c1 : (j - 4.0 * floor(j / 4.0) < 2.5 ? u_c2 : u_c3));
            if (f > u_at.z || u_flash > 0.5) c = u_red;
            vec2 q = p - vec2(bx, by + 12.0);
            if (on) o = over(o, c, 0.5 * exp(-dot(q, q) / 98.0));
            if (abs(q.x) < 4.0 && p.y >= by && p.y <= by + 5.0) o = over(o, vec3(0.29, 0.35, 0.31), 1.0);
            float e = length(q / vec2(6.0, 9.0));
            o = over(o, on ? c : u_track.rgb, clamp((1.0 - e) * 6.0, 0.0, 1.0));
        }
        gl_FragColor = o;
        return;
    }
    // the track, then the glow and the lit core up to xe
    o = over(o, u_track.rgb, u_track.a * clamp(7.5 - dist(p, x0, x1), 0.0, 1.0));
    if (u_value > 0.0) {
        float dl = dist(p, x0, xe);
        vec3 c = u_flash > 0.5 ? u_red : grad(clamp((p.x - x0) / len, 0.0, u_value));
        o = over(o, c, 0.55 * exp(-dl * dl / 242.0));
        o = over(o, c, clamp(5.5 - dl, 0.0, 1.0));
    }
    gl_FragColor = o;
}
`;

const DECO = `// The Ribbon theme's backdrop (GLSL ES 1.00), one whole-panel layer: u_bg everywhere (it covers BMW's gauges), the
// gear's rounded frame u_pill (x, y, w, h; 2 px in u_pc), and a holiday's art by u_mode, all static, no loops:
//   1 snow (white flakes), 2 unused (was Halloween), 3 Fourth of July (three
//   fireworks: u_a, u_b, u_c), 4 New Year (bubbles in u_a, confetti u_a / u_b / u_c), 5 Thanksgiving (leaves u_a,
//   u_b, u_c). Flakes, bubbles, confetti and leaves sit in a grid of cells (one each at most, placed by a hash); one
//   whose centre is within its size of the u_k0..u_k3 rects (x0, y0, x1, y1: the readouts and BMW's gear box) or of
//   BMW's bottom strip (y 660) is left out whole. Leaves also stay below the rev line (y 215).
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_mode;
uniform vec4 u_bg;
uniform vec3 u_a;
uniform vec3 u_b;
uniform vec3 u_c;
uniform vec4 u_pill;
uniform vec3 u_pc;
uniform vec4 u_k0;
uniform vec4 u_k1;
uniform vec4 u_k2;
uniform vec4 u_k3;

float h1(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
bool inR(vec2 p, vec4 r, float m) { return p.x > r.x - m && p.x < r.z + m && p.y > r.y - m && p.y < r.w + m; }
bool keep(vec2 c, float m) { return inR(c, u_k0, m) || inR(c, u_k1, m) || inR(c, u_k2, m) || inR(c, u_k3, m) || c.y > 660.0 - m; }
// one firework burst at c, radius r: 28 rays from 0.25 r out to 0.8..1.05 r, a dot at each tip, a faint glow
float burst(vec2 p, vec2 c, float r) {
    vec2 d = p - c;
    float rr = length(d), st = 6.2831853 / 28.0;
    float i = floor(atan(d.y, d.x) / st + 0.5);
    float tip = r * (0.8 + 0.25 * h1(vec2(i, r)));
    float a = 0.0;
    if (rr > 0.25 * r && rr < tip) a = 0.45 * clamp(1.6 - abs(atan(d.y, d.x) - i * st) * rr, 0.0, 1.0);
    vec2 t = c + tip * vec2(cos(i * st), sin(i * st)) + vec2(0.0, 4.0);
    a = max(a, 0.6 * clamp(2.9 - length(p - t), 0.0, 1.0));
    return max(a, 0.08 * exp(-rr * rr / (0.18 * r * r)));
}

void main() {
    vec2 p = v_uv * u_size;
    vec3 col = u_bg.rgb;
    if (u_mode > 0.5 && u_mode < 1.5) {                              // snow
        vec2 cell = floor(p / 48.0), f = p - cell * 48.0;
        float h = h1(cell), r = 1.0 + 2.2 * h1(cell + 7.0);
        vec2 c = 6.0 + 36.0 * vec2(h1(cell + 3.0), h1(cell + 5.0));
        if (h < 0.45 && !keep(cell * 48.0 + c, r)) col = mix(col, vec3(1.0), (0.25 + 0.5 * h1(cell + 9.0)) * clamp(r + 0.5 - length(f - c), 0.0, 1.0));
    } else if (u_mode > 2.5 && u_mode < 3.5) {                       // Fourth of July
        col = mix(col, u_a, burst(p, vec2(250.0, 470.0), 110.0));
        col = mix(col, u_b, burst(p, vec2(1760.0, 500.0), 100.0));
        col = mix(col, u_c, burst(p, vec2(1500.0, 560.0), 60.0));
    } else if (u_mode > 3.5 && u_mode < 4.5) {                       // New Year: bubbles and confetti
        vec2 cell = floor(p / 64.0), f = p - cell * 64.0;
        float r = 2.0 + 6.0 * h1(cell + 2.0);
        vec2 c = 10.0 + 44.0 * vec2(h1(cell + 3.0), h1(cell + 4.0));
        if (h1(cell) < 0.45 && !keep(cell * 64.0 + c, r + 2.0)) col = mix(col, u_a, (0.2 + 0.35 * h1(cell + 6.0)) * clamp(1.2 - abs(length(f - c) - r), 0.0, 1.0));
        vec2 cl = floor((p + 31.0) / 70.0), cc = cl * 70.0 - 31.0 + 10.0 + 50.0 * vec2(h1(cl + 8.0), h1(cl + 1.0)), g = p - cc;
        float an = 3.14159 * h1(cl + 5.0), ca = cos(an), sa = sin(an);
        vec2 q = vec2(ca * g.x + sa * g.y, -sa * g.x + ca * g.y);
        float pick = h1(cl + 11.0);
        if (h1(cl + 12.0) < 0.5 && !keep(cc, 6.0) && abs(q.x) < 2.0 && abs(q.y) < 5.0)
            col = mix(col, pick < 0.34 ? u_a : (pick < 0.67 ? u_b : u_c), 0.35 + 0.3 * h1(cl + 13.0));
    } else if (u_mode > 4.5 && u_mode < 5.5) {                       // Thanksgiving: maple leaves (five pointed lobes)
        vec2 lc = floor(p / 120.0) * 120.0 + 60.0 + 30.0 * vec2(h1(floor(p / 120.0) + 1.0) - 0.5, h1(floor(p / 120.0) + 2.0) - 0.5);
        vec2 cell = floor(p / 120.0), f = p - lc;
        float sz = 18.0 + 16.0 * h1(cell + 3.0), th = atan(f.y, f.x) + 6.2831853 * h1(cell + 4.0);
        float edge = sz * (0.55 + 0.45 * pow(abs(cos(2.5 * th)), 1.6)) * (1.0 - 0.18 * pow(abs(sin(7.5 * th)), 8.0));
        float pick = h1(cell + 5.0);
        if (h1(cell) < 0.5 && lc.y > 215.0 && !keep(lc, sz)) col = mix(col, pick < 0.34 ? u_a : (pick < 0.67 ? u_b : u_c), 0.5 * clamp(edge - length(f), 0.0, 1.0));
    }
    // the gear's frame
    vec2 hs = u_pill.zw * 0.5, q = abs(p - u_pill.xy - hs) - (hs - hs.y);
    float dp = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - hs.y;
    if (u_pill.z > 0.0) col = mix(col, u_pc, clamp(1.5 - abs(dp + 1.0), 0.0, 1.0));
    gl_FragColor = vec4(col, u_bg.a);
}
`;

const MVIEW = `// The M view theme in one cluster-render "effect" layer (GLSL ES 1.00), after the Live Cockpit's M view: black
// everywhere (opaque), the speed scale on the left and the rev scale on the right (its mirror): a white outer line with
// rounded corners (u_path, the left one, from its bottom end to its top end), marks inside it, the band inside the line
// lit from 0 up to the value with red dots by the needle, a red needle across the line, red / yellow marks outside the
// rev line from the redline; a fuel dial in the lower left corner and an oil temperature dial in the lower right one (its
// mirror); a line under the speed and under the gear, and the bottom lines towards the middle. The middle is cut
// see-through for the Waze map while u_hole is set ("mapLive": only u_hole changes, no rebuild). v_uv (0,0) is the
// top-left. Ported from Asksket's f90 branch of this repo (MIT, issue #15).
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec2 u_path[32];   // the left scale's line, layer px
uniform float u_cum[32];   // arc length at each point
uniform float u_n;         // points used
uniform vec4 u_scale;      // arc length at 0 and at the top mark, -, the line's whole length
uniform vec4 u_ticks;      // speed: numbered marks, steps per number; rpm: the same
uniform float u_speed;     // 0..1
uniform float u_rpm;       // 0..1
uniform float u_redFrom;   // 0..1 of the rev scale
uniform float u_orange;    // 0..1, orange marks from here to the redline
uniform vec4 u_dial;       // fuel dial: centre x, y, radius (the oil dial is its mirror)
uniform vec2 u_dialAng;    // its angle (degrees, 0 = right, 90 = down) at full and at empty
uniform float u_fuel;      // 0..1
uniform float u_oil;       // 0..1 (50..150 C)
uniform vec4 u_line;       // the line under the speed: from x, to x, y; the bottom line runs on to x
uniform vec4 u_hole;       // the map window x, y, w, h (w 0 = none)
uniform float u_holeR;
uniform vec4 u_panel;      // the dark panel's inner edge: its top point x, y and its point at the middle x, y
uniform vec4 u_panelB;     // its bottom point x, y; z: how far inside the line the panel starts (0 = no panel)
uniform float u_oval;      // > 0: the map window is an oval inside u_hole, feathered over this many px

const vec3 WHITE = vec3(0.92, 0.93, 0.95);
const vec3 GREY = vec3(0.55, 0.57, 0.6);
const vec3 PANEL = vec3(0.105, 0.11, 0.12);
const vec3 RED = vec3(0.95, 0.1, 0.12);
const vec3 ORANGE = vec3(1.0, 0.6, 0.1);
const vec3 BLUE = vec3(0.25, 0.55, 1.0);

float cov(float d) { return clamp(0.5 - d, 0.0, 1.0); }
vec3 put(vec3 c, vec3 col, float a) { return mix(c, col, clamp(a, 0.0, 1.0)); }

void main() {
    vec2 p = v_uv * u_size;
    bool right = p.x > u_size.x * 0.5;
    vec2 q = right ? vec2(u_size.x - p.x, p.y) : p;
    vec3 c = vec3(0.0);

    // the nearest point of the line: its arc length s and the signed distance sd (+ inside the scale)
    float best = 1e6, s = 0.0, sd = 0.0;
    for (int i = 0; i < 31; i++) {
        if (float(i) >= u_n - 1.0) break;
        vec2 a = u_path[i], b = u_path[i + 1], ba = b - a;
        float L = max(length(ba), 0.001);
        float h = clamp(dot(q - a, ba) / (L * L), 0.0, 1.0);
        vec2 d = q - (a + ba * h);
        float dist = length(d);
        if (dist < best) { best = dist; s = u_cum[i] + h * L; sd = (ba.x * d.y - ba.y * d.x) / L; }
    }
    float total = u_scale.w, s0 = u_scale.x, s1 = u_scale.y;
    float v = right ? u_rpm : u_speed;
    float sv = mix(s0, s1, v);
    float f = (s - s0) / (s1 - s0);

    // the dark panel inside the scale: from a little inside the line to the chevron edge facing the middle
    if (u_panelB.z > 0.0 && sd > 0.0) {
        vec2 t = u_panel.xy, m = u_panel.zw, b = u_panelB.xy;
        float ex, slope;
        if (q.y < m.y) { float h = (q.y - t.y) / (m.y - t.y); ex = mix(t.x, m.x, h); slope = (m.x - t.x) / (m.y - t.y); }
        else { float h = (q.y - m.y) / (b.y - m.y); ex = mix(m.x, b.x, h); slope = (b.x - m.x) / (b.y - m.y); }
        float inner = (ex - q.x) / sqrt(1.0 + slope * slope);
        float pm = clamp(inner + 0.5, 0.0, 1.0) * smoothstep(u_panelB.z, u_panelB.z + 3.0, sd) * step(t.y, q.y);
        // a touch lighter towards the line, like BMW's
        c = put(c, PANEL * (1.0 + 0.35 * exp(-(sd - u_panelB.z) / 90.0)), pm);
    }

    if (best < 140.0) {
        // from 0 up to the value the band inside the line is lit: grey, brightest by the line and towards the needle
        if (s >= s0 - 6.0 && s <= sv && sd > 0.0 && sd < 100.0) {
            float toward = 0.18 + 0.82 * exp(-(sv - s) / 320.0);
            float inward = pow(1.0 - sd / 100.0, 1.6);
            float lit = toward * inward * smoothstep(s0 - 6.0, s0 + 10.0, s);
            c = put(c, vec3(0.86, 0.87, 0.9), lit * 0.8);
            // red dots right behind the needle
            vec2 cell = mod(p, 6.0) - 3.0;
            float spot = cov(length(cell) - 1.4);
            float near = exp(-(sv - s) / 55.0) * (1.0 - smoothstep(40.0, 95.0, sd));
            c = put(c, RED, spot * near * 0.9);
        }
        // BMW's red glow by the needle, at any value (also at 0, parked): red dots fading along and inwards
        if (u_panelB.z > 0.0 && sd > 0.0 && sd < 120.0 && s > s0 - 90.0) {
            vec2 cell = mod(p, 6.0) - 3.0;
            float spot = cov(length(cell) - 1.5);
            float glow = exp(-abs(s - sv) / 60.0) * (1.0 - smoothstep(20.0, 120.0, sd)) * smoothstep(s0 - 90.0, s0 - 30.0, s);
            c = put(c, RED, spot * glow * 0.85);
            c = put(c, RED * 0.35, glow * 0.35);
        }
        // the line: white, fading out at both ends, with a faint second line inside it
        float ends = smoothstep(0.0, 40.0, s) * smoothstep(0.0, 30.0, total - s);
        c = put(c, WHITE, cov(abs(sd) - 1.6) * ends);
        c = put(c, GREY, cov(abs(sd - 7.0) - 0.8) * ends * 0.5);
        // the marks inside it: a long one at each number and a short one between two
        vec2 tk = right ? u_ticks.zw : u_ticks.xy;
        float stp = (s1 - s0) / (tk.x * tk.y);
        float t = (s - s0) / stp, k = floor(t + 0.5);
        float along = abs(t - k) * stp;
        bool major = mod(k, tk.y) < 0.5;
        float len = major ? 26.0 : 14.0;
        if (k >= 0.0 && k <= tk.x * tk.y && sd > 0.0) {
            float a = cov(along - (major ? 1.7 : 1.1)) * cov(sd - len) * smoothstep(2.0, 4.0, sd);
            c = put(c, major ? WHITE : GREY, a);
        }
        // the rev scale: red then orange dashes outside the line, from the redline on
        if (right && f >= u_orange && f <= 1.0 && sd < -5.0 && sd > -15.0) {
            float gap = cov(abs(mod(s - s0, 46.0) - 23.0) - 19.0);
            c = put(c, f >= u_redFrom ? RED : vec3(1.0, 0.82, 0.1), cov(abs(sd + 10.0) - 3.5) * gap);
        }
        // the needle: a red bar across the line, stopping short of the numbers (centred 56 px in)
        float nb = cov(abs(s - sv) - 3.0) * smoothstep(-14.0, -8.0, sd) * (1.0 - smoothstep(30.0, 36.0, sd));
        c = put(c, RED, nb);
    }

    // the corner dial: fuel (left) or oil temperature (right), its value as a red mark
    vec2 dp = q - u_dial.xy;
    float r = length(dp);
    float ang = degrees(atan(dp.y, dp.x));
    float a0 = u_dialAng.x, a1 = u_dialAng.y;
    float df = (ang - a1) / (a0 - a1);          // 0 empty / cold .. 1 full / hot
    float arcLen = radians(abs(a0 - a1)) * u_dial.z;
    if (df > -0.03 && df < 1.03 && abs(r - u_dial.z) < 40.0) {
        float inArc = smoothstep(-0.02, 0.0, df) * (1.0 - smoothstep(1.0, 1.02, df));
        vec3 rim = WHITE;
        if (!right && df < 0.12) rim = RED;
        if (right && df < 0.15) rim = BLUE;
        if (right && df > 0.85) rim = RED;
        c = put(c, rim, cov(abs(r - u_dial.z) - 1.5) * inArc);
        float dv = right ? u_oil : u_fuel;
        float mk = cov(abs(df - dv) * arcLen - 3.0) * cov(abs(r - u_dial.z + 12.0) - 12.0);
        c = put(c, RED, mk);
        for (int j = 0; j < 3; j++) {
            float tf = float(j) * 0.5;
            c = put(c, WHITE, cov(abs(df - tf) * arcLen - 1.2) * cov(abs(r - u_dial.z + 8.0) - 8.0) * 0.9);
        }
    }

    // the line under the speed (left) and under the gear (right), fading in from the outer end
    if (q.x >= u_line.x && q.x <= u_line.y) {
        float x0 = u_line.x + 56.0;
        if (q.x < x0 - 8.0) {
            // the double dash at the outer end
            c = put(c, WHITE, cov(abs(abs(q.y - u_line.z) - 4.0) - 1.6));
        } else if (q.x >= x0) {
            float fade = smoothstep(x0, x0 + 60.0, q.x) * (1.0 - smoothstep(u_line.y - 4.0, u_line.y, q.x));
            c = put(c, WHITE, cov(abs(q.y - u_line.z) - 1.2) * (0.35 + 0.65 * fade));
        }
    }
    // the bottom line, on from the scale's bottom end towards the middle
    vec2 b0 = u_path[0];
    if (q.x >= b0.x && q.x <= u_line.w) {
        float fade = 1.0 - smoothstep(u_line.w - 140.0, u_line.w, q.x);
        c = put(c, GREY, cov(abs(q.y - b0.y) - 1.0) * fade);
    }

    float alpha = 1.0;
    if (u_hole.z > 0.0 && u_oval > 0.0) {
        // an oval window, its edge feathered into the black like BMW's map
        vec2 hs = u_hole.zw * 0.5;
        vec2 e = (p - (u_hole.xy + hs)) / hs;
        float ed = (length(e) - 1.0) * min(hs.x, hs.y);     // about px outside the oval
        alpha = smoothstep(-u_oval, 0.0, ed);
    } else if (u_hole.z > 0.0) {
        vec2 hs = u_hole.zw * 0.5;
        vec2 hq = abs(p - (u_hole.xy + hs)) - (hs - vec2(u_holeR));
        float hd = length(max(hq, 0.0)) + min(max(hq.x, hq.y), 0.0) - u_holeR;
        alpha = clamp(hd + 0.5, 0.0, 1.0);
        // a thin grey frame round the window
        c = put(c, GREY, cov(abs(hd - 2.0) - 1.0) * 0.8);
        alpha = max(alpha, cov(abs(hd - 2.0) - 1.0) * 0.8);
    }
    gl_FragColor = vec4(c, alpha);
}
`;

const VDASH = `// The Vector theme in one cluster-render "effect" layer (GLSL ES 1.00): black, angled bracket lines (u_seg), a round
// segmented rev counter (u_tach), four ring gauges (u_ring), three bars in the middle while no map shows (u_bar), and the
// music panel on the right (u_panel: its backdrop; u_vinyl: a record that turns red while something plays; u_prog: the
// track's progress). The middle is cut see-through, an octagon (u_hole, u_holeC), while the Waze map shows ("mapLive").
// v_uv (0,0) is the top-left.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_seg[20];    // the bracket lines: from x, y, to x, y
uniform float u_segW[20];  // each one's width (whole px) + brightness (the fraction: 0 grey .. 0.99 white)
uniform float u_nseg;
uniform vec4 u_tach;       // the rev counter: centre x, y, inner and outer radius of its segments
uniform vec4 u_tachA;      // its start angle (deg, clockwise from 3 o'clock), sweep (deg), segments, revs 0..1
uniform float u_redFrom;   // 0..1 of the rev counter
uniform vec4 u_ring[4];    // the ring gauges: centre x, y, radius, value 0..1 (radius 0 = none)
uniform vec3 u_ringC[4];   // their colours
uniform vec4 u_bar[3];     // the middle bars: left x, y, width (0 = none), value 0..1
uniform vec4 u_panel;      // the music panel's backdrop x, y, w, h (w 0 = none)
uniform vec4 u_vinyl;      // the record: centre x, y, radius; w: 1 while something plays
uniform vec4 u_prog;       // the progress line: left x, y, width, value 0..1
uniform vec4 u_hole;       // the map window x, y, w, h (w 0 = none)
uniform float u_holeC;     // its corners cut this far

const vec3 WHITE = vec3(0.93, 0.94, 0.96);
const vec3 GREY = vec3(0.5, 0.53, 0.58);
const vec3 TRACK = vec3(0.15, 0.16, 0.19);
const vec3 RED = vec3(0.95, 0.12, 0.14);

float cov(float d) { return clamp(0.5 - d, 0.0, 1.0); }
vec3 put(vec3 c, vec3 col, float a) { return mix(c, col, clamp(a, 0.0, 1.0)); }
float segd(vec2 p, vec2 a, vec2 b) {
    vec2 ba = b - a;
    float h = clamp(dot(p - a, ba) / max(dot(ba, ba), 0.001), 0.0, 1.0);
    return length(p - a - ba * h);
}
// signed distance (about px) to a box with its corners cut at 45 degrees
float octd(vec2 p, vec4 r, float ch) {
    vec2 hs = r.zw * 0.5;
    vec2 q = abs(p - (r.xy + hs));
    return max(max(q.x - hs.x, q.y - hs.y), (q.x + q.y - (hs.x + hs.y - ch)) * 0.70710678);
}

void main() {
    vec2 p = v_uv * u_size;
    vec3 c = vec3(0.0);
    bool playing = u_vinyl.w > 0.5;

    // the music panel: a dark plate with cut corners and a thin edge
    if (u_panel.z > 0.0) {
        float d = octd(p, u_panel, 26.0);
        c = put(c, vec3(0.05, 0.053, 0.06), cov(d));
        c = put(c, vec3(0.2, 0.21, 0.24), cov(abs(d) - 0.8));
    }
    // the record: grooves, a sheen, the label red while something plays
    if (u_vinyl.z > 0.0) {
        vec2 d = p - u_vinyl.xy;
        float r = length(d), R = u_vinyl.z;
        if (r < R + 2.0) {
            vec3 vc = vec3(0.025);
            float groove = 0.5 + 0.5 * sin(r * 0.9);
            vc = mix(vc, vec3(0.1, 0.105, 0.12), groove * smoothstep(R * 0.38, R * 0.42, r) * 0.8);
            float sheen = pow(abs(cos(atan(d.y, d.x) - 0.8)), 12.0) * 0.16 * smoothstep(R * 0.4, R * 0.5, r);
            vc += vec3(sheen);
            vc = mix(vc, playing ? RED * 0.85 : GREY * 0.45, cov(r - R * 0.36));
            vc = mix(vc, vec3(0.0), cov(r - 5.0));
            c = put(c, vc, cov(r - R));
            c = put(c, GREY * 0.7, cov(abs(r - R) - 0.8));
        }
    }
    // the progress line, with a dot at the position
    if (playing && u_prog.z > 0.0) {
        float t = (p.x - u_prog.x) / u_prog.z;
        float on = step(0.0, t) * step(t, 1.0);
        float line = cov(abs(p.y - u_prog.y) - 2.0) * on;
        c = put(c, TRACK, line);
        c = put(c, WHITE, line * step(t, u_prog.w));
        c = put(c, WHITE, cov(length(p - vec2(u_prog.x + u_prog.z * u_prog.w, u_prog.y)) - 6.0));
    }

    // the rev counter: segments round the dial, lit up to the revs, red from the redline
    {
        vec2 d = p - u_tach.xy;
        float r = length(d);
        if (r < u_tach.w + 30.0 && r > u_tach.z - 24.0) {
            float rel = mod(degrees(atan(d.y, d.x)) - u_tachA.x + 720.0, 360.0);
            float f = rel / u_tachA.y;
            if (f <= 1.0) {
                float n = u_tachA.z, k = floor(f * n), within = fract(f * n);
                float edge = min(within, 1.0 - within) * radians(u_tachA.y) / n * r;     // px to the segment's side
                float m = cov(-min(r - u_tach.z, u_tach.w - r)) * clamp(edge - 1.5 + 0.5, 0.0, 1.0);
                float mid = (k + 0.5) / n;
                bool red = mid >= u_redFrom;
                vec3 off = red ? vec3(0.3, 0.05, 0.06) : TRACK;
                vec3 lit = red ? RED : mix(GREY, WHITE, mid);
                c = put(c, mid <= u_tachA.w ? lit : off, m);
                // a thin ring inside, and a mark outside at every 1000
                c = put(c, GREY * 0.8, cov(abs(r - (u_tach.z - 14.0)) - 0.7));
                float per = u_tachA.y / 8.0;
                float tk = abs(radians(mod(rel + per * 0.5, per) - per * 0.5)) * r;
                c = put(c, f >= u_redFrom - 0.01 ? RED : WHITE, cov(tk - 1.5) * cov(abs(r - (u_tach.w + 9.0)) - 5.0));
            }
        }
    }

    // the ring gauges: a 300 degree track open at the bottom, filled to the value in the ring's colour
    for (int i = 0; i < 4; i++) {
        vec4 g = u_ring[i];
        if (g.z <= 0.0) continue;
        vec2 d = p - g.xy;
        float r = length(d);
        if (r > g.z + 8.0) continue;
        float f = mod(degrees(atan(d.y, d.x)) - 120.0 + 720.0, 360.0) / 300.0;
        float on = step(f, 1.0);
        float ring = cov(abs(r - g.z) - 4.0) * on;
        c = put(c, TRACK, ring);
        c = put(c, u_ringC[i], ring * step(f, g.w));
        c = put(c, GREY * 0.55, cov(abs(r - g.z + 11.0) - 0.6) * on);
    }

    // the middle bars, with a mark every 10 %
    for (int i = 0; i < 3; i++) {
        vec4 b = u_bar[i];
        if (b.z <= 0.0) continue;
        float t = (p.x - b.x) / b.z;
        float on = step(0.0, t) * step(t, 1.0);
        float bar = cov(abs(p.y - b.y) - 4.0) * on;
        c = put(c, TRACK, bar);
        c = put(c, mix(GREY, WHITE, t), bar * step(t, b.w));
        float mk = abs(fract(t * 10.0 + 0.5) - 0.5) * b.z / 10.0;
        c = put(c, GREY * 0.7, cov(mk - 0.6) * on * cov(abs(p.y - b.y - 13.0) - 3.0));
    }

    // the bracket lines
    for (int i = 0; i < 20; i++) {
        if (float(i) >= u_nseg) break;
        vec4 s = u_seg[i];
        float w = floor(u_segW[i]), br = fract(u_segW[i]);
        c = put(c, mix(GREY, WHITE, br), cov(segd(p, s.xy, s.zw) - w * 0.5));
    }

    float alpha = 1.0;
    if (u_hole.z > 0.0) alpha = clamp(octd(p, u_hole, u_holeC) + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(c, alpha);
}
`;

const SAKURA = `// The Sakura themes in one cluster-render "effect" layer (GLSL ES 1.00): pixel art on a 480 x 180 grid, every art
// pixel 4 x 4 panel px. Back to front: the scene from the RGBA asset u_art (tools/bake_sakura_art.py: scene at 0,0;
// blossom sprites 12 x 12 at 0,180; petals 4 x 4 at 112,180; G ring 40 x 40 at 132,180; G dot 4 x 4 at 176,180; rev
// numerals at 184,180), the falling petals (u_pet: two a vec4, art px, the frame / 8 in x's fraction; never inside a
// plate), the revs, the plates (u_plate, art px: 0 centre, 1 oil, 2 coolant, 3 fuel, 4 boost, 5 G) in u_fill at 92 %
// over the scene with a u_edge border and notched corners, their 10-segment bars (u_bars 0..1: oil, coolant, fuel,
// boost; u_pgeo: the bar's x, y in the plate, segment width, 1 art px apart, 2 tall), the warning state (u_warn: oil,
// coolant, boost, and the 1 Hz blink of the ! block at u_bang in the plate, from its right edge when x < 0: amber plate,
// dark full bar), and the G-meter ring at u_g.zw with its dot u_g.xy art px off its middle.
// The revs (u_rev: x lit, y 0 or shift frame 1 / 2, z shift: the centre plate's border red, w mode):
//   mode 0, blossoms: 14 in an arc, centres 16 art px apart, y = 140 + 0.00037 (x - 960)^2 panel px snapped to 4; a
//     half lit one is opening; lit ones take the shift sprites while shifting. Numerals 1..7 under the arc.
//   mode 1, a segment bar: u_bar (x, y, w, h art px), u_bar2 (pitch, count, segments a thousand rpm, numeral top in 2 px
//     units); the first 5/7 pink, then white, the last 1/7 red, unlit u_track; lit ones white / red while shifting.
//     Numerals 1..7 under the bar at each thousand.
// The numerals are the one finer thing: Press Start 2P's font pixels drawn 2 x 2 panel px, 6 and 7 red. u_keep (art px
// x0, y0, x1, y1) stays see-through: BMW's gear letter in its bottom strip. Texels are read at their centres, so nearest
// and bilinear sampling read the same. v_uv (0,0) is the top-left.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_art;
uniform vec4 u_plate[6];
uniform vec4 u_pet[8];
uniform vec4 u_rev;
uniform vec4 u_bar;
uniform vec4 u_bar2;
uniform vec4 u_bars;
uniform vec4 u_warn;
uniform vec4 u_pgeo;
uniform vec2 u_bang;
uniform vec4 u_g;
uniform vec4 u_keep;
uniform vec3 u_fill;
uniform vec3 u_edge;
uniform vec3 u_track;
uniform float u_dim;

const vec2 ART = vec2(480.0, 220.0);
const vec3 SHIFT = vec3(1.0, 0.176, 0.333);       // #FF2D55
const vec3 AMBER = vec3(1.0, 0.698, 0.22);        // #FFB238, the warning, used nowhere else
const vec3 AMBER_EDGE = vec3(0.78, 0.50, 0.10);
const vec3 INK = vec3(0.102, 0.059, 0.0);         // #1A0F00
const vec3 BAR = vec3(0.561, 0.525, 0.753);       // #8F86C0
const vec3 PINK = vec3(1.0, 0.498, 0.686);        // #FF7FAF: the fuel bar, rev segments
const vec3 WHITE = vec3(1.0, 0.867, 0.922);       // #FFDDEB
const vec3 RED = vec3(1.0, 0.2, 0.267);           // #FF3344: rev segments, numerals 6 and 7
const vec3 NUM = vec3(0.561, 0.525, 0.753);       // #8F86C0, rev numerals

vec4 art(vec2 t) { return texture2D(u_art, (t + 0.5) / ART); }
float inRect(vec2 p, vec4 r) { return step(r.x, p.x) * step(p.x, r.x + r.z - 1.0) * step(r.y, p.y) * step(p.y, r.y + r.w - 1.0); }

void main() {
    vec2 p = floor(v_uv * vec2(480.0, 180.0));
    if (inRect(p, vec4(u_keep.xy, u_keep.zw - u_keep.xy)) > 0.5) { gl_FragColor = vec4(0.0); return; }
    vec3 c = art(p).rgb;

    // which plate (if any) this art pixel is in
    float plate = -1.0;
    vec4 r = vec4(0.0);
    for (int j = 0; j < 6; j++) {
        if (inRect(p, u_plate[j]) > 0.5) { plate = float(j); r = u_plate[j]; }
    }

    // the petals, under the revs and every plate
    if (plate < 0.0) {
        vec2 pc = vec2(-1.0);
        for (int k = 0; k < 8; k++) {
            vec4 e = u_pet[k];
            vec2 o = p - vec2(floor(e.x), e.y);
            if (o.x >= 0.0 && o.x < 4.0 && o.y >= 0.0 && o.y < 4.0)
                pc = vec2(112.0 + floor(fract(e.x) * 8.0 + 0.5) * 4.0 + o.x, 180.0 + mod(float(2 * k), 3.0) * 4.0 + o.y);
            o = p - vec2(floor(e.z), e.w);
            if (o.x >= 0.0 && o.x < 4.0 && o.y >= 0.0 && o.y < 4.0)
                pc = vec2(112.0 + floor(fract(e.z) * 8.0 + 0.5) * 4.0 + o.x, 180.0 + mod(float(2 * k + 1), 3.0) * 4.0 + o.y);
        }
        if (pc.x >= 0.0) { vec4 t = art(pc); c = mix(c, t.rgb, t.a); }
    }

    // the revs, and where numeral k's 8 x 8 cell starts (2 px units)
    vec2 f = floor(v_uv * vec2(960.0, 360.0));
    float k, nx, ny;
    if (u_rev.w < 0.5) {
        float i = floor((p.x - 130.0) / 16.0);
        if (i >= 0.0 && i < 14.0) {
            float cx = 136.0 + 16.0 * i;
            float cy = floor(35.0 + 0.00148 * (cx - 240.0) * (cx - 240.0) + 0.5);
            vec2 q = p - vec2(cx - 6.0, cy - 6.0);
            if (q.x >= 0.0 && q.x < 12.0 && q.y >= 0.0 && q.y < 12.0) {
                float zone = i < 10.0 ? 1.0 : (i < 12.0 ? 3.0 : 5.0);
                float s = i + 1.0 <= u_rev.x ? zone + 1.0 : (i < u_rev.x ? zone : 0.0);
                if (u_rev.y > 0.5 && i < u_rev.x) s = u_rev.y > 1.5 ? 8.0 : 7.0;
                vec4 t = art(vec2(s * 12.0 + q.x, 180.0 + q.y));
                c = mix(c, t.rgb, t.a);
            }
        }
        k = floor((f.x - 252.0) / 64.0);
        float xa = 128.0 + 32.0 * k;
        nx = 252.0 + 64.0 * k;
        ny = 2.0 * floor(35.0 + 0.00148 * (xa - 240.0) * (xa - 240.0) + 0.5) + 10.0;
    } else {
        vec2 b = p - u_bar.xy;
        float si = floor(b.x / u_bar2.x);
        if (b.y >= 0.0 && b.y < u_bar.w && si >= 0.0 && si < u_bar2.y && b.x - si * u_bar2.x < u_bar.z) {
            float fz = (si + 0.5) / u_bar2.y;
            vec3 on = fz < 0.714 ? PINK : (fz < 0.857 ? WHITE : RED);
            if (u_rev.y > 0.5) on = u_rev.y > 1.5 ? RED : WHITE;
            c = si < u_rev.x ? on : u_track;
        }
        float a0 = 2.0 * u_bar.x - (u_bar2.x - u_bar.z) - 4.0, d = 2.0 * u_bar2.z * u_bar2.x;
        k = floor((f.x - a0) / d);
        nx = a0 + k * d;
        ny = u_bar2.w;
    }
    vec2 nq = f - vec2(nx, ny);
    if (k >= 1.0 && k <= 7.0 && nq.x >= 0.0 && nq.x < 8.0 && nq.y >= 0.0 && nq.y < 8.0) {
        vec4 t = art(vec2(184.0 + (k - 1.0) * 8.0 + nq.x, 180.0 + nq.y));
        c = mix(c, k < 6.0 ? NUM : RED, t.a);
    }

    if (plate >= 0.0) {
        vec2 o = p - r.xy;
        float ex = (o.x < 0.5 || o.x > r.z - 1.5) ? 1.0 : 0.0, ey = (o.y < 0.5 || o.y > r.w - 1.5) ? 1.0 : 0.0;
        float warn = plate == 1.0 ? u_warn.x : (plate == 2.0 ? u_warn.y : (plate == 4.0 ? u_warn.z : 0.0));
        if (ex * ey < 0.5) {                                  // the corners are notched: the scene shows there
            vec3 edge = plate == 0.0 && u_rev.z > 0.5 ? SHIFT : (warn > 0.5 ? AMBER_EDGE : u_edge);
            c = ex + ey > 0.5 ? edge : (warn > 0.5 ? AMBER : mix(c, u_fill, 0.92));
            // the bar: 10 segments of u_pgeo.z art px, 1 apart, 2 tall
            if (plate > 0.5 && plate < 4.5) {
                float v = plate == 1.0 ? u_bars.x : (plate == 2.0 ? u_bars.y : (plate == 3.0 ? u_bars.z : u_bars.w));
                float b = o.x - u_pgeo.x, pitch = u_pgeo.z + 1.0, seg = floor(b / pitch);
                if (o.y >= u_pgeo.y && o.y < u_pgeo.y + 2.0 && b >= 0.0 && seg < 10.0 && mod(b, pitch) < u_pgeo.z) {
                    float on = warn > 0.5 || seg + 0.5 < v * 10.0 ? 1.0 : 0.0;
                    c = warn > 0.5 ? INK : mix(u_track, plate == 3.0 ? PINK : BAR, on);
                }
            }
            // the ! block while warning, blinking
            vec2 bq = o - vec2(u_bang.x < 0.0 ? r.z + u_bang.x : u_bang.x, u_bang.y);
            if (warn > 0.5 && u_warn.w > 0.5 && bq.x >= 0.0 && bq.x < 7.0 && bq.y >= 0.0 && bq.y < 9.0) {
                c = INK;
                if (bq.x >= 3.0 && bq.x < 4.0 && ((bq.y >= 1.0 && bq.y < 6.0) || (bq.y >= 7.0 && bq.y < 8.0))) c = AMBER;
            }
        }
        // the G-meter ring and its dot
        if (plate == 5.0 && u_g.z > 0.0) {
            vec2 g = p - u_g.zw;
            if (g.x >= 0.0 && g.x < 40.0 && g.y >= 0.0 && g.y < 40.0) {
                vec4 t = art(vec2(132.0, 180.0) + g);
                c = mix(c, t.rgb, t.a);
                vec2 d = g - (vec2(18.0) + u_g.xy);
                if (d.x >= 0.0 && d.x < 4.0 && d.y >= 0.0 && d.y < 4.0) {
                    vec4 t2 = art(vec2(176.0, 180.0) + d);
                    c = mix(c, t2.rgb, t2.a);
                }
            }
        }
    }
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

const PHOTO = `// A photo theme in one cluster-render "effect" layer (GLSL ES 1.00), My Boy's; every position is in layer px (u_size),
// sent by hud.js from panel px. Back to front: a night-blue background (u_bg at the top to u_bg2 at the bottom) with
// faint twinkling stars (one chance a 48 px cell; u_t is a phase 0..2 pi, each star runs at 1, 2 or 3 times it), a soft
// halo behind the photo (u_halo: centre x, y and radius x, y), the photo from the RGBA asset u_art drawn 1:1 at u_photo
// (x, y, w, h; its alpha is the cut-out; texels are read at their centres, so nearest and bilinear sampling read the
// same), and two checker rev strips (u_stripL / u_stripR: x, y, w, h, two rows of u_sq px squares in the romper's blue
// and cream) that fill from their outer ends towards the photo, mirrored. u_rev: x columns lit (of each strip's
// w / u_sq), y the first red column, z the shift flash (0 or 1). u_keep (x0, y0, x1, y1) stays see-through: BMW's gear
// letter in its bottom strip. A heart in u_pink at u_heart (centre x, y, size px, scale: it breathes while the car
// stands). One texture read (the photo), no loops. v_uv (0,0) is the top-left.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_art;
uniform vec2 u_size;
uniform vec4 u_photo;
uniform vec4 u_halo;
uniform vec4 u_stripL;
uniform vec4 u_stripR;
uniform vec4 u_rev;
uniform vec4 u_keep;
uniform vec4 u_heart;
uniform vec3 u_bg;
uniform vec3 u_bg2;
uniform vec3 u_blue;
uniform vec3 u_cream;
uniform vec3 u_red;
uniform float u_sq;
uniform float u_t;
uniform float u_dim;

// Dave Hoskins' hash (no sin, so it holds in mediump): 0..1 from a small whole-number cell
float hash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}

// Inigo Quilez's heart: signed distance, the heart in x -0.6..0.6, y 0..1 (y up)
float heart(vec2 p) {
    p.x = abs(p.x);
    if (p.y + p.x > 1.0) return length(p - vec2(0.25, 0.75)) - 0.35355;
    vec2 a = p - vec2(0.0, 1.0), b = p - 0.5 * max(p.x + p.y, 0.0);
    return sqrt(min(dot(a, a), dot(b, b))) * sign(p.x - p.y);
}

// a checker strip's colour at p (rgb), a = 1 on a square; fromRight: it fills from its right end
vec4 strip(vec2 p, vec4 s, float fromRight) {
    vec2 q = p - s.xy;
    if (q.x < 0.0 || q.y < 0.0 || q.x >= s.z || q.y >= s.w) return vec4(0.0);
    vec2 cell = floor(q / u_sq), o = q - cell * u_sq;
    if (o.x < 2.0 || o.y < 2.0 || o.x >= u_sq - 2.0 || o.y >= u_sq - 2.0) return vec4(0.0);   // 4 px between squares
    float k = fromRight > 0.5 ? floor(s.z / u_sq) - 1.0 - cell.x : cell.x;   // columns counted from the outer end
    float cream = mod(k + cell.y, 2.0);
    vec3 off = mix(u_bg, cream > 0.5 ? u_cream : u_blue, cream > 0.5 ? 0.13 : 0.24);
    vec3 on = cream > 0.5 ? u_cream : u_blue;
    if (k >= u_rev.y) on = cream > 0.5 ? mix(u_cream, u_red, 0.45) : u_red;
    if (u_rev.z > 0.5) on = cream > 0.5 ? u_cream : u_red;
    return vec4(k < u_rev.x ? on : off, 1.0);
}

void main() {
    vec2 p = floor(v_uv * u_size) + 0.5;
    if (p.x >= u_keep.x && p.x < u_keep.z && p.y >= u_keep.y && p.y < u_keep.w) { gl_FragColor = vec4(0.0); return; }
    vec3 c = mix(u_bg, u_bg2, v_uv.y);

    // stars: at most one a 48 px cell, fading out below y 300, each twinkling at its own pace
    vec2 cell = floor(p / 48.0);
    float h = hash(cell);
    if (h > 0.62) {
        vec2 sp = cell * 48.0 + 8.0 + 32.0 * vec2(hash(cell + 17.0), hash(cell + 41.0));
        float d = length(p - sp);
        float tw = 0.55 + 0.45 * sin(u_t * (1.0 + floor((h - 0.62) * 7.8)) + h * 60.0);   // 1, 2 or 3 x the clock
        float b = (smoothstep(2.2, 0.0, d) + 0.35 * smoothstep(6.0, 0.0, d)) * tw * (1.0 - smoothstep(300.0, 520.0, p.y));
        c = mix(c, mix(u_cream, u_blue, hash(cell + 5.0)), clamp(b, 0.0, 1.0) * 0.55);
    }

    // the halo behind him
    vec2 hd = (p - u_halo.xy) / u_halo.zw;
    c = mix(c, u_blue, 0.42 * exp(-2.2 * dot(hd, hd)));

    // the photo, 1:1
    vec2 q = p - u_photo.xy;
    if (q.x >= 0.0 && q.y >= 0.0 && q.x < u_photo.z && q.y < u_photo.w) {
        vec4 t = texture2D(u_art, (floor(q) + 0.5) / u_photo.zw);
        c = mix(c, t.rgb, t.a);
    }

    // the heart, with a soft glow
    vec2 hq = (p - u_heart.xy) / (u_heart.z * u_heart.w);
    if (u_heart.z > 0.0 && abs(hq.x) < 1.2 && abs(hq.y) < 1.2) {
        float hd2 = heart(vec2(hq.x, 0.44 - hq.y) * 1.25) * u_heart.z * u_heart.w / 1.25;
        c = mix(c, u_red, 0.35 * exp(-0.18 * max(hd2, 0.0)) * step(0.0, hd2));
        c = mix(c, u_red, clamp(0.5 - hd2, 0.0, 1.0));
    }

    vec4 s = strip(p, u_stripL, 0.0);
    if (s.a > 0.5) c = s.rgb;
    s = strip(p, u_stripR, 1.0);
    if (s.a > 0.5) c = s.rgb;
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------------
// Scene themes (widget type "scene", hud.js _sceneUpdate): a whole theme's backdrop in one effect layer, drawn with no
// pictures. Every scene gets the same inputs; positions are layer px (u_size), (0,0) the top-left:
//   u_drive   x speed 0..1 (of 200 km/h), y revs 0..1 (of the bar max), z the shift flash (0 / 1), w the redline 0..1
//   u_a   the scene's clocks (distance and time phases, hud.js says which)       (Night Drive, Warp, Light Trails)
//   u_b   the scene's numbers                                                     (Paper; the canvas designs, below)
//   u_g   the G dot, the warning and the shift point                              (the canvas designs, below)
//   u_c1..u_c4 the theme's colour roles c1..c4; u_keep (x0, y0, x1, y1) stays see-through (BMW's gear letter); u_dim
// Every scene stays small for the cluster's GPU: no textures, loops of at most four.
const SCENE_HEAD = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_drive;
uniform vec4 u_keep;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform vec3 u_c4;
uniform float u_dim;
float hash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
bool kept(vec2 p) { return p.x >= u_keep.x && p.x < u_keep.z && p.y >= u_keep.y && p.y < u_keep.w; }
`;

// Night Drive: a purple sky over a neon grid that runs towards you with the speed, a striped sun whose glow pulses with
// the revs, mountains at the sides. The revs light the horizon line from the middle out. u_a: x the grid's phase, y the
// mountains' offset (px), z seconds. c1 the night sky, c2 magenta, c3 the sun's yellow, c4 the grid's cyan.
const SCENE_SYNTH = SCENE_HEAD + `uniform vec4 u_a;
const float HZ = 400.0;
void main() {
    vec2 p = floor(v_uv * u_size) + 0.5;
    if (kept(p)) { gl_FragColor = vec4(0.0); return; }
    vec3 c;
    if (p.y < HZ) {
        c = mix(u_c1, u_c2 * 0.85, (p.y / HZ) * (p.y / HZ));
        vec2 cell = floor(p / 36.0);
        float h = hash(cell);
        if (h > 0.86 && p.y < 270.0) {
            vec2 sp = cell * 36.0 + 6.0 + 24.0 * vec2(hash(cell + 3.1), hash(cell + 7.7));
            c += vec3(smoothstep(1.6, 0.0, length(p - sp)) * (0.45 + 0.55 * fract(h * 13.0 + u_a.z * 0.25)));
        }
        vec2 sc = vec2(960.0, HZ - 30.0);
        float R = 210.0, d = length(p - sc);
        c += u_c2 * 0.45 * (0.6 + 0.9 * u_drive.y) * exp(-max(d - R, 0.0) / 70.0) * step(R, d);
        if (d < R) {
            vec3 sun = mix(u_c3, u_c2, smoothstep(0.1, 0.95, (p.y - (sc.y - R)) / (2.0 * R)));
            float b = p.y - (sc.y - 0.25 * R);
            if (!(b > 0.0 && mod(b, 22.0) < 2.0 + 10.0 * b / (1.25 * R))) c = sun;
        }
        float mx = p.x + u_a.y;
        float hg = max(95.0 * (1.0 - abs(fract(mx / 430.0) * 2.0 - 1.0)), 60.0 * (1.0 - abs(fract((mx + 170.0) / 270.0) * 2.0 - 1.0)));
        hg *= smoothstep(230.0, 560.0, abs(p.x - 960.0));
        float top = HZ - hg;
        if (p.y > top) c = mix(u_c1 * 0.7, u_c2 * 0.22, (p.y - top) / max(hg, 1.0));
        if (abs(p.y - top) < 1.5 && hg > 3.0) c = u_c4;
    } else {
        float y = p.y - HZ + 0.5;
        c = mix(u_c1 * 0.55, vec3(0.02, 0.0, 0.05), smoothstep(0.0, 320.0, y));
        float z = 4200.0 / y, f = fract(z / 60.0 + u_a.x), dz = 4200.0 / (y * y) / 60.0 * 1.8;
        float h1 = 1.0 - smoothstep(dz * 0.5, dz * 1.5, min(f, 1.0 - f));
        float g = fract((p.x - 960.0) / y * 2.2), dw = 2.2 / y * 1.4;
        float v1 = 1.0 - smoothstep(dw * 0.5, dw * 1.5, min(g, 1.0 - g));
        float line = max(h1, v1) * smoothstep(0.0, 30.0, y);
        c = mix(c, u_c4, line * 0.9) + u_c4 * 0.1 * line;
        c += u_c2 * 0.28 * exp(-y / 40.0) * exp(-abs(p.x - 960.0) / 420.0);
    }
    float hy = abs(p.y - HZ);
    if (hy < 5.0) {
        float f = abs(p.x - 960.0) / 960.0;
        vec3 on = f >= u_drive.w ? vec3(1.0, 0.25, 0.25) : mix(vec3(1.0), u_c4, f);
        if (u_drive.z > 0.5) on = vec3(1.0, 0.2, 0.3);
        c = mix(c, f < u_drive.y ? on : u_c2 * 0.55, 1.0 - smoothstep(1.5, 5.0, hy));
    }
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

// Neon Highway: driving down a neon highway into a striped synthwave sun, rows of low-poly neon palms on both sides,
// a grid floor, low-poly mountains, a ringed planet and a big dim one, stars. The lane dashes, the grid and the palms
// come at you with the speed (u_a.x: how far you've driven, in world units, the road's half width being 1). The revs
// light the road's two edges from the bottom of the cluster towards the sun (cyan, magenta, red from the redline),
// flashing at the shift point; the sun's glow pulses with them. u_a: x the distance, y seconds.
const SCENE_HIGHWAY = SCENE_HEAD + `uniform vec4 u_a;
uniform vec4 u_b;
const float HZ = 410.0;
const float G = 1.355;
const float D = 900.0;
float seg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
// a leaf from a to b, a long kite at most w wide each side, widest 0.3 of the way: x the distance from its rib, y from
// its outline (< 0 inside)
vec2 leaf(vec2 p, vec2 a, vec2 b, float w) {
    vec2 pa = p - a, ba = b - a;
    float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0), d = length(pa - ba * t);
    return vec2(d, d - w * min(t / 0.3, (1.0 - t) / 0.7));
}
// a palm in its own units (its foot at 0, 1 tall, x outwards from the road), h its hash, e an edge's width: 0 outside,
// 1 its dark body, 2 a neon edge (outlines, the leaves' ribs, the trunk's rings)
float palm(vec2 q, float h, float e) {
    float lean = 0.08 + 0.14 * h;
    vec2 mid = vec2(lean * 0.25, -0.5), top = vec2(lean, -1.0), d = q - top;
    float dd = min(seg(q, vec2(0.0), mid), seg(q, mid, top)) - mix(0.055, 0.03, clamp(-q.y, 0.0, 1.0));
    bool rib = dd < 0.0 && fract(q.y * 13.0) < 0.12;
    // seven drooping fronds over the top, each a long kite: the two nearest this point's angle
    float a = atan(d.y, d.x);
    if (a > 1.5708) a -= 6.2832;
    float fk = clamp((a + 3.1416) / 0.4488 - 0.5, 0.0, 6.0);
    for (int j = 0; j < 2; j++) {
        float th = -3.1416 + (min(floor(fk) + float(j), 6.0) + 0.5) * 0.4488 + (h - 0.5) * 0.3;
        vec2 dir = vec2(cos(th), sin(th)), l = leaf(q, top, top + dir * 0.6 + vec2(0.0, 0.12 + 0.2 * dir.x * dir.x), 0.09);
        if (l.y < dd) { dd = l.y; rib = l.x < e * 0.5; }
    }
    return dd < -e ? (rib ? 2.0 : 1.0) : dd < 0.0 ? 2.0 : 0.0;
}
void main() {
    vec2 p = floor(v_uv * u_size) + 0.5;
    if (kept(p)) { gl_FragColor = vec4(0.0); return; }
    // the road follows the drive (u_b.x, the bend): the view banks into it (1.1 degrees a unit), a row of the ground at
    // depth Z has the road's middle 329 B Z / (30 + Z) px out (the road bending away with Z squared, its far end 329 B
    // px out), and all at the horizon swings H = 190 B px towards it (less, so the sun stays clear of the figures)
    float B = u_b.x, ca = cos(0.02 * B), sa = sin(0.02 * B), H = 190.0 * B;
    p -= vec2(960.0, 560.0);
    p = vec2(960.0, 560.0) + vec2(ca * p.x + sa * p.y, ca * p.y - sa * p.x);
    // k2 the speed effects (from 30 km/h, full at 120), k3 the strongest ones (from 50 km/h, full at 150)
    float T = u_a.x, sx = p.x - 960.0 - H, ax = abs(sx), k2 = smoothstep(0.15, 0.6, u_drive.x), k3 = smoothstep(0.25, 0.75, u_drive.x);
    vec3 hzc = vec3(0.98, 0.30, 0.52), c;
    if (p.y < HZ) {
        // the sky, faint scan lines, stars
        float t = p.y / HZ;
        c = mix(vec3(0.05, 0.02, 0.15), vec3(0.34, 0.05, 0.38), smoothstep(0.0, 0.62, t));
        c = mix(c, hzc, smoothstep(0.55, 1.0, t)) * (0.93 + 0.07 * step(2.0, mod(p.y, 6.0)));
        vec2 ps = p - vec2(0.5 * H, 0.0), cell = floor(ps / 36.0);
        float sh = hash(cell);
        if (sh > 0.86 && p.y < 260.0) c += vec3(smoothstep(1.6, 0.0, length(ps - cell * 36.0 - 6.0 - 24.0 * vec2(hash(cell + 3.1), hash(cell + 7.7))))) * (0.45 + 0.55 * fract(sh * 13.0 + u_a.y * 0.25));
        // a big dim planet top left; a ringed one top right (the ring behind it, then in front)
        float bp = length(ps - vec2(330.0, 64.0));
        c = mix(c, mix(vec3(0.55, 0.12, 0.30), vec3(0.16, 0.03, 0.16), smoothstep(-90.0, 110.0, ps.x - 330.0 + p.y - 64.0)), 0.8 * smoothstep(106.0, 104.0, bp));
        vec2 rp = ps - vec2(1585.0, 118.0), rr = vec2(rp.x * 0.978 + rp.y * 0.208, rp.y * 0.978 - rp.x * 0.208);
        float re = length(rr / vec2(74.0, 13.0)), ring = step(0.8, re) * step(re, 1.0);
        vec3 rc = mix(vec3(1.0, 0.80, 0.30), vec3(1.0, 0.42, 0.22), (re - 0.8) * 5.0);
        if (ring > 0.0 && rr.y < 0.0) c = rc;
        if (length(rp) < 30.0) c = mix(vec3(1.0, 0.50, 0.32), vec3(0.42, 0.07, 0.28), smoothstep(-25.0, 30.0, rp.x + rp.y));
        if (ring > 0.0 && rr.y >= 0.0) c = rc;
        // the sun: yellow to orange to pink, slices cut from its lower part, its glow pulsing with the revs
        vec2 sc = vec2(960.0 + H, HZ - 18.0), sv = p - sc;
        float R = 205.0, d = length(sv), fl = u_b.w;
        c += vec3(1.0, 0.30, 0.55) * 0.5 * (0.6 + 0.9 * u_drive.y + 0.6 * k3 + 1.2 * fl) * exp(-max(d - R, 0.0) / (80.0 + 60.0 * k3 + 80.0 * fl)) * step(R, d);
        c += vec3(1.0, 0.62, 0.40) * 0.7 * fl * pow(max(0.0, sin(atan(sv.y, sv.x) * 16.0 + u_a.y * 0.8)), 12.0) * exp(-max(d - R, 0.0) / 260.0) * step(R, d);
        if (d < R) {
            float st = (p.y - sc.y + R) / (2.0 * R), b = p.y - sc.y + 0.12 * R;
            vec3 sun = mix(mix(vec3(1.0, 0.95, 0.32), vec3(1.0, 0.55, 0.24), smoothstep(0.1, 0.55, st)), vec3(1.0, 0.24, 0.52), smoothstep(0.5, 0.95, st));
            if (!(b > 0.0 && mod(b, 24.0) < 2.0 + 11.0 * b / (1.12 * R))) c = sun * (1.0 + 0.25 * fl);
        }
        // low-poly mountains at the sides: faces towards the sun lit, a cyan edge
        float mx = p.x - H, w1 = fract((mx + 37.0) / 300.0), w2 = fract((mx + 140.0) / 190.0);
        float h1 = (1.0 - abs(w1 * 2.0 - 1.0)) * (70.0 + 60.0 * hash(vec2(floor((mx + 37.0) / 300.0), 2.0)));
        float h2 = (1.0 - abs(w2 * 2.0 - 1.0)) * (40.0 + 40.0 * hash(vec2(floor((mx + 140.0) / 190.0), 5.0)));
        float k = smoothstep(150.0, 430.0, ax), hg = max(h1, h2) * k, top = HZ - hg;
        if (p.y > top) {
            bool lit = ((h1 >= h2 ? w1 : w2) > 0.5) == (sx < 0.0);
            c = mix(vec3(0.30, 0.07, 0.40), vec3(0.10, 0.02, 0.18), (p.y - top) / max(hg, 1.0)) * (lit ? 1.4 : 0.75);
        }
        if (abs(p.y - top) < 1.5 && hg > 3.0) c = vec3(0.35, 0.95, 1.0);
    } else {
        // the ground: Z ahead, X to the side (the road |X| < 1); things fixed in the world are fixed in Z + T
        float y = p.y - HZ + 0.5, Z = D / y, rx = p.x - 960.0 - 329.3 * B * Z / (30.0 + Z), X = rx / (G * y), aX = abs(X), dz = D / (y * y);
        if (aX < 1.0) {
            // the road, the sun on its wet asphalt, two dashed lane lines
            c = mix(vec3(0.12, 0.04, 0.18), vec3(0.03, 0.02, 0.08), smoothstep(0.0, 220.0, y));
            c += hzc * 0.35 * exp(-y / 60.0) * exp(-aX * 2.5);
            float fd = fract((Z + T) / 2.4), dl = 0.3 + 0.55 * k2;
            float dash = mix(step(fd, dl) * (1.0 - 0.75 * k2 * fd / dl), dl * 0.6, smoothstep(0.1, 0.4, dz / 2.4)), lw = max(1.2, 0.035 * G * y);
            c = mix(c, vec3(0.90, 0.88, 1.0), dash * smoothstep(lw * 0.5 + 0.8, lw * 0.5 - 0.2, abs(aX - 0.3333) * G * y) * smoothstep(0.0, 20.0, y));
        } else {
            // the grid floor
            c = mix(vec3(0.07, 0.02, 0.16), vec3(0.01, 0.0, 0.05), smoothstep(0.0, 300.0, y));
            float f = fract((Z + T) / 1.2), dr = dz / 1.2 * 1.8, g = fract(aX * 2.0), dw = 2.8 * (y + abs(rx)) / (G * y * y);   // (a step down a row moves along the lines too, off to the side)
            float v1 = (1.0 - smoothstep(dw * 0.5, dw * 1.5, min(g, 1.0 - g))) * min(1.0, 0.25 / dw) * smoothstep(0.0, 30.0, y);
            float line = max((1.0 - smoothstep(dr * 0.5, dr * 1.5 + 0.3 * k2, min(f, 1.0 - f))) * min(1.0, 0.12 / dr) * (1.0 - 0.5 * k2) * smoothstep(0.0, 30.0, y), v1);
            vec3 gc = mix(vec3(0.20, 0.55, 1.0), vec3(0.75, 0.30, 1.0), k3);
            c = mix(c, gc, line * 0.85) + gc * 0.12 * line;
            float hp = hash(vec2(floor(aX * 2.0 + 0.5), step(0.0, rx))), pz = fract((Z + T * 1.8) / 9.0 + hp);
            c += vec3(1.0, 0.55, 0.95) * v1 * k2 * step(0.3, hp) * smoothstep(0.1 + 0.3 * k2, 0.0, pz) * 1.8;
            c += hzc * 0.3 * (1.0 + k2) * exp(-y / 35.0);
        }
        // the road's edges: the revs, lit from the bottom of the cluster towards the sun
        float s = (720.0 - p.y) / (720.0 - HZ), ex = abs(aX - 1.0) * G * y, ew = max(2.0, 0.05 * G * y);
        vec3 on = s >= u_drive.w ? vec3(1.0, 0.22, 0.25) : mix(vec3(0.45, 1.0, 1.0), vec3(1.0, 0.40, 0.90), s);
        if (u_drive.z > 0.5) on = vec3(1.0, 0.85, 0.90);
        vec3 ec = s < u_drive.y || u_drive.z > 0.5 ? on : vec3(0.32, 0.20, 0.62);
        ec = mix(ec * (1.0 + 1.2 * k2 * step(fract((Z + T * 1.5) / 6.0), 0.25)), vec3(1.0, 0.15, 0.2), u_b.y);
        c = mix(c, ec, smoothstep(ew * 0.5 + 1.0, ew * 0.5, ex)) + ec * (0.5 + 0.4 * k2) * exp(-ex / (5.0 + 0.05 * y));
    }
    // the palms, a pair every 10 (480 = 48 pairs), 3.4 out either side of the road where it is at their depth, drawn
    // far to near
    float n0 = floor(T / 10.0);
    for (int i = 0; i < 3; i++) {
        float n = n0 + 3.0 - float(i), Zp = n * 10.0 - T, yb = D / Zp, s = G * yb * 2.6, cx = p.x - 960.0 - 329.3 * B * Zp / (30.0 + Zp), side = step(0.0, cx);
        vec2 q = (vec2(abs(cx), p.y) - vec2(3.4 * G * yb, HZ + yb)) / s;
        if (q.x > -0.75 && q.x < 0.95 && q.y > -1.65 && q.y < 0.05) {
            float v = palm(q, hash(vec2(mod(n, 48.0), side)), 1.8 / s), fog = smoothstep(20.0, 29.5, Zp);
            if (v > 1.5) c = mix(vec3(0.30, 0.95, 1.0), c, fog * 0.8);
            else if (v > 0.5) c = mix(vec3(0.03, 0.03, 0.12), c, fog);
        }
    }
    // at speed: streaks of light flying out of the vanishing point, the edges of the view darker
    if (k3 > 0.0) {
        vec2 v = p - vec2(960.0 + H, HZ);
        float r = length(v), an = atan(v.y, v.x) / 6.2832 * 260.0, h = hash(vec2(floor(an), 9.0));
        float sl = fract(log(r) * 1.6 - u_a.z * (1.0 + floor(h * 3.0)) + h * 7.0), ln = 0.1 + 0.12 * k3;
        c += mix(vec3(0.75, 0.92, 1.0), vec3(1.0, 0.6, 0.95), step(0.85, h)) * 1.1 * k3 * step(0.4, h) * step(sl, ln) * (1.0 - sl / ln)
            * smoothstep(0.3, 0.12, abs(fract(an) - 0.5)) * smoothstep(60.0, 360.0, r);
        float vg = smoothstep(0.5, 1.15, length(v / vec2(960.0, 430.0)));
        c = c * (1.0 - 0.6 * k3 * vg) + vec3(0.30, 0.0, 0.25) * 0.25 * k3 * vg;
    }
    // braking hard: the scene runs red, with a flash as it starts
    c = mix(c, vec3(dot(c, vec3(0.5, 0.35, 0.15)) * 1.4 + 0.1, 0.02, 0.07), 0.5 * u_b.y) + vec3(1.0, 0.08, 0.12) * 0.45 * u_b.z;
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

// Warp: stars streaming out of the middle, dots when slow, long streaks when fast; the revs a ring round the middle
// (from 7:30 round to 4:30), the whole sky flashing at the shift point. u_a: x the distance travelled through the stars,
// y seconds. c1 space, c2 the stars' blue, c3 the ring's cyan and the glow ahead, c4 the red zone.
const SCENE_WARP = SCENE_HEAD + `uniform vec4 u_a;
const vec2 C = vec2(960.0, 330.0);
void main() {
    vec2 p = floor(v_uv * u_size) + 0.5;
    if (kept(p)) { gl_FragColor = vec4(0.0); return; }
    vec2 d = p - C;
    float r = length(d), a = atan(d.y, d.x) / 6.2831853 + 0.5;
    vec3 c = u_c1 + u_c2 * 0.08 * (0.5 + 0.5 * sin(p.x * 0.0035 + 1.3 + u_a.y * 0.02) * sin(p.y * 0.006 - 0.7));
    c += u_c3 * 0.2 * exp(-r / (120.0 + 280.0 * u_drive.x));
    for (int i = 0; i < 3; i++) {
        float n = 110.0 + 70.0 * float(i);
        float s = floor(a * n);
        vec2 hs = vec2(s, float(i) * 17.0);
        float h = hash(hs);
        if (h > 0.4) {
            float ph = fract(hash(hs + 5.0) + u_a.x * (0.5 + 0.5 * h));
            float rs = 24.0 * exp(ph * 3.9), len = rs * (0.02 + 0.6 * u_drive.x);
            float da = abs(a - (s + 0.25 + 0.5 * hash(hs + 9.0)) / n) * 6.2831853 * r;
            float w = 0.5 + 1.6 * ph;
            if (da < w && r < rs && r > rs - len - 1.5)
                c += mix(u_c2, vec3(1.0), ph) * clamp((r - (rs - len)) / max(len, 1.0), 0.0, 1.0) * (0.35 + 0.65 * ph) * (1.0 - da / w);
        }
    }
    float th = atan(d.x, -d.y), f = (th + 2.3562) / 4.7124;
    if (r > 232.0 && r < 258.0 && f >= 0.0 && f <= 1.0) {
        float seg = f * 45.0;
        if (fract(seg) > 0.16) {
            vec3 on = f >= u_drive.w ? u_c4 : (f < 0.6 ? u_c3 : vec3(1.0));
            if (u_drive.z > 0.5) on = mod(floor(seg), 2.0) < 0.5 ? u_c4 : vec3(1.0);
            c = f < u_drive.y ? on : mix(c, u_c2 * 0.22, 0.85);
        }
    }
    c = mix(c, u_c3 * 0.6, clamp(1.6 - abs(r - 266.0), 0.0, 1.0) * 0.5);
    c += u_c3 * 0.22 * u_drive.z;
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

// Paper: warm paper with a faint grain, as an e-ink page; one hairline with a tick each thousand rpm, inked thick up to
// the revs and in red ink from the redline (all red at the shift point). Nothing else moves. u_b: x the thousands on the
// scale. c1 the paper, c2 the ink, c3 the red ink, c4 the hairline.
const SCENE_PAPER = SCENE_HEAD + `uniform vec4 u_b;
void main() {
    vec2 p = floor(v_uv * u_size) + 0.5;
    if (kept(p)) { gl_FragColor = vec4(0.0); return; }
    float n = hash(floor(p / 2.0)) - 0.5;
    vec3 c = u_c1 * (1.0 + n * 0.035) * (1.0 - 0.06 * smoothstep(500.0, 1100.0, length(p - vec2(960.0, 360.0))));
    float x0 = 240.0, x1 = 1680.0, y0 = 528.0, f = (p.x - x0) / (x1 - x0);
    if (f >= 0.0 && f <= 1.0 && abs(p.y - y0) < 16.0) {
        float dy = abs(p.y - y0);
        float tk = abs(fract(f * u_b.x + 0.5) - 0.5) * (x1 - x0) / u_b.x;
        float ink = clamp(1.6 - dy, 0.0, 1.0);
        if (tk < 1.0 && p.y > y0 - 14.0 && p.y < y0) ink = 1.0;
        bool lit = f < u_drive.y;
        if (lit) ink = max(ink, clamp(5.5 - dy, 0.0, 1.0));
        vec3 inkc = f >= u_drive.w || (u_drive.z > 0.5 && lit) ? u_c3 : u_c2;
        c = mix(c, lit ? inkc : u_c4, ink);
    }
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

// Light Trails: a long-exposure photo of a highway at night: white headlight trails coming, red tail-light trails going,
// all running to the city glowing on the horizon, street lamps passing as soft orbs and lane dashes rushing by; longer,
// brighter streaks the faster you go. The revs a white-to-red light streak at the top. u_a: x the traffic's clock (faster
// with the speed), y the dashes' phase, z seconds. c1 the night, c2 headlights, c3 tail lights, c4 lamps' orange.
const SCENE_TRAILS = SCENE_HEAD + `uniform vec4 u_a;
const vec2 VP = vec2(960.0, 300.0);
float trail(vec2 p, float bx, float seed) {
    float t = (p.y - VP.y) / (720.0 - VP.y);
    if (t <= 0.0) return 0.0;
    float x = VP.x + (bx - VP.x) * t, w = 0.8 + 7.0 * t;
    float d = abs(p.x - x);
    if (d > w * 3.0) return 0.0;
    float z = 1.0 / t;
    float run = 0.25 + 0.75 * smoothstep(0.0, 0.2 + 0.65 * u_drive.x, fract(z * 0.22 - u_a.x * (1.0 + seed * 0.4) + seed));
    return (clamp(w - d + 0.5, 0.0, 1.0) + 0.35 * exp(-d / (w * 1.2))) * run * smoothstep(0.0, 0.08, t);
}
void main() {
    vec2 p = floor(v_uv * u_size) + 0.5;
    if (kept(p)) { gl_FragColor = vec4(0.0); return; }
    vec3 c = mix(u_c1 * 0.5, u_c1 * 2.0 + u_c3 * 0.05, smoothstep(0.0, VP.y, p.y));
    if (p.y < VP.y + 20.0 && p.y > VP.y - 90.0) {
        vec2 cl = floor(p / 34.0);
        float h = hash(cl);
        if (h > 0.45) {
            vec2 bc = cl * 34.0 + 17.0 + 10.0 * (vec2(hash(cl + 3.0), hash(cl + 6.0)) - 0.5);
            float rad = 5.0 + 10.0 * hash(cl + 9.0);
            vec3 bk = h > 0.8 ? u_c4 : (h > 0.62 ? u_c2 * 0.8 : vec3(0.5, 0.6, 1.0));
            c += bk * 0.35 * smoothstep(rad, rad - 2.0, length(p - bc)) * (1.0 - abs(p.y - VP.y + 30.0) / 90.0);
        }
    }
    if (p.y > VP.y) {
        float t = (p.y - VP.y) / (720.0 - VP.y);
        c = mix(vec3(0.03, 0.03, 0.05), vec3(0.06, 0.06, 0.08), t);
        float z = 1.0 / t;
        for (int k = -1; k <= 1; k += 2) {
            float lx = VP.x + float(k) * 260.0 * t;
            if (abs(p.x - lx) < 0.6 + 3.0 * t && fract(z * 0.5 - u_a.y) < 0.45) c += vec3(0.5) * smoothstep(0.0, 0.1, t);
        }
        c += u_c2 * (trail(p, 90.0, 0.0) + 0.9 * trail(p, 360.0, 0.37) + 0.75 * trail(p, 620.0, 0.83));
        c += u_c3 * (0.75 * trail(p, 1300.0, 0.52) + 0.9 * trail(p, 1560.0, 0.71) + trail(p, 1830.0, 0.13));
    }
    for (int i = 0; i < 5; i++) {
        float z = 1.0 + 9.0 * fract((float(i) + u_a.x * 1.4) / 5.0);
        float s = 1.0 / z;
        vec2 L1 = VP + vec2(-1150.0, -330.0) * s, L2 = VP + vec2(1150.0, -330.0) * s;
        float rad = 4.0 + 40.0 * s;
        float b = smoothstep(rad, rad * 0.4, length(p - L1)) + smoothstep(rad, rad * 0.4, length(p - L2));
        c += u_c4 * b * 0.55 * smoothstep(10.0, 6.0, z);
    }
    vec2 r = p - vec2(640.0, 128.0);
    if (r.x > -10.0 && r.x < 650.0 && abs(r.y) < 12.0) {
        float f = clamp(r.x / 640.0, 0.0, 1.0), dd = max(abs(r.y) - 2.0, max(-r.x, r.x - 640.0));
        bool lit = f < u_drive.y;
        vec3 on = f >= u_drive.w || u_drive.z > 0.5 ? u_c3 : mix(u_c2, u_c3 * 1.2, f * f);
        c = mix(c, lit ? on : u_c1 * 2.5, clamp(1.0 - dd, 0.0, 1.0));
        if (lit) c += on * 0.45 * exp(-max(dd, 0.0) / 5.0);
    }
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

// The canvas designs (the "Sakura 桜 cluster theme" canvas: Aurora and Orbital from its Modern collection, VFD from its
// Terminal variants): their shapes, gauges and light here, their text as text widgets (tools/gen_scenes.py places them
// where the designs do). They get u_b: oil, coolant, fuel and boost
// as their bars' fills 0..1; u_g: x / y the G dot's offset in g (screen directions), z coolant over its limit, w the
// shift point (steady while it lasts; u_drive.z is its 4 Hz blink); u_a.x seconds.

// Aurora (05 · AURORA, Modern EV glass): drifting aurora light behind frosted glass cards, a glowing ring gauge (r 235
// round 960,405, 240 degrees over the top) lit mint to violet up to the revs with a red zone and a white dot at its end,
// orange and pulsing at the shift point; the cards' bars, the G-force ball, the mode pill, the shift / warning pills.
// c1 mint, c2 violet, c3 the shift orange, c4 red.
const SCENE_GLASS = SCENE_HEAD + `uniform vec4 u_a;
uniform vec4 u_b;
uniform vec4 u_g;
const vec3 BG = vec3(0.016, 0.024, 0.043);
const vec3 AMBER = vec3(1.0, 0.761, 0.302);
float rbox(vec2 p, vec4 b, float r) { vec2 q = abs(p - b.xy - b.zw * 0.5) - b.zw * 0.5 + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float blob(vec2 p, vec2 c, vec2 r, float T) {
    float ph = 0.5 - 0.5 * cos(3.14159 * u_a.x / T);
    vec2 d = (p - c - ph * vec2(60.0, 20.0)) / (r * (1.0 + 0.12 * ph));
    return 1.0 - smoothstep(0.45, 1.4, length(d));
}
vec3 grad(float x) { return mix(u_c1, u_c2, clamp((x - 700.0) / 520.0, 0.0, 1.0)); }
// a bar 6 px tall, 360 wide, round ends: its track and its fill (the gradient, or amber when warn)
vec3 bar(vec2 p, vec3 c, vec2 at, float w, float f, float warn) {
    float d = rbox(p, vec4(at, w, 6.0), 3.0);
    if (d > 0.5) return c;
    float k = clamp(0.5 - d, 0.0, 1.0);
    vec3 fill = warn > 0.5 ? AMBER : mix(u_c1, u_c2, (p.x - at.x) / w);
    return mix(c, p.x - at.x < f * w ? fill : mix(c, vec3(1.0), 0.06), k);
}
void main() {
    vec2 p = floor(v_uv * u_size) + 0.5;
    if (kept(p)) { gl_FragColor = vec4(0.0); return; }
    vec3 c = BG;
    c = mix(c, vec3(0.114, 0.914, 0.714), 0.22 * blob(p, vec2(270.0, 120.0), vec2(390.0, 180.0), 18.0));
    c = mix(c, vec3(0.486, 0.302, 1.0), 0.24 * blob(p, vec2(1610.0, 110.0), vec2(430.0, 190.0), 23.0));
    c = mix(c, vec3(0.361, 0.949, 0.788), 0.10 * blob(p, vec2(970.0, 690.0), vec2(410.0, 130.0), 27.0));
    c = mix(c, BG, 0.85 * (1.0 - clamp(length((p - vec2(960.0, 420.0)) / vec2(360.0, 300.0)), 0.0, 1.0)));
    // the two glass cards (the left one's rim amber while the coolant is over its limit)
    for (int k = 0; k < 2; k++) {
        vec4 r = k == 0 ? vec4(180.0, 224.0, 420.0, 376.0) : vec4(1320.0, 224.0, 420.0, 376.0);
        float d = rbox(p, r, 28.0);
        if (d < 0.5) {
            c = mix(c, vec3(1.0), 0.035 * clamp(0.5 - d, 0.0, 1.0));
            if (d > -1.0) c = mix(c, k == 0 && u_g.z > 0.5 ? AMBER : vec3(1.0), k == 0 && u_g.z > 0.5 ? 0.5 : 0.08);
        }
    }
    c = bar(p, c, vec2(210.0, 339.0), 360.0, u_b.x, 0.0);
    c = bar(p, c, vec2(210.0, 417.0), 360.0, u_b.y, u_g.z);
    c = bar(p, c, vec2(210.0, 495.0), 360.0, u_b.z, 0.0);
    c = bar(p, c, vec2(1350.0, 339.0), 360.0, u_b.w, 0.0);
    // the G-force ball: a disc, a ring at half, cross hairs, the dot with its glow
    vec2 gq = p - vec2(1634.0, 446.0);
    float gr = length(gq);
    if (gr < 65.0) {
        c = mix(c, vec3(1.0), 0.02);
        if (abs(gr - 64.0) < 0.7) c = mix(c, vec3(1.0), 0.1);
        if (abs(gr - 32.0) < 0.6 || abs(gq.x) < 0.6 || abs(gq.y) < 0.6) c = mix(c, vec3(1.0), 0.07);
    }
    float gd = length(gq - clamp(u_g.xy * 60.0, vec2(-55.0), vec2(55.0)));
    c = mix(c, u_c1, clamp(9.5 - gd, 0.0, 1.0)) + u_c1 * 0.3 * exp(-max(gd - 9.0, 0.0) / 6.0);
    // the ring gauge
    vec2 d = p - vec2(960.0, 405.0);
    float r = length(d), th = atan(d.x, -d.y), f = (th + 2.0944) / 4.1888;
    bool shift = u_g.w > 0.5;
    float pulse = shift ? 0.775 + 0.225 * sin(u_a.x * 6.2832) : 1.0;
    vec3 lit = shift ? u_c3 : grad(p.x);
    float fe = clamp(u_drive.y, 0.0, 1.0), ae = -2.0944 + fe * 4.1888;
    vec2 E = vec2(960.0, 405.0) + 235.0 * vec2(sin(ae), -cos(ae));
    vec2 S0 = vec2(960.0, 405.0) + 235.0 * vec2(sin(-2.0944), -cos(-2.0944));
    float onArc = f >= 0.0 && f <= 1.0 ? abs(r - 235.0) : min(length(p - S0), length(p - (vec2(960.0, 405.0) + 235.0 * vec2(sin(2.0944), -cos(2.0944)))));
    c = mix(c, vec3(1.0), 0.07 * clamp(6.5 - onArc, 0.0, 1.0));
    if (f >= u_drive.w && f <= 1.0) c = mix(c, u_c4, 0.55 * clamp(6.5 - abs(r - 235.0), 0.0, 1.0));
    float litD = (f >= 0.0 && f <= fe) ? abs(r - 235.0) : min(length(p - S0), length(p - E));
    c += lit * 0.45 * pulse * exp(-max(litD - 5.0, 0.0) / 7.0) * step(litD, 40.0);
    c = mix(c, lit, pulse * clamp(5.5 - litD, 0.0, 1.0));
    for (int k = 0; k <= 7; k++) {
        float a = -2.0944 + float(k) / 7.0 * 4.1888;
        float td = length(p - vec2(960.0, 405.0) - 259.0 * vec2(sin(a), -cos(a)));
        c = mix(c, k == 7 ? u_c4 : vec3(0.541, 0.576, 0.651), clamp(3.0 - td, 0.0, 1.0));
    }
    float ed = length(p - E);
    vec3 dotc = shift ? u_c3 : vec3(1.0);
    c += (shift ? u_c3 : u_c1) * 0.55 * pulse * exp(-max(ed - 11.0, 0.0) / 7.0);
    c = mix(c, dotc, pulse * clamp(11.5 - ed, 0.0, 1.0));
    // the mode pill, and the shift-up / warning pill under the speed
    float pd = rbox(p, vec4(885.0, 232.0, 150.0, 30.0), 15.0);
    if (pd < 0.5) c = mix(c, abs(pd + 0.5) < 1.0 ? mix(c, u_c1, 0.3) : mix(c, u_c1, 0.1), clamp(0.5 - pd, 0.0, 1.0));
    bool blinkOn = u_drive.z > 0.5;
    if ((shift && blinkOn) || (!shift && u_g.z > 0.5)) {
        vec3 pc = shift ? u_c3 : AMBER;
        vec4 pr = shift ? vec4(894.0, 570.0, 132.0, 36.0) : vec4(776.0, 570.0, 368.0, 36.0);
        float sd = rbox(p, pr, 18.0);
        if (sd < 0.5) c = mix(c, abs(sd + 0.5) < 1.0 ? mix(c, pc, 0.6) : mix(c, pc, 0.14), clamp(0.5 - sd, 0.0, 1.0));
        vec2 ic = p - vec2(pr.x + 28.0, 588.0);
        float icon = shift ? min(abs(ic.x) + max(abs(ic.y) - 7.0, 0.0), abs(abs(ic.x) - (ic.y + 7.0))) : min(abs(abs(ic.x) * 1.8 - (ic.y + 8.0) * 0.9), max(abs(ic.y - 8.0), abs(ic.x) - 8.0));
        if (shift && ic.y > 7.5) icon = 9.0;
        if (icon < 1.3 && abs(ic.x) < 9.5 && abs(ic.y) < 9.5) c = pc;
    }
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

// Orbital (08 · ORBITAL, Space telemetry): a star field over a planet's horizon (its rim glowing blue), the revs as a
// satellite going round an orbit (an ellipse 380 x 168 round 960,392: dashed in full, its upper arc lit cyan from the 0 mark
// at its lower left up to the revs, red from 6 500, as the design spaces its 0..7 marks along it), the satellite orange and
// blinking at the shift point; the readouts' 2 px bars, the attitude globe and its G dot, the SHIFT / COOLANT ANOMALY tags.
// c1 cyan, c2 the shift orange, c3 amber, c4 red.
const SCENE_ORBITAL = SCENE_HEAD + `uniform vec4 u_a;
uniform vec4 u_b;
uniform vec4 u_g;
const vec2 OC = vec2(960.0, 392.0);
const vec2 OR = vec2(380.0, 168.0);
const vec3 LINE = vec3(0.102, 0.133, 0.251);
const vec3 GREY = vec3(0.447, 0.510, 0.659);
float rbox(vec2 p, vec4 b) { vec2 q = abs(p - b.xy - b.zw * 0.5) - b.zw * 0.5; return max(q.x, q.y); }
// the orbit's angle (degrees, 150 at the 0 mark .. 390 at the 7 mark) for a fraction of the rev scale, and back: the design
// spaces its marks evenly along the arc's length, so the angles between them differ
float angOf(float f) {
    float k = clamp(f, 0.0, 1.0) * 7.0, a = 150.0;
    a = k < 1.0 ? mix(150.0, 197.6, k) : (k < 2.0 ? mix(197.6, 232.5, k - 1.0) : (k < 3.0 ? mix(232.5, 258.0, k - 2.0) : (k < 4.0 ? mix(258.0, 282.0, k - 3.0) :
        (k < 5.0 ? mix(282.0, 307.5, k - 4.0) : (k < 6.0 ? mix(307.5, 342.4, k - 5.0) : mix(342.4, 390.0, k - 6.0))))));
    return a;
}
float fracOf(float a) {
    float k = a < 197.6 ? (a - 150.0) / 47.6 : (a < 232.5 ? 1.0 + (a - 197.6) / 34.9 : (a < 258.0 ? 2.0 + (a - 232.5) / 25.5 : (a < 282.0 ? 3.0 + (a - 258.0) / 24.0 :
        (a < 307.5 ? 4.0 + (a - 282.0) / 25.5 : (a < 342.4 ? 5.0 + (a - 307.5) / 34.9 : 6.0 + (a - 342.4) / 47.6)))));
    return k / 7.0;
}
vec3 bar2(vec2 p, vec3 c, vec2 at, float w, float f, vec3 col) {
    if (p.y < at.y || p.y >= at.y + 2.0 || p.x < at.x || p.x >= at.x + w) return c;
    return p.x - at.x < f * w ? col : LINE;
}
void main() {
    vec2 p = floor(v_uv * u_size) + 0.5;
    if (kept(p)) { gl_FragColor = vec4(0.0); return; }
    vec3 c = vec3(0.008, 0.012, 0.039);
    vec2 cl = floor(p / 64.0);
    float h = hash(cl);
    vec2 sp = cl * 64.0 + 4.0 + 56.0 * vec2(hash(cl + 3.0), hash(cl + 7.0));
    float tw = h > 0.85 ? 0.15 + 0.55 * (0.5 + 0.5 * sin(u_a.x * 0.785 + h * 40.0)) : 0.15 + 0.35 * hash(cl + 9.0);
    c = mix(c, vec3(0.788, 0.839, 1.0), tw * clamp((h > 0.8 ? 1.9 : 1.4) - length(p - sp), 0.0, 1.0));
    // the planet: a huge disc whose top is at y 640, a soft blue glow above its rim, a bright inner edge
    vec2 pc = vec2(960.0, 2100.0);
    float pd = length(p - pc) - 1460.0;
    if (pd < 0.0) {
        float g = length(p - vec2(960.0, 640.0)) / 3265.0;
        c = g < 0.12 ? mix(vec3(0.043, 0.086, 0.212), vec3(0.020, 0.039, 0.110), g / 0.12) : mix(vec3(0.020, 0.039, 0.110), vec3(0.008, 0.012, 0.039), clamp((g - 0.12) / 0.18, 0.0, 1.0));
        c += vec3(0.239, 0.482, 1.0) * 0.18 * exp(pd / 30.0);
        c = mix(c, vec3(0.49, 0.976, 1.0), 0.45 * clamp(2.0 + pd, 0.0, 1.0));
    } else c += vec3(0.239, 0.482, 1.0) * 0.35 * exp(-pd / 22.0);
    // the orbit: the dashed ellipse, the scale's arc, the lit part, the red zone, its marks, the satellite
    vec2 q = (p - OC) / OR;
    float lq = length(q);
    float ed = (lq - 1.0) / length(q / (OR * max(lq, 0.001)));
    float a = degrees(atan(q.y, q.x));
    if (a < 0.0) a += 360.0;
    float aa = a < 90.0 ? a + 360.0 : a;
    if (abs(ed) < 0.8 && mod(a * 3.6, 8.0) < 2.0) c = mix(c, LINE, 0.9);
    bool onArc = aa >= 150.0 && aa <= 390.0;
    bool shift = u_g.w > 0.5;
    float pulse = shift ? 0.75 + 0.25 * sin(u_a.x * 6.2832) : 1.0;
    vec3 lit = shift ? u_c2 : u_c1;
    if (onArc) {
        float f = fracOf(aa);
        c = mix(c, u_c1, 0.12 * clamp(2.0 - abs(ed), 0.0, 1.0));
        if (f >= u_drive.w) c = mix(c, u_c4, 0.7 * clamp(2.0 - abs(ed), 0.0, 1.0));
        if (f <= u_drive.y) {
            c += lit * 0.5 * pulse * 0.6 * exp(-abs(ed) / 4.0);
            c = mix(c, lit, pulse * clamp(2.0 - abs(ed), 0.0, 1.0));
        }
    }
    for (int k = 0; k <= 7; k++) {
        float ta = radians(angOf(float(k) / 7.0));
        vec2 m = OC + OR * vec2(cos(ta), sin(ta));
        vec2 n = normalize(vec2(cos(ta), sin(ta)) / OR);
        vec2 dm = p - m;
        float along = dot(dm, n), across = dot(dm, vec2(-n.y, n.x));
        if (along > 0.0 && along < 8.0 && abs(across) < 0.75) c = k == 7 ? u_c4 : GREY;
    }
    float sa = radians(angOf(u_drive.y));
    vec2 S = OC + OR * vec2(cos(sa), sin(sa));
    float sd = length(p - S);
    bool sOn = !shift || u_drive.z > 0.5;
    if (sOn) {
        c = mix(c, lit, 0.45 * clamp(1.0 - abs(sd - 15.0), 0.0, 1.0));
        c = mix(c, shift ? u_c2 : vec3(0.933, 0.953, 1.0), clamp(7.5 - sd, 0.0, 1.0));
    }
    // the readouts' 2 px bars (the coolant's amber while over its limit)
    c = bar2(p, c, vec2(180.0, 494.0), 360.0, u_b.x, u_c1);
    c = bar2(p, c, vec2(180.0, 550.0), 360.0, u_b.y, u_g.z > 0.5 ? u_c3 : u_c1);
    c = bar2(p, c, vec2(180.0, 606.0), 360.0, u_b.z, u_c1);
    c = bar2(p, c, vec2(1400.0, 330.0), 320.0, u_b.w, u_c1);
    if (u_g.z > 0.5 && rbox(p, vec4(257.0, 518.0, 78.0, 17.0)) < 0.0) c = u_c3;     // the ANOMALY badge
    // the attitude globe: its disc, latitudes and a meridian, the G dot
    vec2 gq = p - vec2(1630.0, 498.0);
    float gr = length(gq);
    if (gr < 80.5) {
        c = mix(c, u_c1, 0.03);
        float l1 = abs(length(gq / vec2(80.0, 26.0)) - 1.0) * 26.0, l2 = abs(length((gq + vec2(0.0, 28.0)) / vec2(70.4, 20.0)) - 1.0) * 20.0;
        float l3 = abs(length((gq - vec2(0.0, 28.0)) / vec2(70.4, 20.0)) - 1.0) * 20.0, l4 = abs(length(gq / vec2(28.0, 80.0)) - 1.0) * 28.0;
        if (min(min(l1, l2), min(l3, l4)) < 0.7) c = LINE;
    }
    if (abs(gr - 80.0) < 0.7) c = mix(c, GREY, 0.6);
    float dd = length(gq - clamp(u_g.xy * 76.0, vec2(-72.0), vec2(72.0)));
    c = mix(c, u_c1, clamp(8.5 - dd, 0.0, 1.0)) + u_c1 * 0.3 * exp(-max(dd - 8.0, 0.0) / 6.0);
    // the SHIFT tag (blinking fast) or the COOLANT ANOMALY tag (blinking at 1 Hz), top middle
    bool warn = u_g.z > 0.5 && !shift;
    if ((shift && u_drive.z > 0.5) || (warn && fract(u_a.x) < 0.5)) {
        vec4 tr = shift ? vec4(896.0, 128.0, 128.0, 31.0) : vec4(756.0, 128.0, 408.0, 31.0);
        vec3 tc = shift ? u_c2 : u_c3;
        float td = rbox(p, tr);
        if (td < 0.0) c = td > -1.0 ? tc : mix(c, tc, 0.1);
        vec2 ic = p - (shift ? vec2(1000.0, 144.0) : vec2(784.0, 144.0));
        if (shift && ic.y > -6.0 && ic.y < 5.0 && abs(ic.x) < (ic.y + 6.0) * 0.6) c = tc;
        if (!shift && ic.y > -7.0 && ic.y < 7.0 && abs(ic.x) < (ic.y + 7.0) * 0.6 && !(abs(ic.x) < 1.0 && ic.y > -2.0 && ic.y < 5.0 && ic.y != 3.0)) c = tc;
    }
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

// VFD (T4 · VFD on the canvas, an 80s vacuum-fluorescent dash), in three phosphors at once as the multi-colour VFDs
// of the time: the middle cyan, the left panel amber, the right one green. Near-black glass with three recessed panels
// (rims and fills tinted their phosphor) and a faint sheen; the revs as a 40-bar skyline in colour zones (cyan, green,
// amber, orange from half way, red from the redline; the unlit bars a faint tint of theirs), all of it red flashing
// orange at the shift point; segment bars for oil and coolant (amber, orange, red at the hot end; all red over their
// limits), fuel (red at the bottom) and boost (green, amber, red); a 7 x 7 dot grid with the G dot lit (0.2 g a step,
// green, amber from 0.45 g, red from 0.85); and every digit's unlit segments, the ghost 8s, in its panel's tint; the lit
// segments are text over them (the vf_* seven-segment fonts, tools/bake_fonts.py bake_seg, the same geometry). An unlit
// segment or bar is its phosphor at 16 %.
const SCENE_VFD = SCENE_HEAD + `uniform vec4 u_a;
uniform vec4 u_b;
uniform vec4 u_g;
const vec3 BG = vec3(0.008, 0.031, 0.027);
const vec3 CY = vec3(0.435, 1.0, 0.914);
const vec3 GR = vec3(0.549, 1.0, 0.420);
const vec3 AM = vec3(1.0, 0.757, 0.290);
const vec3 OR = vec3(1.0, 0.616, 0.231);
const vec3 RD = vec3(1.0, 0.294, 0.169);
float rbox(vec2 p, vec4 b, float r) { vec2 q = abs(p - b.xy - b.zw * 0.5) - b.zw * 0.5 + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
// distance to the segments of an 8 (and its decimal point when dp), digit-local px before the 6 degree slant;
// g: segment thickness, digit width, height. Folded to a quarter: the top bar, the middle bar, the upper left bar.
float seg8(vec2 q, vec3 g, float dp) {
    float h = 0.5 * g.x, L = 0.5 * g.y - 0.68 * g.x, Lv = 0.25 * g.z - 0.43 * g.x;
    vec2 f = vec2(min(q.x, g.y - q.x), min(q.y, g.z - q.y));
    float m = abs(q.x - 0.5 * g.y), n = abs(f.y - h), k = 0.5 * g.z - f.y;
    float d = min(max(n - h, (n + m - L) * 0.7071), max(k - h, (k + m - L) * 0.7071));
    n = abs(f.x - h);
    m = abs(f.y - 0.68 * g.x - Lv);
    d = min(d, max(n - h, (n + m - Lv) * 0.7071));
    vec2 b = abs(q - vec2(g.y + 0.625 * g.x, g.z - 0.55 * g.x)) - 0.45 * g.x;
    return dp > 0.5 ? min(d, max(b.x, b.y)) : d;
}
// a row of n bars (sz, every pitch px from the top-left at), the first lit of them lit with their glow, the rest unlit;
// bar i in colour ca, cb from bar bi, cr from bar ri
vec3 bars(vec2 p, vec3 c, vec2 at, float n, float pitch, vec2 sz, float lit, vec3 ca, vec3 cb, float bi, vec3 cr, float ri) {
    vec2 q = p - at;
    if (q.y < -12.0 || q.y > sz.y + 12.0 || q.x < -12.0 || q.x > n * pitch + 12.0) return c;
    float i = clamp(floor((q.x + 0.5 * (pitch - sz.x)) / pitch), 0.0, n - 1.0);
    vec2 b = abs(q - vec2(i * pitch + 0.5 * sz.x, 0.5 * sz.y)) - 0.5 * sz;
    float d = length(max(b, 0.0)) + min(max(b.x, b.y), 0.0);
    bool on = i < lit - 0.5;
    vec3 col = i > ri - 0.5 ? cr : i > bi - 0.5 ? cb : ca;
    if (d < 0.0) return on ? col : col * 0.16;
    return on ? c + col * 0.42 * exp(-d / 3.5) : c;
}
void main() {
    vec2 p = floor(v_uv * u_size) + 0.5;
    if (kept(p)) { gl_FragColor = vec4(0.0); return; }
    vec3 c = BG;
    // the three panels: a 2 px rim, recessed (darker towards their edges), tinted amber, cyan, green
    vec4 pr = p.x < 675.0 ? vec4(180.0, 248.0, 470.0, 384.0) : p.x < 1245.0 ? vec4(700.0, 230.0, 520.0, 420.0) : vec4(1270.0, 248.0, 470.0, 384.0);
    vec3 tint = p.x < 675.0 ? AM : p.x < 1245.0 ? CY : GR;
    float pd = rbox(p, pr, 14.0);
    if (pd < 0.0) c = pd > -2.0 ? tint * 0.14 : (tint * 0.045 + 0.004) * (1.0 - 0.4 * (1.0 - smoothstep(0.0, 26.0, -pd - 2.0)));
    // the glass sheen: white at 3.5 % fading out by 35 % along a 115 degree line
    float sh = dot(p - vec2(960.0, 360.0), vec2(0.9063, 0.4226)) / 2044.5 + 0.5;
    c = mix(c, vec3(1.0), 0.035 * max(0.0, 1.0 - sh / 0.35));
    bool shift = u_g.w > 0.5;
    // the rev skyline: 40 bars 14 px wide every 22 px from 520, 14 px tall rising to 64, standing on y 206
    vec2 rq = p - vec2(520.0, 142.0);
    if (rq.x > -12.0 && rq.x < 892.0 && rq.y > -12.0 && rq.y < 76.0) {
        float i = clamp(floor((rq.x + 4.0) / 22.0), 0.0, 39.0);
        float bh = floor(14.0 + i * 50.0 / 39.0 + 0.5);
        vec2 b = abs(p - vec2(527.0 + i * 22.0, 206.0 - 0.5 * bh)) - vec2(7.0, 0.5 * bh);
        float d = length(max(b, 0.0)) + min(max(b.x, b.y), 0.0);
        bool on = i < floor(u_drive.y * 40.0 + 0.5) - 0.5;
        float f = (i + 0.5) / 40.0;
        vec3 zc = f > (u_drive.w > 0.3 ? u_drive.w : 0.93) ? RD : f > 0.5 ? OR : f > 0.42 ? AM : f > 0.3 ? GR : CY;
        vec3 col = shift ? (u_drive.z > 0.5 ? OR : RD) : zc;
        if (d < 0.0) c = on ? col : zc * 0.16;
        else if (on && !(shift && u_drive.z < 0.5)) c += col * 0.45 * exp(-d / 4.0);
    }
    // oil and coolant (red over their limits), fuel, boost
    bool wo = u_a.x > 0.5, wc = u_g.z > 0.5;
    c = bars(p, c, vec2(390.0, 310.0), 12.0, 20.0, vec2(14.0, 28.0), floor(u_b.x * 12.0 + 0.5), wo ? RD : AM, wo ? RD : OR, 8.0, RD, 10.0);
    c = bars(p, c, vec2(390.0, 414.0), 12.0, 20.0, vec2(14.0, 28.0), floor(u_b.y * 12.0 + 0.5), wc ? RD : AM, wc ? RD : OR, 8.0, RD, 10.0);
    c = bars(p, c, vec2(204.0, 580.0), 20.0, 21.0, vec2(15.0, 20.0), floor(u_b.z * 20.0 + 0.5), RD, AM, 3.0, AM, 20.0);
    c = bars(p, c, vec2(1500.0, 310.0), 12.0, 18.0, vec2(12.0, 28.0), floor(u_b.w * 12.0 + 0.5), GR, AM, 8.0, RD, 10.0);
    // the G grid: 7 x 7 dots 26 px apart round 1607,503, the one at the G lit (0.2 g a step), cross hairs over them
    vec2 gq = p - vec2(1607.0, 503.0);
    if (abs(gq.x) < 100.0 && abs(gq.y) < 100.0) {
        vec2 cell = clamp(floor(gq / 26.0 + 0.5), -3.0, 3.0), gl = clamp(floor(u_g.xy / 0.2 + 0.5), -3.0, 3.0);
        float gm = length(u_g.xy);
        vec3 dc = gm < 0.45 ? GR : gm < 0.85 ? AM : RD;
        c = mix(c, cell == gl ? dc : GR * 0.16, clamp(9.5 - length(gq - cell * 26.0), 0.0, 1.0));
        float ld = length(gq - gl * 26.0);
        if (ld > 9.0) c += dc * 0.5 * exp(-(ld - 9.0) / 4.0);
        if ((gq.x > -1.0 && gq.x < 1.0 && abs(gq.y) < 92.0) || (gq.y > -1.0 && gq.y < 1.0 && abs(gq.x) < 92.0)) c = GR * 0.16;
    }
    // the ghost 8s: every digit slot's segments unlit (x, y of its first slot, slots, pitch; thickness, width, height;
    // its phosphor: the clock amber, the range cyan, the outside green as the panels above them)
    vec4 R;
    vec3 G, ph = tint;
    float dp = 0.0;
    if (p.y > 650.0) {
        G = vec3(5.0, 20.0, 36.0);
        R = vec4(p.x < 270.0 ? 206.0 : p.x < 600.0 ? 280.0 : p.x < 1300.0 ? 898.0 : 1556.0, 664.0, p.x > 600.0 && p.x < 1300.0 ? 3.0 : 2.0, 28.0);
        ph = p.x < 600.0 ? AM : p.x < 1300.0 ? CY : GR;
    } else if (p.x < 675.0) {
        G = vec3(8.0, 26.0, 60.0);
        R = vec4(204.0, p.y < 375.0 ? 292.0 : p.y < 479.0 ? 396.0 : 500.0, 3.0, 36.0);
    } else if (p.x > 1245.0) {
        G = vec3(8.0, 26.0, 60.0);
        R = p.y < 387.0 ? vec4(1294.0, 292.0, 3.0, 36.0) : vec4(1294.0, 420.0, 2.0, 36.0);
        dp = 1.0;
    } else if (p.y < 521.0) {
        G = vec3(26.0, 140.0, 226.0);
        R = vec4(890.0, 284.0, 1.0, 170.0);
    } else {
        G = vec3(14.0, 66.0, 104.0);
        R = vec4(843.0, 532.0, 3.0, 82.0);
    }
    vec2 q = p - R.xy;
    if (q.y > -2.0 && q.y < G.z + 2.0 && q.x > -4.0 && q.x < R.z * R.w + 0.2 * G.z) {
        q.x -= 0.105104 * (G.z - q.y);
        float i = clamp(floor(q.x / R.w), 0.0, R.z - 1.0);
        c = mix(c, ph * 0.16, clamp(0.5 - seg8(q - vec2(i * R.w, 0.0), G, dp), 0.0, 1.0));
    }
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

// My Family: a Dutch canal at blue hour in pixel art, 3 x 3 panel px a pixel (640 x 240): a dithered sky from navy to
// a warm glow over the roofs, twinkling stars and a crescent moon, a row of gabled canal houses (step, neck, bell and
// spout gables, a church tower) with lit windows, a few going on and off, their reflections wobbling in the canal
// (faster with the speed), a cobbled quay with bollards, two bikes and two old street lamps either side of the family,
// who stand in the middle: the RGBA asset u_art at u_photo (x, y, w, h), drawn 1:1, a shadow at their feet. The revs:
// two strings of twelve fairy lights across the top, lit from their outer ends towards the family (warm white, amber,
// red from the redline), all red at the shift point, flashing. u_a: x the water's clock, y seconds, z the shift point.
const SCENE_CANAL = SCENE_HEAD + `uniform vec4 u_a;
uniform sampler2D u_art;
uniform vec4 u_photo;
const float WL = 140.0;
const float QY = 187.0;
const vec3 WARM = vec3(1.0, 0.72, 0.38);
float seg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
vec3 skyAt(float y) {
    float t = clamp(y / WL, 0.0, 1.0);
    vec3 c = mix(vec3(0.043, 0.063, 0.188), vec3(0.165, 0.149, 0.376), smoothstep(0.0, 0.5, t));
    c = mix(c, vec3(0.416, 0.239, 0.451), smoothstep(0.45, 0.8, t));
    c = mix(c, vec3(0.878, 0.502, 0.416), smoothstep(0.78, 0.94, t));
    return mix(c, vec3(0.949, 0.698, 0.478), smoothstep(0.93, 1.0, t));
}
// a canal house at art px a (y down): rgb and 1 where a house is, 0 for the sky. The house is 18 px wide; the tenth is
// the church tower.
vec4 house(vec2 a) {
    float i = floor(a.x / 18.0), lx = a.x - i * 18.0;
    bool tower = abs(i - 9.0) < 0.5;
    float h = tower ? 116.0 : 52.0 + floor(hash(vec2(i, 7.0)) * 40.0);
    float dy = a.y - (WL - h);
    if (dy < 0.0 || a.y >= WL) return vec4(0.0);
    float k = floor(hash(vec2(i, 3.0)) * 4.0), G = 14.0, hw = 9.0;
    if (tower) hw = dy < 30.0 ? 0.5 + dy * 0.12 : dy < 44.0 ? 4.0 : 6.0;
    else if (dy < G) hw = k < 0.5 ? 2.0 + floor(dy / 3.5) * 2.0 : k < 1.5 ? (dy < 9.0 ? 3.0 : 3.0 + (dy - 9.0) * 1.2)
        : k < 2.5 ? 9.0 * sqrt(dy / G) : 1.0 + dy * 0.6;
    float cx = abs(lx + 0.5 - 9.0);
    if (cx > hw) return vec4(0.0);
    vec3 c = mix(vec3(0.13, 0.11, 0.23), vec3(0.20, 0.14, 0.26), hash(vec2(i, 11.0)));
    if (cx > hw - 1.0 || dy < 1.0) c += vec3(0.07, 0.05, 0.06);
    if (lx < 0.5) c *= 0.7;
    float wy = dy - G - 3.0, row = floor(wy / 9.0), col = floor((lx - 3.0) / 5.0), cxw = mod(lx - 3.0, 5.0);
    if (!tower && wy >= 0.0 && mod(wy, 9.0) < 5.0 && lx >= 3.0 && lx < 16.0 && cxw < 3.0 && a.y < WL - 2.0) {
        float r = hash(vec2(i * 3.0 + col, row));
        bool on = r + 0.06 * sin(u_a.y * 0.25 + r * 40.0) > 0.62;
        c = on ? mix(vec3(1.0, 0.80, 0.44), vec3(1.0, 0.60, 0.30), hash(vec2(row, i))) : vec3(0.09, 0.08, 0.17);
    }
    if (tower && dy > 50.0 && dy < 58.0 && cx < 2.0) c = vec3(1.0, 0.85, 0.55);
    return vec4(c, 1.0);
}
void main() {
    vec2 p = floor(v_uv * u_size) + 0.5;
    if (kept(p)) { gl_FragColor = vec4(0.0); return; }
    vec2 a = floor(p / 3.0);
    vec2 ps = a * 3.0 + 1.5;
    vec3 c;
    bool side = p.x < 560.0 || p.x > 1360.0;
    if (a.y < WL) {
        vec4 hs = house(a);
        c = skyAt(a.y);
        float st = hash(a);
        if (a.y < 90.0 && st > 0.994) c += vec3(0.55, 0.55, 0.6) * (0.55 + 0.45 * sin(u_a.y * (1.0 + st * 3.0) + st * 50.0));
        vec2 mq = ps - vec2(1440.0, 104.0);
        float md = length(mq);
        if (md < 27.0 && length(mq - vec2(10.0, -7.0)) > 23.0) c = vec3(1.0, 0.94, 0.78);
        c += vec3(0.5, 0.45, 0.35) * 0.18 * exp(-md / 60.0);
        if (hs.a > 0.0) {
            c = hs.rgb;
            if (side && c.r > 0.8 && p.y > 210.0) c = mix(vec3(0.16, 0.12, 0.24), c, 0.4);
        }
    } else if (a.y < QY) {
        float wy = a.y - WL, my = WL - 1.0 - floor(wy * 1.15);
        float depth = wy / (QY - WL), wob = floor(sin(a.y * 0.45 + u_a.x * 2.0) * 1.2 + 0.5);
        c = mix(vec3(0.075, 0.098, 0.22), vec3(0.05, 0.07, 0.16), depth);
        vec4 r = house(vec2(a.x + wob, my));
        if (r.a > 0.0) c = r.r > 0.8 ? c + (r.rgb - c) * 0.32 * (1.0 - depth) : mix(c, vec3(0.06, 0.05, 0.12), 0.45);
        else c = mix(c, skyAt(my), 0.3);
        float rip = hash(vec2(floor(a.x / 7.0 + u_a.x * (0.5 + 0.4 * hash(vec2(a.y, 2.0)))), a.y));
        if (rip > 0.975) c += vec3(0.07, 0.07, 0.11);
        for (int k = 0; k < 2; k++) {
            float lx = k == 0 ? 735.0 : 1185.0;
            float dx = abs(ps.x + wob * 3.0 - lx);
            c += WARM * 0.35 * exp(-dx / 9.0) * (1.0 - wy / (QY - WL));
        }
    } else {
        float qy = a.y - QY - 2.0, row = floor(qy / 4.0), bx = a.x + mod(row, 2.0) * 3.5, br = floor(bx / 7.0);
        if (qy < 0.0) c = qy < -1.0 ? vec3(0.36, 0.31, 0.34) : vec3(0.24, 0.20, 0.24);
        else c = (mod(bx, 7.0) < 1.0 || mod(qy, 4.0) < 1.0) ? vec3(0.09, 0.07, 0.10)
            : mix(vec3(0.17, 0.14, 0.17), vec3(0.24, 0.19, 0.21), hash(vec2(br, row)));
        for (int k = 0; k < 2; k++) {
            float lx = k == 0 ? 735.0 : 1185.0;
            c += WARM * 0.45 * exp(-length((ps - vec2(lx, 640.0)) / vec2(200.0, 70.0)));
        }
        float fd = length((p - vec2(960.0, 652.0)) / vec2(175.0, 13.0));
        c *= 1.0 - 0.5 * (1.0 - smoothstep(0.5, 1.0, fd));
    }
    // bollards on the quay edge, every 36 px
    float bm = mod(a.x, 36.0);
    if (bm >= 17.0 && bm < 20.0 && a.y >= QY - 6.0 && a.y < QY + 2.0 && abs(p.x - 960.0) > 200.0)
        c = a.y < QY - 5.0 ? vec3(0.55, 0.22, 0.20) : vec3(0.32, 0.10, 0.10);
    // two bikes on the quay, by the lamps: wheels r 6.5 art px, 19 apart, the frame from line segments
    for (int k = 0; k < 2; k++) {
        vec2 o = a + 0.5 - vec2(k == 0 ? 188.0 : 427.0, QY + 15.0);
        float d = min(abs(length(o) - 6.5), abs(length(o - vec2(19.0, 0.0)) - 6.5));
        d = min(d, min(seg(o, vec2(0.0), vec2(8.0, 0.0)), seg(o, vec2(0.0), vec2(7.0, -8.0))));
        d = min(d, min(seg(o, vec2(8.0, 0.0), vec2(6.5, -9.0)), seg(o, vec2(7.0, -8.0), vec2(16.0, -8.0))));
        d = min(d, min(seg(o, vec2(8.0, 0.0), vec2(16.5, -6.5)), seg(o, vec2(19.0, 0.0), vec2(16.0, -10.0))));
        d = min(d, min(seg(o, vec2(15.0, -10.5), vec2(19.5, -11.5)), seg(o, vec2(4.5, -9.5), vec2(8.5, -9.5))));
        if (d < 0.75) c = vec3(0.04, 0.03, 0.07);
    }
    // the two street lamps: a post, a lantern, its glow
    for (int k = 0; k < 2; k++) {
        float lx = k == 0 ? 245.0 : 395.0;
        vec2 o = a - vec2(lx, 0.0);
        if (abs(o.x + 0.5) < 1.0 && a.y > 96.0 && a.y < 216.0) c = vec3(0.07, 0.06, 0.10);
        if (abs(o.x + 0.5) < 2.0 && a.y > 206.0 && a.y < 216.0) c = vec3(0.07, 0.06, 0.10);
        if (abs(o.x + 0.5) < 3.5 && a.y >= 84.0 && a.y < 96.0) c = (abs(o.x + 0.5) < 2.5 && a.y > 85.0 && a.y < 95.0) ? vec3(1.0, 0.86, 0.55) : vec3(0.07, 0.06, 0.10);
        if (a.y >= 80.0 && a.y < 84.0 && abs(o.x + 0.5) < 1.0 + (a.y - 80.0)) c = vec3(0.07, 0.06, 0.10);
        c += WARM * 0.55 * exp(-length(ps - vec2(lx * 3.0 + 1.5, 271.0)) / 40.0);
    }
    // the fairy lights: the left string from x 330 to 800, the right one its mirror, sagging 52 px from y 112
    vec2 q = vec2(p.x < 960.0 ? ps.x : 1920.0 - ps.x, ps.y);
    if (q.x > 285.0 && q.x < 845.0 && q.y > 78.0 && q.y < 215.0) {
        float u = (q.x - 330.0) / 470.0, s2 = 2.0 * u - 1.0;
        if (u >= 0.0 && u <= 1.0 && abs(q.y - (112.0 + 52.0 * (1.0 - s2 * s2))) < 1.6) c = vec3(0.06, 0.05, 0.09);
        float k = clamp(floor(u * 11.0 + 0.5), 0.0, 11.0), bu = 2.0 * k / 11.0 - 1.0;
        vec2 b = vec2(330.0 + k / 11.0 * 470.0, 122.0 + 52.0 * (1.0 - bu * bu));
        float d = length(q - b);
        bool lit = k < floor(u_drive.y * 12.0 + 0.5) - 0.5;
        vec3 bc = (k + 0.5) / 12.0 >= u_drive.w ? vec3(1.0, 0.30, 0.25) : k >= 8.0 ? vec3(1.0, 0.68, 0.25) : vec3(1.0, 0.92, 0.72);
        if (u_a.z > 0.5) bc = u_drive.z > 0.5 ? vec3(1.0, 0.32, 0.26) : vec3(0.55, 0.08, 0.08);
        if (d < 7.5) c = lit ? bc : vec3(0.22, 0.19, 0.27);
        else if (lit) c += bc * 0.5 * exp(-(d - 7.0) / 7.0) * smoothstep(36.0, 20.0, d);
    }
    // the family, 1:1
    vec2 f = p - u_photo.xy;
    if (f.x >= 0.0 && f.y >= 0.0 && f.x < u_photo.z && f.y < u_photo.w) {
        vec4 t = texture2D(u_art, (floor(f) + 0.5) / u_photo.zw);
        c = mix(c, t.rgb, t.a);
    }
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

// My Family: Sakura: hanami by a lake at night, painted smooth (1 panel px a pixel): an indigo sky warming to rose at the
// horizon, stars, a full moon, Mount Fuji with its snow in the moonlight, the far shore's trees and festival lights, a
// five-storey pagoda, all mirrored in the lake (rippling faster with the speed, the moon's path on it), a stone bank with
// fallen petals, two stone lanterns alight beside the family, cherry trees at both sides arching over the top in
// blossom, petals falling and blowing faster with the speed, and paper lanterns hung from the branches that light with
// the revs (warm, red from the redline, all flashing red at the shift point). The family (u_art, at u_photo) in front.
// u_a: x the water's clock, y seconds, z the shift point, w the wind's clock.
const SCENE_HANAMI = SCENE_HEAD + `uniform vec4 u_a;
uniform sampler2D u_art;
uniform vec4 u_photo;
const float HZ = 432.0;
float seg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
float vnoise(vec2 x) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 skyAt(float y) {
    float t = clamp(y / HZ, 0.0, 1.0);
    vec3 c = mix(vec3(0.04, 0.05, 0.15), vec3(0.13, 0.10, 0.29), smoothstep(0.0, 0.5, t));
    c = mix(c, vec3(0.40, 0.23, 0.43), smoothstep(0.45, 0.86, t));
    return mix(c, vec3(0.84, 0.50, 0.52), smoothstep(0.84, 1.0, t));
}
// what lies across the lake, seen or mirrored in it
vec3 far(vec2 q) {
    vec3 c = skyAt(q.y);
    float st = hash(floor(q / 6.0) + 17.0);
    if (st > 0.985 && length(fract(q / 6.0) - 0.5) < 0.26) c += vec3(0.6, 0.6, 0.7) * clamp(1.0 - q.y / 300.0, 0.0, 1.0);
    // the moon
    vec2 mo = q - vec2(600.0, 122.0);
    float md = length(mo);
    c += vec3(0.75, 0.62, 0.82) * 0.30 * exp(-max(md - 38.0, 0.0) / 70.0);
    float mm = max(smoothstep(13.0, 9.0, length(mo - vec2(-9.0, -7.0))), smoothstep(10.0, 6.0, length(mo - vec2(13.0, 9.0))));
    c = mix(c, mix(vec3(1.0, 0.97, 0.90), vec3(0.87, 0.84, 0.82), mm * 0.8), smoothstep(38.5, 37.0, md));
    // Mount Fuji: its moonlit left flank, ridges running down, the snow with its fingers, haze at its foot
    float t = (q.y - 214.0) / (HZ - 214.0);
    if (t > 0.0) {
        float dx = q.x - 640.0, e = 24.0 + 520.0 * pow(t, 1.65) - abs(dx);
        if (e > -1.0) {
            vec3 m = mix(vec3(0.17, 0.16, 0.34), vec3(0.10, 0.09, 0.23), smoothstep(-30.0, 40.0, dx)) * (0.92 + 0.08 * sin(dx / (2.5 + 14.0 * t)));
            if (t < 0.30 + 0.035 * sin(dx * 0.07) + 0.025 * sin(dx * 0.19 + 1.0) + 0.14 * pow(max(0.0, sin(dx * 0.11 + 0.5)), 2.0) * (0.25 + 0.75 * abs(sin(dx * 0.037 + 2.0))))
                m = mix(vec3(0.88, 0.90, 0.99), vec3(0.50, 0.54, 0.78), smoothstep(-40.0, 30.0, dx)) * (0.95 + 0.05 * sin(dx / (2.0 + 10.0 * t)));
            c = mix(c, mix(m, skyAt(HZ - 8.0), smoothstep(0.3, 1.0, t) * 0.55), clamp(e + 0.5, 0.0, 1.0));
        }
    }
    // the far shore: trees in blossom catching the last light, festival lights among them
    float th = HZ - 8.0 - 6.0 * (1.0 + sin(q.x * 0.021)) - 4.0 * (1.0 + sin(q.x * 0.077 + 1.0)) - 2.5 * (1.0 + sin(q.x * 0.21));
    if (q.y > th - 1.0) {
        c = mix(c, mix(vec3(0.46, 0.26, 0.42), vec3(0.16, 0.10, 0.21), smoothstep(0.0, 9.0, q.y - th)), clamp(q.y - th + 0.5, 0.0, 1.0));
        float lx = floor(q.x / 34.0);
        if (hash(vec2(lx, 8.0)) > 0.55) c = mix(c, vec3(1.0, 0.78, 0.50), smoothstep(2.2, 1.2, length(vec2(q.x - (lx + 0.5) * 34.0, q.y - HZ + 5.0))));
    }
    // the pagoda: five storeys, vermilion posts, dark roofs with their eaves turned up and lit from below, the spire
    vec2 g = q - vec2(1292.0, HZ - 6.0);
    if (abs(g.x) < 66.0 && g.y < 0.0 && g.y > -252.0) {
        // storey i (0 at the bottom) is a 30 - 3i px body under a 14 px roof, so it starts 45.5i - 1.5i^2 px up: which
        // one is here, at once
        float y = -g.y, dx = abs(g.x), hit = 0.0, fi = floor((45.5 - sqrt(max(0.0, 2070.25 - 6.0 * y))) / 3.0);
        vec3 pc = vec3(0.10, 0.08, 0.13);
        if (y < 190.0) {
            float bw = 30.0 - 3.2 * fi, rw = 64.0 - 6.5 * fi, yr = -(45.5 * fi - 1.5 * fi * fi) - 30.0 + 3.0 * fi;
            if (g.y > yr && dx < bw) {
                hit = 1.0;
                pc = mix(vec3(0.62, 0.17, 0.13), vec3(0.30, 0.08, 0.09), smoothstep(-bw, bw, g.x)) * (fract(g.x / 8.0) < 0.2 ? 0.6 : 1.0);
            }
            float lo = yr + 3.0 - 9.0 * pow(min(dx / rw, 1.0), 3.0);
            if (g.y < lo && dx < mix(rw, bw * 0.75, pow((lo - g.y) / (lo - yr + 14.0), 0.7))) { hit = 1.0; pc = g.y > lo - 2.0 ? vec3(0.86, 0.48, 0.32) : vec3(0.09, 0.07, 0.13); }
        } else if ((y < 244.0 && dx < (mod(g.y, 6.0) < 2.0 && y < 230.0 ? 5.0 : 1.6)) || length(vec2(g.x, y - 247.0)) < 3.5) hit = 1.0;   // the spire, its rings, the finial
        c = mix(c, mix(pc, skyAt(HZ - 8.0), 0.12), hit);
    }
    return c;
}
void main() {
    vec2 p = floor(v_uv * u_size) + 0.5;
    if (kept(p)) { gl_FragColor = vec4(0.0); return; }
    float shore = 606.0 + 8.0 * sin(p.x * 0.0041 + 0.8) - 5.0 * sin(p.x * 0.011);
    // the lake mirrors all that lies across it, wobbling with the ripples (one pass of far() for the sky and the lake)
    float dw = p.y - HZ, wt = u_a.x;
    bool lake = dw >= 0.0 && p.y < shore;
    float wob = (0.5 + dw * 0.025) * sin(p.y * 0.45 + wt * 2.0106) + (0.4 + dw * 0.02) * sin(p.y * 0.12 - wt * 1.2566 + p.x * 0.006);
    vec3 c = far(lake ? vec2(p.x + wob, HZ - dw) : p);
    if (lake) {
        // darker nearer, ripples, the moon's path glittering on it
        c = mix(c * 0.66, vec3(0.05, 0.05, 0.15), 0.2 + 0.4 * dw / 175.0);
        float rl = vnoise(vec2(p.x / (30.0 + dw * 1.5), p.y / (1.5 + dw * 0.03) - wt * 0.7));
        c *= 0.74 + 0.5 * rl;
        float gw = 16.0 + dw * 0.42;
        c += vec3(1.0, 0.92, 0.86) * 0.6 * smoothstep(gw, gw * 0.3, abs(p.x - 600.0 + wob * 1.5)) * smoothstep(0.55, 0.78, rl) * (1.0 - 0.9 * smoothstep(50.0, 120.0, dw));
        c = mix(c, vec3(0.04, 0.04, 0.10), smoothstep(shore - 16.0, shore, p.y) * 0.5);
    } else if (dw >= 0.0) {
        // the near bank: stones along the water, moss, fallen petals, the family's shadow
        float d = p.y - shore, sx = floor(p.x / 28.0);
        c = mix(vec3(0.13, 0.12, 0.19), vec3(0.06, 0.06, 0.10), smoothstep(0.0, 110.0, d));
        float h = hash(floor(p / 11.0) + 41.0), an = h * 40.0;
        vec2 pf = fract(p / 11.0) - 0.5 - (fract(h * vec2(7.3, 9.1)) - 0.5) * 0.3;
        vec2 cs = vec2(cos(an), sin(an));
        if (h > 0.8 && length(vec2(dot(pf, cs), cs.x * pf.y - cs.y * pf.x) / vec2(0.3, 0.17)) < 1.0)
            c = mix(c, vec3(0.88, 0.60, 0.72), 0.7 - 0.3 * smoothstep(0.0, 110.0, d));
        vec2 so = vec2((fract(p.x / 28.0) - 0.5) * 28.0, d - 6.0 - 2.0 * hash(vec2(sx, 3.0)));
        if (length(so / vec2(12.5, 6.5)) < 1.0) c = mix(vec3(0.34, 0.32, 0.42), vec3(0.15, 0.14, 0.21), smoothstep(-6.0, 5.0, so.y)) * (0.9 + 0.2 * hash(vec2(sx, 5.0)));
        c *= 1.0 - 0.55 * (1.0 - smoothstep(0.5, 1.0, length((p - vec2(960.0, 652.0)) / vec2(175.0, 13.0))));
    }
    // two stone lanterns on the bank beside the family (one, mirrored), alight
    {
        vec2 o = vec2(abs(p.x - 960.0) - 228.0, p.y - 648.0) / 1.25;
        float ax = abs(o.x), gl = exp(-length(o + vec2(0.0, 66.0)) / 46.0), s = 0.0;
        if (o.y < 0.0 && o.y > -10.0 && ax < 20.0) s = 1.0;
        else if (o.y < -10.0 && o.y > -46.0 && ax < 6.0) s = 1.0;
        else if (o.y < -46.0 && o.y > -54.0 && ax < 18.0) s = 1.0;
        else if (o.y < -54.0 && o.y > -78.0 && ax < 13.0) s = ax < 8.0 && o.y < -58.0 && o.y > -74.0 ? 2.0 : 1.0;
        else if (o.y < -78.0 && o.y > -92.0 && ax < 28.0 - 22.0 * (-78.0 - o.y) / 14.0 + 3.0 * smoothstep(18.0, 28.0, ax) * step(o.y, -80.0)) s = 1.0;
        else if (length(o + vec2(0.0, 97.0)) < 5.0) s = 1.0;
        if (s > 1.5) c = vec3(1.0, 0.82, 0.52);
        else if (s > 0.5) c = mix(vec3(0.42, 0.40, 0.47), vec3(0.17, 0.16, 0.22), smoothstep(-14.0, 14.0, o.x)) * (0.88 + 0.2 * hash(floor(p / 3.0)));
        c += vec3(1.0, 0.60, 0.30) * 0.32 * gl;
    }
    // the cherry trees, one at each side: the trunk, the branches arching over the top, the blossom on them
    vec2 t = vec2(p.x < 960.0 ? p.x : 1920.0 - p.x, p.y);
    if (t.x < 860.0) {
        float tr = min(min(seg(t, vec2(34.0, 740.0), vec2(50.0, 430.0)) - 19.0, seg(t, vec2(50.0, 430.0), vec2(76.0, 260.0)) - 16.0), seg(t, vec2(76.0, 260.0), vec2(105.0, 175.0)) - 12.0);
        float br = min(min(seg(t, vec2(105.0, 175.0), vec2(330.0, 104.0)) - 7.0, seg(t, vec2(330.0, 104.0), vec2(560.0, 62.0)) - 5.0), seg(t, vec2(560.0, 62.0), vec2(805.0, 96.0)) - 3.0);
        float wd = min(tr, br);
        if (wd < 1.0) {
            vec3 bark = mix(vec3(0.36, 0.22, 0.22), vec3(0.10, 0.07, 0.10), smoothstep(-8.0, 6.0, t.x - 60.0));
            if (fract(p.y / 7.0 + 0.3 * sin(p.x * 0.2)) < 0.16) bark *= 0.65;
            c = mix(c, tr < br ? bark : vec3(0.12, 0.08, 0.11), clamp(1.0 - wd, 0.0, 1.0));
        }
        float db = br + 4.0, n = vnoise(p / 30.0) * 0.7 + vnoise(p / 10.0) * 0.3;
        float R = mix(48.0, 22.0, clamp(t.x / 800.0, 0.0, 1.0)) * (0.2 + 1.4 * n) * (1.0 + 0.35 * max(0.0, sin(t.x * 0.031 + 1.0)));
        float al = smoothstep(0.0, 1.5, R - db) * smoothstep(176.0, 166.0, t.y);
        if (al > 0.0) {
            float k = clamp((R - db) / 16.0, 0.0, 1.0), lt = clamp(0.55 + 3.5 * (n - vnoise((p - vec2(6.0, 8.0)) / 30.0)), 0.0, 1.0);
            vec3 bc = mix(vec3(0.46, 0.24, 0.43), mix(vec3(0.86, 0.52, 0.68), vec3(1.0, 0.84, 0.90), lt), 0.35 + 0.65 * k);
            bc += vec3(0.18, 0.07, 0.02) * smoothstep(0.0, 30.0, t.y - 104.0 + (t.x - 330.0) * 0.12) * k;
            c = mix(c, bc, al);
        }
    }
    // petals falling, two layers (far, near), blown faster with the speed; their pattern repeats every 64 cells and the
    // clocks' rates fit it, so the clocks' wraps don't show
    for (int i = 0; i < 2; i++) {
        float fi = float(i), C = 44.0 + 22.0 * fi;
        vec2 q = p + vec2(u_a.w * (14.08 + 7.04 * fi), -u_a.y * (14.08 + 14.08 * fi)), cl = floor(q / C), f = q - (cl + 0.5) * C;
        cl = mod(cl, 64.0);
        float h = hash(cl + fi * 31.0), h2 = fract(h * 13.7);
        if (h > 0.45 + 0.08 * fi) {
            vec2 r = f - (vec2(h2, fract(h * 7.3)) - 0.5) * C * 0.5;
            float an = u_a.y * (1.2566 + 0.6283 * fi) + h * 20.0, L = 3.0 + 2.6 * fi;
            vec2 cs = vec2(cos(an), sin(an));
            r = vec2(dot(r, cs), cs.x * r.y - cs.y * r.x);
            float pd = length(r / vec2(L, L * (0.25 + 0.4 * abs(sin(u_a.y * 2.0944 + h2 * 20.0)))));
            c = mix(c, mix(vec3(1.0, 0.88, 0.93), vec3(0.92, 0.56, 0.71), smoothstep(-L, L, r.x)), smoothstep(1.0, 0.7, pd) * (0.65 + 0.3 * fi));
        }
    }
    // the paper lanterns: the left string from x 330 to 800, the right one its mirror, sagging 52 px from y 112
    vec2 q = vec2(p.x < 960.0 ? p.x : 1920.0 - p.x, p.y);
    if (q.x > 300.0 && q.x < 830.0 && q.y > 95.0 && q.y < 240.0) {
        float uu = (q.x - 330.0) / 470.0, s2 = 2.0 * uu - 1.0;
        if (uu >= 0.0 && uu <= 1.0) c = mix(c, vec3(0.08, 0.06, 0.10), smoothstep(1.6, 0.6, abs(q.y - 112.0 - 52.0 * (1.0 - s2 * s2))));
        float kk = clamp(floor(uu * 11.0 + 0.5), 0.0, 11.0), bu = 2.0 * kk / 11.0 - 1.0;
        vec2 o = q - vec2(330.0 + kk / 11.0 * 470.0 + 2.0 * sin(u_a.y * 2.0944 + kk), 134.0 + 52.0 * (1.0 - bu * bu));
        bool lit = kk < floor(u_drive.y * 12.0 + 0.5) - 0.5;
        vec3 lc = (kk + 0.5) / 12.0 >= u_drive.w ? vec3(1.0, 0.26, 0.22) : vec3(1.0, 0.72, 0.40);
        if (u_a.z > 0.5) { lit = true; lc = u_drive.z > 0.5 ? vec3(1.0, 0.28, 0.24) : vec3(0.50, 0.08, 0.08); }
        if (lit) c += lc * 0.45 * smoothstep(26.0, 10.0, length(o));
        float e = length(o / vec2(10.5, 13.0));
        if (abs(o.x) < 1.0 && o.y < -13.0 && o.y > -23.0) c = vec3(0.08, 0.06, 0.10);
        if (abs(o.x) < 6.0 && abs(abs(o.y) - 14.0) < 2.5) c = vec3(0.10, 0.07, 0.10);
        else if (e < 1.0) {
            vec3 b = lit ? mix(lc, vec3(1.0, 0.95, 0.86), (1.0 - e) * 0.6) : vec3(0.38, 0.20, 0.25) * (1.0 - 0.3 * e);
            c = mix(c, b * (mod(o.y + 13.0, 4.0) < 1.0 ? 0.8 : 1.0), smoothstep(1.0, 0.9, e));
        }
    }
    // the family, 1:1
    vec2 f = p - u_photo.xy;
    if (f.x >= 0.0 && f.y >= 0.0 && f.x < u_photo.z && f.y < u_photo.w) {
        vec4 a = texture2D(u_art, (floor(f) + 0.5) / u_photo.zw);
        c = mix(c, a.rgb, a.a);
    }
    gl_FragColor = vec4(c * u_dim, 1.0);
}
`;

module.exports = { shiftbar: SHIFTBAR, arc: ARC, revbar: REVBAR, lights: LIGHTS, fill: FILL, box: BOX, grid: GRID, segbar: SEGBAR, mdash: MDASH, mtach: MTACH, sdash: SDASH, boxes: BOXES, atext: ATEXT, meter: METER, gmeter: GMETER, revarc: REVARC, tiles: TILES, ribbon: RIBBON, deco: DECO, mview: MVIEW, vdash: VDASH, sakura: SAKURA, photo: PHOTO,
    scene_synth: SCENE_SYNTH, scene_warp: SCENE_WARP, scene_paper: SCENE_PAPER, scene_trails: SCENE_TRAILS,
    scene_glass: SCENE_GLASS, scene_orbital: SCENE_ORBITAL, scene_vfd: SCENE_VFD, scene_canal: SCENE_CANAL, scene_hanami: SCENE_HANAMI, scene_highway: SCENE_HIGHWAY };
