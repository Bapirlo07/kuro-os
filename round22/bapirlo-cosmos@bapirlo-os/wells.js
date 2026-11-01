// Kuro Gravity wells — Super+Alt+P makes the focused window a PLANET. Every other window on that workspace
// (and every window you open there afterwards) swings into orbit around it along an arc: evenly spaced
// around the planet, windows of the same app next to each other. A faint orbit ring and a glow sit on the
// wallpaper behind it. Drag the planet and its moons follow; drag a moon well away and it leaves orbit
// (drop it near its spot and it drifts back). Super+Alt+P on the planet again → everything goes home.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {accent} from './gfx.js';

const SWING = 750;            // ms per orbit swing
const LEAVE = 260;            // px dragged off its slot = leaves orbit
const MOVING = new Set([Meta.GrabOp.MOVING, Meta.GrabOp.MOVING_UNCONSTRAINED, Meta.GrabOp.KEYBOARD_MOVING]);

const maximized = w => (w.is_maximized ? w.is_maximized() : w.get_maximized?.() === 3);
const orbitable = w => w && !w.minimized && w.window_type === Meta.WindowType.NORMAL && !w.is_fullscreen() &&
    !maximized(w) && w.allows_move() && !w.is_on_all_workspaces() && !w.is_skip_taskbar();
const appId = w => Shell.WindowTracker.get_default().get_window_app(w)?.get_id() ?? w.get_wm_class() ?? '';

export class Wells {
    constructor() {
        this._systems = new Map();    // workspace → {planet, moons: Map<win, {home, slot}>, halo}
        this._anims = new Map();      // win → {from, to, c, t0}
        global.display.connectObject(
            'window-created', (_d, w) => this._created(w),
            'grab-op-begin', (_d, w, op) => this._grab(w, op, true),
            'grab-op-end', (_d, w, op) => this._grab(w, op, false), this);
        global.workspace_manager.connectObject('active-workspace-changed', () => this._syncHalos(), this);
    }

    toggle(win = global.display.focus_window) {
        if (!win)
            return;
        const ws = win.get_workspace();
        const sys = this._systems.get(ws);
        if (sys?.planet === win) {
            this.dissolve(ws, true);
            return;
        }
        if (sys)
            this.dissolve(ws, false);
        if (!orbitable(win))
            return;
        const s = {planet: win, moons: new Map(), ws};
        this._systems.set(ws, s);
        win.connectObject('unmanaged', () => this.dissolve(ws, false),
            'position-changed', () => this._planetMoved(s), this);
        for (const w of ws.list_windows())
            if (w !== win && w.get_monitor() === win.get_monitor() && orbitable(w))
                this._addMoon(s, w, false);
        this._halo(s);
        this._layout(s);
        Main.osdWindowManager.showAll(Gio.ThemedIcon.new('weather-clear-night-symbolic'),
            s.moons.size ? `Planet · ${s.moons.size} in orbit` : 'Planet · new windows will orbit it', null, null);
    }

    dissolve(ws, goHome) {
        const s = this._systems.get(ws);
        if (!s)
            return;
        this._systems.delete(ws);
        s.planet.disconnectObject(this);
        for (const [w, m] of s.moons) {
            w.disconnectObject(this);
            if (goHome && orbitable(w))
                this._swing(w, m.home, null);
        }
        s.halo?.destroy();
    }

    _addMoon(s, w, relayout = true) {
        if (s.moons.has(w))
            return;
        const r = w.get_frame_rect();
        s.moons.set(w, {home: {x: r.x, y: r.y}, slot: null});
        w.connectObject('unmanaged', () => {
            s.moons.delete(w);
            this._anims.delete(w);
            this._layout(s);
        }, this);
        if (relayout)
            this._layout(s);
    }

