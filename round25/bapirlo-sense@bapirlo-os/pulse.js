// Kuro Sense — music-reactive Kuro.
// While any MPRIS player is Playing, the user unit kuro-pulse.service (helpers/kuro-pulse.py) listens to what the
// speakers play (the default output's monitor — never the microphone) and sends Levels(level, bass, onset)
// ~30×/s. Nothing playing for 8 s → the unit is stopped again (it costs nothing while music is off).
// Each beat:
//   · Liquid Glass rims (bar pills, dock, island) glow in the album-art colour (globalThis.kuroGlass.glow)
//   · the centre pill (clock / Dynamic Island) swells a few % on the kick
//   · globalThis.kuroBeat = {level, bass, col} — Kuro Cosmos' aurora adds it to its energy and tint
// The colour = the most vivid colour of the current track's album art (mpris:artUrl, file:// or https://),
// else Kuro crimson.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UNIT = 'kuro-pulse.service';
const CRIMSON = [0.894, 0.0, 0.239];
const STOP_AFTER_US = 8e6;

export class Pulse {
    constructor(settings) {
        this._s = settings;
        this._col = CRIMSON;
        this._artUrl = null;
        this._g = 0;
        this._last = 0;
        this._playingSince = 0;
        this._quietSince = 0;
        this._unitOn = false;
        this._sub = Gio.DBus.session.signal_subscribe(null, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            '/org/mpris/MediaPlayer2', null, Gio.DBusSignalFlags.NONE, () => this._scanSoon());
        this._poll = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 4, () => {
            this._scan();
            return GLib.SOURCE_CONTINUE;
        });
        settings.connectObject('changed::pulse', () => this._scan(), this);
        globalThis.kuroBeat = {level: 0, bass: 0, col: this._col, _owner: this};
        this._scan();
    }

    status() {
        if (!this._s.get_boolean('pulse'))
            return 'off';
        return this._unitOn ? 'listening' : 'waiting for music';
    }

    // ---------- is anything playing? ----------
    _scanSoon() {
        if (this._scanId)
            return;
        this._scanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._scanId = 0;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scan() {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, null, Gio.DBusCallFlags.NONE, 2000, null, (c, res) => {
                let names = [];
                try {
                    [names] = c.call_finish(res).deepUnpack();
                } catch {
                    return;
                }
                const players = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
                let pending = players.length, playing = null;
                const done = () => {
                    if (--pending <= 0)
                        this._playing(playing);
                };
                if (!pending)
                    this._playing(null);
                for (const name of players) {
                    Gio.DBus.session.call(name, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'GetAll',
                        new GLib.Variant('(s)', ['org.mpris.MediaPlayer2.Player']), null, Gio.DBusCallFlags.NONE, 1500, null,
                        (c2, r2) => {
                            try {
                                const [props] = c2.call_finish(r2).deepUnpack();
                                if (props.PlaybackStatus?.deepUnpack() === 'Playing' && !playing)
                                    playing = {name, meta: props.Metadata?.deepUnpack() ?? {}};
                            } catch {}
                            done();
                        });
                }
            });
    }

    _playing(p) {
        const now = GLib.get_monotonic_time();
        const want = !!p && this._s.get_boolean('pulse');
        if (want) {
            this._quietSince = 0;
            this._unit(true);
            const art = p.meta['mpris:artUrl']?.deepUnpack?.() ?? p.meta['mpris:artUrl'];
            if (typeof art === 'string' && art !== this._artUrl) {
                this._artUrl = art;
                this._loadArt(art);
            }
        } else {
            this._quietSince ||= now;
            if (!this._s.get_boolean('pulse') || now - this._quietSince > STOP_AFTER_US)
                this._unit(false);
        }
    }

    _unit(on) {
        if (on === this._unitOn)
            return;
        this._unitOn = on;
        Gio.DBus.session.call('org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager',
            on ? 'StartUnit' : 'StopUnit', new GLib.Variant('(ss)', [UNIT, 'replace']), null, Gio.DBusCallFlags.NONE, 3000,
            null, (c, res) => {
                try {
                    c.call_finish(res);
                } catch (e) {
                    console.warn(`Kuro Pulse: ${on ? 'start' : 'stop'} ${UNIT}: ${e.message}`);
                }
            });
        if (!on)
            this._decay();
    }

    // ---------- album colour ----------
    _loadArt(url) {
        try {
            const f = Gio.File.new_for_uri(url);
            f.load_contents_async(null, (_f, res) => {
                try {
                    const [, bytes] = f.load_contents_finish(res);
                    const stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(bytes));
                    const pb = GdkPixbuf.Pixbuf.new_from_stream_at_scale(stream, 24, 24, false, null);
                    this._col = vivid(pb) ?? CRIMSON;
                } catch {
                    this._col = CRIMSON;
                }
                if (globalThis.kuroBeat?._owner === this)
                    globalThis.kuroBeat.col = this._col;
            });
        } catch {
            this._col = CRIMSON;
        }
    }

    // ---------- the beat ----------
    levels(level, bass, onset) {
        if (!this._s.get_boolean('pulse'))
            return;
        this._last = GLib.get_monotonic_time();
        const target = Math.min(1, bass * 1.15 + (onset ? 0.45 : 0));
        // fast attack, slower release
        this._g = target > this._g ? target : this._g * 0.82 + target * 0.18;
        this._apply(level, bass);
        this._watchSilence();
    }

    _apply(level, bass) {
        const g = this._g;
        globalThis.kuroGlass?.glow(g * 0.9, this._col);
        const c = Main.panel._centerBox;
        if (c) {
            c.set_pivot_point(0.5, 0.5);
            c.set_scale(1 + 0.035 * g, 1 + 0.035 * g);
        }
        if (globalThis.kuroBeat?._owner === this)
            Object.assign(globalThis.kuroBeat, {level, bass, col: this._col});
    }

    // the helper stopped sending (pause / unit stopped): fade the glow out over ~0.4 s
    _watchSilence() {
        if (this._silenceId)
            return;
        this._silenceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            if (GLib.get_monotonic_time() - this._last < 250e3)
                return GLib.SOURCE_CONTINUE;
            this._g *= 0.6;
            this._apply(0, 0);
            if (this._g > 0.01)
                return GLib.SOURCE_CONTINUE;
            this._silenceId = 0;
            this._decay();
            return GLib.SOURCE_REMOVE;
        });
    }

    _decay() {
        this._g = 0;
        globalThis.kuroGlass?.glow(0, this._col);
        Main.panel._centerBox?.ease({scale_x: 1, scale_y: 1, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (globalThis.kuroBeat?._owner === this)
            Object.assign(globalThis.kuroBeat, {level: 0, bass: 0});
    }

    demo() {   // 6 s of a 120 BPM kick, no music needed
        let n = 0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            const ph = (n * 33 % 500) / 500;
            const kick = Math.exp(-ph * 9);
            this.levels(0.4 + 0.4 * kick, kick, ph < 0.07);
            return ++n < 180 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._sub);
        for (const id of [this._poll, this._scanId, this._silenceId])
            if (id)
                GLib.source_remove(id);
        this._poll = this._scanId = this._silenceId = 0;
        this._s.disconnectObject(this);
        if (this._unitOn)
            this._unit(false);
        Main.panel._centerBox?.set_scale(1, 1);
        if (globalThis.kuroBeat?._owner === this)
            delete globalThis.kuroBeat;
    }
}

