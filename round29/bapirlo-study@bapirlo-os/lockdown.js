// Kuro Study — Focus Lock. While a Kuro Bar focus block runs (Super+Alt+F or "Focus on…"), every app except
// the allowed ones (Lectern by default) is blocked: its windows are minimised, opening or switching to one
// sends it straight back down with a small "blocked" card, and Lectern comes to the front. Breaks are free.
// When the block ends, the windows that were sent down come back where they were.
//   allowed apps:  gsettings set org.gnome.shell.extensions.bapirlo-study focus-allowed "['lectern.desktop', 'firefox.desktop']"
//   off switch:    the "Block other apps during focus" toggle in the Kuro Study menu (key focus-lock)
// Panels, the desktop icons, the live wallpaper renderer and other skip-taskbar windows are never touched.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BAR = 'bapirlo-bar@bapirlo-os';
const LECTERN = 'lectern.desktop';
const ALWAYS_APPS = [LECTERN, 'os.bapirlo.Focus.desktop'];    // Lectern + the Kuro Focus app itself
// helper windows an allowed app may need (file chooser / print dialogs come from the portal)
const ALWAYS_CLASSES = new Set(['xdg-desktop-portal-gnome', 'xdg-desktop-portal-gtk', 'gnome-shell']);
const BLOCKABLE = new Set([Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY]);

function barSettings() {
    const ext = Main.extensionManager.lookup(BAR);
    const dir = ext?.dir?.get_child('schemas');
    try {
        const src = dir?.query_exists(null)
            ? Gio.SettingsSchemaSource.new_from_directory(dir.get_path(), Gio.SettingsSchemaSource.get_default(), false)
            : Gio.SettingsSchemaSource.get_default();
        const schema = src.lookup('org.gnome.shell.extensions.bapirlo-bar', true);
        return schema ? new Gio.Settings({settings_schema: schema}) : null;
    } catch {
        return null;
    }
}

export class FocusLock {
    constructor(settings) {
        this._settings = settings;
        this._tracker = Shell.WindowTracker.get_default();
        this._sent = new Set();          // windows we minimised, to give back when the block ends
        this._on = false;
        this._card = null;
        this._cardTimer = 0;
        this._settings.connectObject('changed::focus-lock', () => this._sync(),
            'changed::focus-allowed', () => this._sync(true), this);
        this._bar = barSettings();
        if (this._bar)
            this._watchBar();
        else    // the bar may load after us
            Main.extensionManager.connectObject('extension-state-changed', (_m, ext) => {
                if (ext.uuid === BAR && !this._bar && (this._bar = barSettings()))
                    this._watchBar();
            }, this);
    }

    destroy() {
        this._settings.disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        this._bar?.disconnectObject(this);
        this._setOn(false, false);
        this._hideCard();
        this._bar = null;
    }

    get active() {
        return this._on;
    }

    _watchBar() {
        this._bar.connectObject('changed::focus-phase', () => this._sync(), this);
        this._sync();
    }

    _sync(recheck = false) {
        const want = this._settings.get_boolean('focus-lock') && this._bar?.get_string('focus-phase') === 'focus';
        if (want !== this._on)
            this._setOn(want, true);
        else if (want && recheck)
            this._sweep();
    }

    _setOn(on, giveBack) {
        this._on = on;
        if (on) {
            global.display.connectObject(
                'notify::focus-window', () => this._check(global.display.focus_window, true),
                'window-created', (_d, w) => this._watchNew(w), this);
            this._sweep();
            this._toast('🔒  Focus lock on', 'Only your allowed apps until the block ends');
            return;
        }
        global.display.disconnectObject(this);
        if (giveBack) {
            for (const w of this._sent) {
                try {
                    if (w.minimized)
                        w.unminimize();
                } catch {}     // window already gone
            }
        }
        for (const w of this._sent)
            w.disconnectObject?.(this);
        this._sent.clear();
    }

