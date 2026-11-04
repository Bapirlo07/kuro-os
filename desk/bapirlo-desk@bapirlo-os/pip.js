// Kuro Desk — picture-in-picture (and Live Captions) always on top.
// Chrome's (and Firefox's) PiP window and the Live Captions window are made "always on top" and
// "on every workspace" as soon as they appear — Wayland apps can't ask for that themselves.
// Unpin / re-pin any window (PiP included) with Super+Alt+K (mutter toggle-above) or the window
// menu's "Always on Top"; an unpinned PiP is left alone until it is closed and reopened.
// Fullscreen games / videos: a focused fullscreen window is raised into the same top layer, so
// whenever the stack changes and one of those ends up above a kept window, the kept windows are
// raised back over it (one cheap check per restack, nothing runs otherwise). Note: while a PiP
// floats over a fullscreen game, the game can't use direct scan-out — a few % GPU, by design.
// Position + size are remembered per kind (pip / captions) in ~/.local/state/bapirlo/pip.json and
// put back the next time one opens (clamped onto a screen that still exists).
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import {STATE_DIR, readJson, writeJson} from './util.js';

const STATE = GLib.build_filenamev([STATE_DIR, 'pip.json']);
const BROWSERS = /chrome|chromium|firefox|librewolf|brave|vivaldi|edge|opera/i;
const PIP_TITLE = /^picture[- ]in[- ]picture$/i;

function kindOf(w) {
    if (w.get_window_type() !== Meta.WindowType.NORMAL && w.get_window_type() !== Meta.WindowType.UTILITY)
        return null;
    const cls = `${w.get_wm_class() ?? ''} ${w.get_gtk_application_id?.() ?? ''} ${w.get_sandboxed_app_id?.() ?? ''}`;
    if (/net\.sapples\.LiveCaptions/i.test(cls))
        return 'captions';
    // Chrome's PiP on Wayland has an EMPTY app id, so fall back to the owning process name
    if (PIP_TITLE.test((w.get_title() ?? '').trim()) && (BROWSERS.test(cls) || BROWSERS.test(procName(w))))
        return 'pip';
    return null;
}

function procName(w) {
    const pid = w.get_pid?.() ?? 0;
    if (pid <= 0)
        return '';
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/comm`);
        return ok ? new TextDecoder().decode(bytes).trim() : '';
    } catch {
        return '';
    }
}

export class PipKeeper {
    constructor() {
        this._state = readJson(STATE, {});
        this._kept = new Map();      // window → kind
        this._watched = new Set();   // windows waiting for a title
        global.display.connectObject(
            'window-created', (_d, w) => this._consider(w),
            'restacked', () => this._queueRestack(),
            this);
        for (const a of global.get_window_actors())
            this._consider(a.meta_window);
    }

    _consider(w) {
        if (!w || this._kept.has(w))
            return;
        const kind = kindOf(w);
        if (kind) {
            this._keep(w, kind);
            return;
        }
        // Chrome titles its PiP window a moment after creating it, and on Wayland the app id
        // (wm-class) itself arrives after window-created: watch until the class is known and
        // isn't a browser, or the window turns out to be one to keep
        const cls = w.get_wm_class();
        if (this._watched.has(w) || (cls && !BROWSERS.test(cls) && !BROWSERS.test(procName(w))))
            return;
        this._watched.add(w);
        const check = () => {
            const k = kindOf(w);
            const c = w.get_wm_class();
            if (k) {
                this._unwatch(w);
                this._keep(w, k);
            } else if (c && !BROWSERS.test(c) && !/LiveCaptions/i.test(c) && !BROWSERS.test(procName(w))) {
                this._unwatch(w);
            }
        };
        w.connectObject(
            'notify::title', check,
            'notify::wm-class', check,
            'unmanaged', () => this._unwatch(w),
            this);
    }

    _unwatch(w) {
        if (this._watched.delete(w))
            w.disconnectObject(this);
    }

    _keep(w, kind) {
        this._kept.set(w, kind);
        if (!w.is_above())
            w.make_above();
        if (!w.is_on_all_workspaces())
            w.stick();
        this._restore(w, kind);
        let saveId = 0;
        const save = () => {
            if (saveId)
                GLib.source_remove(saveId);
            saveId = GLib.timeout_add(GLib.PRIORITY_LOW, 600, () => {
                saveId = 0;
                const r = w.get_frame_rect();
                this._state[kind] = {x: r.x, y: r.y, width: r.width, height: r.height};
                writeJson(STATE, this._state);
                return GLib.SOURCE_REMOVE;
            });
        };
        w.connectObject(
            'position-changed', save,
            'size-changed', save,
            'unmanaged', () => {
                if (saveId)
                    GLib.source_remove(saveId);
                w.disconnectObject(this);
                this._kept.delete(w);
            },
            this);
    }

    _restore(w, kind) {
        const s = this._state[kind];
        if (!s)
            return;
        // only onto a screen that is still there
        const rect = new Mtk.Rectangle({x: s.x, y: s.y, width: s.width, height: s.height});
        const mon = global.display.get_monitor_index_for_rect(rect);
        const area = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(mon);
        const width = Math.min(s.width, area.width);
        const height = Math.min(s.height, area.height);
        const x = Math.max(area.x, Math.min(s.x, area.x + area.width - width));
        const y = Math.max(area.y, Math.min(s.y, area.y + area.height - height));
        // wait for the first frame, or the client's initial configure undoes the move
        const actor = w.get_compositor_private();
        const apply = () => w.move_resize_frame(true, x, y, width, height);
        if (actor?.visible)
            apply();
        else
            actor?.connectObject('first-frame', () => {
                actor.disconnectObject(this);
                apply();
            }, this);
    }

    _queueRestack() {
        if (this._restackId || this._kept.size === 0)
            return;
        this._restackId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._restackId = 0;
            this._liftOverFullscreen();
            return GLib.SOURCE_REMOVE;
        });
    }

    _liftOverFullscreen() {
        const kept = [...this._kept.keys()].filter(w => !w.minimized && w.is_above());
        if (kept.length === 0)
            return;
        const ws = global.workspace_manager.get_active_workspace();
        const stack = global.display.sort_windows_by_stacking(ws.list_windows().filter(w => !w.minimized));
        const top = stack.at(-1);
        if (!top || this._kept.has(top) || !top.is_fullscreen())
            return;
        // something fullscreen is on top of a kept window that shares its screen
        for (const w of kept) {
            if (w.get_monitor() === top.get_monitor())
                w.raise();
        }
    }

    destroy() {
        if (this._restackId)
            GLib.source_remove(this._restackId);
        this._restackId = 0;
        global.display.disconnectObject(this);
        for (const w of this._watched)
            w.disconnectObject(this);
        this._watched.clear();
        // kept windows stay where they are; only stop forcing them on top
        for (const w of this._kept.keys()) {
            w.disconnectObject(this);
            w.get_compositor_private()?.disconnectObject(this);
            if (w.is_above())
                w.unmake_above();
            if (w.is_on_all_workspaces())
                w.unstick();
        }
        this._kept.clear();
    }
}