// the most vivid colour of a small pixbuf as [r, g, b] 0..1 (null if it's all grey)
function vivid(pb) {
    const px = pb.get_pixels(), n = pb.get_n_channels(), rs = pb.get_rowstride();
    let best = null, bestScore = 0.08;
    const acc = new Map();
    for (let y = 0; y < pb.get_height(); y++) {
        for (let x = 0; x < pb.get_width(); x++) {
            const i = y * rs + x * n;
            const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            const sat = mx ? (mx - mn) / mx : 0;
            // bucket by hue so one big vivid area beats a few stray pixels
            const hue = Math.round(hueOf(r, g, b, mx, mn) / 30);
            const a = acc.get(hue) ?? {s: 0, r: 0, g: 0, b: 0, k: 0};
            const w = sat * sat * mx;
            a.s += w;
            a.r += r * w;
            a.g += g * w;
            a.b += b * w;
            a.k++;
            acc.set(hue, a);
        }
    }
    for (const a of acc.values()) {
        const score = a.s / (pb.get_width() * pb.get_height()) * 4;
        if (score > bestScore && a.s > 0) {
            bestScore = score;
            best = [a.r / a.s, a.g / a.s, a.b / a.s];
        }
    }
    if (!best)
        return null;
    // brighten so it reads as a glow
    const m = Math.max(...best) || 1;
    return best.map(v => Math.min(1, v / m));
}

function hueOf(r, g, b, mx, mn) {
    const d = mx - mn;
    if (!d)
        return 0;
    let h;
    if (mx === r)
        h = ((g - b) / d) % 6;
    else if (mx === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return (h * 60 + 360) % 360;
}