    _created(w) {
        // wait for the window to get its real size
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._pending?.delete(id);
            const ws = w.get_workspace?.();
            const s = ws && this._systems.get(ws);
            if (s && s.planet !== w && orbitable(w) && w.get_monitor() === s.planet.get_monitor() && !w.get_transient_for())
                this._addMoon(s, w);
            return GLib.SOURCE_REMOVE;
        });
        this._pending ??= new Set();
        this._pending.add(id);
    }

    // even slots on an ellipse around the planet, same-app windows next to each other
    _layout(s) {
        const p = s.planet.get_frame_rect();
        const wa = Main.layoutManager.getWorkAreaForMonitor(s.planet.get_monitor());
        const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
        const moons = [...s.moons.keys()].sort((a, b) => appId(a).localeCompare(appId(b)));
        const n = moons.length;
        moons.forEach((w, i) => {
            const r = w.get_frame_rect();
            const ang = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n) + (n === 2 ? Math.PI / 2 : 0);
            const rx = p.width / 2 + r.width * 0.32 + 40, ry = p.height / 2 + r.height * 0.32 + 30;
            let x = cx + Math.cos(ang) * rx - r.width / 2, y = cy + Math.sin(ang) * ry - r.height / 2;
            x = Math.min(Math.max(x, wa.x), wa.x + wa.width - r.width);
            y = Math.min(Math.max(y, wa.y), wa.y + wa.height - r.height);
            const m = s.moons.get(w);
            m.slot = {x: Math.round(x), y: Math.round(y)};
            this._swing(w, m.slot, {x: cx, y: cy});
        });
        this._drawHalo(s);
    }

    // move along an arc around c (or straight when c is null)
    _swing(w, to, c) {
        const r = w.get_frame_rect();
        this._anims.set(w, {from: {x: r.x, y: r.y}, to, c, t0: GLib.get_monotonic_time()});
        if (!this._loop) {
            this._loop = GLib.timeout_add(GLib.PRIORITY_HIGH, 16, () => {
                try {
                    return this._step() ? GLib.SOURCE_CONTINUE : (this._loop = 0, GLib.SOURCE_REMOVE);
                } catch (e) {
                    console.error(`Kuro wells: ${e.stack ?? e}`);
                    this._loop = 0;
                    return GLib.SOURCE_REMOVE;
                }
            });
        }
    }

    _step() {
        const now = GLib.get_monotonic_time();
        for (const [w, a] of this._anims) {
            if (!orbitable(w) || this._dragging === w) {
                this._anims.delete(w);
                continue;
            }
            const k = Math.min(1, (now - a.t0) / (SWING * 1000));
            const e = 1 - Math.pow(1 - k, 3);
            const r = w.get_frame_rect();
            let x, y;
            if (a.c) {
                // polar interpolation of the window centre around the planet centre
                const fcx = a.from.x + r.width / 2 - a.c.x, fcy = a.from.y + r.height / 2 - a.c.y;
                const tcx = a.to.x + r.width / 2 - a.c.x, tcy = a.to.y + r.height / 2 - a.c.y;
                const fa = Math.atan2(fcy, fcx), ta = Math.atan2(tcy, tcx);
                let da = ta - fa;
                while (da > Math.PI) da -= 2 * Math.PI;
                while (da < -Math.PI) da += 2 * Math.PI;
                const fr = Math.hypot(fcx, fcy), tr = Math.hypot(tcx, tcy);
                const ang = fa + da * e, rad = fr + (tr - fr) * e;
                x = a.c.x + Math.cos(ang) * rad - r.width / 2;
                y = a.c.y + Math.sin(ang) * rad - r.height / 2;
                if (k >= 1)
                    [x, y] = [a.to.x, a.to.y];
            } else {
                x = a.from.x + (a.to.x - a.from.x) * e;
                y = a.from.y + (a.to.y - a.from.y) * e;
            }
            w.move_frame(true, Math.round(x), Math.round(y));
            if (k >= 1)
                this._anims.delete(w);
        }
        return this._anims.size > 0;
    }

    _planetMoved(s) {
        if (this._following)
            return;
        const p = s.planet.get_frame_rect();
        const last = s.last ?? {x: p.x, y: p.y};
        s.last = {x: p.x, y: p.y};
        const dx = p.x - last.x, dy = p.y - last.y;
        if (!dx && !dy)
            return;
        // moons follow the planet (throttled to one move per frame by the event itself)
        this._following = true;
        for (const [w, m] of s.moons) {
            if (!m.slot || this._anims.has(w))
                continue;
            m.slot = {x: m.slot.x + dx, y: m.slot.y + dy};
            w.move_frame(true, m.slot.x, m.slot.y);
        }
        this._following = false;
        this._placeHalo(s);
    }

    _grab(w, op, begin) {
        if (!MOVING.has(op))
            return;
        if (begin) {
            this._dragging = w;
            for (const s of this._systems.values())
                if (s.planet === w)
                    s.last = {x: w.get_frame_rect().x, y: w.get_frame_rect().y};
            return;
        }
        this._dragging = null;
        for (const s of this._systems.values()) {
            const m = s.moons.get(w);
            if (!m?.slot)
                continue;
            const r = w.get_frame_rect();
            if (Math.hypot(r.x - m.slot.x, r.y - m.slot.y) > LEAVE) {
                // escaped orbit
                s.moons.delete(w);
                w.disconnectObject(this);
                this._layout(s);
            } else {
                const p = s.planet.get_frame_rect();
                this._swing(w, m.slot, {x: p.x + p.width / 2, y: p.y + p.height / 2});
            }
        }
    }

    // ---------------------------------------------------------------- glow + orbit ring on the wallpaper
    _halo(s) {
        const halo = new St.DrawingArea({reactive: false});
        halo.connect('repaint', area => this._paintHalo(area, s));
        const bg = Main.layoutManager._backgroundGroup;
        bg.add_child(halo);
        s.halo = halo;
        this._drawHalo(s);
        this._syncHalos();
    }

    _drawHalo(s) {
        if (!s.halo)
            return;
        const p = s.planet.get_frame_rect();
        let rx = p.width / 2 + 120, ry = p.height / 2 + 100;
        for (const [w] of s.moons) {
            const r = w.get_frame_rect();
            rx = Math.max(rx, p.width / 2 + r.width * 0.32 + 40);
            ry = Math.max(ry, p.height / 2 + r.height * 0.32 + 30);
        }
        s.ring = {rx, ry};
        s.halo.set_size(Math.round(2 * rx + 160), Math.round(2 * ry + 160));
        this._placeHalo(s);
        s.halo.queue_repaint();
    }

    _placeHalo(s) {
        if (!s.halo || !s.ring)
            return;
        const p = s.planet.get_frame_rect();
        s.halo.set_position(Math.round(p.x + p.width / 2 - s.ring.rx - 80), Math.round(p.y + p.height / 2 - s.ring.ry - 80));
    }

    _paintHalo(area, s) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const [r, g, b] = accent();
        const cx = w / 2, cy = h / 2;
        const p = s.planet.get_frame_rect();
        // glow behind the planet
        const glow = new cairo.RadialGradient(cx, cy, 0, cx, cy, Math.max(p.width, p.height) * 0.75);
        glow.addColorStopRGBA(0, r, g, b, 0.35);
        glow.addColorStopRGBA(1, r, g, b, 0);
        cr.setSource(glow);
        cr.paint();
        // the orbit
        cr.save();
        cr.translate(cx, cy);
        cr.scale(s.ring.rx, s.ring.ry);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();
        cr.setSourceRGBA(1, 1, 1, 0.22);
        cr.setLineWidth(1.5);
        cr.setDash([6, 9], 0);
        cr.stroke();
        cr.$dispose();
    }

    _syncHalos() {
        const active = global.workspace_manager.get_active_workspace();
        for (const [ws, s] of this._systems)
            if (s.halo)
                s.halo.visible = ws === active;
    }

    destroy() {
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const ws of [...this._systems.keys()])
            this.dissolve(ws, false);
        if (this._loop)
            GLib.source_remove(this._loop);
        this._loop = 0;
        for (const id of this._pending ?? [])
            GLib.source_remove(id);
        this._pending = null;
        this._anims.clear();
    }
}