    _allowed(w) {
        if (!w || w.skip_taskbar || !BLOCKABLE.has(w.get_window_type()))
            return true;
        if (ALWAYS_CLASSES.has(w.get_wm_class() ?? ''))
            return true;
        const list = [...ALWAYS_APPS, ...this._settings.get_strv('focus-allowed')];
        const ok = win => {
            const id = this._tracker.get_window_app(win)?.get_id() ?? '';
            if (list.includes(id))
                return true;
            // AppImages are sometimes not matched to their .desktop file — fall back to the window class
            const cls = (win.get_wm_class() ?? '').toLowerCase();
            return list.some(a => a.replace(/\.desktop$/, '').toLowerCase() === cls);
        };
        if (ok(w))
            return true;
        const parent = w.get_transient_for();   // a dialog of an allowed app is allowed
        return parent ? ok(parent) : false;
    }

    _sweep() {
        for (const actor of global.get_window_actors()) {
            const w = actor.meta_window;
            if (!w.minimized)
                this._check(w, false);
        }
        if (!this._allowed(global.display.focus_window))
            this._toLectern();
    }

    _watchNew(w) {
        // the app id is only known once the window is mapped
        let id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            id = 0;
            if (this._on)
                this._check(w, w.has_focus());
            return GLib.SOURCE_REMOVE;
        });
        w.connectObject('unmanaged', () => {
            if (id)
                GLib.source_remove(id);
            id = 0;
        }, this);
    }

    _check(w, loud) {
        if (!this._on || !w || this._allowed(w))
            return;
        if (!w.can_minimize())
            return;
        w.minimize();
        if (!this._sent.has(w)) {
            this._sent.add(w);
            w.connectObject('unmanaged', () => this._sent.delete(w), this);
        }
        if (loud) {
            const app = this._tracker.get_window_app(w);
            const left = this._leftText();
            this._toast(`🔒  ${app?.get_name() ?? w.get_title() ?? 'That app'} is blocked`,
                left ? `${left} of focus left — stay with it` : 'Focus block running');
            this._toLectern();
        }
    }

    _toLectern() {
        const app = Shell.AppSystem.get_default().lookup_app(LECTERN);
        if (!app)
            return;
        const wins = app.get_windows();
        if (wins.length)
            Main.activateWindow(wins[0]);
        else
            app.activate();
    }

    _leftText() {
        let end = 0, paused = 0;
        try {
            end = Number(this._bar.get_int64('focus-end'));
            paused = this._bar.get_int('focus-left');
        } catch {}
        const s = paused > 0 ? paused : end - Math.floor(Date.now() / 1000);
        if (!(s > 0))
            return '';
        const m = Math.ceil(s / 60);
        return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
    }

    // notification banners are held during focus, so the card is our own
    _toast(title, body) {
        this._hideCard();
        const card = new St.BoxLayout({style_class: 'ks-lock-card', orientation: Clutter.Orientation.VERTICAL, opacity: 0,
            reactive: false});
        card.add_child(new St.Label({text: title, style_class: 'ks-lock-title'}));
        card.add_child(new St.Label({text: body, style_class: 'ks-lock-body'}));
        Main.layoutManager.uiGroup.add_child(card);
        const mon = Main.layoutManager.primaryMonitor;
        const [, natW] = card.get_preferred_width(-1);
        card.set_position(mon.x + Math.round((mon.width - natW) / 2), mon.y + Main.panel.height + 18);
        card.ease({opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._card = card;
        this._cardTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2600, () => {
            this._cardTimer = 0;
            card.ease({opacity: 0, duration: 300, onComplete: () => {
                if (this._card === card)
                    this._card = null;
                card.destroy();
            }});
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideCard() {
        if (this._cardTimer)
            GLib.source_remove(this._cardTimer);
        this._cardTimer = 0;
        this._card?.destroy();
        this._card = null;
    }
}
