// Kuro Autopilot (shell part) — the eyes and hands of bin/bapirlo-autopilot. It
//   · notes app launches and files you move out of ~/Downloads into ~/.local/state/bapirlo/autopilot/events.jsonl
//     (app id + time; file type + folder — never file contents, never anything else),
//   · every few hours asks bapirlo-autopilot to look for patterns and, at most once every 6 hours, shows ONE
//     suggestion as a notification: "Yes, do that" / "No, don't ask again",
//   · runs only the rules you said yes to: "time" rules open an app at its time on weekdays (if it isn't open),
//     "move" rules are applied to each finished download (bapirlo-autopilot file PATH).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'bapirlo', 'autopilot']);
const EVENTS = GLib.build_filenamev([DIR, 'events.jsonl']);
const STATE = GLib.build_filenamev([DIR, 'state.json']);
const PARTIAL = /\.(part|crdownload|download|partial|opdownload|tmp)$/i;
const ANALYZE_EVERY_S = 3 * 3600;
const ASK_GAP_US = 6 * 3600 * 1e6;

function spawn(argv) {
    try {
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        console.warn(`Kuro autopilot: ${argv[0]}: ${e.message}`);
    }
}

function readState() {
    try {
        const [, b] = GLib.file_get_contents(STATE);
        return JSON.parse(new TextDecoder().decode(b));
    } catch {
        return {suggestions: {}, rules: {}};
    }
}

function xdg(dir, fallback) {
    return GLib.get_user_special_dir(dir) ?? GLib.build_filenamev([GLib.get_home_dir(), fallback]);
}

export class Autopilot {
    constructor(settings) {
        this._settings = settings;
        this._settings.connectObject('changed::autopilot', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const on = this._settings.get_boolean('autopilot');
        if (on && !this._on)
            this._start();
        else if (!on && this._on)
            this._stop();
    }

    _start() {
        this._on = true;
        GLib.mkdir_with_parents(DIR, 0o700);
        // app launches
        this._states = new Map();
        const sys = Shell.AppSystem.get_default();
        for (const a of sys.get_running())
            this._states.set(a.get_id(), a.state);
        sys.connectObject('app-state-changed', (_s, app) => {
            const prev = this._states.get(app.get_id()) ?? Shell.AppState.STOPPED;
            this._states.set(app.get_id(), app.state);
            if (prev === Shell.AppState.STOPPED && app.state !== Shell.AppState.STOPPED && !app.is_window_backed())
                this._log({k: 'launch', app: app.get_id()});
        }, this);
        // Downloads: what leaves, and where it lands
        this._gone = new Map();      // name → time it left Downloads
        this._mons = [];
        const dl = xdg(GLib.UserDirectory.DIRECTORY_DOWNLOAD, 'Downloads');
        this._dl = dl;
        this._watch(dl, (file, other, ev) => this._downloadsEvent(file, other, ev));
        const dests = [xdg(GLib.UserDirectory.DIRECTORY_DOCUMENTS, 'Documents'), xdg(GLib.UserDirectory.DIRECTORY_PICTURES, 'Pictures'),
            xdg(GLib.UserDirectory.DIRECTORY_MUSIC, 'Music'), xdg(GLib.UserDirectory.DIRECTORY_VIDEOS, 'Videos'),
            xdg(GLib.UserDirectory.DIRECTORY_DESKTOP, 'Desktop'), GLib.build_filenamev([GLib.get_home_dir(), 'Projects'])];
        for (const d of dests) {
            if (d === dl)
                continue;
            this._watch(d, (file, _o, ev) => this._landed(file, ev));
            for (const sub of this._subdirs(d).slice(0, 40))
                this._watch(sub, (file, _o, ev) => this._landed(file, ev));
        }
        // ask / analyze / time rules
        this._lastAsk = 0;
        this._analyzeTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, ANALYZE_EVERY_S, () => {
            this._analyze();
            return GLib.SOURCE_CONTINUE;
        });
        this._firstTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 600, () => {
            this._firstTimer = 0;
            this._analyze();
            return GLib.SOURCE_REMOVE;
        });
        this._minute = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => {
            this._timeRules();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _subdirs(path) {
        const out = [];
        try {
            const en = Gio.File.new_for_path(path).enumerate_children('standard::name,standard::type,standard::is-hidden',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = en.next_file(null))) {
                if (info.get_file_type() === Gio.FileType.DIRECTORY && !info.get_is_hidden())
                    out.push(GLib.build_filenamev([path, info.get_name()]));
            }
            en.close(null);
        } catch {}
        return out;
    }

    _watch(path, fn) {
        try {
            const m = Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            m.connect('changed', (_m, file, other, ev) => fn(file, other, ev));
            this._mons.push(m);
        } catch {}
    }

