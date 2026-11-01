// Kuro Smooth Guard — keeps the desktop smooth by itself. It quietly watches how hard the shell works
// (main-thread time per frame + how late the main loop runs) and, when the shell starts to stutter
// (a big build, a heavy game in a window, a low battery), it switches to Lite: the breathing wallpaper and
// the aurora pause, the live video wallpaper freezes on its current frame, and the full-screen cosmic one-shots
// (supernova / wormhole) are skipped. When things have been calm for a while, everything comes back.
// Cost: two timestamps per frame + one 250 ms timer — nothing is drawn by the guard itself.
// State + numbers for `bapirlo-cosmos smooth`: ~/.local/state/bapirlo/smooth.json (written at most every 20 s).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {STATE_DIR} from './gfx.js';

const FILE = GLib.build_filenamev([STATE_DIR, 'smooth.json']);
const TICK_MS = 250;            // main-loop lateness probe
const WINDOW_US = 2000000;      // judge every 2 s
const HEAVY_FRAME_MS = 9;       // 90th-percentile main-thread time per frame above this = stutter
const LATE_MS = 35;             // average main-loop lateness above this = the shell is choking
const BAD_TO_LITE = 2;          // 2 bad windows in a row (4 s) → Lite
const CALM_TO_FULL = 8;         // 16 s calm → full effects again
const LOW_BATTERY = 15;         // % on battery → Lite until charging
const GRACE_US = 20000000;      // the first 20 s after login are always busy (login intro, apps starting)
const HANABI = 'hanabi-extension@jeffshee.github.io';

