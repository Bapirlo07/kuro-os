// Kuro Ruler — Super+Shift+M: measure anything on screen (GNOME Shell 50/51).
//   · crosshair across the monitor under the pointer, with the pointer's position on that monitor
//   · drag a box → its size; letting go copies "W×H" to the clipboard (stays open to measure again)
// Sizes are real screen pixels (what a screenshot of it would measure); with fractional scaling the
// app-size ("logical") pixels are shown underneath. Esc, right-click or Super+Shift+M closes it.
// Colours: Super+Shift+C is the colour picker (bin/bapirlo-capture pick).
// Off switch: gnome-extensions disable bapirlo-ruler@bapirlo-os
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const GAP = 18;     // label distance from the pointer

export default class BapirloRulerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        Main.wm.addKeybinding('ruler-toggle', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggle());
    }

    disable() {
        Main.wm.removeKeybinding('ruler-toggle');
        this._close();
        this._settings = null;
    }

    _toggle() {
        if (this._overlay)
            this._close();
        else
            this._open();
    }

    _monitorAt(x, y) {
        return Main.layoutManager.monitors.find(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) ?? Main.layoutManager.primaryMonitor;
    }

    _open() {
        this._overlay = new St.Widget({style_class: 'br-overlay', reactive: true, can_focus: true,
            x: 0, y: 0, width: global.stage.width, height: global.stage.height});
        this._h = new St.Widget({style_class: 'br-line'});
        this._v = new St.Widget({style_class: 'br-line'});
        this._box = new St.Widget({style_class: 'br-box', visible: false});
        this._label = new St.Label({style_class: 'br-label'});
        this._hint = new St.Label({style_class: 'br-hint',
            text: 'RULER · drag to measure · click copies the spot · Esc to close'});
        this._hint.clutter_text.ellipsize = 0;     // NONE
        for (const a of [this._h, this._v, this._box, this._label, this._hint])
            this._overlay.add_child(a);
        const mon = Main.layoutManager.primaryMonitor;
        this._hint.connect('notify::width', () =>
            this._hint.set_position(Math.round(mon.x + (mon.width - this._hint.width) / 2), mon.y + 64));

        this._overlay.connect('motion-event', (a, ev) => this._onMotion(...ev.get_coords()));
        this._overlay.connect('button-press-event', (a, ev) => {
            if (ev.get_button() !== Clutter.BUTTON_PRIMARY) {
                this._close();
                return Clutter.EVENT_STOP;
            }
            this._start = ev.get_coords();
            this._copied = false;
            this._onMotion(...this._start);
            return Clutter.EVENT_STOP;
        });
        this._overlay.connect('button-release-event', (a, ev) => {
            if (ev.get_button() === Clutter.BUTTON_PRIMARY && this._start) {
                this._finish(...ev.get_coords());
                this._start = null;
            }
            return Clutter.EVENT_STOP;
        });
        this._overlay.connect('key-press-event', (a, ev) => {
            const sym = ev.get_key_symbol();
            const superHeld = ev.get_state() & (Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK);
            if (sym === Clutter.KEY_Escape || (superHeld && (sym === Clutter.KEY_m || sym === Clutter.KEY_M)))
                this._close();
            return Clutter.EVENT_STOP;
        });

        Main.layoutManager.addTopChrome(this._overlay);
        this._grab = Main.pushModal(this._overlay, {actionMode: Shell.ActionMode.SYSTEM_MODAL});
        this._overlay.grab_key_focus();
        this._setCursor(true);
        const [x, y] = global.get_pointer();
        this._onMotion(x, y);
        this._overlay.opacity = 0;
        this._overlay.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // GNOME 50: Meta.Display.set_cursor · GNOME 51: the stage's cursor type (put back as it was)
    _setCursor(cross) {
        if (global.display.set_cursor) {
            global.display.set_cursor(cross ? Meta.Cursor.CROSSHAIR : Meta.Cursor.DEFAULT);
        } else if (cross) {
            this._oldCursor = global.stage.get_cursor_type();
            global.stage.set_cursor_type(Clutter.CursorType.CROSSHAIR);
        } else {
            global.stage.set_cursor_type(this._oldCursor ?? Clutter.CursorType.DEFAULT);
        }
    }

    // logical stage pixels → screen pixels on monitor m
    _px(v, m) {
        return Math.round(v * m.geometry_scale);
    }

    _onMotion(x, y) {
        const m = this._monitorAt(x, y);
        x = Math.round(x);
        y = Math.round(y);
        this._h.set_position(m.x, y);
        this._h.set_size(m.width, 1);
        this._v.set_position(x, m.y);
        this._v.set_size(1, m.height);
        if (this._copied && !this._start)   // the result stays where it was until the next drag
            return;

        let text;
        if (this._start) {
            const [x0, y0] = this._start.map(Math.round);
            const [l, t] = [Math.min(x0, x), Math.min(y0, y)];
            const [w, h] = [Math.abs(x - x0), Math.abs(y - y0)];
            this._box.set_position(l, t);
            this._box.set_size(Math.max(w, 1), Math.max(h, 1));
            this._box.show();
            text = this._size(w, h, m);
        } else {
            this._box.hide();
            text = `${this._px(x - m.x, m)}, ${this._px(y - m.y, m)}`;
        }
        this._label.text = text;
        this._place(x, y, m);
    }

    _size(w, h, m) {
        const s = m.geometry_scale;
        const main = `${this._px(w, m)} × ${this._px(h, m)}`;
        return s === 1 ? main : `${main}\n${w} × ${h} logical`;
    }

    // label beside the pointer, flipped so it never leaves the monitor
    _place(x, y, m) {
        const [lw, lh] = this._label.get_size();
        let lx = x + GAP, ly = y + GAP;
        if (lx + lw > m.x + m.width)
            lx = x - GAP - lw;
        if (ly + lh > m.y + m.height)
            ly = y - GAP - lh;
        this._label.set_position(Math.round(lx), Math.round(ly));
    }

    _finish(x, y) {
        const m = this._monitorAt(x, y);
        const [x0, y0] = this._start.map(Math.round);
        const [w, h] = [Math.abs(Math.round(x) - x0), Math.abs(Math.round(y) - y0)];
        if (w < 2 && h < 2) {           // a click, not a drag: copy the position
            const pos = `${this._px(x0 - m.x, m)}, ${this._px(y0 - m.y, m)}`;
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, pos);
            this._box.hide();
            this._label.text = `${pos}  ·  copied`;
        } else {
            const size = `${this._px(w, m)}×${this._px(h, m)}`;
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, size);
            this._label.text = `${this._size(w, h, m)}  ·  copied`;
        }
        this._copied = true;
        this._place(Math.round(x), Math.round(y), m);
    }

    _close() {
        const overlay = this._overlay;
        if (!overlay)
            return;
        this._overlay = null;
        this._start = null;
        this._copied = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._setCursor(false);
        overlay.destroy();
    }
}
