// Kuro Black hole close — fling a window hard into a screen CORNER (mouse throw, Kuro Physics) and a black hole
// opens there: the window spirals in, everything around the hole is bent by gravitational lensing, the hole
// collapses with a flash and the screen shakes. Then the window is closed for real (if the app asks
// "save changes?", the window comes back).
// Kuro Physics calls globalThis.kuroCosmos.blackhole(win, corner) ('tl' | 'tr' | 'bl' | 'br').
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WarpEffect, screenClone, animate, clamp} from './gfx.js';

const DURATION = 1500;     // ms, whole show
const GROW = 0.18;         // fraction: hole opens
const EAT_END = 0.72;      // window gone by here
const R_MAX = 120;         // px event-horizon radius at full size

// p = this pixel in px; c = hole centre in px; r = horizon radius (px)
const DECL = `
uniform vec2 size;
uniform vec2 c;
uniform float r;
uniform float t;
uniform float flash;`;
const BODY = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 p = uv * size;
vec2 d = p - c;
float dist = length(d);
vec4 col;
if (r < 0.5) {
    col = texture2D(tex, uv);
} else {
    // lensing: pull the sample point outward (light from behind the hole bends around it)
    float bend = r * r * 1.9 / max(dist, 1.0) * exp(-max(dist - r, 0.0) / (r * 5.0));
    vec2 q = c + normalize(d) * (dist + bend);
    col = texture2D(tex, clamp(q / size, 0.0, 1.0));
    // swirl of the accretion disk
    float ang = atan(d.y, d.x);
    float ring = exp(-pow((dist - r * 1.35) / (r * 0.28), 2.0));
    float swirl = 0.6 + 0.4 * sin(ang * 5.0 - t * 9.0 + dist * 0.05);
    vec3 disk = mix(vec3(1.0, 0.45, 0.15), vec3(1.0, 0.85, 0.6), swirl) * ring * swirl * 1.3;
    col.rgb = col.rgb * (1.0 - 0.55 * ring) + disk;
    // photon ring + horizon
    float photon = exp(-pow((dist - r) / 2.5, 2.0));
    col.rgb += vec3(1.0, 0.8, 0.55) * photon * 0.9;
    float horizon = 1.0 - smoothstep(r - 2.0, r + 1.0, dist);
    col.rgb = mix(col.rgb, vec3(0.0), horizon);
}
// collapse flash
float fl = flash * exp(-dist / (180.0 + 900.0 * flash));
col.rgb += vec3(1.0, 0.9, 0.8) * fl;
cogl_color_out = vec4(clamp(col.rgb, 0.0, 1.0), 1.0) * cogl_color_in.a;`;

const ease = k => 1 - Math.pow(1 - k, 3);

export class BlackHole {
    constructor() {
        this._shows = new Set();
    }

    // true = we took the window
    swallow(win, corner) {
        if (!win || win.window_type !== Meta.WindowType.NORMAL || win._kuroVanish)
            return false;
        const actor = win.get_compositor_private();
        const mi = win.get_monitor();
        const mon = Main.layoutManager.monitors[mi];
        if (!actor || !mon || this._shows.size >= 3)
            return false;
        let content = null;
        try {
            content = actor.paint_to_content(null);
        } catch {}
        if (!content)
            return false;

        win._kuroVanish = true;      // Kuro Physics / Echo: don't shatter or echo this one
        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        const cx = corner.includes('l') ? 0 : mon.width, cy = corner.includes('t') ? 0 : mon.height;
        // hole sits a little inside the corner so you see it
        const hx = cx === 0 ? 105 : mon.width - 105, hy = cy === 0 ? 105 : mon.height - 105;

        const box = screenClone(mon);
        actor.hide();                 // after the clone exists: the clone must not show it either
        const fx = WarpEffect(DECL, BODY);
        box.add_effect(fx);
        const shard = new Clutter.Actor({content, width: aw, height: ah, x: ax - mon.x, y: ay - mon.y});
        shard.set_pivot_point(0.5, 0.5);
        box.add_child(shard);
        const sx = ax - mon.x + aw / 2, sy = ay - mon.y + ah / 2;     // window centre at start
        const show = {box, win, actor};
        this._shows.add(show);

        const a0 = Math.atan2(sy - hy, sx - hx), d0 = Math.hypot(sx - hx, sy - hy);
        const spin = (corner === 'tl' || corner === 'br' ? 1 : -1) * Math.PI * 2.4;
        show.tl = animate(box, DURATION, (_dt, secs, k) => {
            const grow = ease(clamp(k / GROW, 0, 1));
            const collapse = clamp((k - EAT_END - 0.06) / 0.14, 0, 1);
            const r = R_MAX * grow * (1 - ease(collapse));
            const eat = clamp(k / EAT_END, 0, 1);
            const e = eat * eat * (3 - 2 * eat);
            const dist = d0 * (1 - e), ang = a0 + spin * e * e;
            const s = Math.max(0.001, 1 - e);
            shard.set_scale(s * (1 - 0.35 * e), s);
            shard.rotation_angle_z = 540 * e * e * (spin > 0 ? 1 : -1);
            shard.set_position(hx + Math.cos(ang) * dist - aw / 2, hy + Math.sin(ang) * dist - ah / 2);
            shard.opacity = Math.round(255 * clamp(1.15 - e, 0, 1));
            const flash = collapse > 0 ? Math.sin(Math.PI * clamp((k - EAT_END - 0.12) / 0.16, 0, 1)) : 0;
            fx.set({size: [mon.width, mon.height], c: [hx, hy], r, t: secs, flash});
            if (collapse >= 1 && !show.shook) {
                show.shook = true;
                this._shake();
            }
        }, () => this._finish(show));
        return true;
    }

    _shake() {
        const g = Main.layoutManager.uiGroup;
        const holder = new Clutter.Actor();   // timeline needs an actor on stage
        Main.layoutManager.uiGroup.add_child(holder);
        animate(holder, 380, (_dt, _s, k) => {
            const amp = 9 * Math.pow(1 - k, 2);
            g.translation_x = Math.round(amp * Math.sin(k * 55));
            g.translation_y = Math.round(amp * 0.6 * Math.cos(k * 47));
        }, () => {
            g.translation_x = g.translation_y = 0;
            holder.destroy();
        });
    }

    _finish(show) {
        this._shows.delete(show);
        show.box.destroy();
        if (this._dying)
            return;
        const {win, actor} = show;
        let gone = false;
        win.connectObject('unmanaged', () => (gone = true), this);
        try {
            win.delete(global.get_current_time());
        } catch {}
        // app refused / asked to save → bring it back
        this._timers ??= new Set();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._timers?.delete(id);
            if (!gone) {
                win._kuroVanish = false;
                win.disconnectObject(this);
                actor.show();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    destroy() {
        this._dying = true;
        for (const s of [...this._shows]) {
            s.tl?.stop();                 // → _finish → box destroyed (and no close: _dying)
            if (this._shows.has(s))
                s.box.destroy();
            s.actor.show();
            s.win._kuroVanish = false;
        }
        this._shows.clear();
        for (const id of this._timers ?? [])
            GLib.source_remove(id);
        this._timers = null;
        Main.layoutManager.uiGroup.translation_x = Main.layoutManager.uiGroup.translation_y = 0;
    }
}
