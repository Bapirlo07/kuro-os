// Kuro Desk — the "smart desktop" of Kuro OS (GNOME Shell 51).
//   launchpad.js  Mac-style full-screen app grid: folders, search, zoom (Super+G, dock icon)
//   widgets.js    clock · calendar · deadlines · weather · system on the wallpaper, behind windows;
//                 Super+Alt+E edits them (drag anywhere, show / hide cards), colours follow the wallpaper
//   briefing.js   card a few seconds after login: greeting, weather, today, due soon, battery, updates
//   pip.js        picture-in-picture (Chrome/Firefox) + Live Captions stay on top, remember position
//   popout.js     Super+Alt+I / window menu: any window as a live mini picture-in-picture in a corner
//   privacy.js    red/green/blue dots in the bar while mic / camera / screen sharing are in use
//   airpods.js    AirPods battery chip in the bar (from LibrePods' tray item) + noise control
//   cards.js      Now playing (live visualizer) · To-do · Notes cards for widgets.js; Super+Alt+D = add a to-do
//   session.js    reopens last session's apps on their workspaces / spots after login (session-restore)
//   radial.js     Super+Alt+O: ring of 8 apps around the pointer, in the top bar's look
//   screentime.js counts which app you use (local files) for the SCREEN TIME card / Kuro Settings (screen-time)
//   gestures.js   four-finger swipes: up Launchpad · down desktop · left radial · right previous window (gestures)
//   intro.js      login intro: greeting, wallpaper fades up, bar / dock / widgets fly in (login-intro)
// Each part follows its own setting and can be switched off alone. Nothing polls while unseen:
// the widgets tick only while the desktop can be seen, the calendar is read by a short-lived
// helper (bin/bapirlo-agenda) every 15 minutes.
// D-Bus (on the shell's own connection): /os/bapirlo/Desk os.bapirlo.Desk.Launchpad() / .Briefing() / .EditWidgets() / .PopOut()
//   / .Radial() / .QuickTodo() / .RestoreSession() / .Intro()
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Agenda} from './agenda.js';
import {Launchpad} from './launchpad.js';
import {DeskWidgets} from './widgets.js';
import {Briefing} from './briefing.js';
import {LoginIntro} from './intro.js';
import {PipKeeper} from './pip.js';
import {PopOut} from './popout.js';
import {PrivacyDots} from './privacy.js';
import {AirPodsChip} from './airpods.js';
import {RadialLauncher} from './radial.js';
import {SessionKeeper} from './session.js';
import {ScreenTimeTracker} from './screentime.js';
import {FourFingerGestures} from './gestures.js';

const IFACE = `<node><interface name="os.bapirlo.Desk">
  <method name="Launchpad"/>
  <method name="Briefing"/>
  <method name="EditWidgets"/>
  <method name="PopOut"/>
  <method name="Radial"/>
  <method name="QuickTodo"/>
  <method name="RestoreSession"/>
  <method name="Intro"/>
</interface></node>`;

