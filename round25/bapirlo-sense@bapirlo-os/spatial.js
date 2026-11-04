// Kuro Sense — spatial UI sounds.
// Sounds come from where things happen, through GStreamer's audiopanorama (left ↔ right):
//   · notifications (Kuro Sounds asks globalThis.kuroSpatial.playFor): from the app's window if it has one on
//     this workspace (Discord on the left → the "shing" comes from the left), else from the centre (island)
//   · spatial-windows: a soft blip where a window opens / closes / minimises, and an airy whoosh toward the side
//     a workspace switch moves to. Sounds: kuro-window-open / -close / -minimize / kuro-workspace in the sound
//     theme (~/.local/share/sounds/<theme>/stereo/, made by the round 25 installer).
// Respects Settings → Sound → "Alert sounds" (event-sounds), never while a fullscreen window is focused,
// at most one window sound per 120 ms, none during the first 8 s after login.
import Gio from 'gi://Gio';
import Gst from 'gi://Gst?version=1.0';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const GAP_US = 120e3;
const VOL = {'kuro-window-open': 0.32, 'kuro-window-close': 0.28, 'kuro-window-minimize': 0.26, 'kuro-workspace': 0.30};

export class Spatial {
    constructor(settings) {
        this._s = settings;
        if (!Gst.is_initialized())
            Gst.init(null);
        this._snd = new Gio.Settings({schema_id: 'org.gnome.desktop.sound'});
        this._last = 0;
        this._live = new Set();
        this._bornAt = GLib.get_monotonic_time() + (Main.layoutManager._startingUp ? 8e6 : 0);
        globalThis.kuroSpatial = {
            play: (id, pan) => this.play(id, pan),
            playFor: (id, source) => this.playFor(id, source),
            _owner: this,
        };
        const wm = global.window_manager;
        wm.connectObject(
            'map', (_wm, actor) => this._win('kuro-window-open', actor.meta_window),
            'destroy', (_wm, actor) => this._win('kuro-window-close', actor.meta_window),
            'minimize', (_wm, actor) => this._win('kuro-window-minimize', actor.meta_window),
            'switch-workspace', (_wm, from, to, dir) => this._ws(from, to, dir), this);
    }

    status() {
        return this._s.get_boolean('spatial') ? 'on' : 'off';
    }

    _allowed() {
        return this._s.get_boolean('spatial') && this._snd.get_boolean('event-sounds') &&
            !global.display.focus_window?.is_fullscreen() && GLib.get_monotonic_time() > this._bornAt;
    }

    _win(id, w) {
        if (!this._s.get_boolean('spatial-windows') || !w || w.get_window_type() !== Meta.WindowType.NORMAL || w.skip_taskbar)
            return;
        const now = GLib.get_monotonic_time();
        if (now - this._last < GAP_US || !this._allowed())
            return;
        this._last = now;
        this.play(id, this._panOf(w));
    }

    _ws(from, to, dir) {
        if (!this._s.get_boolean('spatial-windows') || !this._allowed())
            return;
        const right = dir === Meta.MotionDirection.RIGHT || dir === Meta.MotionDirection.DOWN || (dir === undefined && to > from);
        this._last = GLib.get_monotonic_time();
        this.play('kuro-workspace', right ? 0.85 : 0.15);
    }

    _panOf(w) {
        const r = w.get_frame_rect();
        const m = Main.layoutManager.monitors[w.get_monitor()] ?? Main.layoutManager.primaryMonitor;
        if (!m)
            return 0.5;
        return Math.max(0, Math.min(1, (r.x + r.width / 2 - m.x) / m.width));
    }

    // for Kuro Sounds' notification sound: pan toward the app's window, else the centre
    playFor(id, source) {
        if (!this._s.get_boolean('spatial'))
            return false;
        let pan = 0.5;
        try {
            const app = source?.app ?? source?._app;
            const ws = global.workspace_manager.get_active_workspace();
            const w = app?.get_windows?.().find(x => x.located_on_workspace(ws) && !x.minimized);
            if (w)
                pan = this._panOf(w);
        } catch {}
        return this.play(id, pan);
    }

    // pan 0 = left … 1 = right. Returns false if it couldn't (caller falls back to GNOME's player).
    play(id, pan = 0.5) {
        const file = soundFile(id);
        if (!file)
            return false;
        try {
            const p = Math.max(-0.9, Math.min(0.9, pan * 2 - 1));
            const vol = VOL[id] ?? 1.0;
            const pipe = Gst.parse_launch(
                `filesrc location="${file.replace(/"/g, '')}" ! decodebin ! audioconvert ! audioresample ! ` +
                `audiopanorama panorama=${p.toFixed(3)} ! volume volume=${vol} ! ` +
                'pulsesink stream-properties="props,media.role=event,application.name=Kuro,application.id=kuro-spatial"');
            this._live.add(pipe);
            const bus = pipe.get_bus();
            bus.add_signal_watch();
            const end = () => {
                if (!this._live.delete(pipe))
                    return;
                bus.remove_signal_watch();
                pipe.set_state(Gst.State.NULL);
            };
            bus.connect('message::eos', end);
            bus.connect('message::error', end);
            pipe.set_state(Gst.State.PLAYING);
            GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 6, () => {    // never leave a pipeline behind
                end();
                return GLib.SOURCE_REMOVE;
            });
            return true;
        } catch (e) {
            console.warn(`Kuro Spatial: ${id}: ${e.message}`);
            return false;
        }
    }

    destroy() {
        global.window_manager.disconnectObject(this);
        for (const p of this._live)
            p.set_state(Gst.State.NULL);
        this._live.clear();
        if (globalThis.kuroSpatial?._owner === this)
            delete globalThis.kuroSpatial;
    }
}

// the sound theme's file for an event id (theme → its Inherits chain is just bapirlo → freedesktop here)
function soundFile(id) {
    const theme = new Gio.Settings({schema_id: 'org.gnome.desktop.sound'}).get_string('theme-name');
    const dirs = [GLib.build_filenamev([GLib.get_user_data_dir(), 'sounds']), ...GLib.get_system_data_dirs().map(d => `${d}/sounds`)];
    for (const t of [theme, 'freedesktop']) {
        for (const d of dirs) {
            for (const ext of ['oga', 'ogg', 'wav']) {
                const f = `${d}/${t}/stereo/${id}.${ext}`;
                if (GLib.file_test(f, GLib.FileTest.EXISTS))
                    return f;
            }
        }
    }
    return null;
}
