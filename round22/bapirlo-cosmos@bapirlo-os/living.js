// Kuro Living OS (shell part) — the desktop slowly grows with you.
//   · Dock: apps you use most (screen time, last 14 days) wear a warm glow; apps pinned to the dock that you
//     haven't opened in two weeks gather dust (greyed, slightly faded).
//   · Wallpaper: a little garden grows along the bottom corners. One more sprout for every day you use the
//     computer (30+ minutes), stems grow taller over the weeks, flowers start blooming after two weeks.
//     Redrawn once an hour — no animation cost.
//   · Folders: moss on ignored folders is bin/bapirlo-living (daily timer) — not in the shell.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {readJson, STATE_DIR, accent} from './gfx.js';

const ST_DIR = GLib.build_filenamev([STATE_DIR, 'screentime']);
const LIVED_S = 1800;         // a day "counts" with 30 min of use
const HOT = 0.2;              // top 20 % of use → glow
const DUST_DAYS = 14;
const GARDEN_H = 230;

function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return (s >>> 0) / 4294967296;
    };
}

// {use: Map id→s over 14 days, lived: number of days with ≥30 min, known: days of data}
function readLife() {
    const use = new Map();
    let lived = 0, known = 0;
    let dir;
    try {
        dir = GLib.Dir.open(ST_DIR, 0);
    } catch {
        return {use, lived, known};
    }
    const cutoff = GLib.DateTime.new_now_local().add_days(-DUST_DAYS).format('%Y-%m-%d');
    let name;
    while ((name = dir.read_name()) !== null) {
        if (!/^\d{4}-\d\d-\d\d\.json$/.test(name))
            continue;
        const d = readJson(GLib.build_filenamev([ST_DIR, name]), null);
        if (!d?.apps)
            continue;
        const total = Object.values(d.apps).reduce((a, v) => a + (v.s ?? 0), 0);
        if (total >= LIVED_S)
            lived++;
        if (name.slice(0, 10) >= cutoff) {
            known++;
            for (const [id, v] of Object.entries(d.apps))
                use.set(id, (use.get(id) ?? 0) + (v.s ?? 0));
        }
    }
    dir.close();
    return {use, lived, known};
}

