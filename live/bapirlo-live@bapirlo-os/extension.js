// Kuro Live Wallpaper — GPU-drawn embers + sakura petals over the wallpaper (GNOME Shell 51).
//   effect.js   the shader (one Clutter.ShaderEffect per monitor's wallpaper actor)
// Frames are driven at the "fps" setting (30 by default), not the 240 Hz panel rate. The
// animation fades out and the timer stops whenever nobody can see it:
//   a fullscreen / maximised app window covers that monitor · the overview is open · the screen is
//   locked or the session is in the background · on battery · in power-saver (each switchable) ·
//   paused by hand (Super+Alt+W).
// While stopped only a 1 s check runs. The wallpaper itself never changes on disk.
// PARALLAX (setting "parallax", "parallax-strength") is separate from the particles: it keeps
// following the pointer while they are paused or switched off, also over a live video (Hanabi
// draws the video inside the same wallpaper actor). Frames are pushed only while the pointer
// moves or the art is still catching up; it stops when locked, in the overview or when covered
// (not for "paused", battery or power-saver — standing still it costs nothing).
// DEPTH / 3D (setting "depth", on by default): a depth map of the wallpaper (white = near, made by
// lib/bapirlo_depth.py — `bapirlo-wallpaper depth`, which every wallpaper change runs) lets the shader move
// near things more than far ones as the pointer moves, so the picture looks 3D. Live videos use their
// still frame's map (the camera in those loops doesn't move). Found via ~/.local/state/bapirlo/wallpaper/
// depth.json ({still, depth}); if it's missing for the current picture we ask for one once. "depth-drift"
// adds a slow sway while the animation is allowed to run (same rules as the particles).
// SEARCH FOCUS (focus.js, setting "search-focus"): while the overview / app grid or ArcMenu is open
// the wallpaper blurs, zooms and drifts toward what you are looking at.
// Off: gnome-extensions disable bapirlo-live@bapirlo-os
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LiveEffect} from './effect.js';
import {SearchFocus} from './focus.js';

const NAME = 'bapirlo-live';
const IDLE_CHECK_MS = 1000;
const FADE_S = 0.6;
const WRAP_S = 3600;        // shader time wraps hourly (float precision); hidden by the fade logic
const PARALLAX = {max: 0.010, ease: 0.08};      // max shift at strength 1 (fraction of the screen)
const PARALLAX_IDLE_MS = 100;                     // pointer still + art settled: look 10× a second
const DEPTH = {max: 0.025, focal: 0.4, drift: 0.35}; // near/far split at strength 1; focal plane stays put
const DEPTH_STATE = GLib.build_filenamev([GLib.get_user_state_dir(), 'bapirlo', 'wallpaper', 'depth.json']);

function hexToRgb(hex, fallback) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    const v = parseInt(m ? m[1] : fallback, 16);
    return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}