export class SmoothGuard {
    constructor(settings, parts) {
        this._settings = settings;
        this._parts = parts;
        this._lite = false;
        this._reason = '';
        this._manualUntil = 0;
        this._stats = {episodes: 0, liteSeconds: 0, worstFrameMs: 0, day: today()};
        try {
            const old = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(FILE)[1]));
            if (old?.today?.day === today())
                Object.assign(this._stats, old.today);
        } catch (e) {
            // first run today
        }
        this._settings.connectObject('changed::smooth-guard', () => this._sync(), this);
        this._sync();
    }

    get lite() {
        return this._lite;
    }

    _sync() {
        const on = this._settings.get_boolean('smooth-guard');
        if (on && !this._tick)
            this._start();
        else if (!on && this._tick)
            this._stop();
        this._write(true);
    }

    _start() {
        this._frames = [];
        this._late = [];
        this._bad = 0;
        this._calm = 0;
        this._winStart = GLib.get_monotonic_time();
        this._graceUntil = this._winStart + GRACE_US;
        this._frameStart = 0;
        this._beforeId = global.stage.connect('before-update', () => {
            this._frameStart ||= GLib.get_monotonic_time();
        });
        this._afterId = global.stage.connect_after('after-paint', () => {
            if (this._frameStart) {
                this._frames.push((GLib.get_monotonic_time() - this._frameStart) / 1000);
                this._frameStart = 0;
            }
        });
        this._expect = GLib.get_monotonic_time() + TICK_MS * 1000;
        this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            const now = GLib.get_monotonic_time();
            this._late.push(Math.max(0, (now - this._expect) / 1000));
            this._expect = now + TICK_MS * 1000;
            if (now - this._winStart >= WINDOW_US)
                this._judge(now);
            return GLib.SOURCE_CONTINUE;
        });
        this._watchBattery();
    }

    _stop() {
        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = 0;
        for (const id of [this._beforeId, this._afterId])
            if (id)
                global.stage.disconnect(id);
        this._beforeId = this._afterId = 0;
        this._battery?.disconnectObject(this);
        this._battery = null;
        if (this._lite)
            this._setLite(false, '');
    }

    _watchBattery() {
        this._batteryLow = false;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.UPower.Device', null, (_o, res) => {
                try {
                    const p = Gio.DBusProxy.new_for_bus_finish(res);
                    if (!this._tick)
                        return;
                    this._battery = p;
                    const read = () => {
                        const pct = p.get_cached_property('Percentage')?.unpack() ?? 100;
                        const state = p.get_cached_property('State')?.unpack() ?? 0;   // 2 = discharging
                        this._batteryLow = state === 2 && pct <= LOW_BATTERY;
                    };
                    p.connectObject('g-properties-changed', read, this);
                    read();
                } catch (e) {
                    // no UPower — frame timing alone decides
                }
            });
    }

    _judge(now) {
        const frames = this._frames.sort((a, b) => a - b);
        const p90 = frames.length ? frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.9))] : 0;
        const late = this._late.length ? this._late.reduce((a, b) => a + b, 0) / this._late.length : 0;
        const fps = frames.length / ((now - this._winStart) / 1e6);
        this._last = {frameP90Ms: round(p90), lateMs: round(late), fps: round(fps)};
        this._frames = [];
        this._late = [];
        this._winStart = now;
        if (this._stats.day !== today())
            this._stats = {episodes: 0, liteSeconds: 0, worstFrameMs: 0, day: today()};
        // only frames that actually happen count (an idle screen draws nothing and is never "heavy")
        const heavy = frames.length >= 6 && p90 > HEAVY_FRAME_MS;
        const choking = late > LATE_MS;
        if (heavy && now >= this._graceUntil)
            this._stats.worstFrameMs = Math.max(this._stats.worstFrameMs, round(p90));
        if (this._lite)
            this._stats.liteSeconds += WINDOW_US / 1e6;

        if (now < this._graceUntil || Main.layoutManager._startingUp || globalThis.kuroIntroRunning) {
            this._bad = 0;
            this._write();
            return;
        }
        if (now < this._manualUntil) {
            this._write();
            return;
        }
        if (this._manualUntil) {
            this._manualUntil = 0;
            this._setLite(false, '');
        }
        if (this._batteryLow) {
            if (!this._lite || this._reason !== 'battery')
                this._setLite(true, 'battery');
        } else if (heavy || choking) {
            this._calm = 0;
            if (++this._bad >= BAD_TO_LITE && !this._lite)
                this._setLite(true, heavy ? `frames took ${round(p90)} ms` : `shell ${round(late)} ms behind`);
        } else {
            this._bad = 0;
            if (this._lite && ++this._calm >= CALM_TO_FULL)
                this._setLite(false, '');
        }
        this._write();
    }

    // `bapirlo-cosmos smooth test` — show what Lite looks like for a few seconds
    test(seconds = 8) {
        this._manualUntil = GLib.get_monotonic_time() + Math.max(2, Math.min(60, seconds)) * 1e6;
        this._setLite(true, 'test');
    }

    _setLite(on, reason) {
        if (on === this._lite && reason === this._reason)
            return;
        const was = this._lite;
        this._lite = on;
        this._reason = reason;
        if (on && !was && reason !== 'test')
            this._stats.episodes++;
        globalThis.kuroLite = on;
        this._parts.breathe?.pause?.(on);
        this._parts.aurora?.pause?.(on);
        this._video(on);
        console.log(`Kuro Smooth: ${on ? `Lite (${reason})` : 'full effects'}`);
        this._write(true);
    }

    _video(pause) {
        try {
            const pb = Main.extensionManager.lookup(HANABI)?.stateObj?.getPlaybackState?.();
            if (!pb)
                return;
            if (pause && pb.getCurrentState() === 'playing') {
                pb.userPause();
                this._pausedVideo = true;
            } else if (!pause && this._pausedVideo) {
                // only undo our own pause (if you paused it yourself meanwhile, it stays paused)
                if (pb.getCurrentState() === 'pausedByUser')
                    pb.userPlay();
                this._pausedVideo = false;
            }
        } catch (e) {
            console.error(`Kuro Smooth: live wallpaper: ${e}`);
        }
    }

    _write(force = false) {
        const now = GLib.get_monotonic_time();
        if (!force && now - (this._wrote ?? 0) < 20e6)
            return;
        this._wrote = now;
        const data = {
            guard: this._settings.get_boolean('smooth-guard'),
            lite: this._lite,
            reason: this._reason,
            now: this._last ?? null,
            limits: {frameP90Ms: HEAVY_FRAME_MS, lateMs: LATE_MS, lowBatteryPct: LOW_BATTERY},
            today: this._stats,
            updated: GLib.DateTime.new_now_local().format_iso8601(),
        };
        try {
            GLib.mkdir_with_parents(STATE_DIR, 0o755);
            GLib.file_set_contents(FILE, JSON.stringify(data, null, 1));
        } catch (e) {
            // state dir unwritable: the guard still works
        }
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._stop();
        delete globalThis.kuroLite;
        this._write(true);
    }
}

function today() {
    return GLib.DateTime.new_now_local().format('%F');
}

function round(v) {
    return Math.round(v * 10) / 10;
}
