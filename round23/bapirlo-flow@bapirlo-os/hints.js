// Kuro Window hints — Super+; puts a letter on every window of this workspace (all monitors). Type the letter
// and that window comes to the front with focus; minimised windows get letters too, in a strip at the bottom.
// Home-row letters first (a s d f j k l …); more than 18 windows → two letters. Esc or a click cancels.
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const KEYS = 'asdfjklghqweruiopzxcvbnmty';
const OK = new Set([Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG]);

function labels(n) {
    if (n <= 18)
        return [...KEYS.slice(0, n)];
    const out = [];
    for (const a of 'asdfjkl')
        for (const b of KEYS)
            if (out.length < n)
                out.push(a + b);
    return out;
}

export class Hints {
    get active() {
        return !!this._root;
    }

    show() {
        if (this._root || Main.sessionMode.isLocked)
            return;
        Main.overview.hide();
        const ws = global.workspace_manager.get_active_workspace();
        // most recently used first → the window you were just in gets 'a'
        const wins = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, ws)
            .filter(w => OK.has(w.window_type) && !w.is_skip_taskbar());
        if (!wins.length)
            return;
        const names = labels(wins.length);
        const [sw, sh] = [global.stage.width, global.stage.height];
        this._root = new St.Widget({reactive: true, x: 0, y: 0, width: sw, height: sh, style_class: 'kuro-hints-veil'});
        this._targets = new Map();
        this._typed = '';
        const tracker = Shell.WindowTracker.get_default();
        const minimised = [];
        wins.forEach((w, i) => {
            const key = names[i];
            this._targets.set(key, w);
            const app = tracker.get_window_app(w);
            const tag = new St.BoxLayout({style_class: 'kuro-hint', reactive: true, track_hover: true});
            tag.add_child(new St.Label({style_class: 'kuro-hint-key', text: key.toUpperCase(), y_align: Clutter.ActorAlign.CENTER}));
            if (app)
                tag.add_child(app.create_icon_texture(22));
            tag.add_child(new St.Label({style_class: 'kuro-hint-title', y_align: Clutter.ActorAlign.CENTER,
                text: (w.get_title() ?? app?.get_name() ?? '').slice(0, 42)}));
            tag.connect('button-press-event', () => {
                this._pick(key);
                return Clutter.EVENT_STOP;
            });
            tag._key = key;
            if (w.minimized) {
                minimised.push(tag);
                return;
            }
            const r = w.get_frame_rect();
            this._root.add_child(tag);
            tag.connect('notify::allocation', () => {
                const [tw, th] = tag.get_size();
                tag.set_position(Math.round(r.x + r.width / 2 - tw / 2), Math.round(r.y + r.height / 2 - th / 2));
            });
            tag.set_position(Math.round(r.x + r.width / 2 - 80), Math.round(r.y + r.height / 2 - 20));
        });
        if (minimised.length) {
            const strip = new St.BoxLayout({style_class: 'kuro-hint-strip'});
            strip.add_child(new St.Label({text: 'Minimised', style_class: 'kuro-hint-strip-title', y_align: Clutter.ActorAlign.CENTER}));
            minimised.forEach(t => strip.add_child(t));
            this._root.add_child(strip);
            const pm = Main.layoutManager.primaryMonitor;
            strip.connect('notify::allocation', () => strip.set_position(Math.round(pm.x + pm.width / 2 - strip.width / 2), pm.y + pm.height - 170));
        }
        Main.layoutManager.addTopChrome(this._root);
        this._root.opacity = 0;
        this._root.ease({opacity: 255, duration: 110});
        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.SYSTEM_MODAL});
        this._root.grab_key_focus();
        this._root.connect('key-press-event', (_a, ev) => this._key(ev));
        this._root.connect('button-press-event', () => {
            this.hide();
            return Clutter.EVENT_STOP;
        });
    }

    _key(ev) {
        const sym = ev.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this.hide();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_BackSpace) {
            this._typed = this._typed.slice(0, -1);
            this._mark();
            return Clutter.EVENT_STOP;
        }
        const ch = String.fromCodePoint(Clutter.keysym_to_unicode(sym) || 0).toLowerCase();
        if (!/^[a-z]$/.test(ch))
            return Clutter.EVENT_STOP;
        this._typed += ch;
        if (this._targets.has(this._typed)) {
            this._pick(this._typed);
        } else if (![...this._targets.keys()].some(k => k.startsWith(this._typed))) {
            this._typed = '';
            this._mark();
        } else {
            this._mark();
        }
        return Clutter.EVENT_STOP;
    }

    // dim tags that no longer match what was typed
    _mark() {
        const walk = a => a.get_children().forEach(c => {
            if (c._key !== undefined)
                c.opacity = c._key.startsWith(this._typed) ? 255 : 70;
            else
                walk(c);
        });
        if (this._root)
            walk(this._root);
    }

    _pick(key) {
        const w = this._targets.get(key);
        this.hide();
        if (w)
            Main.activateWindow(w);
    }

    hide() {
        if (!this._root)
            return;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        Main.layoutManager.removeChrome(this._root);
        this._root.destroy();
        this._root = null;
        this._targets = null;
    }

    destroy() {
        this.hide();
    }
}
