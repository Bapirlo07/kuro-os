// Kuro Desk — screen time (setting screen-time). Every 30 s, the app whose window has focus gets
// 30 s, while you are actually there: not locked, and input in the last 5 minutes (or a fullscreen
// window, e.g. a film). Kept only on this computer, one file a day:
//   ~/.local/state/bapirlo/screentime/YYYY-MM-DD.json   {"apps": {"firefox.desktop": {"name": "Firefox", "s": 5400}}}
// Read by the SCREEN TIME desk card (cards.js) and Kuro Settings → Screen time. Files older than
// 60 days are deleted.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {STATE_DIR, readJson, writeJson} from './util.js';

export const ST_DIR = GLib.build_filenamev([STATE_DIR, 'screentime']);
const STEP_S = 30;
const IDLE_MS = 5 * 60 * 1000;
const SAVE_EVERY = 4;          // steps → write every 2 minutes
const KEEP_DAYS = 60;

export const dayKey = (d = GLib.DateTime.new_now_local()) => d.format('%Y-%m-%d');
export const dayFile = key => GLib.build_filenamev([ST_DIR, `${key}.json`]);

// {apps: {id: {name, s}}} for one day ('YYYY-MM-DD')
export function readDay(key) {
    const d = readJson(dayFile(key), null);
    return d?.apps ? d : {apps: {}};
}

export class ScreenTimeTracker {
    constructor() {
        GLib.mkdir_with_parents(ST_DIR, 0o755);
        this._day = dayKey();
        this._data = readDay(this._day);
        this._steps = 0;
        this._idle = global.backend.get_core_idle_monitor();
        this._tracker = Shell.WindowTracker.get_default();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, STEP_S, () => {
            this._step();
            return GLib.SOURCE_CONTINUE;
        });
        this._prune();
    }

    _here() {
        if (Main.sessionMode.isLocked || Main.screenShield?.active)
            return false;
        const w = global.display.focus_window;
        return this._idle.get_idletime() < IDLE_MS || !!w?.is_fullscreen();
    }

    _step() {
        const today = dayKey();
        if (today !== this._day) {
            this._save();
            this._day = today;
            this._data = {apps: {}};
        }
        const w = global.display.focus_window;
        if (w && this._here()) {
            const app = this._tracker.get_window_app(w);
            const id = app?.get_id() ?? w.get_wm_class() ?? 'other';
            const e = this._data.apps[id] ??= {name: app?.get_name() ?? w.get_wm_class() ?? 'Other', s: 0};
            e.s += STEP_S;
        }
        if (++this._steps % SAVE_EVERY === 0)
            this._save();
    }

    _save() {
        try {
            writeJson(dayFile(this._day), this._data);
        } catch (e) {
            logError(e, 'bapirlo-desk: screen time');
        }
    }

    _prune() {
        const cutoff = dayKey(GLib.DateTime.new_now_local().add_days(-KEEP_DAYS));
        try {
            const en = Gio.File.new_for_path(ST_DIR).enumerate_children('standard::name', 0, null);
            for (let i; (i = en.next_file(null));) {
                const n = i.get_name();
                if (/^\d{4}-\d\d-\d\d\.json$/.test(n) && n.slice(0, 10) < cutoff)
                    en.get_child(i).delete(null);
            }
        } catch {}
    }

    destroy() {
        GLib.source_remove(this._timer);
        this._save();
    }
}

// 1 h 25 m / 25 m / <1 m
export function hm(s) {
    const t = Math.round(s / 60), h = Math.floor(t / 60), m = t % 60;
    return h ? (m ? `${h} h ${m} m` : `${h} h`) : m ? `${m} m` : '<1 m';
}
