// Kuro Shatter lock — lock the screen (Super+L, the menu…) and the desktop cracks like glass from where the
// pointer is; the pieces fall away and reveal the lock screen. Unlock and they fly back together into your
// desktop. The lock itself happens FIRST and instantly (the glass is only a picture drawn on top of the
// already-locked screen), so this never delays or weakens locking. Not used when the screen locks for
// suspend or after going idle (the screen is fading to black then anyway).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ShaderActor, animate} from './gfx.js';

const MAXV = 10;          // max polygon vertices per shard (Voronoi cells here have ≤ ~9)

const DECL = `
uniform vec2 v[${MAXV}];
uniform float n;
uniform vec2 full;       /* snapshot size in px */
uniform float crack;     /* 0..1 crack-line glow */
uniform float alpha;`;
// inside test for a convex polygon (counter-clockwise or clockwise, consistent) + distance to the nearest edge
const BODY = `
vec2 p = cogl_tex_coord_in[0].xy * full;
float sgn = 0.0;
float edge = 1e6;
bool inside = true;
for (int i = 0; i < ${MAXV}; i++) {
    if (float(i) >= n) break;
    vec2 a = v[i];
    vec2 b = v[int(mod(float(i + 1), n))];
    vec2 e = b - a;
    float c = e.x * (p.y - a.y) - e.y * (p.x - a.x);
    if (sgn == 0.0) sgn = sign(c);
    if (c * sgn < 0.0) inside = false;
    float h = clamp(dot(p - a, e) / dot(e, e), 0.0, 1.0);
    edge = min(edge, length(p - a - e * h));
}
if (!inside) discard;
vec4 col = cogl_color_out;
float line = (1.0 - smoothstep(0.0, 1.8, edge)) * crack;
col.rgb = mix(col.rgb, vec3(1.0), line * 0.85);
col.rgb += vec3(0.6, 0.75, 1.0) * (1.0 - smoothstep(0.0, 7.0, edge)) * 0.12;   // glass edge sheen
cogl_color_out = vec4(col.rgb, 1.0) * alpha;`;

// clip polygon (array of [x,y]) by the half-plane closer to a than to b
function clipHalf(poly, a, b) {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const nx = b[0] - a[0], ny = b[1] - a[1];
    const side = p => (p[0] - mx) * nx + (p[1] - my) * ny;   // <0 = a's side
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const sp = side(p), sq = side(q);
        if (sp <= 0)
            out.push(p);
        if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
            const t = sp / (sp - sq);
            out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
    }
    return out;
}

// seeds dense around the impact, sparser further out → Voronoi cells
function cells(w, h, ix, iy) {
    const seeds = [[ix + 3, iy + 2]];
    const rings = [[70, 6], [170, 9], [320, 11], [540, 12], [850, 12], [1300, 10]];
    for (const [r, k] of rings) {
        const off = Math.random() * Math.PI * 2;
        for (let i = 0; i < k; i++) {
            const a = off + (i + (Math.random() - 0.5) * 0.6) * 2 * Math.PI / k;
            const rr = r * (0.8 + Math.random() * 0.4);
            seeds.push([ix + Math.cos(a) * rr, iy + Math.sin(a) * rr]);
        }
    }
    const rect = [[0, 0], [w, 0], [w, h], [0, h]];
    const out = [];
    for (const s of seeds) {
        let poly = rect;
        for (const o of seeds) {
            if (o !== s && Math.hypot(o[0] - s[0], o[1] - s[1]) < 2600)
                poly = clipHalf(poly, s, o);
            if (poly.length < 3)
                break;
        }
        if (poly.length >= 3) {
            // cap the vertex count (drop the shortest edges' points)
            while (poly.length > MAXV) {
                let best = 0, bl = 1e9;
                for (let i = 0; i < poly.length; i++) {
                    const q = poly[(i + 1) % poly.length];
                    const l = Math.hypot(q[0] - poly[i][0], q[1] - poly[i][1]);
                    if (l < bl) {
                        bl = l;
                        best = i;
                    }
                }
                poly.splice(best, 1);
            }
            out.push({seed: s, poly});
        }
    }
    return out;
}

export class ShatterLock {
    constructor(settings) {
        this._settings = settings;
        const shield = Main.screenShield;
        if (!shield)
            return;
        this._shield = shield;
        this._origLock = shield.lock;
        this._origDeactivate = shield.deactivate;
        const self = this;
        shield.lock = function (animate) {
            const play = animate && self._enabled() && !this._isActive && !self._fromSleep();
            const shot = play ? self._snap() : null;
            const ret = self._origLock.call(this, animate);
            if (shot)
                self.shatter(shot, false);
            return ret;
        };
        shield.deactivate = function (animate) {
            const ret = self._origDeactivate.call(this, animate);
            if (animate && self._enabled())
                self._later(() => {
                    const shot = self._snap();
                    if (shot)
                        self.shatter(shot, true);
                });
            return ret;
        };
    }

    _enabled() {
        return this._settings.get_boolean('shatter-lock');
    }

    // prepareForSleep → lock(true): don't animate into a suspend
    _fromSleep() {
        return /_prepareForSleep/.test(new Error().stack ?? '');
    }

