// Kuro Echo windows — close a window and a faint after-image of it stays where it was for a few seconds,
// drifting up and fading. A small "↺ Reopen" pill on it brings the app back (a new window of the same app —
// apps close their own windows, so the old one itself can't be kept alive). Only the pill takes clicks: the
// echo never blocks what's underneath.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LIFE = 5000;     // ms
const MAX = 3;

export class Echo {
    constructor(settings) {
        this._settings = settings;
        this._echoes = [];
        global.window_manager.connectObject('destroy', (_wm, actor) => this._onDestroy(actor), this);
    }

    _onDestroy(actor) {
        if (!this._settings.get_boolean('echo') || Main.overview.visible || Main.sessionMode.isLocked)
            return;
        const win = actor.meta_window;
        if (!win || win._kuroVanish || win.window_type !== Meta.WindowType.NORMAL || win.is_fullscreen() ||
            !actor.visible || win.minimized)
            return;
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        if (!app || app.is_window_backed())
            return;
        let content = null;
        const op = actor.opacity;
        actor.opacity = 255;          // Kuro Physics' glass shatter may have hidden it a moment ago
        try {
            content = actor.paint_to_content(null);
        } catch {}
        actor.opacity = op;
        if (!content)
            return;
        const r = win.get_frame_rect();
        const buf = win.get_buffer_rect();
        this.spawn(content, buf, r, app);
    }

    spawn(content, buf, frame, app) {
        while (this._echoes.length >= MAX)
            this._drop(this._echoes[0], true);
        const ghost = new Clutter.Actor({content, x: buf.x, y: buf.y, width: buf.width, height: buf.height,
            opacity: 0, reactive: false});
        const desat = new Clutter.DesaturateEffect({factor: 0.75});
        ghost.add_effect(desat);
        ghost.add_effect(new Clutter.ColorizeEffect({tint: Cogl.Color.from_string('#aac8ff')[1]}));
        Main.layoutManager.uiGroup.insert_child_above(ghost, global.window_group);

        const pill = new St.Button({style_class: 'kuro-echo-pill', reactive: true, can_focus: false,
            label: `↺  Reopen ${app.get_name()}`, opacity: 0});
        Main.layoutManager.addTopChrome(pill);
        pill.set_position(Math.round(frame.x + frame.width / 2 - 90), Math.round(frame.y + Math.min(frame.height / 2, 260)));

        const e = {ghost, pill, app};
        this._echoes.push(e);
        pill.connect('clicked', () => {
            this._drop(e, false);
            try {
                if (app.get_n_windows() > 0 && app.can_open_new_window())
                    app.open_new_window(-1);
                else
                    app.activate();
            } catch (err) {
                console.warn(`Kuro echo: reopen ${app.get_id()}: ${err.message}`);
            }
        });
        pill.connect('notify::hover', () => {
            // hovering the pill keeps the echo alive
            if (pill.hover) {
                ghost.remove_all_transitions();
                pill.remove_all_transitions();
                ghost.opacity = 110;
                pill.opacity = 255;
            } else {
                this._fade(e, 1800);
            }
        });

        ghost.ease({opacity: 110, duration: 260, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._fade(e, LIFE)});
        pill.ease({opacity: 255, duration: 260, delay: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _fade(e, ms) {
        if (!this._echoes.includes(e))
            return;
        e.ghost.ease({opacity: 0, translation_y: -40, duration: ms, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: finished => finished && this._drop(e, false)});
        e.pill.ease({opacity: 0, translation_y: -40, duration: ms, mode: Clutter.AnimationMode.EASE_IN_QUAD});
    }

    _drop(e, fast) {
        const i = this._echoes.indexOf(e);
        if (i < 0)
            return;
        this._echoes.splice(i, 1);
        e.pill.destroy();
        if (fast) {
            e.ghost.destroy();
        } else {
            e.ghost.remove_all_transitions();
            e.ghost.ease({opacity: 0, duration: 150, onStopped: () => e.ghost.destroy()});
        }
    }

    destroy() {
        global.window_manager.disconnectObject(this);
        for (const e of [...this._echoes]) {
            e.pill.destroy();
            e.ghost.destroy();
        }
        this._echoes = [];
    }
}
