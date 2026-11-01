// Kuro Time dilation — hold Super+Shift+Z: time slows down. Every shell animation runs 5× slower, the pointer
// goes into precision mode (slow, for pixel-exact drags), media players that allow it drop to half speed,
// and the edges of the screen go deep blue like you're inside a time bubble. Let go of Super → back to normal.
// The original pointer speeds are kept in ~/.local/state/bapirlo/cosmos-dilation.json while it's held, so a
// crash mid-hold is undone at the next start.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ShaderActor, animate} from './gfx.js';

const SUPER = Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK;
const SLOW = 5;
const PRECISE = -0.85;
const STATE = GLib.build_filenamev([GLib.get_user_state_dir(), 'bapirlo', 'cosmos-dilation.json']);
const POINTERS = ['org.gnome.desktop.peripherals.mouse', 'org.gnome.desktop.peripherals.touchpad'];

const DECL = `
uniform float aspect;
uniform float k;
uniform float t;`;
const BODY = `
vec2 uv = cogl_tex_coord_in[0].xy - 0.5;
uv.x *= aspect;
float r = length(uv);
float edge = smoothstep(0.35, 0.95, r);
float ripple = 0.5 + 0.5 * sin(r * 60.0 - t * 2.0);
float a = k * (edge * 0.55 + edge * ripple * 0.08);
vec3 c = mix(vec3(0.05, 0.12, 0.35), vec3(0.25, 0.45, 1.0), ripple * edge);
cogl_color_out = vec4(c * a, a);`;

export class Dilation {
    constructor(settings) {
        this._settings = settings;
        this._recover();
    }

    get active() {
        return !!this._on;
    }

    // sticky: stays on until stop() (bapirlo-cosmos slow on) instead of ending when Super is let go
    start(sticky = false) {
        if (this._on || Main.sessionMode.isLocked)
            return;
        this._on = true;
        this._sticky = sticky;
        // 1) shell animations
        const st = St.Settings.get();
        this._oldFactor = st.slow_down_factor;
        st.slow_down_factor = SLOW;
        // 2) pointer precision (remember originals first)
        const saved = {};
        this._ptr = [];
        for (const id of POINTERS) {
            try {
                const s = new Gio.Settings({schema_id: id});
                saved[id] = s.get_double('speed');
                s.set_double('speed', PRECISE);
                this._ptr.push([s, saved[id]]);
            } catch {}
        }
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(STATE), 0o755);
            GLib.file_set_contents(STATE, JSON.stringify({speed: saved, factor: this._oldFactor}));
        } catch {}
        // 3) media
        this._players = [];
        this._rate(0.5);
        // 4) the time bubble
        this._veils = Main.layoutManager.monitors.map(m => {
            const v = new ShaderActor(DECL, BODY, {x: m.x, y: m.y, width: m.width, height: m.height, reactive: false});
            v.set('aspect', m.width / m.height).set('k', 0);
            Main.layoutManager.uiGroup.add_child(v);
            return v;
        });
        this._label = new St.Label({style_class: 'kuro-dilation-label', text: '⏳  time slowed', opacity: 0});
        Main.layoutManager.uiGroup.add_child(this._label);
        const pm = Main.layoutManager.primaryMonitor;
        this._label.set_position(Math.round(pm.x + pm.width / 2 - 70), pm.y + 70);
        this._label.ease({opacity: 255, duration: 200});
        // the veil runs on real time (slow_down_factor would slow our own fade-in too)
        this._t0 = GLib.get_monotonic_time();
        this._tick = GLib.timeout_add(GLib.PRIORITY_HIGH, 33, () => this._step());
    }

    _step() {
        if (!this._on)
            return GLib.SOURCE_REMOVE;
        const [, , mods] = global.get_pointer();
        if (!this._sticky && !(mods & SUPER)) {
            this.stop();
            return GLib.SOURCE_REMOVE;
        }
        const secs = (GLib.get_monotonic_time() - this._t0) / 1e6;
        const k = Math.min(1, secs / 0.35);
        for (const v of this._veils)
            v.set('k', k).set('t', secs);
        return GLib.SOURCE_CONTINUE;
    }

    stop() {
        if (!this._on)
            return;
        this._on = false;
        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = 0;
        St.Settings.get().slow_down_factor = this._oldFactor ?? 1;
        for (const [s, v] of this._ptr ?? [])
            s.set_double('speed', v);
        this._ptr = [];
        GLib.unlink(STATE);
        this._rate(1.0);
        const veils = this._veils ?? [];
        this._veils = [];
        const label = this._label;
        this._label = null;
        // quick fade out on real time
        if (veils.length) {
            animate(veils[0], 220, (_d, _s, k) => veils.forEach(v => v.set('k', 1 - k)), () => veils.forEach(v => v.destroy()));
        }
        label?.destroy();
    }

    // MPRIS Rate for every player that allows it (Spotify doesn't; mpv / VLC / browsers mostly do)
    _rate(rate) {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, null, Gio.DBusCallFlags.NONE, 1000, null, (c, res) => {
                let names = [];
                try {
                    names = c.call_finish(res).deepUnpack()[0].filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
                } catch {
                    return;
                }
                for (const n of names) {
                    Gio.DBus.session.call(n, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Set',
                        new GLib.Variant('(ssv)', ['org.mpris.MediaPlayer2.Player', 'Rate', new GLib.Variant('d', rate)]),
                        null, Gio.DBusCallFlags.NONE, 1000, null, (cc, rr) => {
                            try {
                                cc.call_finish(rr);
                            } catch {}
                        });
                }
            });
    }

    // a crash while held left the pointer slow → put it back
    _recover() {
        try {
            const [, b] = GLib.file_get_contents(STATE);
            const j = JSON.parse(new TextDecoder().decode(b));
            for (const [id, v] of Object.entries(j.speed ?? {}))
                new Gio.Settings({schema_id: id}).set_double('speed', v);
            if (St.Settings.get().slow_down_factor === SLOW)
                St.Settings.get().slow_down_factor = j.factor ?? 1;
            GLib.unlink(STATE);
        } catch {}
    }

    destroy() {
        this.stop();
    }
}