export default class BapirloDesk extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._agenda = new Agenda();
        this._launchpad = new Launchpad();
        this._briefing = new Briefing(this._settings, this._agenda);
        this._popout = new PopOut();
        this._radial = new RadialLauncher(this._settings);
        this._session = new SessionKeeper(this._settings);
        this._parts = {};
        this._intro = new LoginIntro(() => this._parts.widgets);

        const toggle = (key, make) => {
            const sync = () => {
                const on = this._settings.get_boolean(key);
                if (on && !this._parts[key])
                    this._parts[key] = make();
                else if (!on && this._parts[key]) {
                    this._parts[key].destroy();
                    delete this._parts[key];
                }
            };
            this._settings.connectObject(`changed::${key}`, sync, this);
            sync();
        };
        toggle('widgets', () => new DeskWidgets(this._settings, this._agenda));
        toggle('pip-on-top', () => new PipKeeper());
        toggle('privacy-dots', () => new PrivacyDots());
        toggle('airpods', () => new AirPodsChip());
        toggle('screen-time', () => new ScreenTimeTracker());
        toggle('gestures', () => {
            const g = new FourFingerGestures({
                up: () => this._launchpad.toggle(),
                down: () => g.toggleDesktop(),
                left: () => this._toggleRadial(),
                right: () => g.previousWindow(),
            });
            return g;
        });

        Main.wm.addKeybinding('launchpad-toggle', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._launchpad.toggle());
        Main.wm.addKeybinding('briefing-show', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._briefing.show({manual: true}));
        // POPUP too, so the same keys close edit mode again
        Main.wm.addKeybinding('widgets-edit', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => this._editWidgets());
        Main.wm.addKeybinding('popout-toggle', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL, () => this._popout.toggleFocused());
        // POPUP too, so the same keys close the ring again
        Main.wm.addKeybinding('radial-toggle', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => this._toggleRadial());
        Main.wm.addKeybinding('todo-add', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => this._quickTodo());

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, {
            Launchpad: () => this._launchpad.toggle(),
            Briefing: () => this._briefing.show({manual: true}),
            EditWidgets: () => this._editWidgets(),
            PopOut: () => this._popout.toggleFocused(),
            Radial: () => this._toggleRadial(),
            QuickTodo: () => this._quickTodo(),
            RestoreSession: () => this._session.restore(),
            Intro: () => this._intro.play({replay: true}),
        });
        this._dbus.export(Gio.DBus.session, '/os/bapirlo/Desk');

        // the login briefing: only when the extension comes up WITH the session (not on re-enable)
        if (Main.layoutManager._startingUp) {
            if (this._settings.get_boolean('login-intro'))
                this._intro.cover();
            Main.layoutManager.connectObject('startup-complete', () => {
                Main.layoutManager.disconnectObject(this);
                this._intro.play();
                this._briefing.scheduleLogin();
                this._sessionId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                    this._sessionId = 0;
                    this._session.loginRestore();
                    return GLib.SOURCE_REMOVE;
                });
            }, this);
        } else {
            this._session.skipLogin();   // re-enabled mid-session: just keep saving
        }
    }

    // POPUP: only our own ring may be open (not some other modal) for the keys to close it
    _toggleRadial() {
        if (this._radial.isOpen || Main.modalCount === 0)
            this._radial.toggle();
    }

    _quickTodo() {
        if (this._parts.widgets?.editing) {
            this._parts.widgets.quickTodo();
            return;
        }
        if (Main.modalCount > 0 && !Main.overview.visible)
            return;
        if (!this._parts.widgets)
            this._settings.set_boolean('widgets', true);
        Main.overview.hide();
        this._parts.widgets?.quickTodo();
    }

    // edit mode needs the widgets on: switch them on first if they were off
    _editWidgets() {
        if (!this._parts.widgets)
            this._settings.set_boolean('widgets', true);
        Main.overview.hide();
        this._parts.widgets?.toggleEdit();
    }

    disable() {
        this._intro.destroy();
        this._intro = null;
        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);
        Main.wm.removeKeybinding('launchpad-toggle');
        Main.wm.removeKeybinding('briefing-show');
        Main.wm.removeKeybinding('widgets-edit');
        Main.wm.removeKeybinding('popout-toggle');
        Main.wm.removeKeybinding('radial-toggle');
        Main.wm.removeKeybinding('todo-add');
        if (this._sessionId)
            GLib.source_remove(this._sessionId);
        this._sessionId = 0;
        this._dbus?.unexport();
        this._dbus = null;
        for (const part of Object.values(this._parts))
            part.destroy();
        this._parts = {};
        this._popout.destroy();
        this._radial.destroy();
        this._session.destroy();
        this._radial = this._session = null;
        this._briefing.destroy();
        this._launchpad.destroy();
        this._agenda.destroy();
        this._briefing = this._launchpad = this._agenda = this._popout = null;
        this._settings = null;
    }
}
