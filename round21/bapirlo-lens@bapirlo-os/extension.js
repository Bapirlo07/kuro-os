// Kuro Lens (round 21) — three small "see / sort / focus" helpers in one extension (fewer extensions = less lag):
//   X-ray peek   hold Super+Alt+X → a lens at the pointer shows what's behind the window under it   (xray.js)
//   Window shelf fling a window into the left/right edge → parked there as a live thumbnail          (shelf.js)
//   Focus tunnel during a Kuro focus block everything but the focused window fades back             (tunnel.js)
// Settings: org.gnome.shell.extensions.bapirlo-lens (xray-peek, xray-radius, shelf, tunnel, tunnel-blur).
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {XRay} from './xray.js';
import {Shelf} from './shelf.js';
import {Tunnel} from './tunnel.js';

export default class KuroLensExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._xray = new XRay(this._settings);
        Main.wm.addKeybinding('xray-peek', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL, () => this._xray.active || this._xray.start());
        this._tunnel = new Tunnel(this._settings);
        this._settings.connectObject('changed::shelf', () => this._syncShelf(), this);
        this._syncShelf();
    }

    _syncShelf() {
        const on = this._settings.get_boolean('shelf');
        if (on && !this._shelf)
            this._shelf = new Shelf();
        else if (!on && this._shelf) {
            this._shelf.destroy();
            this._shelf = null;
        }
    }

    disable() {
        Main.wm.removeKeybinding('xray-peek');
        this._settings.disconnectObject(this);
        this._xray?.destroy();
        this._shelf?.destroy();
        this._tunnel?.destroy();
        this._xray = this._shelf = this._tunnel = this._settings = null;
    }
}
