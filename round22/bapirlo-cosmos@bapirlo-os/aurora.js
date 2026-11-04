// Kuro Aurora — a living night-sky wallpaper drawn by the GPU, that is also a quiet system monitor:
//   · the aurora's brightness and speed follow CPU load (calm at idle, blazing while compiling)
//   · every notification is a shooting star
//   · while something downloads into ~/Downloads a comet crosses the sky; it bursts when the download ends
//   · mountains on the horizon, twinkling stars, the curtains tinted toward Kuro's accent
// Drawn on top of the normal wallpaper (below the desk widgets), 30 frames a second, and paused on a monitor
// whenever a maximised / fullscreen window covers it, while locked, or with the setting off.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ShaderActor, accent} from './gfx.js';

const FPS = 30;
const PARTIAL = /\.(part|crdownload|download|partial|opdownload)$/i;

const DECL = `
uniform float t;
uniform float aspect;
uniform float energy;     /* 0..1 CPU */
uniform vec3 tint;
uniform vec4 m0;          /* meteor: start.xy, dir angle, age (s; <0 = off) */
uniform vec4 m1;
uniform vec4 m2;
uniform vec3 comet;       /* x, y, on(0..1) */
uniform float burst;      /* comet burst 0..1 */
float hash(float n) { return fract(sin(n) * 43758.5453123); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash(i), hash(i + 1.0), f); }
float fbm(float x) { return noise(x) * 0.55 + noise(x * 2.03 + 7.1) * 0.28 + noise(x * 4.01 + 3.3) * 0.17; }
float noise2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
float meteor(vec2 p, vec4 m) {
    if (m.w < 0.0 || m.w > 1.4) return 0.0;
    vec2 dir = vec2(cos(m.z), sin(m.z));
    vec2 head = m.xy + dir * m.w * 0.9;
    vec2 d = p - head;
    float along = dot(d, -dir);
    float across = abs(d.x * dir.y - d.y * dir.x);
    float tail = smoothstep(0.28, 0.0, along) * step(0.0, along);
    float life = smoothstep(0.0, 0.1, m.w) * smoothstep(1.4, 0.9, m.w);
    return (exp(-across * across * 90000.0) * tail + exp(-dot(d, d) * 6000.0)) * life;
}`;

