// Kuro One-key arrange — Super+A tiles every window on this workspace (on the focused window's monitor) into a
// sensible layout for how many there are. The window you used most recently gets the biggest spot:
//   1 → centred, 2 → 60 / 40, 3 → big left + two stacked, 4 → 2 × 2, 5–6 → big left + grid, more → grid.
// Press Super+A again within 5 seconds to put everything back where it was.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const GAP = 10;
const UNDO_MS = 5000;

const maximized = w => (w.is_maximized ? w.is_maximized() : w.get_maximized?.() === 3);
const tileable = w => w.window_type === Meta.WindowType.NORMAL && !w.minimized && !w.is_fullscreen() &&
    w.allows_move() && w.allows_resize() && !w.is_skip_taskbar() && !w.is_on_all_workspaces();

// rects in 0..1 units for n windows (index 0 = most recent)
function layout(n) {
    const g = (cols, rows, x0 = 0, w = 1) => {
        const out = [];
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++)
                out.push([x0 + c * w / cols, r / rows, w / cols, 1 / rows]);
        return out;
    };
    switch (n) {
    case 1: return [[0.08, 0.04, 0.84, 0.92]];
    case 2: return [[0, 0, 0.6, 1], [0.6, 0, 0.4, 1]];
    case 3: return [[0, 0, 0.56, 1], [0.56, 0, 0.44, 0.5], [0.56, 0.5, 0.44, 0.5]];
    case 4: return g(2, 2);
    case 5: return [[0, 0, 0.5, 1], ...g(2, 2, 0.5, 0.5)];
    case 6: return [[0, 0, 0.4, 1], [0.4, 0, 0.3, 0.5], [0.7, 0, 0.3, 0.5], [0.4, 0.5, 0.2, 0.5], [0.6, 0.5, 0.2, 0.5], [0.8, 0.5, 0.2, 0.5]];
    default: {
        const cols = Math.ceil(Math.sqrt(n * 1.6)), rows = Math.ceil(n / cols);
        return g(cols, rows).slice(0, n);
    }
    }
}

export class Arrange {
    run() {
        if (this._undo && GLib.get_monotonic_time() - this._undo.t < UNDO_MS * 1000) {
            this._restore();
            return;
        }
        const focus = global.display.focus_window;
        const ws = global.workspace_manager.get_active_workspace();
        const mon = focus?.get_monitor() ?? global.display.get_primary_monitor();
        const wins = global.display.get_tab_list(Meta.TabList.NORMAL, ws).filter(w => tileable(w) && w.get_monitor() === mon);
        if (!wins.length)
            return;
        const wa = Main.layoutManager.getWorkAreaForMonitor(mon);
        const saved = wins.map(w => ({w, r: w.get_frame_rect(), max: maximized(w)}));
        const rects = layout(wins.length);
        wins.forEach((w, i) => {
            const [fx, fy, fw, fh] = rects[i];
            const x = Math.round(wa.x + fx * wa.width + GAP), y = Math.round(wa.y + fy * wa.height + GAP);
            const width = Math.round(fw * wa.width - 2 * GAP), height = Math.round(fh * wa.height - 2 * GAP);
            if (maximized(w))
                w.unmaximize();
            w.move_resize_frame(true, x, y, width, height);
        });
        this._undo = {t: GLib.get_monotonic_time(), saved};
        Main.osdWindowManager.showAll(Gio.ThemedIcon.new('view-grid-symbolic'),
            `Arranged ${wins.length} window${wins.length > 1 ? 's' : ''} · Super+A again to undo`, null, null);
    }

    _restore() {
        for (const {w, r, max} of this._undo?.saved ?? []) {
            try {
                w.move_resize_frame(true, r.x, r.y, r.width, r.height);
                if (max)
                    w.maximize();
            } catch {}
        }
        this._undo = null;
        Main.osdWindowManager.showAll(Gio.ThemedIcon.new('edit-undo-symbolic'), 'Back where they were', null, null);
    }

    destroy() {
        this._undo = null;
    }
}
