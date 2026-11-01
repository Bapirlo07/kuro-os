// Kuro Focus tunnel — while a focus block runs (Kuro Bar focus timer: Super+Alt+F), everything except the
// window you're working in fades back behind a dark blurred veil. Switch windows and the veil follows.
// The bar already holds notification banners during focus; the tunnel counts what came in and, when the
// block ends, Kuro (the desktop creature) tells you — or a normal notification does if Kuro is off.
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BAR = 'bapirlo-bar@bapirlo-os';
const SHOWN = new Set([Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG]);

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

export class Tunnel {
    constructor(settings) {
        this._settings = settings;
        this._held = 0;
        this._apps = new Set();
        this._phase = '';
        this._settings.connectObject('changed::tunnel', () => this._sync(), 'changed::tunnel-blur', () => this._rebuild(), this);
        // the bar may load after us
        this._bar = barSettings();
        if (!this._bar)
            Main.extensionManager.connectObject('extension-state-changed', (_m, ext) => {
                if (ext.uuid === BAR && !this._bar && (this._bar = barSettings()))
                    this._watchBar();
            }, this);
        else
            this._watchBar();
        Main.messageTray.connectObject('source-added', (_t, src) => this._watchSource(src), this);
        for (const src of Main.messageTray.getSources())
            this._watchSource(src);
    }

    _watchBar() {
        this._bar.connectObject('changed::focus-phase', () => this._sync(), this);
        this._sync();
    }

    _watchSource(src) {
        src.connectObject('notification-added', (_s, n) => {
            if (this._phase !== 'focus')
                return;
            this._held++;
            this._apps.add(src.title ?? n?.source?.title ?? '');
        }, this);
    }

    _sync() {
        const phase = this._bar?.get_string('focus-phase') ?? '';
        if (phase !== this._phase) {
            if (this._phase === 'focus')
                this._report();
            if (phase === 'focus') {
                this._held = 0;
                this._apps.clear();
            }
            this._phase = phase;
        }
        const want = phase === 'focus' && this._settings.get_boolean('tunnel');
        if (want && !this._veil)
            this._show();
        else if (!want && this._veil)
            this._hide();
    }

    _report() {
        if (!this._held)
            return;
        const apps = [...this._apps].filter(Boolean).slice(0, 3).join(', ');
        const text = `${this._held} notification${this._held === 1 ? '' : 's'} waited for you${apps ? ` (${apps})` : ''}`;
        if (globalThis.kuroPet?.say)
            globalThis.kuroPet.say(text, 6000);
        else
            Main.notify('Focus block done', text);
        this._held = 0;
    }

    _show() {
        this._veil = new St.Widget({reactive: false, opacity: 0, style: 'background-color: rgba(8, 5, 8, 0.62);'});
        this._veil.add_constraint(new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.ALL}));
        this._rebuild();
        global.window_group.add_child(this._veil);
        this._veil.ease({opacity: 255, duration: 600, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        global.display.connectObject('notify::focus-window', () => this._restack(), 'restacked', () => this._restack(), this);
        this._restack();
    }

    _rebuild() {
        if (!this._veil)
            return;
        this._veil.clear_effects();
        if (this._settings.get_boolean('tunnel-blur')) {
            const fx = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, brightness: 0.85});
            if ('radius' in fx)
                fx.radius = 24;
            else
                fx.sigma = 12;
            this._veil.add_effect(fx);
        }
    }

    _restack() {
        if (!this._veil)
            return;
        const w = global.display.focus_window;
        const a = w && SHOWN.has(w.window_type) ? w.get_compositor_private() : null;
        if (!a || a.get_parent() !== global.window_group) {
            this._veil.hide();          // desktop focused (or a window in another group): no veil
            return;
        }
        this._veil.show();
        // keep the focused window's transient dialogs above the veil too
        let below = a;
        const parent = w.get_transient_for?.();
        if (parent && w.window_type !== Meta.WindowType.NORMAL)
            below = parent.get_compositor_private() ?? a;
        if (this._veil.get_next_sibling() !== below)
            global.window_group.set_child_below_sibling(this._veil, below);
    }

    _hide() {
        global.display.disconnectObject(this);
        const v = this._veil;
        this._veil = null;
        v.ease({opacity: 0, duration: 400, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => v.destroy()});
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._bar?.disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        Main.messageTray.disconnectObject(this);
        for (const src of Main.messageTray.getSources())
            src.disconnectObject(this);
        global.display.disconnectObject(this);
        this._veil?.destroy();
        this._veil = null;
    }
}
