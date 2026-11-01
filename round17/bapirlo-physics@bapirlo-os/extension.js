// Kuro Window Physics
//   · THROW: drag a window and let go while still moving → it flies, slows down and bounces off the screen edges
//   · SHAKE: shake the window you're dragging (left-right-left-right) → every other window drops under gravity
//            and piles up at the bottom; shake again (or `bapirlo-physics float`) → they float back home
//   · SHATTER: closing a window breaks it into glass shards that tumble away
//   · CORNER: a hard throw into a screen corner feeds the Kuro Cosmos black hole (globalThis.kuroCosmos, round 22)
// Settings ~/.config/bapirlo/physics.json {"throw": true, "shake": true, "shatter": true}  (bapirlo-physics)
// Other extensions use globalThis.kuroPhysics.fling(win, vx, vy) / .hold(win, on) (Kuro Air Gestures does).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const CONF = GLib.build_filenamev([GLib.get_user_config_dir(), 'bapirlo', 'physics.json']);
const DEFAULTS = {throw: true, shake: true, shatter: true};
const THROW_MIN = 1300;          // px/s at release to count as a throw
const FRICTION = 2.6;            // velocity decay per second (exp)
const BOUNCE = 0.62;             // energy kept on an edge hit
const HOLE_V0 = 1800;            // a throw this fast (px/s at release) that hits the screen near a CORNER
const HOLE_ZONE = 160;           // feeds the Kuro Cosmos black hole (the window is closed) — round 22
const SHELF_V0 = 2400;            // a mostly-sideways throw this fast (px/s at release) that reaches the
                                  // left/right edge parks the window on the Kuro Lens window shelf
const GRAVITY = 3400;            // px/s²
const MOVING = new Set([Meta.GrabOp.MOVING, Meta.GrabOp.MOVING_UNCONSTRAINED, Meta.GrabOp.KEYBOARD_MOVING]);

const IFACE = `<node><interface name="org.bapirlo.Physics">
  <method name="Gravity"/><method name="Float"/>
</interface></node>`;

const maximized = w => (w.is_maximized ? w.is_maximized() : w.get_maximized?.() === 3);

function readConf() {
    try {
        const [, b] = GLib.file_get_contents(CONF);
        return {...DEFAULTS, ...JSON.parse(new TextDecoder().decode(b))};
    } catch {
        return {...DEFAULTS};
    }
}

function movable(w) {
    return w && !w.minimized && w.window_type === Meta.WindowType.NORMAL && !w.is_fullscreen() && !maximized(w) &&
        w.allows_move() && w.showing_on_its_workspace();
}

export default class KuroPhysicsExtension extends Extension {
    enable() {
        this._conf = readConf();
        this._bodies = new Map();        // win → {x, y, vx, vy, mode: 'fly'|'fall'|'home', ...}
        this._held = new Set();
        this._home = null;               // win → {x, y} before gravity
        this._drag = null;

        global.display.connectObject(
            'grab-op-begin', (_d, win, op) => this._grabBegin(win, op),
            'grab-op-end', (_d, win, op) => this._grabEnd(win, op), this);
        global.window_manager.connectObject('destroy', (_wm, actor) => this._shatter(actor), this);

        try {
            this._confMon = Gio.File.new_for_path(CONF).monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._confMon.connect('changed', () => (this._conf = readConf()));
        } catch {}

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, {
            Gravity: () => this.gravity(null),
            Float: () => this.float(),
        });
        this._dbus.export(Gio.DBus.session, '/org/bapirlo/Physics');
        this._owner = Gio.bus_own_name(Gio.BusType.SESSION, 'org.bapirlo.Physics',
            Gio.BusNameOwnerFlags.REPLACE, null, null, null);

