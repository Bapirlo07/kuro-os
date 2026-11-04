// Kuro Session — reopen your apps after log out / restart (GNOME Shell 50).
//
// Saves (every 30 s, when an app opens, and once more the moment you confirm Log Out / Restart /
// Power Off) to ~/.local/state/bapirlo-session/session.json:
//   · running apps (by .desktop id) and how many windows each has
//   · terminal folders (written by the fish hook ~/.config/fish/conf.d/bapirlo-session.fish)
//   · open Files (Nautilus) folders
//   · every window's workspace, monitor, position, size, maximised / minimised state
// At login it relaunches them, one every 0.5 s, and for the first minute puts each window that appears
// back where it was (matched by app, then by title, then in order). Tabs / documents come back from each
// app's own restore (Chrome "continue where you left off", VS Code, Lectern…).
// Nothing is saved while logging out, so apps closing during logout can't wipe the list.
//
// Settings: ~/.config/bapirlo/session.json  {"restore": true, "exclude": ["app.desktop", …]}
// Off switch: gnome-extensions disable bapirlo-session@bapirlo-os
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const STATE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'bapirlo-session']);
const STATE_FILE = GLib.build_filenamev([STATE_DIR, 'session.json']);
const SHELLS_DIR = GLib.build_filenamev([STATE_DIR, 'shells']);
const PENDING_DIR = GLib.build_filenamev([STATE_DIR, 'pending']);
const CONFIG_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'bapirlo', 'session.json']);

const SAVE_EVERY_S = 30;
const LAUNCH_GAP_MS = 500;
const SETTLE_AFTER_RESTORE_S = 75;      // don't save a half-relaunched / half-placed session
const PLACE_FOR_S = 60;                 // how long after login new windows are put back in place
const MAX_WORKSPACES = 12;
const MAX_AGE_DAYS = 30;
const NAUTILUS = 'org.gnome.Nautilus.desktop';
// never relaunched: settings / tools / things that should only open on purpose
const ALWAYS_EXCLUDE = new Set([
    'org.gnome.Settings.desktop', 'gnome-control-center.desktop', 'org.gnome.Extensions.desktop',
    'com.mattjakeman.ExtensionManager.desktop', 'org.gnome.Shell.Extensions.desktop',
    'timeshift-gtk.desktop', 'org.gnome.tweaks.desktop', 'gnome-system-monitor.desktop',
    'org.gnome.SystemMonitor.desktop', 'arcmenu-settings.desktop', 'nvidia-settings.desktop',
    'org.gnome.Shell.Extensions.GSConnect.desktop', 'org.gnome.Shell.Extensions.GSConnect.Preferences.desktop',
]);

function readJson(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

function writeJson(path, obj) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, JSON.stringify(obj, null, 1));
}

function listDir(path) {
    const out = [];
    try {
        const en = Gio.File.new_for_path(path).enumerate_children('standard::name', 0, null);
        for (let info; (info = en.next_file(null));)
            out.push(info.get_name());
    } catch {}
    return out;
}

function isTerminal(app) {
    const cats = app.get_app_info()?.get_categories() ?? '';
    return cats.split(';').includes('TerminalEmulator');
}

// GNOME 49+ dropped the flags argument (and get_maximized)
function maximize(w) {
    if (w.get_maximized)
        w.maximize(Meta.MaximizeFlags.BOTH);
    else
        w.maximize();
}

function unmaximize(w) {
    if (w.get_maximized)
        w.unmaximize(Meta.MaximizeFlags.BOTH);
    else
        w.unmaximize();
}