export default class BapirloLiveExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._effects = new Map();          // monitor index → {effect, actor, amount}
        this._managers = new Set();
        this._attachIdle = 0;
        this._t = 0;
        this._ptr = [0, 0];                 // eased pointer, -1…1 from the primary monitor's centre
        this._depthAmt = 0;
        this._depth = null;                 // {still, path} of the loaded map
        this._asked = new Set();
        this._settled = true;
        this._lastUs = GLib.get_monotonic_time();
        this._readSettings();

        this._settings.connectObject('changed', () => {
            this._readSettings();
            this._schedule();
        }, this);
        Main.layoutManager.connectObject('monitors-changed', () => this._attachAll(), this);
        // Hanabi (live video) rebuilds every BackgroundManager via _updateBackgrounds() without any
        // signal on the old ones: watch the group itself so the effect follows the new actors
        Main.layoutManager._backgroundGroup.connectObject(
            'child-added', () => this._queueAttach(),
            'child-removed', () => this._queueAttach(), this);
        this._bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._bg.connectObject('changed::picture-uri', () => this._queueDepth(), this);
        this._depthMon = Gio.File.new_for_path(DEPTH_STATE).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._depthMon.connectObject('changed', () => this._queueDepth(), this);

        this._upower = this._proxy(Gio.DBus.system, 'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower');
        this._ppd = this._proxy(Gio.DBus.system, 'net.hadess.PowerProfiles', '/net/hadess/PowerProfiles', 'net.hadess.PowerProfiles');
        this._login = this._proxy(Gio.DBus.system, 'org.freedesktop.login1', '/org/freedesktop/login1/session/auto', 'org.freedesktop.login1.Session');

        Main.wm.addKeybinding('live-toggle', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => {
                const paused = !this._settings.get_boolean('paused');
                this._settings.set_boolean('paused', paused);
                Main.osdWindowManager.showAll(Gio.ThemedIcon.new(paused ? 'media-playback-pause-symbolic' : 'weather-clear-night-symbolic'),
                    paused ? 'Live wallpaper paused' : 'Live wallpaper on', null, null);
            });

        this._loadDepth();
        this._attachAll();
        this._focus = new SearchFocus(this._settings, () => {
            for (const i of this._effects.keys())
                this._push(i);
        });
        this._schedule();
    }

    disable() {
        Main.wm.removeKeybinding('live-toggle');
        this._focus?.destroy();
        this._focus = null;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        if (this._depthIdle)
            GLib.source_remove(this._depthIdle);
        this._depthIdle = 0;
        if (this._attachIdle)
            GLib.source_remove(this._attachIdle);
        this._attachIdle = 0;
        Main.layoutManager._backgroundGroup.disconnectObject(this);
        this._depthMon.cancel();
        this._depthMon.disconnectObject(this);
        this._depthMon = null;
        this._bg.disconnectObject(this);
        this._bg = null;
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const mgr of this._managers)
            mgr.disconnectObject?.(this);
        this._managers.clear();
        for (const {actor, effect} of this._effects.values()) {
            actor.disconnectObject(this);
            if (actor.get_effect(NAME) === effect)
                actor.remove_effect(effect);
        }
        this._effects.clear();
        this._depth = null;
        this._upower = this._ppd = this._login = null;
        this._settings = null;
    }

    _proxy(bus, name, path, iface) {
        try {
            return Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, name, path, iface, null);
        } catch {
            return null;
        }
    }

    _readSettings() {
        const s = this._settings;
        this._cfg = {
            paused: s.get_boolean('paused'),
            embers: s.get_boolean('embers'),
            petals: s.get_boolean('petals'),
            glow: s.get_boolean('glow'),
            parallax: s.get_boolean('parallax'),
            strength: s.get_double('parallax-strength'),
            depth: s.get_boolean('depth'),
            depthStrength: s.get_double('depth-strength'),
            drift: s.get_boolean('depth-drift'),
            density: s.get_double('density'),
            speed: s.get_double('speed'),
            fps: s.get_int('fps'),
            emberCol: hexToRgb(s.get_string('ember-color'), 'FF4655'),
            petalCol: hexToRgb(s.get_string('petal-color'), 'F08AA4'),
            battery: s.get_boolean('pause-on-battery'),
            saver: s.get_boolean('pause-in-power-saver'),
        };
    }

    // ---------------------------------------------------------------- depth map
    _queueDepth() {
        if (this._depthIdle)
            return;
        this._depthIdle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._depthIdle = 0;
            this._loadDepth();
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadDepth() {
        const still = Gio.File.new_for_uri(this._bg.get_string('picture-uri')).get_path();
        let path = null;
        try {
            const [, bytes] = GLib.file_get_contents(DEPTH_STATE);
            const st = JSON.parse(new TextDecoder().decode(bytes));
            if (still && st.still === still && GLib.file_test(st.depth, GLib.FileTest.EXISTS))
                path = st.depth;
        } catch {}
        if (!path && still && !this._asked.has(still)) {
            // not made yet (wallpaper set outside bapirlo-wallpaper, or still preparing): ask once
            this._asked.add(still);
            const cli = GLib.find_program_in_path('bapirlo-wallpaper');
            if (cli) {
                try {
                    Gio.Subprocess.new([cli, 'depth', still],
                        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
                } catch {}
            }
        }
        if (this._depth?.path === path)
            return;
        this._depth = path ? {still, path} : null;
        for (const e of this._effects.values())
            e.effect.setDepth(path);
        this._schedule();
    }

    _depthActive() {
        return this._cfg.depth && !!this._depth;
    }

    // ---------------------------------------------------------------- wallpaper actors
    _queueAttach() {
        if (this._attachIdle || !this._settings)
            return;
        this._attachIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._attachIdle = 0;
            this._attachAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _attachAll() {
        // BackgroundManager swaps in a new actor whenever the picture changes (day ↔ night): follow it
        for (const mgr of Main.layoutManager._bgManagers ?? []) {
            if (!this._managers.has(mgr)) {
                this._managers.add(mgr);
                mgr.connectObject('changed', () => this._attachAll(), this);
            }
        }
        const live = new Set(Main.layoutManager._bgManagers ?? []);
        for (const mgr of this._managers) {
            if (!live.has(mgr))
                this._managers.delete(mgr);
        }

        const seen = new Set();
        (Main.layoutManager._bgManagers ?? []).forEach((mgr, i) => {
            const actor = mgr.backgroundActor;
            if (!actor)
                return;
            seen.add(i);
            const cur = this._effects.get(i);
            if (cur?.actor === actor)
                return;
            cur?.actor.disconnectObject(this);
            let effect = actor.get_effect(NAME);
            if (!effect) {
                effect = new LiveEffect();
                actor.add_effect_with_name(NAME, effect);
            }
            effect.setDepth(this._depth?.path ?? null);
            // never keep a disposed actor around: _push() on it floods the journal every frame
            actor.connectObject('destroy', () => {
                if (this._effects.get(i)?.actor === actor)
                    this._effects.delete(i);
                this._queueAttach();
            }, this);
            this._effects.set(i, {actor, effect, amount: cur?.amount ?? 0});
            this._push(i);
        });
        for (const [i, e] of [...this._effects]) {
            if (seen.has(i))
                continue;
            e.actor.disconnectObject(this);
            this._effects.delete(i);
        }
        this._schedule();
    }

    // ---------------------------------------------------------------- visibility / power
    _globallyAllowed() {
        const c = this._cfg;
        if (c.paused || !(c.embers || c.petals || c.glow || (c.drift && this._depthActive())))
            return false;
        return this._sceneAllowed();
    }

    // parallax / 3D: only redraws while the pointer moves, so it ignores "paused", battery and power-saver
    _parallaxAllowed() {
        return (this._cfg.parallax || this._depthActive()) && this._sceneAllowed(false);
    }

    _sceneAllowed(power = true) {
        const c = this._cfg;
        if (Main.sessionMode.isLocked || Main.overview.visible)
            return false;
        if (this._login?.get_cached_property('Active')?.unpack() === false)
            return false;
        if (!power)
            return true;
        if (c.battery && this._upower?.get_cached_property('OnBattery')?.unpack())
            return false;
        if (c.saver && this._ppd?.get_cached_property('ActiveProfile')?.unpack() === 'power-saver')
            return false;
        return true;
    }

    _coveredMonitors() {
        const covered = new Set();
        const ws = global.workspace_manager.get_active_workspace();
        for (const w of ws.list_windows()) {
            // only real app windows count (DING's desktop window is a maximised DESKTOP-type window;
            // Hanabi's screen-sized renderer window isn't an app either)
            if (!w.minimized && w.get_window_type() === Meta.WindowType.NORMAL && w.showing_on_its_workspace?.() !== false &&
                !(w.title ?? '').includes('io.github.jeffshee.HanabiRenderer') &&
                (w.is_fullscreen() || w.is_maximized()))
                covered.add(w.get_monitor());
        }
        return covered;
    }

    // ---------------------------------------------------------------- frames
    _schedule() {
        if (!this._settings)
            return;
        let want = IDLE_CHECK_MS;
        if (this._particlesVisible())
            want = Math.round(1000 / this._cfg.fps);
        else if (this._parallaxVisible())
            want = this._settled ? PARALLAX_IDLE_MS : Math.round(1000 / this._cfg.fps);
        if (this._timer && this._interval === want)
            return;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._interval = want;
        this._lastUs = GLib.get_monotonic_time();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, want, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._timer, '[bapirlo-live] frame');
    }

    _uncovered() {
        const covered = this._coveredMonitors();
        return [...this._effects.keys()].some(i => !covered.has(i));
    }

    _particlesVisible() {
        // still fading out counts as visible, so the fade finishes at full frame rate
        if (this._globallyAllowed() && this._uncovered())
            return true;
        return [...this._effects.values()].some(e => e.amount > 0);
    }

    _parallaxVisible() {
        return (this._parallaxAllowed() && this._uncovered()) || this._ptr.some(v => v !== 0) || this._depthAmt > 0;
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min((now - this._lastUs) / 1e6, 0.25);
        this._lastUs = now;

        const allowed = this._globallyAllowed();
        const covered = allowed ? this._coveredMonitors() : null;
        let moving = false;
        for (const [i, e] of this._effects) {
            const target = allowed && !covered.has(i) ? 1 : 0;
            const before = e.amount;
            if (target > e.amount)
                e.amount = Math.min(target, e.amount + dt / FADE_S);
            else if (target < e.amount)
                e.amount = Math.max(target, e.amount - dt / FADE_S);
            if (e.amount > 0)
                moving = true;
            e.dirty = e.amount !== before || e.amount > 0;
        }
        if (moving)
            this._t = (this._t + dt * this._cfg.speed) % WRAP_S;
        const shifted = this._updateParallax();
        for (const [i, e] of this._effects) {
            if (e.dirty || shifted)
                this._push(i);
        }
        this._schedule();
    }

    _maxShift() {
        return PARALLAX.max * (this._cfg.strength || 1);
    }

    _maxDepth() {
        return DEPTH.max * (this._cfg.depthStrength || 1);
    }

    // returns whether the art moved (so the frame must be redrawn)
    _updateParallax() {
        let target = [0, 0];
        // Kuro Sense (round 25): while the webcam tracks your head, the eye follows the head, not the pointer
        const head = this._parallaxAllowed() ? globalThis.kuroHead?.get?.() : null;
        if (head) {
            target = head;
        } else if (this._parallaxAllowed()) {
            const [px, py] = global.get_pointer();
            const m = Main.layoutManager.primaryMonitor;
            if (m) {
                target = [Math.max(-1, Math.min(1, (px - m.x - m.width / 2) / (m.width / 2))),
                    Math.max(-1, Math.min(1, (py - m.y - m.height / 2) / (m.height / 2)))];
            }
        }
        const before = this._ptr;
        this._ptr = this._ptr.map((v, k) => {
            const n = v + (target[k] - v) * PARALLAX.ease;
            return Math.abs(target[k] - n) < 1e-3 ? target[k] : n;
        });
        const want = this._depthActive() ? 1 : 0;
        const amt = this._depthAmt;
        this._depthAmt = want > amt ? Math.min(want, amt + 0.04) : Math.max(want, amt - 0.04);
        const moved = this._depthAmt !== amt || this._ptr.some((v, k) => v !== before[k]);
        this._settled = !moved;
        return moved;
    }

    _push(i) {
        const e = this._effects.get(i);
        if (!e)
            return;
        const c = this._cfg;
        const w = e.actor.width || 16, h = e.actor.height || 10;
        // just enough zoom that the largest shift never shows an edge
        // 3D: the far edge can move by max · focal, the near edge by max · (1 - focal), plus the drift
        const depthEdge = this._maxDepth() * Math.max(DEPTH.focal, 1 - DEPTH.focal) * (1 + DEPTH.drift);
        const base = 1 / (1 - 2.2 * ((c.parallax ? this._maxShift() : 0) + depthEdge * this._depthAmt));
        // search focus (ArcMenu): extra zoom, and the art moved by `move` (fraction of the screen)
        const focus = this._focus?.desktop ?? {zoom: 1, move: [0, 0]};
        const zoom = base * focus.zoom;
        const flat = c.parallax ? this._ptr.map(v => -v * this._maxShift()) : [0, 0];
        const shift = flat.map((v, k) => v - focus.move[k] / zoom);
        // the eye moves with the pointer (plus a slow sway when the animation may run), so near things
        // slide against it; dscale crops the map the way "zoom" crops the picture to the screen
        const sway = c.drift ? e.amount * DEPTH.drift : 0;
        const eye = [this._ptr[0] + sway * Math.sin(this._t * 0.23), this._ptr[1] + sway * 0.6 * Math.sin(this._t * 0.31 + 1)];
        const sa = w / h, ia = e.effect.depthAspect || sa;
        const dscale = ia > sa ? [sa / ia, 1] : [1, ia / sa];
        e.effect.update({
            t: this._t,
            aspect: w / h,
            amount: e.amount,
            density: c.density,
            embers: c.embers ? 1 : 0,
            petals: c.petals ? 1 : 0,
            glow: c.glow ? 1 : 0,
            zoom,
            shift,
            emberCol: c.emberCol,
            petalCol: c.petalCol,
            depthOn: this._depthAmt,
            dscale,
            dshift: eye.map(v => v * this._maxDepth() / zoom),
            focal: DEPTH.focal,
        });
    }
}
