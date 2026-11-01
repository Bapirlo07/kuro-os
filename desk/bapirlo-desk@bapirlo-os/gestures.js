// Kuro Desk — four-finger touchpad swipes (setting gestures). GNOME keeps its own three-finger ones
// (up = overview / app grid, left-right = workspaces); four fingers were unused:
//   4 up     Launchpad                    4 down   show the desktop (again = windows back)
//   4 left   radial launcher (Super+Alt+O) 4 right  back to the window you used before
// Only listens to touchpad gesture events the shell already receives; nothing runs between swipes.
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FINGERS = 4;
const DIST = 70;            // unaccelerated touchpad units before a swipe counts

export class FourFingerGestures {
    constructor(actions) {
        this._actions = actions;     // {up, down, left, right}
        this._hidden = null;         // windows "show the desktop" minimised
        global.stage.connectObject('captured-event::touchpad', (_s, ev) => this._onEvent(ev), this);
        global.display.connectObject('notify::focus-window', () => {
            // you went back to work: the next swipe down hides again (the focus moving while we
            // minimise doesn't count)
            if (this._hidden && global.display.focus_window && Date.now() - this._hiddenAt > 1500)
                this._hidden = null;
        }, this);
    }

    _onEvent(ev) {
        if (ev.type() !== Clutter.EventType.TOUCHPAD_SWIPE || ev.get_touchpad_gesture_finger_count() !== FINGERS)
            return Clutter.EVENT_PROPAGATE;
        if (Main.actionMode !== Shell.ActionMode.NORMAL && Main.actionMode !== Shell.ActionMode.OVERVIEW)
            return Clutter.EVENT_PROPAGATE;
        const phase = ev.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            this._dx = this._dy = 0;
        } else if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
            const [dx, dy] = ev.get_gesture_motion_delta_unaccelerated();
            this._dx += dx;
            this._dy += dy;
        } else if (phase === Clutter.TouchpadGesturePhase.END) {
            const dir = this._direction();
            if (dir)
                this._actions[dir]?.();
        }
        return Clutter.EVENT_STOP;
    }

    _direction() {
        const ax = Math.abs(this._dx), ay = Math.abs(this._dy);
        if (Math.max(ax, ay) < DIST)
            return null;
        if (ay > ax)
            return this._dy < 0 ? 'up' : 'down';
        return this._dx < 0 ? 'left' : 'right';
    }

    // ---------------------------------------------------------------- actions used by extension.js
    toggleDesktop() {
        if (Main.overview.visible)
            Main.overview.hide();
        const ws = global.workspace_manager.get_active_workspace();
        const alive = (this._hidden ?? []).filter(w => w.get_compositor_private() && w.minimized);
        if (alive.length) {
            this._hidden = null;
            alive.forEach(w => w.unminimize());
            alive.at(-1).activate(global.get_current_time());
            return;
        }
        const wins = global.display.get_tab_list(Meta.TabList.NORMAL, ws).filter(w => !w.minimized && !w.skip_taskbar && w.can_minimize());
        this._hidden = wins.reverse();              // last one = the one that had focus
        this._hiddenAt = Date.now();
        wins.forEach(w => w.minimize());
    }

    previousWindow() {
        const ws = global.workspace_manager.get_active_workspace();
        const wins = global.display.get_tab_list(Meta.TabList.NORMAL, ws);
        const w = wins[1] ?? wins[0];
        if (w) {
            if (Main.overview.visible)
                Main.overview.hide();
            Main.activateWindow(w);
        }
    }

    destroy() {
        global.stage.disconnectObject(this);
        global.display.disconnectObject(this);
    }
}
