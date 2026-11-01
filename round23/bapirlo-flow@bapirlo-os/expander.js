// Kuro Text expander — type a snippet key such as ;addr or ;mail and then a SPACE (or Tab / Enter) in any app
// that supports Wayland text input (GTK, Firefox, Chromium/Electron, LibreOffice…) and it is replaced with
// the full text. Built in: ;date ;time ;now ;week ;shrug. Yours: ~/.config/bapirlo/snippets.json
// ({";addr": "1 Long Street…", …}) — edit them in Kuro Settings → Snippets or with `bapirlo-snippets`.
// How: GNOME Shell is the input-method bridge for every text field. When a field reports the text around the
// cursor, we look at the few characters just before it; on a match the key is deleted and the snippet typed.
// Nothing is stored or logged, and password fields are never looked at. Terminals don't report their text
// (no expansion there).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import IBus from 'gi://IBus';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'bapirlo', 'snippets.json']);
const ENDERS = new Set([' ', '\t', '\n']);

const BUILTIN = {
    ';date': () => GLib.DateTime.new_now_local().format('%-d %B %Y'),
    ';time': () => GLib.DateTime.new_now_local().format('%H:%M'),
    ';now': () => GLib.DateTime.new_now_local().format('%Y-%m-%d %H:%M'),
    ';iso': () => GLib.DateTime.new_now_local().format('%Y-%m-%d'),
    ';week': () => `week ${GLib.DateTime.new_now_local().format('%V')}`,
    ';shrug': () => '¯\\_(ツ)_/¯',
};

// Main.inputMethod keeps the field's purpose as an IBus value
const PASSWORD = [IBus.InputPurpose.PASSWORD, IBus.InputPurpose.PIN];

export class Expander {
    constructor(settings) {
        this._settings = settings;
        this._snips = {};
        this._load();
        try {
            this._mon = Gio.File.new_for_path(FILE).monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._mon.connect('changed', () => this._load());
        } catch {}
        this._im = Main.inputMethod;
        this._im?.connectObject('surrounding-text-set', () => this._check(), this);
        this._busy = false;
    }

    _load() {
        try {
            const [, b] = GLib.file_get_contents(FILE);
            const j = JSON.parse(new TextDecoder().decode(b));
            this._snips = Object.fromEntries(Object.entries(j).filter(([k, v]) => typeof v === 'string' && /^\S{2,24}$/.test(k)));
        } catch {
            this._snips = {};
        }
        this._maxKey = Math.max(8, ...Object.keys(this._snips).map(k => k.length), ...Object.keys(BUILTIN).map(k => k.length));
    }

    _lookup(key) {
        if (Object.hasOwn(this._snips, key))
            return this._snips[key];
        const f = BUILTIN[key];
        return f ? f() : null;
    }

    _check() {
        if (this._busy || !this._settings.get_boolean('expander'))
            return;
        const im = this._im;
        if (!im?.currentFocus && !im?._currentFocus)
            return;
        if (PASSWORD.includes(im._purpose))
            return;
        const [text, cursor, anchor] = im.getSurroundingText?.() ?? [null, 0, 0];
        if (!text || cursor !== anchor)             // a selection: leave it alone
            return;
        // cursor is a byte offset in UTF-8 in Wayland text-input; Clutter hands it to us as characters
        const chars = [...text];
        const before = chars.slice(Math.max(0, cursor - this._maxKey - 1), cursor).join('');
        const last = before.slice(-1);
        if (!ENDERS.has(last))
            return;
        const word = before.slice(0, -1).split(/\s/).pop();
        if (!word || word.length < 2)
            return;
        const value = this._lookup(word);
        if (value === null)
            return;
        this._busy = true;
        try {
            // delete "key␣" (key + the ending character) then type the snippet + the ending character again
            const n = [...word].length + 1;
            im.delete_surrounding(-n, n);
            im.commit(value + last);
        } catch (e) {
            console.warn(`Kuro expander: ${e.message}`);
        }
        // ignore the surrounding-text update our own edit causes
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._busy = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._im?.disconnectObject(this);
        this._mon?.cancel();
        this._mon = null;
    }
}
