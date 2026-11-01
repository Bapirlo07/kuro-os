// Kuro Control Centre — per-app volume (the Sound page): one slider per app that is playing
// sound right now (Spotify, Firefox, a game…), with mute on its icon. Uses GNOME's own mixer
// connection (status/volume.js), so nothing extra runs; rows come and go with the apps.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Gvc from 'gi://Gvc';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

function appFor(stream) {
    const sys = Shell.AppSystem.get_default();
    for (const id of [stream.get_application_id(), stream.get_name()].filter(Boolean)) {
        const app = sys.lookup_app(`${id}.desktop`) ?? sys.lookup_heuristic_basename(id) ??
            sys.lookup_startup_wmclass(id) ?? Shell.AppSystem.search(id)?.[0]?.map(a => sys.lookup_app(a)).find(Boolean);
        if (app)
            return app;
    }
    return null;
}

class AppRow {
    constructor(control, stream) {
        this._control = control;
        this.stream = stream;
        const app = appFor(stream);
        this.actor = new St.BoxLayout({style_class: 'bcc-mix-row', x_expand: true});
        this._mute = new St.Button({style_class: 'bcc-mix-icon', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._mute.child = app?.create_icon_texture(22) ??
            new St.Icon({gicon: Gio.Icon.new_for_string(stream.get_icon_name() || 'audio-x-generic-symbolic'), icon_size: 22});
        this._mute.connect('clicked', () => stream.change_is_muted(!stream.is_muted));
        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'bcc-mix-col'});
        const top = new St.BoxLayout({x_expand: true});
        const name = new St.Label({style_class: 'bcc-mix-name', y_align: Clutter.ActorAlign.CENTER,
            text: app?.get_name() ?? stream.get_name() ?? 'App'});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._value = new St.Label({style_class: 'bcc-mix-value', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(name);
        top.add_child(new St.Widget({x_expand: true}));
        top.add_child(this._value);
        this.slider = new Slider(0);
        this.slider.accessible_name = name.text;
        col.add_child(top);
        col.add_child(new St.Bin({child: this.slider, x_expand: true, style_class: 'bcc-mix-bin', reactive: true}));
        this.actor.add_child(this._mute);
        this.actor.add_child(col);

        this.slider.connect('notify::value', () => {
            if (this._syncing)
                return;
            const max = control.get_vol_max_norm();
            stream.volume = Math.round(this.slider.value * max);
            stream.push_volume();
            if (stream.is_muted && this.slider.value > 0)
                stream.change_is_muted(false);
            this._label();
        });
        stream.connectObject('notify::volume', () => this._sync(), 'notify::is-muted', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        this._syncing = true;
        this.slider.value = this.stream.volume / this._control.get_vol_max_norm();
        this._syncing = false;
        this._mute.opacity = this.stream.is_muted ? 110 : 255;
        this._label();
    }

    _label() {
        this._value.text = this.stream.is_muted ? 'muted' : `${Math.round(this.slider.value * 100)}%`;
    }

    destroy() {
        this.stream.disconnectObject(this);
        this.actor.destroy();
    }
}

// a section for a detail page: {actor, destroy()}
export function buildMixer() {
    const control = getMixerControl();
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bcc-mix', x_expand: true});
    box.add_child(new St.Label({text: 'APPS', style_class: 'bcc-mix-title'}));
    const empty = new St.Label({text: 'No app is playing sound right now.', style_class: 'bcc-note'});
    box.add_child(empty);
    const rows = new Map();

    const add = id => {
        const s = control.lookup_stream_id(id);
        if (!s || rows.has(id) || !(s instanceof Gvc.MixerSinkInput) || s.is_event_stream)
            return;
        const row = new AppRow(control, s);
        rows.set(id, row);
        box.add_child(row.actor);
        empty.visible = false;
    };
    const remove = id => {
        rows.get(id)?.destroy();
        rows.delete(id);
        empty.visible = rows.size === 0;
    };
    control.get_sink_inputs().forEach(s => add(s.id));
    control.connectObject('stream-added', (c, id) => add(id), 'stream-removed', (c, id) => remove(id), box);
    return {
        actor: box,
        destroy: () => {
            control.disconnectObject(box);
            rows.forEach(r => r.destroy());
            rows.clear();
        },
    };
}
