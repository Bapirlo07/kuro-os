// Kuro Sense — look-aware.
// The camera daemon (job "look") sends Look(facing, present) when it changes and every 2 s:
//   facing  = a face is there and turned toward the screen;  present = any face at all.
// Not facing for look-away-ms (2 s):
//   · look-pause  every MPRIS player that is Playing and is NOT a music app (Spotify, Rhythmbox… keep playing —
//                 you can listen without looking) gets Pause, and is remembered
//   · look-dim    a black veil fades in over everything (55 %) — nothing is touched, the input still works
// Facing again → the veil goes at once and only the players WE paused get Play (if still paused, < 15 min).
// Never while the screen is locked; the camera going quiet for 6 s undoes everything.
// look-focus (experimental, off): Point(x, y) = where your head points on the primary monitor (0…1).
// Pointing steadily at another window for 1.2 s focuses it (only with 2+ windows side by side).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MUSIC = /spotify|rhythmbox|amberol|lollypop|elisa|tauon|cider|strawberry|clementine|audacious|deadbeef|cmus|mpd|quodlibet|g4music|gapless|euphonica|kuro-play-music|shortwave|podcasts/i;
const DIM = 140;               // veil opacity (of 255)
const RESUME_WITHIN_US = 15 * 60 * 1e6;
const STALE_US = 6e6;
const DWELL_US = 1.2e6;

export class Look {
    constructor(settings) {
        this._s = settings;
        this._facing = true;
        this._awaySince = 0;
        this._acted = false;
        this._paused = [];     // bus names we paused
        this._pausedAt = 0;
        this._heard = 0;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => this._tick());
        this._dwell = null;
    }

    status() {
        if (!this._heard || GLib.get_monotonic_time() - this._heard > STALE_US)
            return 'idle';
        return this._facing ? 'looking' : 'away';
    }

    update(facing, present) {
        this._heard = GLib.get_monotonic_time();
        if (facing === this._facing)
            return;
        this._facing = facing;
        if (!facing) {
            this._awaySince = GLib.get_monotonic_time();
        } else {
            this._awaySince = 0;
            this._back();
        }
        void present;
    }

    demo() {   // pretend you looked away for 4 s
        this.update(false, true);
        this._awaySince -= 10e6;
        this._tick();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
            this.update(true, true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        if (this._heard && now - this._heard > STALE_US) {     // the camera stopped talking to us
            this._heard = 0;
            this._facing = true;
            this._back();
        }
        if (!this._facing && !this._acted && this._awaySince &&
            now - this._awaySince > this._s.get_int('look-away-ms') * 1000 && !Main.sessionMode.isLocked) {
            this._acted = true;
            if (this._s.get_boolean('look-dim'))
                this._dim(true);
            if (this._s.get_boolean('look-pause'))
                this._pauseVideos();
        }
        return GLib.SOURCE_CONTINUE;
    }

    _back() {
        this._dim(false);
        if (this._acted && this._paused.length && GLib.get_monotonic_time() - this._pausedAt < RESUME_WITHIN_US) {
            for (const name of this._paused)
                this._player(name, 'PlaybackStatus', st => st === 'Paused' && this._mpris(name, 'Play'));
        }
        this._paused = [];
        this._acted = false;
    }

    // ---------- veil ----------
    _dim(on) {
        if (on && !this._veil) {
            this._veil = new St.Widget({style: 'background-color: black;', reactive: false, opacity: 0,
                x: 0, y: 0, width: global.stage.width, height: global.stage.height});
            Main.layoutManager.uiGroup.add_child(this._veil);
            Main.layoutManager.uiGroup.set_child_above_sibling(this._veil, null);
            this._veil.ease({opacity: DIM, duration: 900, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD});
        } else if (!on && this._veil) {
            const v = this._veil;
            this._veil = null;
            v.remove_all_transitions();
            v.ease({opacity: 0, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: () => v.destroy()});
        }
    }

    // ---------- MPRIS ----------
    _pauseVideos() {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, null, Gio.DBusCallFlags.NONE, 2000, null, (c, res) => {
                let names = [];
                try {
                    [names] = c.call_finish(res).deepUnpack();
                } catch {
                    return;
                }
                this._pausedAt = GLib.get_monotonic_time();
                for (const name of names.filter(n => n.startsWith('org.mpris.MediaPlayer2.') && !MUSIC.test(n))) {
                    this._player(name, 'PlaybackStatus', st => {
                        if (st !== 'Playing' || !this._acted)
                            return;
                        this._mpris(name, 'Pause');
                        this._paused.push(name);
                    });
                }
            });
    }

    _player(name, prop, cb) {
        Gio.DBus.session.call(name, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', prop]), null, Gio.DBusCallFlags.NONE, 1500, null,
            (c, res) => {
                try {
                    cb(c.call_finish(res).deepUnpack()[0].deepUnpack());
                } catch {}
            });
    }

    _mpris(name, method) {
        Gio.DBus.session.call(name, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', method,
            null, null, Gio.DBusCallFlags.NONE, 1500, null, () => {});
    }

    // ---------- look to focus ----------
    point(x, y) {
        if (!this._s.get_boolean('look-focus') || !this._facing || Main.overview.visible || Main.sessionMode.isLocked)
            return;
        const m = Main.layoutManager.primaryMonitor;
        if (!m)
            return;
        const px = m.x + x * m.width, py = m.y + y * m.height;
        const ws = global.workspace_manager.get_active_workspace();
        const wins = global.display.sort_windows_by_stacking(ws.list_windows())
            .filter(w => !w.minimized && w.get_window_type() === Meta.WindowType.NORMAL && w.showing_on_its_workspace?.() !== false)
            .reverse();   // top first
        if (wins.length < 2)
            return;
        const target = wins.find(w => {
            const r = w.get_frame_rect();
            return px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height;
        });
        const now = GLib.get_monotonic_time();
        if (!target || target === global.display.focus_window) {
            this._dwell = null;
            return;
        }
        if (this._dwell?.win !== target) {
            this._dwell = {win: target, since: now};
            return;
        }
        if (now - this._dwell.since > DWELL_US) {
            this._dwell = null;
            Main.activateWindow(target);
        }
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._veil?.destroy();
        this._veil = null;
    }
}
