// Kuro Throw-to-Phone
//   OUT: throw a window hard against the TOP edge of the screen (mouse throw or an air-gesture flick):
//        a picture of it flies off the top and lands on your phone (GSConnect / KDE Connect), the window
//        itself bounces back down. Ctrl held while it hits = send what's on your clipboard instead (text/link).
//   IN:  files the phone sends drop in from the top of the screen as a bouncing card (click = open it).
// Needs the phone connected in GSConnect (on iPhone: open the KDE Connect app).
// Kuro Window Physics calls globalThis.kuroPhone.thrown(win, speed).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const GSC = 'org.gnome.Shell.Extensions.GSConnect';
const GSC_PATH = '/org/gnome/Shell/Extensions/GSConnect';
const OUT_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'bapirlo', 'phone']);

function call(path, iface, method, params, type) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(GSC, path, iface, method, params, type ?? null, Gio.DBusCallFlags.NONE, 4000, null,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// the first paired + connected phone that can receive files
async function findPhone() {
    const reply = await call(GSC_PATH, 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', null,
        new GLib.VariantType('(a{oa{sa{sv}}})'));
    const [objs] = reply.deepUnpack();
    let paired = null;
    for (const [path, ifaces] of Object.entries(objs)) {
        const dev = ifaces['org.gnome.Shell.Extensions.GSConnect.Device'];
        if (!dev)
            continue;
        const v = k => dev[k]?.deepUnpack?.();
        if (!v('Paired'))
            continue;
        paired ??= {path, name: v('Name')};
        if (v('Connected'))
            return {path, name: v('Name'), connected: true};
    }
    return paired ? {...paired, connected: false} : null;
}

async function action(path, name, variant) {
    await call(path, 'org.gtk.Actions', 'Activate',
        new GLib.Variant('(sava{sv})', [name, variant ? [variant] : [], {}]));
}

export default class KuroPhoneExtension extends Extension {
    enable() {
        GLib.mkdir_with_parents(OUT_DIR, 0o755);
        globalThis.kuroPhone = {thrown: (w, speed) => this._thrown(w, speed)};
        this._cards = new Set();
        // incoming: watch GSConnect's "Transfer Successful" notifications
        Main.messageTray.connectObject('source-added', (_t, source) => this._watchSource(source), this);
        for (const source of Main.messageTray.getSources?.() ?? [])
            this._watchSource(source);
    }

    disable() {
        delete globalThis.kuroPhone;
        for (const id of this._timers ?? [])
            GLib.source_remove(id);
        this._timers = null;
        Main.messageTray.disconnectObject(this);
        for (const s of this._sources ?? [])
            s.disconnectObject(this);
        this._sources = null;
        for (const c of this._cards ?? [])
            c.destroy();
        this._cards = null;
        this._toast?.destroy();
        this._toast = null;
    }

    // ---------------------------------------------------------------- out
    async _thrown(win, _speed) {
        if (this._busy)
            return;
        this._busy = true;
        try {
            const phone = await findPhone().catch(() => null);
            if (!phone) {
                this._say('📱 No phone paired in GSConnect');
                return;
            }
            if (!phone.connected) {
                this._say(`📱 ${phone.name} isn't connected — open KDE Connect on it`);
                return;
            }
            const [, , mods] = global.get_pointer();
            if (mods & Clutter.ModifierType.CONTROL_MASK) {
                const text = await new Promise(r => St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, t) => r(t)));
                if (!text) {
                    this._say('📋 Clipboard is empty');
                    return;
                }
                const isUrl = /^\w+:\/\/\S+$/.test(text.trim());
                this._flyAway(win, true);
                await action(phone.path, isUrl ? 'shareUri' : 'shareText', new GLib.Variant('s', text.trim()));
                this._say(`📋 ${isUrl ? 'Link' : 'Text'} → ${phone.name}`);
                return;
            }
            const file = await this._snapshot(win);
            this._flyAway(win);
            await action(phone.path, 'shareFile', new GLib.Variant('(sb)', [file, false]));
            this._say(`📱 Sent to ${phone.name}`);
        } catch (e) {
            console.warn(`Kuro phone: ${e.message}`);
            this._say('📱 Couldn\'t send it — is the phone awake?');
        } finally {
            this._busy = false;
        }
    }

    async _snapshot(win) {
        const t = GLib.DateTime.new_now_local().format('%F_%H-%M-%S');
        const name = (win.get_wm_class() || 'window').replace(/[^\w.-]+/g, '-');
        const path = GLib.build_filenamev([OUT_DIR, `${name}_${t}.png`]);
        // Shell.Screenshot shoots the focused window — make sure it's this one
        win.activate(global.display.get_current_time_roundtrip());
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shot = new Shell.Screenshot();
        await shot.screenshot_window(true, false, stream);
        stream.close(null);
        return path;
    }

    // a ghost of the window shoots up off the screen and shrinks away
    _flyAway(win, small = false) {
        const actor = win.get_compositor_private();
        if (!actor)
            return;
        const ghost = new Clutter.Clone({source: actor, reactive: false});
        const [x, y] = actor.get_position();
        ghost.set_position(x, y);
        ghost.set_pivot_point(0.5, 0.5);
        Main.layoutManager.uiGroup.add_child(ghost);
        const [, h] = actor.get_size();
        ghost.ease({
            translation_y: -(y + h + 200),
            scale_x: small ? 0.15 : 0.3, scale_y: small ? 0.15 : 0.3,
            rotation_angle_z: (Math.random() - 0.5) * 30,
            opacity: 120,
            duration: 520,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onStopped: () => ghost.destroy(),
        });
    }

    // ---------------------------------------------------------------- in
    _watchSource(source) {
        this._sources ??= new Set();
        if (this._sources.has(source))
            return;
        this._sources.add(source);
        source.connectObject('notification-added', (_s, n) => this._incoming(n),
            'destroy', () => this._sources?.delete(source), this);
    }

    _incoming(n) {
        const m = /Received “(.+)” from (.+)/.exec(n.body ?? '');
        if (!m || !/Transfer Successful/i.test(n.title ?? ''))
            return;
        this._dropCard(m[1], m[2]);
    }

    _dropCard(filename, from) {
        const mon = Main.layoutManager.primaryMonitor;
        const card = new St.Button({style_class: 'kuro-phone-card', reactive: true, can_focus: true});
        const box = new St.BoxLayout({style_class: 'kuro-phone-card-box'});
        box.add_child(new St.Icon({icon_name: 'phone-symbolic', icon_size: 22}));
        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        col.add_child(new St.Label({text: filename, style_class: 'kuro-phone-card-title'}));
        col.add_child(new St.Label({text: `from ${from} · click to open`, style_class: 'kuro-phone-card-sub'}));
        box.add_child(col);
        card.set_child(box);
        Main.layoutManager.uiGroup.add_child(card);
        this._cards.add(card);
        const [, nw] = card.get_preferred_width(-1);
        const [, nh] = card.get_preferred_height(nw);
        const x = mon.x + Math.round(mon.width / 2 - nw / 2 + (Math.random() - 0.5) * 200);
        const rest = mon.y + Math.round(mon.height * 0.1) + this._cards.size * (nh + 10);
        card.set_position(x, mon.y - nh - 20);
        card.rotation_angle_z = (Math.random() - 0.5) * 16;
        card.set_pivot_point(0.5, 0.5);
        card.ease({y: rest, rotation_angle_z: 0, duration: 900, mode: Clutter.AnimationMode.EASE_OUT_BOUNCE});
        const dir = this._receiveDir();
        card.connect('clicked', () => {
            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, filename]));
            Gio.AppInfo.launch_default_for_uri_async(file.query_exists(null) ? file.get_uri()
                : Gio.File.new_for_path(dir).get_uri(), null, null, null);
            this._dismiss(card);
        });
        this._later(7000, () => this._dismiss(card));
    }

    _receiveDir() {
        return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ?? GLib.get_home_dir();
    }

    _dismiss(card) {
        if (!this._cards?.has(card))
            return;
        this._cards.delete(card);
        card.ease({opacity: 0, translation_y: -30, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => card.destroy()});
    }

    _later(ms, fn) {
        this._timers ??= new Set();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers?.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    _say(text) {
        const m = Main.layoutManager.primaryMonitor;
        this._toast?.destroy();
        const t = new St.Label({text, style_class: 'kuro-phone-toast', opacity: 0});
        this._toast = t;
        Main.layoutManager.uiGroup.add_child(t);
        const [, nw] = t.get_preferred_width(-1);
        t.set_position(Math.round(m.x + (m.width - nw) / 2), m.y + Math.round(m.height * 0.06));
        t.ease({opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._later(2600, () => t.ease({opacity: 0, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (this._toast === t)
                    this._toast = null;
                t.destroy();
            }}));
    }
}