    _downloadsEvent(file, other, ev) {
        const E = Gio.FileMonitorEvent;
        const name = file.get_basename();
        if (ev === E.MOVED_OUT || ev === E.DELETED) {
            if (!PARTIAL.test(name))
                this._gone.set(name, GLib.get_monotonic_time());
            return;
        }
        // a finished download: created directly, or renamed from .part to its real name
        let done = null;
        if (ev === E.RENAMED && other && PARTIAL.test(name) && !PARTIAL.test(other.get_basename()))
            done = other;
        else if ((ev === E.CREATED || ev === E.MOVED_IN) && !PARTIAL.test(name) && !name.startsWith('.'))
            done = file;
        if (!done)
            return;
        const rules = Object.values(readState().rules ?? {}).filter(r => r.kind === 'move');
        const dot = done.get_basename().lastIndexOf('.');
        const ext = dot > 0 ? done.get_basename().slice(dot).toLowerCase() : '';
        if (rules.some(r => r.ext === ext)) {
            // let the browser finish writing first
            GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5, () => {
                spawn(['bapirlo-autopilot', 'file', done.get_path()]);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _landed(file, ev) {
        const E = Gio.FileMonitorEvent;
        if (ev !== E.MOVED_IN && ev !== E.CREATED)
            return;
        const name = file.get_basename();
        const t = this._gone.get(name);
        if (t === undefined || GLib.get_monotonic_time() - t > 15e6)
            return;
        this._gone.delete(name);
        const dot = name.lastIndexOf('.');
        this._log({k: 'move', ext: dot > 0 ? name.slice(dot).toLowerCase() : '', dest: file.get_parent().get_path()});
    }

    _log(e) {
        try {
            const line = `${JSON.stringify({t: Math.floor(Date.now() / 1000), ...e})}\n`;
            const f = Gio.File.new_for_path(EVENTS);
            const s = f.append_to(Gio.FileCreateFlags.PRIVATE, null);
            s.write_all(new TextEncoder().encode(line), null);
            s.close(null);
        } catch (err) {
            console.warn(`Kuro autopilot: log: ${err.message}`);
        }
    }

    _analyze() {
        try {
            const p = Gio.Subprocess.new(['bapirlo-autopilot', 'analyze'], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            p.wait_async(null, () => this._maybeAsk());
        } catch {}
    }

    _maybeAsk(force = false) {
        if (!this._on || Main.sessionMode.isLocked)
            return;
        if (!force && GLib.get_monotonic_time() - this._lastAsk < ASK_GAP_US)
            return;
        const st = readState();
        const s = Object.values(st.suggestions ?? {}).sort((a, b) => (a.at_found ?? 0) - (b.at_found ?? 0))[0];
        if (!s)
            return;
        this._lastAsk = GLib.get_monotonic_time();
        const source = MessageTray.getSystemSource();
        const n = new MessageTray.Notification({source, title: 'Kuro Autopilot has an idea', body: s.text,
            gicon: Gio.ThemedIcon.new('weather-clear-symbolic'), urgency: MessageTray.Urgency.NORMAL});
        n.addAction('Yes, do that', () => spawn(['bapirlo-autopilot', 'accept', s.id]));
        n.addAction('No, don\'t ask again', () => spawn(['bapirlo-autopilot', 'reject', s.id]));
        source.addNotification(n);
    }

    // open apps at their time on weekdays (accepted "time" rules only)
    _timeRules() {
        const now = GLib.DateTime.new_now_local();
        const dow = now.get_day_of_week();          // 1 = Monday
        if (dow > 5 || Main.sessionMode.isLocked)
            return;
        const hm = now.format('%H:%M');
        this._ran ??= new Set();
        const today = now.format('%F');
        for (const r of Object.values(readState().rules ?? {})) {
            if (r.kind !== 'time' || r.at !== hm || this._ran.has(`${today}${r.id}`))
                continue;
            this._ran.add(`${today}${r.id}`);
            const app = Shell.AppSystem.get_default().lookup_app(r.app);
            if (app && app.state === Shell.AppState.STOPPED) {
                app.activate();
                Main.notify('Kuro Autopilot', `Opened ${app.get_name()} — it's ${hm} (your rule)`);
            }
        }
    }

    _stop() {
        this._on = false;
        Shell.AppSystem.get_default().disconnectObject(this);
        for (const m of this._mons ?? [])
            m.cancel();
        this._mons = [];
        for (const id of [this._analyzeTimer, this._firstTimer, this._minute])
            if (id)
                GLib.source_remove(id);
        this._analyzeTimer = this._firstTimer = this._minute = 0;
    }

    // test / bapirlo-flow: show a waiting suggestion now
    askNow() {
        this._maybeAsk(true);
    }

    destroy() {
        this._settings.disconnectObject(this);
        if (this._on)
            this._stop();
    }
}
