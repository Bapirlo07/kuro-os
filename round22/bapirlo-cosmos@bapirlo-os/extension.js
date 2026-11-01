// Kuro Cosmos (round 22) — the cosmic layer of Kuro OS, eleven parts in one extension (fewer extensions =
// less lag). Each part follows its own setting (org.gnome.shell.extensions.bapirlo-cosmos).
//   blackhole.js     fling a window into a screen corner → black hole swallows it (closes it)   black-hole
//   echo.js          closed windows leave a fading after-image with a "↺ Reopen" pill             echo
//   supernova.js     urgent notifications burst out of the island as a shockwave               supernova
//   wormhole.js      workspace switches fly through a short star tunnel                        wormhole
//   dilation.js      hold Super+Shift+Z: slow motion + precision pointer + half-speed media     dilation-key
//   breathe.js       the wallpaper breathes, slower during focus / bedtime                      breathe
//   wells.js         Super+Alt+P: focused window becomes a planet, others orbit it             planet-key
//   shatterlock.js   locking cracks the desktop like glass; unlocking puts it back             shatter-lock
//   aurora.js        living night-sky wallpaper: CPU = aurora, notifications = shooting stars,
//                    downloads = a comet                                                       aurora
//   constellation.js Super+Shift+Space: apps as stars, linked by how you use them              constellation-key
//   living.js        dock glow / dust by use, a garden that grows on the wallpaper             living
//                    (+ bin/bapirlo-living: moss on ignored folders)
//   smooth.js        Smooth Guard: shell stutters / battery low → Lite (effects + live video pause)  smooth-guard
// D-Bus (session, org.bapirlo.Cosmos /org/bapirlo/Cosmos): BlackHole(s corner) BlackHoleTitle(s corner, s title)
//   Supernova() Wormhole()
//   Dilate(b) Planet() Shatter(b reverse) Constellation() ShootingStar() Echo() — used by bapirlo-cosmos + tests.
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {BlackHole} from './blackhole.js';
import {Echo} from './echo.js';
import {Supernova} from './supernova.js';
import {Wormhole} from './wormhole.js';
import {Dilation} from './dilation.js';
import {Breathe} from './breathe.js';
import {Wells} from './wells.js';
import {ShatterLock} from './shatterlock.js';
import {Aurora} from './aurora.js';
import {Constellation} from './constellation.js';
import {Living} from './living.js';
import {SmoothGuard} from './smooth.js';

const IFACE = `<node><interface name="org.bapirlo.Cosmos">
  <method name="BlackHole"><arg type="s" direction="in" name="corner"/><arg type="b" direction="out"/></method>
  <method name="BlackHoleTitle"><arg type="s" direction="in" name="corner"/><arg type="s" direction="in" name="title"/><arg type="b" direction="out"/></method>
  <method name="Supernova"/>
  <method name="Wormhole"/>
  <method name="Dilate"><arg type="b" direction="in" name="on"/></method>
  <method name="Planet"/>
  <method name="Shatter"><arg type="b" direction="in" name="reverse"/></method>
  <method name="Constellation"/>
  <method name="ShootingStar"/>
  <method name="SmoothTest"><arg type="u" direction="in" name="seconds"/></method>
  <property name="LivedDays" type="u" access="read"/>
</interface></node>`;

export default class KuroCosmosExtension extends Extension {
    enable() {
        const s = this._settings = this.getSettings();
        const safe = (name, fn) => {
            try {
                return fn();
            } catch (e) {
                console.error(`Kuro Cosmos: ${name} failed to start: ${e.stack ?? e}`);
                return null;
            }
        };
        this._parts = {
            blackhole: safe('black hole', () => new BlackHole()),
            echo: safe('echo', () => new Echo(s)),
            supernova: safe('supernova', () => new Supernova(s)),
            wormhole: safe('wormhole', () => new Wormhole(s)),
            dilation: safe('dilation', () => new Dilation(s)),
            breathe: safe('breathe', () => new Breathe(s)),
            wells: safe('wells', () => new Wells()),
            shatter: safe('shatter lock', () => new ShatterLock(s)),
            aurora: safe('aurora', () => new Aurora(s)),
            constellation: safe('constellation', () => new Constellation()),
            living: safe('living', () => new Living(s)),
        };
        const p = this._parts;
        this._smooth = safe('smooth guard', () => new SmoothGuard(s, p));

        const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        Main.wm.addKeybinding('dilation-key', s, flags, Shell.ActionMode.NORMAL, () => p.dilation?.start());
        Main.wm.addKeybinding('planet-key', s, flags, Shell.ActionMode.NORMAL, () => p.wells?.toggle());
        Main.wm.addKeybinding('constellation-key', s, flags, mode, () => p.constellation?.toggle());

        // Kuro Physics asks us when a window is flung into a corner
        globalThis.kuroCosmos = {
            blackhole: (win, corner) => s.get_boolean('black-hole') && !!p.blackhole?.swallow(win, corner),
        };

        // every new notification: shooting star + maybe a supernova
        const watch = src => src.connectObject('notification-added', (_s, n) => {
            p.aurora?.shootingStar();
            p.supernova?.notification(n);
        }, this);
        Main.messageTray.connectObject('source-added', (_t, src) => watch(src), this);
        Main.messageTray.getSources().forEach(watch);

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, {
            BlackHole: corner => !!p.blackhole?.swallow(global.display.focus_window, corner || 'tr'),
            // only a window with exactly this title (the demo's own throwaway window) — never anything else
            BlackHoleTitle: (corner, title) => {
                const win = global.get_window_actors().map(a => a.meta_window).find(w => w.get_title() === title);
                return !!win && !!p.blackhole?.swallow(win, corner || 'tr');
            },
            Supernova: () => p.supernova?.burst(),
            Wormhole: () => p.wormhole?.fly(1),
            Dilate: on => (on ? p.dilation?.start(true) : p.dilation?.stop()),
            Planet: () => p.wells?.toggle(),
            Shatter: reverse => {
                const shot = p.shatter?._snap();
                if (shot)
                    p.shatter.shatter(shot, reverse);
            },
            Constellation: () => p.constellation?.toggle(),
            ShootingStar: () => p.aurora?.shootingStar(),
            SmoothTest: seconds => this._smooth?.test(seconds),
            get LivedDays() {
                return p.living?.days ?? 0;
            },
        });
        this._dbus.export(Gio.DBus.session, '/org/bapirlo/Cosmos');
        this._owner = Gio.bus_own_name(Gio.BusType.SESSION, 'org.bapirlo.Cosmos', Gio.BusNameOwnerFlags.REPLACE,
            null, null, null);
    }

    disable() {
        delete globalThis.kuroCosmos;
        for (const k of ['dilation-key', 'planet-key', 'constellation-key'])
            Main.wm.removeKeybinding(k);
        Main.messageTray.disconnectObject(this);
        for (const src of Main.messageTray.getSources())
            src.disconnectObject(this);
        if (this._owner)
            Gio.bus_unown_name(this._owner);
        this._owner = 0;
        this._dbus?.unexport();
        this._dbus = null;
        try {
            this._smooth?.destroy();
        } catch (e) {
            console.error(`Kuro Cosmos: smooth guard destroy: ${e.stack ?? e}`);
        }
        this._smooth = null;
        for (const [k, part] of Object.entries(this._parts ?? {})) {
            try {
                part?.destroy();
            } catch (e) {
                console.error(`Kuro Cosmos: ${k} destroy: ${e.stack ?? e}`);
            }
        }
        this._parts = null;
        this._settings = null;
    }
}
