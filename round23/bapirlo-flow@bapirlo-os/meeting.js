// Kuro Meeting mode — switches itself on when a call starts: the camera comes on, or an app (not Kuro's own
// knock / gesture helpers) keeps the microphone open for 10 s. While it's on:
//   · notification banners are held (they still go to the list), music that was playing is paused,
//   · the desk widgets and the Kuro creature step out of the way,
//   · a small "● In a meeting · 12:04" timer sits under the bar ("Not a meeting" turns it off until the call ends).
// 20 s after the camera and mic are both free, everything goes back exactly as it was (music resumes).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MIC_HOLD_S = 10;
const END_S = 20;
const OWN = /knock|kuro|bapirlo|gesture|speech-dispatcher|easyeffects|cava/i;

function extSettings(uuid, id) {
    const ext = Main.extensionManager.lookup(uuid);
    const dir = ext?.dir?.get_child('schemas');
    try {
        const src = dir?.query_exists(null)
            ? Gio.SettingsSchemaSource.new_from_directory(dir.get_path(), Gio.SettingsSchemaSource.get_default(), false)
            : Gio.SettingsSchemaSource.get_default();
        const schema = src.lookup(id, true);
        return schema ? new Gio.Settings({settings_schema: schema}) : null;
    } catch {
        return null;
    }
}

function run(argv) {
    return new Promise(resolve => {
        try {
            const p = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            p.communicate_utf8_async(null, null, (pp, res) => {
                try {
                    resolve(pp.communicate_utf8_finish(res)[1] ?? '');
                } catch {
                    resolve('');
                }
            });
        } catch {
            resolve('');
        }
    });
}

function dbus(dest, path, iface, method, params, type) {
    return new Promise(resolve => Gio.DBus.session.call(dest, path, iface, method, params,
        type ? new GLib.VariantType(type) : null, Gio.DBusCallFlags.NONE, 1000, null, (c, r) => {
            try {
                resolve(c.call_finish(r));
            } catch {
                resolve(null);
            }
        }));
}

export class Meeting {
    constructor(settings) {
        this._settings = settings;
        this._on = false;
        this._ignored = false;
        this._tries = 0;
        this._attach();
    }

    _attach() {
        const qs = Main.panel.statusArea.quickSettings;
        if (!qs?._volumeInput || !qs._camera) {
            if (++this._tries < 60)
                this._retry = setTimeout(() => this._attach(), 500);
            return;
        }
        this._micIcon = qs._volumeInput._indicator;
        this._camIcon = qs._camera._indicator;
        for (const icon of [this._micIcon, this._camIcon])
            icon?.connectObject('notify::visible', () => this._sync(), this);
        this._sync();
    }

    async _micIsCall() {
        const out = await run(['pactl', '-f', 'json', 'list', 'source-outputs']);
        try {
            const list = JSON.parse(out || '[]');
            return list.some(o => {
                const p = o.properties ?? {};
                const who = `${p['application.name'] ?? ''} ${p['application.process.binary'] ?? ''} ${p['media.name'] ?? ''}`;
                return !OWN.test(who) && !/peak detect|monitor/i.test(p['media.name'] ?? '');
            });
        } catch {
            return false;
        }
    }