        globalThis.kuroPhysics = {
            fling: (w, vx, vy) => this._conf.throw && this.fling(w, vx, vy),
            hold: (w, on) => (on ? this._held.add(w) : this._held.delete(w), on && this._bodies.delete(w)),
        };
    }

    disable() {
        delete globalThis.kuroPhysics;
        this._stopLoop();
        this._stopDragSampler();
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        this._confMon?.cancel();
        this._confMon = null;
        if (this._owner)
            Gio.bus_unown_name(this._owner);
        this._owner = 0;
        this._dbus?.unexport();
        this._dbus = null;
        for (const s of this._shards ?? [])
            s.destroy();
        this._shards = null;
        this._bodies = null;
        this._held = null;
    }

    // ---------------------------------------------------------------- dragging with the mouse
    _grabBegin(win, op) {
        if (!MOVING.has(op) || !win)
            return;
        this._bodies.delete(win);
        this._drag = {win, samples: [], flips: [], lastDir: 0, travel: 0, shook: false};
        this._stopDragSampler();
        this._sampler = GLib.timeout_add(GLib.PRIORITY_HIGH, 16, () => {
            this._sample();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopDragSampler() {
        if (this._sampler)
            GLib.source_remove(this._sampler);
        this._sampler = 0;
    }

    _sample() {
        const d = this._drag;
        if (!d)
            return;
        const r = d.win.get_frame_rect();
        const t = GLib.get_monotonic_time();
        const prev = d.samples[d.samples.length - 1];
        d.samples.push({t, x: r.x, y: r.y});
        while (d.samples.length && t - d.samples[0].t > 150000)
            d.samples.shift();
        if (!prev || !this._conf.shake || d.shook)
            return;
        // shake = quick left/right reversals
        const dx = r.x - prev.x;
        if (Math.abs(dx) < 6)
            return;
        d.travel += Math.abs(dx);
        const dir = Math.sign(dx);
        if (d.lastDir && dir !== d.lastDir)
            d.flips.push(t);
        d.lastDir = dir;
        while (d.flips.length && t - d.flips[0] > 900000)
            d.flips.shift();
        if (d.flips.length >= 4 && d.travel > 350) {
            d.shook = true;
            if (this._home)
                this.float();
            else
                this.gravity(d.win);
        }
    }

    _grabEnd(win, op) {
        if (!MOVING.has(op) || !this._drag || this._drag.win !== win)
            return;
        this._stopDragSampler();
        const s = this._drag.samples;
        const shook = this._drag.shook;
        this._drag = null;
        if (!this._conf.throw || shook || s.length < 3)
            return;
        // velocity over the last ~80 ms before letting go
        const last = s[s.length - 1];
        const first = s.find(p => last.t - p.t <= 90000) ?? s[0];
        const dt = (last.t - first.t) / 1e6;
        if (dt <= 0.015)
            return;
        const vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt;
        if (Math.hypot(vx, vy) > THROW_MIN)
            this.fling(win, vx, vy);
    }

    // ---------------------------------------------------------------- the simulation
    fling(win, vx, vy) {
        if (!movable(win))
            return;
        const r = win.get_frame_rect();
        const cap = 6000;
        const sp = Math.hypot(vx, vy);
        const k = sp > cap ? cap / sp : 1;
        this._bodies.set(win, {x: r.x, y: r.y, ox: r.x, oy: r.y, v0x: vx * k, v0y: vy * k, vx: vx * k, vy: vy * k, mode: 'fly', t0: GLib.get_monotonic_time()});
        win.connectObject('unmanaged', () => this._bodies?.delete(win), this);
        this._startLoop();
    }

    gravity(except) {
        const ws = global.workspace_manager.get_active_workspace();
        const wins = ws.list_windows().filter(w => w !== except && movable(w));
        if (!wins.length)
            return;
        this._home = new Map();
        for (const w of wins) {
            const r = w.get_frame_rect();
            this._home.set(w, {x: r.x, y: r.y});
            this._bodies.set(w, {x: r.x, y: r.y, vx: (Math.random() - 0.5) * 120, vy: -Math.random() * 250,
                mode: 'fall', t0: GLib.get_monotonic_time(), settled: false});
            w.connectObject('unmanaged', () => {
                this._bodies?.delete(w);
                this._home?.delete(w);
            }, this);
        }
        this._startLoop();
    }

    float() {
        if (!this._home)
            return;
        const t0 = GLib.get_monotonic_time();
        for (const [w, home] of this._home) {
            if (!movable(w))
                continue;
            const r = w.get_frame_rect();
            this._bodies.set(w, {mode: 'home', fx: r.x, fy: r.y, tx: home.x, ty: home.y, t0,
                delay: Math.random() * 120000, x: r.x, y: r.y});
        }
        this._home = null;
        this._startLoop();
    }

    _shelve(w, side, b, r) {
        try {
            return globalThis.kuroShelf?.park(w, side, {x: b.ox ?? r.x, y: b.oy ?? r.y}) ?? false;
        } catch (e) {
            console.error(`Kuro physics → shelf: ${e.stack ?? e}`);
            return false;
        }
    }

    // which corner a window touching the edge is in (its near corner within HOLE_ZONE of the screen corner)
    _corner(b, r, wa, maxX, maxY) {
        const left = b.x < wa.x + HOLE_ZONE, right = b.x > maxX - HOLE_ZONE;
        const top = b.y < wa.y + HOLE_ZONE, bottom = b.y > maxY - HOLE_ZONE;
        const v = (top ? 't' : bottom ? 'b' : '') + (left ? 'l' : right ? 'r' : '');
        if (v.length !== 2)
            return null;
        // the THROW must head diagonally into that corner — a sideways fling near the top stays a shelf throw
        const sp = Math.hypot(b.v0x, b.v0y);
        const sx = v[1] === 'l' ? -1 : 1, sy = v[0] === 't' ? -1 : 1;
        return Math.sign(b.v0x) === sx && Math.sign(b.v0y) === sy &&
            Math.abs(b.v0x) > 0.35 * sp && Math.abs(b.v0y) > 0.35 * sp ? v : null;
    }

    _hole(w, corner) {
        try {
            return globalThis.kuroCosmos?.blackhole(w, corner) ?? false;
        } catch (e) {
            console.error(`Kuro physics → black hole: ${e.stack ?? e}`);
            return false;
        }
    }

    _startLoop() {
        if (this._loop)
            return;
        this._lastT = GLib.get_monotonic_time();
        this._loop = GLib.timeout_add(GLib.PRIORITY_HIGH, 16, () => {
            try {
                return this._step() ? GLib.SOURCE_CONTINUE : (this._loop = 0, GLib.SOURCE_REMOVE);
            } catch (e) {
                console.error(`Kuro physics: ${e.stack ?? e}`);
                this._loop = 0;
                return GLib.SOURCE_REMOVE;
            }
        });
    }

    _stopLoop() {
        if (this._loop)
            GLib.source_remove(this._loop);
        this._loop = 0;
    }

    _step() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min(0.033, (now - this._lastT) / 1e6);
        this._lastT = now;
        const falling = [];
        for (const [w, b] of this._bodies) {
            if (this._held.has(w) || !movable(w) || (this._drag && this._drag.win === w)) {
                this._bodies.delete(w);
                continue;
            }
            const r = w.get_frame_rect();
            const wa = Main.layoutManager.getWorkAreaForMonitor(w.get_monitor());
            if (b.mode === 'home') {
                const k = Math.min(1, Math.max(0, (now - b.t0 - b.delay) / 650000));
                const e = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);       // ease-out-back
                b.x = b.fx + (b.tx - b.fx) * e;
                b.y = b.fy + (b.ty - b.fy) * e;
                w.move_frame(true, Math.round(b.x), Math.round(b.y));
                if (k >= 1)
                    this._bodies.delete(w);
                continue;
            }
            if (b.mode === 'fall') {
                falling.push([w, b, r, wa]);
                continue;
            }
            // flying: friction + bounce off the work area edges
            const f = Math.exp(-FRICTION * dt);
            b.vx *= f;
            b.vy *= f;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            const maxX = wa.x + wa.width - r.width, maxY = wa.y + wa.height - r.height;
            // slammed into a CORNER → Kuro Cosmos black hole swallows it (round 22)
            if (!b.bounced && (b.x < wa.x || b.x > maxX || b.y < wa.y || b.y > maxY) && Math.hypot(b.v0x, b.v0y) > HOLE_V0) {
                const corner = this._corner(b, r, wa, maxX, maxY);
                if (corner && this._hole(w, corner)) {
                    this._bodies.delete(w);
                    continue;
                }
            }
            // slammed into the left/right edge → Kuro Lens window shelf parks it there (round 21)
            if ((b.x < wa.x || b.x > maxX) && !b.bounced && Math.abs(b.v0x) > SHELF_V0 &&
                Math.abs(b.v0x) > 1.5 * Math.abs(b.v0y) && Math.sign(b.v0x) === (b.x < wa.x ? -1 : 1) && this._shelve(w, b.x < wa.x ? 'left' : 'right', b, r)) {
                this._bodies.delete(w);
                continue;
            }
            if (b.x < wa.x || b.x > maxX)
                b.bounced = true;       // only the first edge it hits can shelve it
            if (b.x < wa.x) {
                b.x = wa.x;
                b.vx = Math.abs(b.vx) * BOUNCE;
            } else if (b.x > maxX) {
                b.x = Math.max(wa.x, maxX);
                b.vx = -Math.abs(b.vx) * BOUNCE;
            }
            if (b.y < wa.y) {
                // slammed into the top edge → Kuro Throw-to-Phone sends it to your phone
                if (b.vy < -1400 && !b.sent && globalThis.kuroPhone) {
                    b.sent = true;
                    globalThis.kuroPhone.thrown(w, -b.vy);
                }
                b.y = wa.y;
                b.vy = Math.abs(b.vy) * BOUNCE;
            } else if (b.y > maxY) {
                b.y = Math.max(wa.y, maxY);
                b.vy = -Math.abs(b.vy) * BOUNCE;
            }
            w.move_frame(true, Math.round(b.x), Math.round(b.y));
            if (Math.hypot(b.vx, b.vy) < 35 || now - b.t0 > 4e6)
                this._bodies.delete(w);
        }

        // gravity pile: lower windows land first; each lands on the floor or on a window already resting below it
        falling.sort((a, b) => (b[1].y + b[2].height) - (a[1].y + a[2].height));
        const rested = [];
        for (const [w, b, r, wa] of falling) {
            let floor = wa.y + wa.height;
            for (const o of rested) {
                if (b.x < o.x + o.w - 30 && b.x + r.width > o.x + 30 && o.y >= b.y + r.height - 4)
                    floor = Math.min(floor, o.y);
            }
            if (!b.settled) {
                b.vy += GRAVITY * dt;
                b.vx *= Math.exp(-1.5 * dt);
                b.x += b.vx * dt;
                b.y += b.vy * dt;
                b.x = Math.min(Math.max(b.x, wa.x), Math.max(wa.x, wa.x + wa.width - r.width));
                if (b.y + r.height >= floor) {
                    b.y = floor - r.height;
                    if (b.vy > 420) {
                        b.vy = -b.vy * 0.28;           // a little bounce
                    } else {
                        b.vy = 0;
                        b.settled = true;
                    }
                }
                b.y = Math.max(b.y, wa.y);
                w.move_frame(true, Math.round(b.x), Math.round(b.y));
            }
            rested.push({x: b.x, y: b.y, w: r.width});
        }
        if (falling.length && falling.every(([, b]) => b.settled)) {
            for (const [w] of falling)
                this._bodies.delete(w);
        }
        return this._bodies.size > 0;
    }

    // ---------------------------------------------------------------- shatter on close
    _shatter(actor) {
        if (!this._conf.shatter || Main.overview.visible)
            return;
        const win = actor.meta_window;
        if (!win || win._kuroVanish || win.window_type !== Meta.WindowType.NORMAL || win.is_fullscreen() || !actor.visible)
            return;
        let content;
        try {
            content = actor.paint_to_content(null);
        } catch (e) {
            console.warn(`Kuro physics: no snapshot: ${e.message}`);
            return;
        }
        if (!content)
            return;
        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        if (aw < 40 || ah < 40)
            return;
        actor.opacity = 0;                                   // GNOME's own close effect stays invisible

        // break the rectangle into uneven shards (random guillotine cuts)
        const pieces = [];
        const cut = (x, y, w, h, depth) => {
            if (depth === 0 || (w < 90 && h < 90)) {
                pieces.push([x, y, w, h]);
                return;
            }
            const vertical = w > h ? Math.random() < 0.8 : Math.random() < 0.2;
            const f = 0.3 + Math.random() * 0.4;
            if (vertical) {
                cut(x, y, w * f, h, depth - 1);
                cut(x + w * f, y, w * (1 - f), h, depth - 1);
            } else {
                cut(x, y, w, h * f, depth - 1);
                cut(x, y + h * f, w, h * (1 - f), depth - 1);
            }
        };
        cut(0, 0, aw, ah, 5);

        const parent = Main.layoutManager.uiGroup;
        this._shards ??= new Set();
        const cx = aw / 2, cy = ah / 2;
        for (const [px, py, pw, ph] of pieces.slice(0, 40)) {
            const s = new Clutter.Actor({x: ax, y: ay, width: aw, height: ah, content, reactive: false});
            s.set_clip(px, py, pw, ph);
            s.set_pivot_point((px + pw / 2) / aw, (py + ph / 2) / ah);
            parent.insert_child_above(s, global.window_group);
            this._shards.add(s);
            const dirX = (px + pw / 2 - cx) / aw, dirY = (py + ph / 2 - cy) / ah;
            const dur = 650 + Math.random() * 350;
            s.ease({
                translation_x: dirX * (260 + Math.random() * 260),
                translation_y: dirY * 220 + 380 + Math.random() * 380,        // and they fall
                rotation_angle_z: (Math.random() - 0.5) * 220,
                scale_x: 0.6, scale_y: 0.6,
                opacity: 0,
                duration: dur,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => {
                    this._shards?.delete(s);
                    s.destroy();
                },
            });
        }
    }
}