    _later(fn) {
        const laters = global.compositor.get_laters();
        laters.add(1 /* BEFORE_REDRAW */, () => {
            try {
                fn();
            } catch (e) {
                console.error(`Kuro shatter: ${e.stack ?? e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // one picture of the whole screen as it looks right now (wallpaper, windows, bar) — never the lock screen
    _snap() {
        const shield = Main.layoutManager.screenShieldGroup;
        const was = shield?.visible;
        try {
            if (shield)
                shield.visible = false;
            const w = global.stage.width, h = global.stage.height;
            const c = global.stage.paint_to_content(new Mtk.Rectangle({x: 0, y: 0, width: w, height: h}), 1,
                global.stage.context.get_default_color_state(), Clutter.PaintFlag.NO_CURSORS);
            const tex = c?.get_texture?.();
            return tex ? {tex, w, h} : null;
        } catch (e) {
            console.warn(`Kuro shatter: snapshot: ${e.message}`);
            return null;
        } finally {
            if (shield)
                shield.visible = was;
        }
    }

    // reverse=false: crack + fall away. reverse=true: pieces fly in and form the desktop, then vanish.
    shatter(shot, reverse) {
        this._stop();
        const [px, py] = global.get_pointer();
        const ix = reverse ? shot.w / 2 : px, iy = reverse ? shot.h / 2 : py;
        const root = new Clutter.Actor({width: shot.w, height: shot.h, reactive: false});
        const backdrop = reverse ? new ShaderActor('', 'cogl_color_out = vec4(0.0, 0.0, 0.0, 1.0);',
            {width: shot.w, height: shot.h}) : null;
        if (backdrop)
            root.add_child(backdrop);
        Main.layoutManager.uiGroup.add_child(root);
        Main.layoutManager.uiGroup.set_child_above_sibling(root, null);
        this._root = root;

        const shards = cells(shot.w, shot.h, ix, iy).map(({seed, poly}) => {
            const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
            const x1 = Math.floor(Math.min(...xs)), y1 = Math.floor(Math.min(...ys));
            const x2 = Math.ceil(Math.max(...xs)), y2 = Math.ceil(Math.max(...ys));
            const a = new ShaderActor(DECL, BODY, {texture: shot.tex, x: x1, y: y1, width: x2 - x1, height: y2 - y1});
            a.setRegion(x1 / shot.w, y1 / shot.h, x2 / shot.w, y2 / shot.h);
            const flat = [];
            for (let i = 0; i < MAXV; i++)
                flat.push(...(poly[i] ?? [0, 0]));
            a.set('v', flat, 2).set('n', poly.length).set('full', [shot.w, shot.h]).set('alpha', 1)
                .set('crack', 0);
            a.set_pivot_point(0.5, 0.5);
            root.add_child(a);
            const d = Math.hypot(seed[0] - ix, seed[1] - iy);
            const dx = (seed[0] - ix) / (d || 1), dy = (seed[1] - iy) / (d || 1);
            return {a, d, vx: dx * (120 + Math.random() * 260), vy: dy * 120 - 80 - Math.random() * 200,
                spin: (Math.random() - 0.5) * 300, tilt: (Math.random() - 0.5) * 70, delay: d / 2600};
        });
        this._snd(reverse);

        const CR = 0.16;              // crack phase (fraction)
        const total = reverse ? 900 : 1500;
        this._tl = animate(root, total, (_dt, secs, k) => {
            for (const s of shards) {
                let t;
                if (reverse) {
                    // pieces come in from where they fell, nearest the centre first
                    const kk = Math.min(1, Math.max(0, (k - s.delay * 0.4) / 0.75));
                    t = 1.05 * (1 - (1 - Math.pow(1 - kk, 3)));
                    s.a.set('crack', kk > 0.85 ? (1 - kk) / 0.15 * 0.7 : 0.7);
                    s.a.set('alpha', Math.min(1, kk * 2.5));
                } else {
                    s.a.set('crack', Math.min(1, k / (CR * 0.5)));
                    t = Math.max(0, secs - CR * total / 1000 - s.delay);
                    s.a.set('alpha', Math.max(0, 1 - t / 1.0));
                }
                const g = 2600;
                s.a.translation_x = s.vx * t;
                s.a.translation_y = s.vy * t + 0.5 * g * t * t;
                s.a.rotation_angle_z = s.spin * t;
                s.a.rotation_angle_x = s.tilt * t;
                const sc = 1 - 0.18 * Math.min(1, t);
                s.a.set_scale(sc, sc);
            }
            if (backdrop && k > 0.9)
                backdrop.opacity = Math.round(255 * (1 - (k - 0.9) / 0.1));
        }, () => this._stop());
    }

    // a small glass sound if the Kuro sound theme has one
    _snd(reverse) {
        try {
            global.display.get_sound_player().play_from_theme(reverse ? 'kuro-glass-in' : 'kuro-glass-break',
                reverse ? 'Unlock' : 'Lock', null);
        } catch {}
    }

    _stop() {
        this._tl?.stop();
        this._root?.destroy();
        this._root = this._tl = null;
    }

    destroy() {
        this._stop();
        if (this._shield) {
            this._shield.lock = this._origLock;
            this._shield.deactivate = this._origDeactivate;
            // instance overrides → drop them so the prototype's methods are used again
            if (this._shield.lock === Object.getPrototypeOf(this._shield).lock)
                delete this._shield.lock;
            if (this._shield.deactivate === Object.getPrototypeOf(this._shield).deactivate)
                delete this._shield.deactivate;
        }
    }
}
