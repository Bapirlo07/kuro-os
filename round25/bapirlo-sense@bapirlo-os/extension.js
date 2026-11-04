// Kuro Sense — Kuro OS round 25 (GNOME Shell 51).
//   head.js     3D wallpaper follows your HEAD (webcam) instead of the pointer — Kuro Live Wallpaper asks
//               globalThis.kuroHead.get() every frame it draws the parallax
//   look.js     look away → videos pause + the screen dims; look back → both come back. Optional:
//               hold your head toward a window to focus it (look-focus, off by default)
//   glass.js    Liquid Glass: the bar pills, dock and island bend + split the wallpaper behind them
//   pulse.js    music-reactive: while something plays, the glass rims / dock / island / aurora pulse to the beat,
//               coloured from the album art (globalThis.kuroBeat for Kuro Cosmos)
//   spatial.js  UI sounds panned to where they happen (notifications at the island, window open/close where
//               the window is, workspace switch left/right) — globalThis.kuroSpatial for Kuro Sounds
//   voice.js    "Hey Kuro": Super+K (or the wake word) → offline speech → a command
// Camera side: ~/bapirlo-os/gestures/kuro-gestures-daemon.py (jobs "head" / "look" in camera.json) calls
// org.bapirlo.Sense.Head / Look / Point. Music: helpers/kuro-pulse.py → Levels. Voice: helpers/kuro-voice.py.
// CLI: bapirlo-sense. Off: gnome-extensions disable bapirlo-sense@bapirlo-os
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Head} from './head.js';
import {Look} from './look.js';
import {Glass} from './glass.js';
import {Pulse} from './pulse.js';
import {Spatial} from './spatial.js';
import {Voice} from './voice.js';

const IFACE = `<node><interface name="org.bapirlo.Sense">
  <method name="Head"><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/></method>
  <method name="Look"><arg type="b" direction="in"/><arg type="b" direction="in"/></method>
  <method name="Point"><arg type="d" direction="in"/><arg type="d" direction="in"/></method>
  <method name="Levels"><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="b" direction="in"/></method>
  <method name="VoiceState"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
  <method name="Listen"/>
  <method name="Command"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
  <method name="Demo"><arg type="s" direction="in"/></method>
  <method name="Status"><arg type="s" direction="out"/></method>
</interface></node>`;

export default class KuroSense extends Extension {
    enable() {
        const s = this._settings = this.getSettings();
        const p = this._parts = {};
        const make = (name, C) => {
            try {
                p[name] = new C(s, this);
            } catch (e) {
                console.error(`Kuro Sense: ${name} failed to start: ${e.stack ?? e}`);
            }
        };
        make('head', Head);
        make('look', Look);
        make('glass', Glass);
        make('spatial', Spatial);
        make('pulse', Pulse);     // after glass: it lights the glass rims
        make('voice', Voice);

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, {
            Head: (x, y, z) => p.head?.update(x, y, z),
            Look: (facing, present) => p.look?.update(facing, present),
            Point: (x, y) => p.look?.point(x, y),
            Levels: (level, bass, onset) => p.pulse?.levels(level, bass, onset),
            VoiceState: (state, text) => p.voice?.state(state, text),
            Listen: () => p.voice?.listen(),
            Command: text => p.voice?.command(text) ?? 'voice is off',
            Demo: what => this._demo(what),
            Status: () => JSON.stringify(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v?.status?.() ?? 'on']))),
        });
        this._dbus.export(Gio.DBus.session, '/org/bapirlo/Sense');
        this._name = Gio.bus_own_name(Gio.BusType.SESSION, 'org.bapirlo.Sense', Gio.BusNameOwnerFlags.REPLACE, null, null, null);
    }

    _demo(what) {
        const p = this._parts;
        switch (what) {
        case 'beat': p.pulse?.demo(); break;
        case 'away': p.look?.demo(); break;
        case 'sound-left': p.spatial?.play('message-new-instant', 0.0); break;
        case 'sound-right': p.spatial?.play('message-new-instant', 1.0); break;
        case 'glass': p.glass?.rebuild(); break;
        }
    }

    disable() {
        if (this._name)
            Gio.bus_unown_name(this._name);
        this._name = 0;
        this._dbus?.unexport();
        this._dbus = null;
        for (const [k, v] of Object.entries(this._parts ?? {})) {
            try {
                v?.destroy();
            } catch (e) {
                console.error(`Kuro Sense: ${k}.destroy: ${e.stack ?? e}`);
            }
        }
        this._parts = null;
        this._settings = null;
    }
}