    _sync() {
        const cam = !!this._camIcon?.visible, mic = !!this._micIcon?.visible;
        if (cam || mic) {
            if (this._endTimer) {
                GLib.source_remove(this._endTimer);
                this._endTimer = 0;
            }
            if (this._on || this._ignored || !this._settings.get_boolean('meeting'))
                return;
            if (cam) {
                this._start();
            } else if (!this._micTimer) {
                this._micTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MIC_HOLD_S, () => {
                    this._micTimer = 0;
                    if (this._micIcon?.visible && !this._on)
                        this._micIsCall().then(call => call && this._micIcon?.visible && this._start());
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            if (this._micTimer) {
                GLib.source_remove(this._micTimer);
                this._micTimer = 0;
            }
            if ((this._on || this._ignored) && !this._endTimer) {
                this._endTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, END_S, () => {
                    this._endTimer = 0;
                    this._ignored = false;
                    this._stop();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    async start() {
        return this._start();
    }

    async _start() {
        if (this._on)
            return;
        this._on = true;
        this._t0 = GLib.get_monotonic_time();
        const saved = this._saved = {};
        // banners
        const notif = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        saved.banners = notif.get_boolean('show-banners');
        notif.set_boolean('show-banners', false);
        // desk widgets
        const desk = extSettings('bapirlo-desk@bapirlo-os', 'org.gnome.shell.extensions.bapirlo-desk');
        if (desk?.settings_schema.has_key('widgets')) {
            saved.widgets = desk.get_boolean('widgets');
            desk.set_boolean('widgets', false);
            this._desk = desk;
        }
        // Kuro creature
        const pet = (await run(['bapirlo-pet', 'status'])).trim();
        saved.pet = /^Kuro is out/.test(pet);
        if (saved.pet)
            run(['bapirlo-pet', 'hide']);
        // music
        saved.paused = [];
        const names = await dbus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null, '(as)');
        for (const n of (names?.deepUnpack()[0] ?? []).filter(x => x.startsWith('org.mpris.MediaPlayer2.'))) {
            const st = await dbus(n, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'PlaybackStatus']), '(v)');
            // a browser tab with the call itself is also an MPRIS player while it has media — only pause music players
            if (st?.deepUnpack()[0]?.deepUnpack?.() === 'Playing' && !/chromium|chrome|firefox|brave|edge|zoom|teams|discord|vesktop/i.test(n)) {
                await dbus(n, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', 'Pause', null, null);
                saved.paused.push(n);
            }
        }
        this._showPill();
    }

    _stop() {
        if (!this._on)
            return;
        this._on = false;
        const s = this._saved ?? {};
        if (s.banners !== undefined)
            new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'}).set_boolean('show-banners', s.banners);
        if (s.widgets !== undefined)
            this._desk?.set_boolean('widgets', s.widgets);
        if (s.pet)
            run(['bapirlo-pet', 'show']);
        for (const n of s.paused ?? [])
            dbus(n, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', 'Play', null, null);
        this._saved = null;
        this._hidePill();
    }

    get active() {
        return this._on;
    }

    _showPill() {
        this._hidePill();
        const pill = new St.BoxLayout({style_class: 'kuro-meeting-pill', reactive: true});
        const dot = new St.Widget({style_class: 'kuro-meeting-dot', y_align: Clutter.ActorAlign.CENTER});
        this._clock = new St.Label({text: 'In a meeting · 0:00', y_align: Clutter.ActorAlign.CENTER});
        const not = new St.Button({style_class: 'kuro-meeting-not', label: 'Not a meeting', can_focus: true});
        not.connect('clicked', () => {
            this._ignored = true;
            this._stop();
        });
        pill.add_child(dot);
        pill.add_child(this._clock);
        pill.add_child(not);
        Main.layoutManager.addTopChrome(pill);
        const pm = Main.layoutManager.primaryMonitor;
        pill.connect('notify::allocation', () => pill.set_position(Math.round(pm.x + pm.width - pill.width - 16),
            pm.y + Main.panel.height + 10));
        this._pill = pill;
        this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 1, () => {
            const s = Math.floor((GLib.get_monotonic_time() - this._t0) / 1e6);
            const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
            this._clock.text = `In a meeting · ${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(ss).padStart(2, '0')}`;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _hidePill() {
        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = 0;
        if (this._pill) {
            Main.layoutManager.removeChrome(this._pill);
            this._pill.destroy();
        }
        this._pill = null;
    }

    destroy() {
        clearTimeout(this._retry);
        for (const id of [this._micTimer, this._endTimer])
            if (id)
                GLib.source_remove(id);
        this._micTimer = this._endTimer = 0;
        for (const icon of [this._micIcon, this._camIcon])
            icon?.disconnectObject(this);
        this._stop();
    }
}