export class Living {
    constructor(settings) {
        this._settings = settings;
        this._gardens = [];
        this._marked = new Set();
        this._settings.connectObject('changed::living', () => this._sync(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._sync(true), this);
        Main.overview.connectObject('showing', () => this._refreshDock(), this);
        this._sync();
    }

    _sync(rebuild = false) {
        const on = this._settings.get_boolean('living');
        if (!on || rebuild)
            this._teardown();
        if (!on)
            return;
        this._life = readLife();
        this._buildGardens();
        this._refreshDock();
        this._timer ??= GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 3600, () => {
            this._life = readLife();
            this._gardens.forEach(g => g.queue_repaint());
            this._refreshDock();
            return GLib.SOURCE_CONTINUE;
        });
        // dock icons get rebuilt now and then → re-mark a little after any change
        this._dockTimer ??= GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 600, () => {
            this._refreshDock();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---------------------------------------------------------------- dock: glow + dust
    _appIcons() {
        const out = [];
        const walk = a => {
            for (const c of a.get_children()) {
                if (c.app && c.icon && typeof c.app.get_id === 'function') {
                    out.push(c);
                    continue;
                }
                if (c.get_n_children?.())
                    walk(c);
            }
        };
        const dock = Main.uiGroup.get_children().filter(a => /dock/i.test(a.name ?? '') || /dock/i.test(a.constructor?.name ?? ''));
        for (const d of dock)
            walk(d);
        if (Main.overview.dash)
            walk(Main.overview.dash);
        return out;
    }

    _refreshDock() {
        if (!this._settings.get_boolean('living') || !this._life)
            return;
        const {use, known} = this._life;
        const vals = [...use.values()].sort((a, b) => b - a);
        const hotMin = vals.length ? vals[Math.max(0, Math.floor(vals.length * HOT) - 1)] : Infinity;
        const [r, g, b] = accent('accent2').map(v => Math.round(v * 255));
        for (const icon of this._appIcons()) {
            const id = icon.app.get_id();
            const s = use.get(id) ?? 0;
            const target = icon.icon?._iconBin ?? icon.icon;
            if (!target)
                continue;
            const hot = s >= hotMin && s > 3600;
            const dusty = known >= 5 && s === 0 && icon.app.state !== 2 /* RUNNING */;
            if (!this._marked.has(target)) {
                target._kuroStyle = target.get_style() ?? '';
                this._marked.add(target);
                target.connectObject('destroy', () => this._marked.delete(target), this);
            }
            const glow = hot ? ` box-shadow: 0 0 ${10 + Math.round(10 * Math.min(1, s / (vals[0] || 1)))}px rgba(${r},${g},${b},0.55); border-radius: 22%;` : '';
            target.set_style(`${target._kuroStyle}${glow}`);
            let fx = target.get_effect('kuro-dust');
            if (dusty && !fx)
                target.add_effect_with_name('kuro-dust', new Clutter.DesaturateEffect({factor: 0.75}));
            else if (!dusty && fx)
                target.remove_effect(fx);
            target.opacity = dusty ? 175 : 255;
        }
    }

    _clearDock() {
        for (const t of this._marked) {
            t.disconnectObject(this);
            t.set_style(t._kuroStyle || null);
            const fx = t.get_effect('kuro-dust');
            if (fx)
                t.remove_effect(fx);
            t.opacity = 255;
        }
        this._marked.clear();
    }

    // ---------------------------------------------------------------- the garden
    _buildGardens() {
        const bg = Main.layoutManager._backgroundGroup;
        if (!bg)
            return;
        Main.layoutManager.monitors.forEach((m, i) => {
            const g = new St.DrawingArea({x: m.x, y: m.y + m.height - GARDEN_H, width: m.width, height: GARDEN_H, reactive: false});
            g._monitor = i;
            g.connect('repaint', area => this._paint(area, i));
            // just above the wallpaper picture(s) (and the aurora), below Kuro Desk widgets
            const kids = bg.get_children();
            const lastBg = kids.filter(a => a instanceof Meta.BackgroundActor || a.constructor?.name === 'KuroShaderActor').pop();
            if (lastBg)
                bg.insert_child_above(g, lastBg);
            else
                bg.add_child(g);
            this._gardens.push(g);
        });
        bg.connectObject('child-added', (_b, a) => {
            if (!(a instanceof Meta.BackgroundActor || a.constructor?.name === 'KuroShaderActor'))
                return;
            for (const g of this._gardens)
                bg.set_child_above_sibling(g, a);
        }, this);
    }

    _paint(area, monitor) {
        const cr = area.get_context();
        const [W, H] = area.get_surface_size();
        const days = Math.max(1, this._life?.lived ?? 1);
        const [ar, ag, ab] = accent();
        const rand = rng(1337 + monitor * 7919);
        // two clusters: left and right corners (the dock lives in the middle)
        const sprouts = Math.min(26, 3 + days);
        const growth = Math.min(1, days / 30);            // full height after a month
        for (let i = 0; i < sprouts; i++) {
            const left = i % 2 === 0;
            const k = rand();
            const x = left ? W * (0.015 + k * 0.2) : W * (0.785 + k * 0.2);
            const age = Math.max(0, days - i);           // older sprouts are taller
            const h = (28 + rand() * 90) * Math.min(1, 0.25 + age / 25) * (0.5 + 0.5 * growth);
            const lean = (rand() - 0.5) * 0.5;
            // stem
            cr.setSourceRGBA(0.17 + rand() * 0.08, 0.42 + rand() * 0.15, 0.18, 0.9);
            cr.setLineWidth(1.6 + rand() * 1.4);
            cr.moveTo(x, H);
            const tx = x + lean * h, ty = H - h;
            cr.curveTo(x, H - h * 0.4, tx - lean * h * 0.3, ty + h * 0.3, tx, ty);
            cr.stroke();
            // leaves along the stem
            const leaves = 1 + Math.floor(Math.min(4, age / 4));
            for (let l = 0; l < leaves; l++) {
                const t = (l + 1) / (leaves + 1);
                const lx = x + (tx - x) * t, ly = H - h * t;
                const side = l % 2 ? 1 : -1;
                const L = 7 + rand() * 9;
                cr.setSourceRGBA(0.22, 0.55 + rand() * 0.15, 0.24, 0.85);
                cr.moveTo(lx, ly);
                cr.curveTo(lx + side * L * 0.5, ly - L * 0.6, lx + side * L, ly - L * 0.2, lx + side * L * 1.1, ly);
                cr.curveTo(lx + side * L * 0.6, ly + L * 0.25, lx + side * L * 0.2, ly + L * 0.1, lx, ly);
                cr.fill();
            }
            // flowers after two weeks, more as the weeks go by
            const blooming = days >= 14 && i < Math.floor((days - 12) / 2.5) && rand() < 0.85;
            if (blooming) {
                const petals = 5 + Math.floor(rand() * 3);
                const R = 4 + rand() * 4 + Math.min(4, (days - 14) / 10);
                const hue = rand();
                const pr = hue < 0.5 ? ar : 0.95, pg = hue < 0.5 ? ag : 0.85 - hue * 0.3, pb = hue < 0.5 ? ab : 0.9;
                for (let p = 0; p < petals; p++) {
                    const a = p / petals * Math.PI * 2;
                    cr.setSourceRGBA(pr, pg, pb, 0.92);
                    cr.arc(tx + Math.cos(a) * R * 0.8, ty + Math.sin(a) * R * 0.8, R * 0.62, 0, Math.PI * 2);
                    cr.fill();
                }
                cr.setSourceRGBA(1, 0.85, 0.35, 1);
                cr.arc(tx, ty, R * 0.42, 0, Math.PI * 2);
                cr.fill();
            } else if (days >= 7 && rand() < 0.4) {
                // a bud
                cr.setSourceRGBA(0.35, 0.65, 0.3, 0.95);
                cr.arc(tx, ty, 2.6, 0, Math.PI * 2);
                cr.fill();
            }
        }
        // a few glowing fireflies once the garden is established
        if (days >= 21) {
            for (let f = 0; f < Math.min(8, Math.floor(days / 7)); f++) {
                const fx = (rand() < 0.5 ? W * (0.03 + rand() * 0.2) : W * (0.77 + rand() * 0.2)), fy = H * (0.2 + rand() * 0.5);
                cr.setSourceRGBA(1, 0.95, 0.6, 0.18);
                cr.arc(fx, fy, 6, 0, Math.PI * 2);
                cr.fill();
                cr.setSourceRGBA(1, 0.95, 0.7, 0.9);
                cr.arc(fx, fy, 1.6, 0, Math.PI * 2);
                cr.fill();
            }
        }
        cr.$dispose();
    }

    get days() {
        return this._life?.lived ?? 0;
    }

    _teardown() {
        for (const id of [this._timer, this._dockTimer])
            if (id)
                GLib.source_remove(id);
        this._timer = this._dockTimer = null;
        Main.layoutManager._backgroundGroup?.disconnectObject(this);
        for (const g of this._gardens)
            g.destroy();
        this._gardens = [];
        this._clearDock();
    }

    destroy() {
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._teardown();
    }
}
