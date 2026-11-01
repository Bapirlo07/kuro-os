// Kuro Breathing desktop — the wallpaper slowly swells and settles, about six breaths a minute (a calm
// breathing pace), so subtle you feel it more than see it. During a focus block or bedtime the breath slows
// to ~4.5 a minute — breathe with it. Windows and text never move (scaling them would blur text).
// Cheap on purpose: it rides frames the screen draws anyway (live video, animations — stage 'before-update')
// so it adds no extra full-screen repaints then; only when nothing else is moving does its own slow timer
// (8 fps) drive it, and on the Power Saver profile it never forces a frame at all. Skipped on monitors where a
// maximised or fullscreen window hides the wallpaper anyway.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {barSettings, readJson, STATE_DIR} from './gfx.js';

const AMP = 0.014;          // +1.4 % at the top of a breath
const NORMAL = 10;          // seconds per breath
const CALM = 13.5;
const BEDTIME = GLib.build_filenamev([STATE_DIR, 'bedtime.json']);
const RIDE_US = 80000;      // step at most every 80 ms inside frames that happen anyway
const OWN_MS = 125;         // own pace when the screen is otherwise still (8 fps, sub-pixel steps)

export class Breathe {
    constructor(settings) {
        this._settings = settings;
        this._settings.connectObject('changed::breathe', () => this._sync(), this);
        this._phase = 0;
        this._calm = false;
        this._sync();
    }

    _sync() {
        const on = this._settings.get_boolean('breathe');
        if (on && !this._timer) {
            this._last = GLib.get_monotonic_time();
            this._checkCalm();
            this._calmTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 30, () => {
                this._checkCalm();
                return GLib.SOURCE_CONTINUE;
            });
            this._lastStep = 0;
            this._stageId = global.stage.connect('before-update', () => {
                const now = GLib.get_monotonic_time();
                if (now - this._lastStep >= RIDE_US)
                    this._step(now);
            });
            this._watchPower();
            this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, OWN_MS, () => {
                const now = GLib.get_monotonic_time();
                // a frame already carried a step recently → nothing to do; Power Saver → never force a frame
                if (!this._saver && now - this._lastStep >= OWN_MS * 1000 - 5000)
                    this._step(now);
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._timer) {
            this._stopTimers();
            this._reset();
        }
    }

    _checkCalm() {
        this._bar ??= barSettings();
        const focus = this._bar?.get_string?.('focus-phase') === 'focus';
        const bed = !!readJson(BEDTIME, {})?.on;
        this._calm = focus || bed;
    }

    get calm() {
        return this._calm;
    }

    _bgs() {
        return (Main.layoutManager._backgroundGroup?.get_children() ?? []).filter(a => a instanceof Meta.BackgroundActor);
    }

    _hidden(monitorIndex) {
        const ws = global.workspace_manager.get_active_workspace();
        return ws.list_windows().some(w => !w.minimized && w.get_monitor() === monitorIndex &&
            (w.is_fullscreen() || (w.is_maximized ? w.is_maximized() : w.get_maximized?.() === 3)));
    }

    // Kuro Smooth Guard: Lite mode holds the wallpaper still
    pause(on) {
        this._paused = on;
        if (on)
            this._reset();
    }

    _watchPower() {
        if (this._power)
            return;
        this._saver = false;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            'net.hadess.PowerProfiles', '/net/hadess/PowerProfiles', 'net.hadess.PowerProfiles', null,
            (_o, res) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    if (!this._timer)
                        return;
                    this._power = proxy;
                    const read = () => {
                        this._saver = proxy.get_cached_property('ActiveProfile')?.unpack() === 'power-saver';
                    };
                    proxy.connectObject('g-properties-changed', read, this);
                    read();
                } catch (e) {
                    // no power-profiles-daemon: just keep breathing
                }
            });
    }

    _step(now = GLib.get_monotonic_time()) {
        this._lastStep = now;
        if (this._paused)
            return;
        const dt = (now - this._last) / 1e6;
        this._last = now;
        // the overview has its own wallpaper zoom (search focus) and the login intro animates it too
        if (Main.sessionMode.isLocked || Main.overview.visible || Main.layoutManager._startingUp || globalThis.kuroIntroRunning)
            return;
        const period = this._calm ? CALM : NORMAL;
        this._phase = (this._phase + dt / period) % 1;
        // inhale a bit quicker than exhale, soft at both ends
        const p = this._phase;
        const breath = p < 0.42 ? 0.5 - 0.5 * Math.cos(Math.PI * p / 0.42) : 0.5 + 0.5 * Math.cos(Math.PI * (p - 0.42) / 0.58);
        const s = 1 + AMP * breath;
        for (const a of this._bgs()) {
            if (this._hidden(a.monitor ?? 0))
                continue;
            a.set_pivot_point(0.5, 0.5);
            a.set_scale(s, s);
        }
    }

    _reset() {
        for (const a of this._bgs())
            a.set_scale(1, 1);
    }

    _stopTimers() {
        for (const id of [this._timer, this._calmTimer])
            if (id)
                GLib.source_remove(id);
        this._timer = this._calmTimer = 0;
        if (this._stageId)
            global.stage.disconnect(this._stageId);
        this._stageId = 0;
        this._power?.disconnectObject(this);
        this._power = null;
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._stopTimers();
        this._reset();
    }
}