const BODY = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 p = vec2(uv.x * aspect, 1.0 - uv.y);          /* y up, 0 = bottom */
/* sky */
vec3 col = mix(vec3(0.05, 0.06, 0.14), vec3(0.0, 0.01, 0.04), smoothstep(0.0, 1.0, p.y));
col += vec3(0.10, 0.05, 0.16) * exp(-p.y * 3.5);
/* stars (two layers, twinkling) */
for (int l = 0; l < 2; l++) {
    float sc = l == 0 ? 90.0 : 190.0;
    vec2 g = p * sc;
    vec2 id = floor(g);
    float h = hash2(id + float(l) * 17.0);
    if (h > 0.972) {
        vec2 c = id + 0.5 + (vec2(hash2(id + 3.1), hash2(id + 5.7)) - 0.5) * 0.7;
        float d = length(g - c);
        float tw = 0.6 + 0.4 * sin(t * (1.0 + h * 3.0) + h * 40.0);
        col += vec3(0.9, 0.93, 1.0) * exp(-d * d * (l == 0 ? 16.0 : 28.0)) * tw * (0.35 + (h - 0.972) * 25.0) * smoothstep(0.12, 0.4, p.y);
    }
}
/* aurora: three curtains */
float spd = 0.05 + energy * 0.25;
float glow = 1.1 + energy * 1.1;
vec3 aur = vec3(0.0);
for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = p.x * (0.9 + fi * 0.35) + fi * 3.7;
    float base = 0.55 + fi * 0.07 + (fbm(x * 1.3 + t * spd * (1.0 + fi * 0.4)) - 0.5) * 0.35;
    float dy = p.y - base;
    float rays = 0.55 + 0.45 * noise2(vec2(p.x * 38.0 + fi * 11.0, t * (0.4 + energy)));
    float curtain = exp(-max(dy, 0.0) * (5.0 - fi)) * smoothstep(-0.03, 0.0, dy) * rays;
    curtain *= 0.5 + 0.5 * fbm(x * 2.0 - t * spd * 2.0 + 9.0);
    vec3 low = mix(vec3(0.1, 1.0, 0.55), tint, 0.25);
    vec3 high = mix(vec3(0.55, 0.25, 0.95), tint, 0.45);
    aur += mix(low, high, smoothstep(0.0, 0.3, dy)) * curtain * (0.55 - fi * 0.12);
}
col += aur * glow;
/* meteors (notifications) */
col += vec3(1.0, 0.97, 0.9) * (meteor(p, m0) + meteor(p, m1) + meteor(p, m2));
/* comet (download) */
if (comet.z > 0.0) {
    vec2 cp = vec2(comet.x * aspect, comet.y);
    vec2 d = p - cp;
    vec2 back = normalize(vec2(-1.0, 0.25));
    float along = dot(d, back);
    float across = abs(d.x * back.y - d.y * back.x);
    float tail = step(0.0, along) * exp(-along * 4.0) * exp(-across * across / (0.0004 + along * 0.004));
    float head = exp(-dot(d, d) * 9000.0);
    col += (vec3(0.6, 0.85, 1.0) * tail * 0.9 + vec3(1.0) * head * 1.5) * comet.z;
    col += vec3(0.7, 0.9, 1.0) * exp(-length(d) * 30.0) * burst * 2.0;
}
/* mountains */
float far = 0.16 + fbm(p.x * 2.2 + 1.0) * 0.12;
float near = 0.08 + fbm(p.x * 4.0 + 20.0) * 0.1;
vec3 farCol = vec3(0.04, 0.05, 0.1) + aur * 0.08;
col = mix(col, farCol, smoothstep(far + 0.003, far - 0.003, p.y));
col = mix(col, vec3(0.012, 0.012, 0.03), smoothstep(near + 0.003, near - 0.003, p.y));
cogl_color_out = vec4(clamp(col, 0.0, 1.0), 1.0);`;

export class Aurora {
    constructor(settings) {
        this._settings = settings;
        this._skies = [];
        this._meteors = [-1, -1, -1].map(() => ({x: 0, y: 0, a: 0, t0: -1}));
        this._energy = 0;
        this._load = 0;
        this._downloads = new Set();
        this._settings.connectObject('changed::aurora', () => this._sync(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._rebuild(), this);
        this._sync();
    }

    _sync() {
        const on = this._settings.get_boolean('aurora');
        if (on && !this._timer)
            this._start();
        else if (!on && this._timer)
            this._stop();
    }

    _start() {
        this._t0 = GLib.get_monotonic_time();
        this._rebuild();
        this._cpuPrev = this._readCpu();
        this._cpuTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => {
            const c = this._readCpu();
            if (c && this._cpuPrev) {
                const idle = c.idle - this._cpuPrev.idle, total = c.total - this._cpuPrev.total;
                this._load = total > 0 ? Math.min(1, Math.max(0, 1 - idle / total)) : 0;
            }
            this._cpuPrev = c;
            return GLib.SOURCE_CONTINUE;
        });
        this._watchDownloads();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(1000 / FPS), () => {
            this._frame();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _rebuild() {
        for (const s of this._skies)
            s.destroy();
        this._skies = [];
        if (!this._timer && !this._settings.get_boolean('aurora'))
            return;
        const bg = Main.layoutManager._backgroundGroup;
        if (!bg)
            return;
        bg.disconnectObject(this);
        const tint = accent();
        this._tint = tint;
        Main.layoutManager.monitors.forEach((m, i) => {
            const s = new ShaderActor(DECL, BODY, {x: m.x, y: m.y, width: m.width, height: m.height, reactive: false});
            s._monitor = i;
            s.set('aspect', m.width / m.height).set('tint', tint).set('energy', 0).set('comet', [0, 0, 0]).set('burst', 0);
            for (const k of ['m0', 'm1', 'm2'])
                s.set(k, [0, 0, 0, -1]);
            // above the picture(s), below Kuro Desk widgets / desktop icons
            const pics = bg.get_children().filter(a => a instanceof Meta.BackgroundActor);
            const top = pics[pics.length - 1];
            if (top)
                bg.insert_child_above(s, top);
            else
                bg.insert_child_at_index(s, 0);
            this._skies.push(s);
        });
        // a wallpaper change adds a new picture actor on top → lift the skies above it again
        bg.connectObject('child-added', (_g, a) => {
            if (!(a instanceof Meta.BackgroundActor))
                return;
            for (const s of this._skies)
                bg.set_child_above_sibling(s, a);
        }, this);
    }

    _readCpu() {
        try {
            const [, b] = GLib.file_get_contents('/proc/stat');
            const f = new TextDecoder().decode(b).split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
            const idle = f[3] + (f[4] ?? 0);
            return {idle, total: f.reduce((a, v) => a + v, 0)};
        } catch {
            return null;
        }
    }

    _watchDownloads() {
        const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ?? GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
        try {
            const f = Gio.File.new_for_path(dir);
            const en = f.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)))
                if (PARTIAL.test(info.get_name()))
                    this._downloads.add(info.get_name());
            en.close(null);
            this._dlMon = f.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._dlMon.connect('changed', (_m, file, other, ev) => {
                const name = file.get_basename();
                const was = this._downloads.size;
                if (PARTIAL.test(name)) {
                    if (ev === Gio.FileMonitorEvent.CREATED)
                        this._downloads.add(name);
                    else if (ev === Gio.FileMonitorEvent.DELETED || ev === Gio.FileMonitorEvent.MOVED_OUT || ev === Gio.FileMonitorEvent.RENAMED)
                        this._downloads.delete(name);
                }
                if (was > 0 && this._downloads.size === 0)
                    this._burstT0 = GLib.get_monotonic_time();
                if (was === 0 && this._downloads.size > 0)
                    this._cometT0 = GLib.get_monotonic_time();
            });
            if (this._downloads.size)
                this._cometT0 = GLib.get_monotonic_time();
        } catch (e) {
            console.warn(`Kuro aurora: downloads watch: ${e.message}`);
        }
    }

    // a notification arrived
    shootingStar() {
        if (!this._timer)
            return;
        const m = this._meteors.find(x => x.t0 < 0 || (GLib.get_monotonic_time() - x.t0) / 1e6 > 1.4) ?? this._meteors[0];
        m.x = 0.3 + Math.random() * 1.2;
        m.y = 0.75 + Math.random() * 0.2;
        m.a = Math.PI + 0.35 + Math.random() * 0.35;    // down-left
        if (Math.random() < 0.5) {
            m.a = -0.35 - Math.random() * 0.35;          // down-right
            m.x = Math.random() * 0.8;
        }
        m.t0 = GLib.get_monotonic_time();
    }

    _covered(i) {
        const ws = global.workspace_manager.get_active_workspace();
        return ws.list_windows().some(w => !w.minimized && w.get_monitor() === i &&
            (w.is_fullscreen() || (w.is_maximized ? w.is_maximized() : w.get_maximized?.() === 3)));
    }

    // Kuro Smooth Guard: Lite mode freezes the sky (no frames drawn)
    pause(on) {
        this._paused = on;
    }

    _frame() {
        if (this._paused)
            return;
        if (Main.sessionMode.isLocked)
            return;
        const now = GLib.get_monotonic_time();
        const t = (now - this._t0) / 1e6;
        this._energy += (this._load - this._energy) * 0.04;
        const mets = this._meteors.map(m => [m.x, m.y, m.a, m.t0 < 0 ? -1 : (now - m.t0) / 1e6]);
        let comet = [0, 0, 0];
        if (this._downloads.size && this._cometT0) {
            const k = (((now - this._cometT0) / 1e6) / 24) % 1;          // crosses in 24 s, loops while busy
            comet = [0.05 + k * 0.9, 0.62 + 0.18 * Math.sin(k * Math.PI), Math.min(1, (now - this._cometT0) / 6e5)];
            this._lastComet = comet;
        }
        let burst = 0;
        if (this._burstT0) {
            const b = (now - this._burstT0) / 1e6;
            burst = b < 1.2 ? Math.sin(Math.PI * b / 1.2) : 0;
            if (b >= 1.2)
                this._burstT0 = 0;
            else
                comet = [...(this._lastComet ?? [0.5, 0.7, 0]).slice(0, 2), 0.6 * (1 - b / 1.2)];
        }
        // Kuro Sense (round 25): while music plays the sky pulses to the kick and leans to the album colour
        const beat = globalThis.kuroBeat;
        const kick = beat?.bass ?? 0;
        this._beatMix = (this._beatMix ?? 0) + ((beat?.level ? 0.55 : 0) - (this._beatMix ?? 0)) * 0.03;
        const base = this._tint ?? [0.894, 0, 0.239];
        const tintNow = beat?.col && this._beatMix > 0.01 ? base.map((v, k) => v + (beat.col[k] - v) * this._beatMix) : null;
        const wasTinted = this._tinted;
        this._tinted = !!tintNow;
        for (const s of this._skies) {
            if (this._covered(s._monitor))
                continue;
            s.set('t', t).set('energy', Math.min(1, this._energy + kick * 0.7)).set('comet', comet).set('burst', burst);
            if (tintNow || wasTinted)
                s.set('tint', tintNow ?? base);
            s.set('m0', mets[0]).set('m1', mets[1]).set('m2', mets[2]);
        }
    }

    _stop() {
        for (const id of [this._timer, this._cpuTimer])
            if (id)
                GLib.source_remove(id);
        this._timer = this._cpuTimer = 0;
        Main.layoutManager._backgroundGroup?.disconnectObject(this);
        this._dlMon?.cancel();
        this._dlMon = null;
        this._downloads.clear();
        for (const s of this._skies)
            s.destroy();
        this._skies = [];
    }

    destroy() {
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._stop();
    }
}
