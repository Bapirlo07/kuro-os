// Kuro Flow (round 23) — the "get things done faster" layer of Kuro OS, in one extension.
//   hints.js       Super+;            a letter on every window — type it to jump there
//   palette.js     Super+Shift+P      command palette: app actions, Kuro commands, settings, windows
//   expander.js    ;key + space       text snippets in any app (~/.config/bapirlo/snippets.json)      expander
//   arrange.js     Super+A            tile this workspace's windows sensibly (again = undo)
//   watch.js       Super+Shift+W      watch a part of the screen, get told when it changes
//   meeting.js     (automatic)        camera / mic call → quiet notifications, music paused, timer    meeting
//   totask.js      Super+Shift+D      selected text → to-do with a due date
//   deepsearch.js  (search)           "Inside your files" results (bin/bapirlo-deepsearch index)      deep-search
//   autopilot.js   (background)       notices repeated habits, suggests automating them (suggest-only) autopilot
// D-Bus (session): org.bapirlo.Flow /org/bapirlo/Flow — Hints() Palette() Arrange() Watch() ToTask()
//   AutopilotAsk() Meeting(b) — for bapirlo-flow and the tests.
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Hints} from './hints.js';
import {Palette} from './palette.js';
import {Expander} from './expander.js';
import {Arrange} from './arrange.js';
import {Watch} from './watch.js';
import {Meeting} from './meeting.js';
import {ToTask} from './totask.js';
import {DeepSearch} from './deepsearch.js';
import {Autopilot} from './autopilot.js';

const IFACE = `<node><interface name="org.bapirlo.Flow">
  <method name="Hints"/><method name="Palette"/><method name="Arrange"/><method name="Watch"/>
  <method name="WatchArea"><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
  <method name="ToTask"/><method name="AutopilotAsk"/>
  <method name="Meeting"><arg type="b" direction="in" name="on"/></method>
  <property name="MeetingActive" type="b" access="read"/>
  <property name="Watching" type="u" access="read"/>
</interface></node>`;

const KEYS = ['hints-key', 'palette-key', 'arrange-key', 'watch-key', 'task-key'];

export default class KuroFlowExtension extends Extension {
    enable() {
        const s = this._settings = this.getSettings();
        const safe = (name, fn) => {
            try {
                return fn();
            } catch (e) {
                console.error(`Kuro Flow: ${name} failed to start: ${e.stack ?? e}`);
                return null;
            }
        };
        const p = this._parts = {
            hints: safe('hints', () => new Hints()),
            palette: safe('palette', () => new Palette()),
            expander: safe('expander', () => new Expander(s)),
            arrange: safe('arrange', () => new Arrange()),
            watch: safe('watch', () => new Watch()),
            meeting: safe('meeting', () => new Meeting(s)),
            totask: safe('totask', () => new ToTask()),
            deep: safe('deep search', () => new DeepSearch(s, this.path)),
            autopilot: safe('autopilot', () => new Autopilot(s)),
        };
        const N = Shell.ActionMode.NORMAL, O = Shell.ActionMode.OVERVIEW;
        const f = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        Main.wm.addKeybinding('hints-key', s, f, N | O, () => (p.hints?.active ? p.hints.hide() : p.hints?.show()));
        Main.wm.addKeybinding('palette-key', s, f, N | O, () => p.palette?.toggle());
        Main.wm.addKeybinding('arrange-key', s, f, N, () => p.arrange?.run());
        Main.wm.addKeybinding('watch-key', s, f, N | O, () => p.watch?.pick());
        Main.wm.addKeybinding('task-key', s, f, N | O, () => p.totask?.run());

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, {
            Hints: () => p.hints?.show(),
            Palette: () => p.palette?.toggle(),
            Arrange: () => p.arrange?.run(),
            Watch: () => p.watch?.pick(),
            WatchArea: (x, y, w, h) => p.watch?.add(x, y, w, h),
            ToTask: () => p.totask?.run(),
            AutopilotAsk: () => p.autopilot?.askNow(),
            Meeting: on => (on ? p.meeting?.start() : p.meeting?._stop()),
            get MeetingActive() {
                return !!p.meeting?.active;
            },
            get Watching() {
                return p.watch?.count ?? 0;
            },
        });
        this._dbus.export(Gio.DBus.session, '/org/bapirlo/Flow');
        this._owner = Gio.bus_own_name(Gio.BusType.SESSION, 'org.bapirlo.Flow', Gio.BusNameOwnerFlags.REPLACE, null, null, null);
    }

    disable() {
        for (const k of KEYS)
            Main.wm.removeKeybinding(k);
        if (this._owner)
            Gio.bus_unown_name(this._owner);
        this._owner = 0;
        this._dbus?.unexport();
        this._dbus = null;
        for (const [k, part] of Object.entries(this._parts ?? {})) {
            try {
                part?.destroy();
            } catch (e) {
                console.error(`Kuro Flow: ${k} destroy: ${e.stack ?? e}`);
            }
        }
        this._parts = null;
        this._settings = null;
    }
}
