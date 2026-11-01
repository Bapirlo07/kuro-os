// Kuro Constellation — Super+Shift+Space: your apps as a night sky. Each app is a star, bigger and brighter
// the more you use it (Kuro screen time, last 30 days); faint lines join apps you tend to use on the same
// days, so your "work" and "play" apps gather into their own constellations. Type and the matching stars
// flare while the rest dim; Enter or a click launches. Esc / click the sky closes.
// The layout is worked out once (a small force simulation, seeded per app so the sky stays the same) and
// kept until your usage changes a lot.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ShaderActor, readJson, STATE_DIR, accent} from './gfx.js';

const MAX_STARS = 44;
const DAYS = 30;
const ST_DIR = GLib.build_filenamev([STATE_DIR, 'screentime']);

const SKY = `
uniform float aspect;
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`;
const SKY_BODY = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 p = vec2(uv.x * aspect, uv.y);
vec3 col = mix(vec3(0.02, 0.02, 0.06), vec3(0.06, 0.03, 0.10), uv.y);
col += vec3(0.12, 0.06, 0.18) * exp(-length(uv - vec2(0.5, 0.55)) * 3.0) * 0.6;   // milky glow
vec2 g = p * 160.0; vec2 id = floor(g); float h = h2(id);
if (h > 0.96) { float d = length(g - id - 0.5); col += vec3(0.8, 0.85, 1.0) * exp(-d * d * 10.0) * (h - 0.96) * 18.0; }
cogl_color_out = vec4(col, 1.0);`;

function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++)
        h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296;
}

// {usage: Map id→seconds, days: [Set ids]}
function readUsage() {
    const usage = new Map();
    const days = [];
    const now = GLib.DateTime.new_now_local();
    for (let i = 0; i < DAYS; i++) {
        const key = now.add_days(-i).format('%Y-%m-%d');
        const d = readJson(GLib.build_filenamev([ST_DIR, `${key}.json`]), null);
        if (!d?.apps)
            continue;
        const set = new Set();
        for (const [id, v] of Object.entries(d.apps)) {
            usage.set(id, (usage.get(id) ?? 0) + (v.s ?? 0));
            if ((v.s ?? 0) >= 300)
                set.add(id);
        }
        days.push(set);
    }
    return {usage, days};
}

export class Constellation {
    constructor() {
        this._sys = Shell.AppSystem.get_default();
    }

    get open() {
        return !!this._root;
    }

    toggle() {
        if (this._root)
            this.close();
        else
            this.show();
    }

    _pickApps() {
        const {usage, days} = readUsage();
        const apps = [];
        const seen = new Set();
        const add = app => {
            if (!app || seen.has(app.get_id()) || !app.get_app_info()?.should_show?.())
                return;
            seen.add(app.get_id());
            apps.push(app);
        };
        [...usage.entries()].sort((a, b) => b[1] - a[1]).forEach(([id]) => add(this._sys.lookup_app(id)));
        for (const id of global.settings.get_strv('favorite-apps'))
            add(this._sys.lookup_app(id));
        for (const app of Shell.AppUsage.get_default().get_most_used())
            add(app);
        return {apps: apps.slice(0, MAX_STARS), usage, days};
    }

    // force layout in a unit square: links pull, everyone repels, gentle pull to centre
    _layout(apps, links) {
        const n = apps.length;
        const pos = apps.map(a => {
            const h = hashStr(a.get_id()), h2 = hashStr(`${a.get_id()}*`);
            return {x: 0.5 + (h - 0.5) * 0.8, y: 0.5 + (h2 - 0.5) * 0.8, vx: 0, vy: 0};
        });
        for (let it = 0; it < 220; it++) {
            for (let i = 0; i < n; i++) {
                const p = pos[i];
                let fx = (0.5 - p.x) * 0.02, fy = (0.5 - p.y) * 0.02;
                for (let j = 0; j < n; j++) {
                    if (i === j)
                        continue;
                    const q = pos[j];
                    let dx = p.x - q.x, dy = p.y - q.y;
                    const d2 = dx * dx + dy * dy + 1e-4;
                    fx += dx / d2 * 0.00035;
                    fy += dy / d2 * 0.00035;
                }
                p.vx = (p.vx + fx) * 0.82;
                p.vy = (p.vy + fy) * 0.82;
            }
            for (const [i, j, w] of links) {
                const p = pos[i], q = pos[j];
                const dx = q.x - p.x, dy = q.y - p.y;
                const d = Math.hypot(dx, dy) || 1e-3;
                const f = (d - 0.09) * 0.05 * w;
                p.vx += dx / d * f;
                p.vy += dy / d * f;
                q.vx -= dx / d * f;
                q.vy -= dy / d * f;
            }
            for (const p of pos) {
                p.x = Math.min(0.94, Math.max(0.06, p.x + p.vx));
                p.y = Math.min(0.9, Math.max(0.1, p.y + p.vy));
            }
        }
        return pos;
    }

    _links(apps, days) {
        const idx = new Map(apps.map((a, i) => [a.get_id(), i]));
        const count = new Map(), single = new Array(apps.length).fill(0);
        for (const set of days) {
            const ids = [...set].filter(id => idx.has(id)).map(id => idx.get(id));
            for (const i of ids)
                single[i]++;
            for (let a = 0; a < ids.length; a++) {
                for (let b = a + 1; b < ids.length; b++) {
                    const k = ids[a] < ids[b] ? `${ids[a]},${ids[b]}` : `${ids[b]},${ids[a]}`;
                    count.set(k, (count.get(k) ?? 0) + 1);
                }
            }
        }
        const all = [];
        for (const [k, c] of count) {
            const [i, j] = k.split(',').map(Number);
            const jac = c / (single[i] + single[j] - c);
            if (jac >= 0.3 && c >= 2)
                all.push([i, j, jac]);
        }
        // keep each star's two strongest links
        all.sort((a, b) => b[2] - a[2]);
        const deg = new Array(apps.length).fill(0);
        return all.filter(([i, j]) => deg[i] < 2 && deg[j] < 2 && (deg[i]++, deg[j]++, true));
    }

    show() {
        if (this._root || Main.sessionMode.isLocked)
            return;
        Main.overview.hide();
        const mon = Main.layoutManager.primaryMonitor;
        const {apps, usage, days} = this._pickApps();
        if (!apps.length)
            return;
        const links = this._links(apps, days);
        const pos = this._layout(apps, links);
        const maxUse = Math.max(1, ...apps.map(a => usage.get(a.get_id()) ?? 0));
        const W = mon.width, H = mon.height;

        const root = new St.Widget({reactive: true, can_focus: true, x: mon.x, y: mon.y, width: W, height: H,
            opacity: 0});
        this._root = root;
        const sky = new ShaderActor(SKY, SKY_BODY, {width: W, height: H});
        sky.set('aspect', W / H);
        root.add_child(sky);

        const [ar, ag, ab] = accent();
        const lines = new St.DrawingArea({width: W, height: H});
        lines.connect('repaint', area => {
            const cr = area.get_context();
            for (const [i, j, w] of links) {
                const lit = this._lit ? this._lit.has(i) && this._lit.has(j) : true;
                cr.setSourceRGBA(lit ? 0.75 : 0.5, lit ? 0.8 : 0.5, 1, (lit ? 0.18 : 0.05) + 0.25 * w);
                cr.setLineWidth(1.2);
                cr.moveTo(pos[i].x * W, pos[i].y * H);
                cr.lineTo(pos[j].x * W, pos[j].y * H);
                cr.stroke();
            }
            cr.$dispose();
        });
        root.add_child(lines);
        this._lines = lines;

        const title = new St.Label({style_class: 'kuro-const-title', text: 'Constellation'});
        title.clutter_text.ellipsize = 0;
        root.add_child(title);
        title.set_position(48, 40);
        this._entry = new St.Entry({style_class: 'kuro-const-entry', hint_text: 'Type to find a star…', can_focus: true});
        root.add_child(this._entry);
        this._entry.set_width(420);
        this._entry.set_position(Math.round(W / 2 - 210), H - 110);

        this._stars = apps.map((app, i) => {
            const use = usage.get(app.get_id()) ?? 0;
            const mag = Math.sqrt(use / maxUse);
            const size = Math.round(40 + 40 * mag);
            const b = new St.Button({style_class: 'kuro-star', reactive: true, track_hover: true, can_focus: false,
                width: size, height: size, style: `border-radius: ${size / 2}px; box-shadow: 0 0 ${Math.round(10 + 30 * mag)}px rgba(${Math.round(ar * 255)},${Math.round(ag * 255)},${Math.round(ab * 255)},${(0.35 + 0.5 * mag).toFixed(2)});`});
            b.set_child(app.create_icon_texture(Math.round(size * 0.62)));
            const label = new St.Label({style_class: 'kuro-star-label', text: app.get_name(), opacity: mag > 0.35 || i < 8 ? 220 : 0});
            const x = Math.round(pos[i].x * W - size / 2), y = Math.round(pos[i].y * H - size / 2);
            b.set_position(x, y);
            b.set_pivot_point(0.5, 0.5);
            root.add_child(b);
            root.add_child(label);
            label.set_position(Math.round(pos[i].x * W - 80), y + size + 6);
            label.set_width(160);
            label.clutter_text.set_line_alignment?.(1);
            const star = {app, b, label, mag, base: label.opacity, i};
            b.connect('clicked', () => this._launch(app));
            b.connect('notify::hover', () => {
                if (!this._lit || this._lit.has(i))
                    label.ease({opacity: b.hover ? 255 : star.base, duration: 120});
                b.ease({scale_x: b.hover ? 1.25 : (this._lit?.has(i) ? 1.5 : 1), scale_y: b.hover ? 1.25 : (this._lit?.has(i) ? 1.5 : 1), duration: 140});
            });
            // twinkle in, nearest the centre first
            b.scale_x = b.scale_y = 0.1;
            b.opacity = 0;
            const delay = Math.round(Math.hypot(pos[i].x - 0.5, pos[i].y - 0.5) * 500);
            b.ease({scale_x: 1, scale_y: 1, opacity: 255, delay, duration: 380, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            return star;
        });

        Main.layoutManager.addTopChrome(root);
        root.ease({opacity: 255, duration: 200});
        this._grab = Main.pushModal(root, {actionMode: Shell.ActionMode.SYSTEM_MODAL});
        this._entry.grab_key_focus();
        this._entry.clutter_text.connect('text-changed', () => this._filter());
        this._entry.clutter_text.connect('activate', () => {
            const best = this._best();
            if (best)
                this._launch(best.app);
        });
        root.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        root.connect('button-press-event', (_a, ev) => {
            if (ev.get_source?.() === root || ev.get_source?.() === sky || ev.get_source?.() === lines)
                this.close();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _filter() {
        const q = this._entry.get_text().trim().toLowerCase();
        if (!q) {
            this._lit = null;
            for (const s of this._stars) {
                s.b.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 160});
                s.label.ease({opacity: s.base, duration: 160});
            }
            this._lines.queue_repaint();
            return;
        }
        const words = q.split(/\s+/);
        const match = app => {
            const hay = `${app.get_name()} ${app.get_app_info()?.get_keywords?.()?.join(' ') ?? ''} ${app.get_id()}`.toLowerCase();
            return words.every(w => hay.includes(w));
        };
        this._lit = new Set(this._stars.filter(s => match(s.app)).map(s => s.i));
        for (const s of this._stars) {
            const on = this._lit.has(s.i);
            s.b.ease({opacity: on ? 255 : 45, scale_x: on ? 1.5 : 0.85, scale_y: on ? 1.5 : 0.85, duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            s.label.ease({opacity: on ? 255 : 0, duration: 180});
        }
        this._lines.queue_repaint();
        // nothing in the sky matches → a new star from the rest of your apps
        this._extra?.destroy();
        this._extra = null;
        if (!this._lit.size) {
            const res = Shell.AppSystem.search(q).flat().map(id => this._sys.lookup_app(id)).filter(Boolean);
            if (res.length) {
                const app = res[0];
                const b = new St.Button({style_class: 'kuro-star kuro-star-new', width: 64, height: 64,
                    style: 'border-radius: 32px;'});
                b.set_child(app.create_icon_texture(40));
                b.connect('clicked', () => this._launch(app));
                const lbl = new St.Label({style_class: 'kuro-star-label', text: `${app.get_name()} — a new star`});
                const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_align: Clutter.ActorAlign.CENTER});
                box.add_child(b);
                box.add_child(lbl);
                this._root.add_child(box);
                box.set_position(Math.round(this._root.width / 2 - 100), Math.round(this._root.height / 2 - 60));
                box.set_width(200);
                this._extra = box;
                this._extraApp = app;
            }
        }
    }

    _best() {
        if (this._extra && this._extraApp)
            return {app: this._extraApp};
        const lit = this._stars.filter(s => !this._lit || this._lit.has(s.i));
        lit.sort((a, b) => b.mag - a.mag);
        return lit[0] ?? null;
    }

    _launch(app) {
        this.close();
        try {
            app.activate();
        } catch (e) {
            console.warn(`Kuro constellation: ${e.message}`);
        }
    }

    close() {
        if (!this._root)
            return;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        const root = this._root;
        this._root = null;
        this._stars = [];
        this._lit = null;
        this._extra = null;
        root.ease({opacity: 0, duration: 160, onStopped: () => {
            Main.layoutManager.removeChrome(root);
            root.destroy();
        }});
    }

    destroy() {
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        if (this._root) {
            Main.layoutManager.removeChrome(this._root);
            this._root.destroy();
        }
        this._root = null;
    }
}