export default class BapirloSessionExtension extends Extension {
    enable() {
        this._frozen = false;
        this._saving = false;
        this._config = {restore: true, exclude: [], ...readJson(CONFIG_FILE)};
        this._appSystem = Shell.AppSystem.get_default();
        this._subs = [];

        // the moment Log Out / Restart / Power Off is confirmed: save once, then stop saving
        const freezeOn = (iface, path, signals) => {
            this._subs.push([Gio.DBus.session, Gio.DBus.session.signal_subscribe(null, iface, null, path, null,
                Gio.DBusSignalFlags.NONE, (c, sender, p, i, name) => {
                    if (signals.includes(name))
                        this._freeze();
                })]);
        };
        freezeOn('org.gnome.SessionManager.EndSessionDialog', '/org/gnome/SessionManager/EndSessionDialog',
            ['ConfirmedLogout', 'ConfirmedReboot', 'ConfirmedShutdown']);
        this._subs.push([Gio.DBus.system, Gio.DBus.system.signal_subscribe('org.freedesktop.login1',
            'org.freedesktop.login1.Manager', 'PrepareForShutdown', '/org/freedesktop/login1', null,
            Gio.DBusSignalFlags.NONE, (c, s, p, i, n, params) => {
                if (params.deepUnpack()[0])
                    this._freeze();
            })]);
        // the session saying it is ending (any other route: gnome-session-quit, etc.)
        this._subs.push([Gio.DBus.session, Gio.DBus.session.signal_subscribe('org.gnome.SessionManager',
            'org.gnome.SessionManager', 'SessionOver', '/org/gnome/SessionManager', null,
            Gio.DBusSignalFlags.NONE, () => this._freeze())]);

        if (Main.layoutManager._startingUp) {
            Main.layoutManager.connectObject('startup-complete', () => {
                this._restoreId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    this._restoreId = 0;
                    this._restore();
                    return GLib.SOURCE_REMOVE;
                });
            }, this);
        } else {
            this._startSaving(0);
        }
    }

    // ------------------------------------------------------------------ save
    _startSaving(delayS) {
        this._startId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, Math.max(1, delayS), () => {
            this._startId = 0;
            this._save();
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, SAVE_EVERY_S, () => {
                this._save();
                return GLib.SOURCE_CONTINUE;
            });
            // a newly opened app is saved within a few seconds; closing is only picked up by the
            // timer (closing is exactly what happens during logout)
            this._appSystem.connectObject('app-state-changed', (sys, app) => {
                if (app.state === Shell.AppState.RUNNING)
                    this._queueSave();
            }, this);
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueSave() {
        if (this._queuedId)
            return;
        this._queuedId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5, () => {
            this._queuedId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _freeze() {
        if (this._frozen)
            return;
        this._save();
        this._frozen = true;
    }

    _excluded(id) {
        return !id || id.startsWith('window:') || ALWAYS_EXCLUDE.has(id) ||
            this._config.exclude.includes(id);
    }

    async _save() {
        if (this._frozen || this._saving || Main.sessionMode.currentMode !== 'user')
            return;
        this._saving = true;
        try {
            const apps = [];
            let terminals = 0;
            for (const app of this._appSystem.get_running()) {
                const id = app.get_id();
                if (this._excluded(id))
                    continue;
                const windows = app.get_windows().filter(w => !w.skip_taskbar).length;
                if (!windows)
                    continue;           // background-only (tray) apps start themselves
                const terminal = isTerminal(app);
                if (terminal)
                    terminals += windows;
                apps.push({id, windows, terminal, wins: this._windowPlaces(app)});
            }
            const shells = this._shellDirs().slice(0, terminals);
            const running = new Set(apps.map(a => a.id));
            const folders = running.has(NAUTILUS) ? await this._nautilusFolders() : [];
            if (this._frozen)
                return;
            writeJson(STATE_FILE, {saved: GLib.DateTime.new_now_local().format_iso8601(), apps, shells, folders});
        } catch (e) {
            console.warn(`bapirlo-session: save failed: ${e.message}`);
        } finally {
            this._saving = false;
        }
    }

    _windowPlaces(app) {
        const display = global.display;
        return app.get_windows()
            .filter(w => !w.skip_taskbar && w.get_window_type() === Meta.WindowType.NORMAL &&
                !/picture.in.picture/i.test(w.get_title() ?? ''))
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence())
            .map(w => {
                const r = w.get_frame_rect();
                const mon = Math.max(0, w.get_monitor());
                const g = display.get_monitor_geometry(mon);
                return {
                    ws: w.is_on_all_workspaces() ? -1 : (w.get_workspace()?.index() ?? 0),
                    mon, rx: r.x - g.x, ry: r.y - g.y, w: r.width, h: r.height,
                    max: !!(w.maximizedHorizontally && w.maximizedVertically),
                    min: !!w.minimized, title: w.get_title() ?? '',
                };
            });
    }

    // live fish shells write their folder to shells/<pid>; newest first
    _shellDirs() {
        const rows = [];
        for (const name of listDir(SHELLS_DIR)) {
            const path = GLib.build_filenamev([SHELLS_DIR, name]);
            if (!GLib.file_test(`/proc/${name}`, GLib.FileTest.IS_DIR)) {
                GLib.unlink(path);      // shell is gone
                continue;
            }
            try {
                const [, bytes] = GLib.file_get_contents(path);
                const dir = new TextDecoder().decode(bytes).trim();
                const mtime = Gio.File.new_for_path(path).query_info('time::modified', 0, null)
                    .get_modification_date_time().to_unix();
                if (dir)
                    rows.push({dir, mtime});
            } catch {}
        }
        return rows.sort((a, b) => b.mtime - a.mtime).map(r => r.dir);
    }

    async _nautilusFolders() {
        try {
            const reply = await Gio.DBus.session.call('org.freedesktop.FileManager1',
                '/org/freedesktop/FileManager1', 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.freedesktop.FileManager1', 'OpenWindowsWithLocations']),
                null, Gio.DBusCallFlags.NO_AUTO_START, 1000, null);
            const windows = reply.deepUnpack()[0].deepUnpack();       // {window-path: [uri, …]}
            const uris = [];
            for (const locs of Object.values(windows)) {
                const first = locs[0];                                  // the window's active tab
                if (first && !uris.includes(first) && !first.startsWith('x-network-view'))
                    uris.push(first);
            }
            return uris;
        } catch {
            return [];
        }
    }

    // ------------------------------------------------------------------ restore
    _restore() {
        const state = this._config.restore ? readJson(STATE_FILE) : null;
        const saved = state?.saved ? GLib.DateTime.new_from_iso8601(state.saved, null) : null;
        const fresh = saved && GLib.DateTime.new_now_local().difference(saved) <
            MAX_AGE_DAYS * 24 * 3600 * GLib.USEC_PER_SEC;
        if (!fresh) {
            this._startSaving(1);
            return;
        }

        this._startPlacing(state);

        // hand the saved terminal folders to the fish shells that are about to start
        GLib.mkdir_with_parents(PENDING_DIR, 0o700);
        for (const name of listDir(PENDING_DIR))
            GLib.unlink(GLib.build_filenamev([PENDING_DIR, name]));
        (state.shells ?? []).forEach((dir, i) =>
            GLib.file_set_contents(GLib.build_filenamev([PENDING_DIR, String(i).padStart(3, '0')]), dir));

        const queue = [];
        const already = new Set(this._appSystem.get_running().map(a => a.get_id()));
        for (const {id, windows, terminal} of state.apps ?? []) {
            if (this._excluded(id) || id === NAUTILUS || already.has(id))
                continue;
            const app = this._appSystem.lookup_app(id);
            if (!app)
                continue;               // uninstalled since
            // terminals get one launch per window; other apps restore their own windows
            for (let n = terminal ? Math.min(windows, 8) : 1; n > 0; n--)
                queue.push(() => app.open_new_window(-1));
        }
        if (state.folders?.length) {
            queue.push(() => Gio.DBus.session.call('org.freedesktop.FileManager1',
                '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1', 'ShowFolders',
                new GLib.Variant('(ass)', [state.folders, '']), null, Gio.DBusCallFlags.NONE, -1, null, null));
        }

        const next = () => {
            const job = queue.shift();
            if (!job) {
                this._launchId = 0;
                this._startSaving(SETTLE_AFTER_RESTORE_S);
                return GLib.SOURCE_REMOVE;
            }
            try {
                job();
            } catch (e) {
                console.warn(`bapirlo-session: relaunch failed: ${e.message}`);
            }
            return GLib.SOURCE_CONTINUE;
        };
        this._launchId = GLib.timeout_add(GLib.PRIORITY_LOW, LAUNCH_GAP_MS, next);
    }

    // ------------------------------------------------------------------ window places
    _startPlacing(state) {
        this._pending = new Map();
        for (const a of state.apps ?? []) {
            if (a.wins?.length && !this._excluded(a.id))
                this._pending.set(a.id, a.wins.map(x => ({...x})));
        }
        if (!this._pending.size)
            return;
        this._tracker = Shell.WindowTracker.get_default();
        this._sources = new Set();
        global.display.connectObject('window-created', (_d, win) => this._watch(win, false), this);
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window, true);
        this._placeEndId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, PLACE_FOR_S, () => {
            this._placeEndId = 0;
            this._stopPlacing();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopPlacing() {
        global.display.disconnectObject(this);
        for (const id of this._sources ?? [])
            GLib.source_remove(id);
        this._sources = null;
        this._pending = null;
    }

    _later(ms, fn) {
        if (!this._sources)
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sources?.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
    }

    _watch(win, existing) {
        if (!win || win.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        if (existing) {
            this._place(win);
            return;
        }
        // poll until the window is mapped and its app is known (first-frame often fires before we can
        // connect to it), then place it — and once more shortly after, in case the app or Wayland's
        // initial placement moves it again
        let tries = 0;
        const attempt = () => {
            if (!win.get_compositor_private())
                return;                                     // gone
            const ready = win.get_frame_rect().width > 0 && this._tracker.get_window_app(win);
            if (!ready) {
                if (++tries < 40)
                    this._later(200, attempt);
                return;
            }
            const s = this._place(win);
            if (s)
                this._later(700, () => win.get_compositor_private() && this._applySafe(win, s));
        };
        this._later(200, attempt);
    }

    _place(win) {
        if (!this._pending || !win.get_compositor_private() || win.skip_taskbar)
            return null;
        const title = win.get_title() ?? '';
        if (/picture.in.picture/i.test(title))
            return null;
        const id = this._tracker.get_window_app(win)?.get_id();
        const list = this._pending.get(id);
        if (!list?.length)
            return null;
        let i = list.findIndex(s => s.title && s.title === title);
        if (i < 0)
            i = 0;
        const s = list.splice(i, 1)[0];
        if (!list.length)
            this._pending.delete(id);
        this._applySafe(win, s);
        return s;
    }

    _applySafe(win, s) {
        try {
            this._apply(win, s);
        } catch (e) {
            console.warn(`bapirlo-session: placing a window failed: ${e.message}`);
        }
    }

    _apply(win, s) {
        const display = global.display, wm = global.workspace_manager;
        if (s.ws === -1) {
            win.stick();
        } else if (s.ws >= 0 && s.ws < MAX_WORKSPACES) {
            while (wm.n_workspaces <= s.ws)
                wm.append_new_workspace(false, global.get_current_time());
            win.change_workspace_by_index(s.ws, false);
        }
        const mon = s.mon < display.get_n_monitors() ? s.mon : display.get_primary_monitor();
        const ismax = win.maximizedHorizontally || win.maximizedVertically;
        if (s.max) {
            if (win.get_monitor() !== mon) {
                if (ismax)
                    unmaximize(win);
                win.move_to_monitor(mon);
            }
            maximize(win);
        } else {
            if (ismax)
                unmaximize(win);
            const wa = win.get_work_area_for_monitor(mon);
            const g = display.get_monitor_geometry(mon);
            const w = Math.min(s.w, wa.width), h = Math.min(s.h, wa.height);
            const x = Math.max(wa.x, Math.min(g.x + s.rx, wa.x + wa.width - w));
            const y = Math.max(wa.y, Math.min(g.y + s.ry, wa.y + wa.height - h));
            win.move_resize_frame(true, x, y, w, h);
        }
        if (s.min)
            win.minimize();
    }

    disable() {
        this._stopPlacing();
        for (const id of [this._placeEndId])
            if (id)
                GLib.source_remove(id);
        this._placeEndId = 0;
        // disabled while still logged in → keep the latest state on disk
        if (!this._frozen && Main.sessionMode.currentMode === 'user' && this._tickId)
            this._save();
        for (const id of [this._restoreId, this._startId, this._tickId, this._queuedId, this._launchId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._restoreId = this._startId = this._tickId = this._queuedId = this._launchId = 0;
        for (const [bus, id] of this._subs)
            bus.signal_unsubscribe(id);
        this._subs = [];
        this._appSystem?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._appSystem = null;
    }
}
