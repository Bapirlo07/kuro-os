// Kuro Command palette — Super+Shift+P: one box that runs anything by name.
//   · the focused app's own actions — its launcher actions ("New Private Window") and, for GTK apps, every
//     action it publishes ("New tab", "Find", "Export as PDF"…; read live over D-Bus)
//   · Kuro's commands (the same list as Kuro Search) and quick system toggles (dark mode, night light…)
//   · every Settings page ("Wi-Fi", "Displays", "Sound"…)
//   · your open windows ("Go to …")
// Type a few letters (fuzzy: "nwpr" finds "New Private Window"), ↑/↓ to choose, Enter runs, Esc closes.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MAX = 9;
const PANELS = [
    ['wifi', 'Wi-Fi'], ['network', 'Network'], ['bluetooth', 'Bluetooth'], ['display', 'Displays'],
    ['sound', 'Sound'], ['power', 'Power'], ['keyboard', 'Keyboard & shortcuts'], ['mouse', 'Mouse & touchpad'],
    ['printers', 'Printers'], ['privacy', 'Privacy & security'], ['background', 'Appearance'],
    ['notifications', 'Notifications'], ['applications', 'Apps & permissions'], ['online-accounts', 'Online accounts'],
    ['users', 'Users'], ['system', 'System (date, language, about)'], ['multitasking', 'Multitasking'],
    ['accessibility', 'Accessibility'], ['wellbeing', 'Wellbeing'], ['search', 'Search'],
];
const SKIP_ACTION = /^(_|.*debug|.*inspector|.*-internal)/;

// fuzzy score: every query char must appear in order; consecutive & word-start matches score higher
function score(query, text) {
    const q = query.toLowerCase(), t = text.toLowerCase();
    if (!q)
        return 1;
    const idx = t.indexOf(q);
    if (idx >= 0)
        return 1000 - idx * 3 - t.length * 0.1 + (idx === 0 || t[idx - 1] === ' ' ? 200 : 0);
    let s = 0, ti = 0, run = 0;
    for (const ch of q) {
        const f = t.indexOf(ch, ti);
        if (f < 0)
            return -1;
        run = f === ti ? run + 1 : 0;
        s += 10 + run * 6 + (f === 0 || t[f - 1] === ' ' || t[f - 1] === '-' ? 15 : 0) - Math.min(8, f - ti);
        ti = f + 1;
    }
    return s - t.length * 0.1;
}

const human = name => name.replace(/^(app|win)\./, '').replace(/[-_.]+/g, ' ').replace(/^\w/, c => c.toUpperCase());

function dbusCall(bus, path, iface, method, params, type) {
    return new Promise(resolve => {
        Gio.DBus.session.call(bus, path, iface, method, params, type ? new GLib.VariantType(type) : null,
            Gio.DBusCallFlags.NONE, 800, null, (c, res) => {
                try {
                    resolve(c.call_finish(res));
                } catch {
                    resolve(null);
                }
            });
    });
}

export class Palette {
    get open() {
        return !!this._root;
    }

    toggle() {
        if (this._root)
            this.close();
        else
            this.show();
    }

    async _gtkActions(win) {
        const bus = win?.get_gtk_unique_bus_name?.();
        if (!bus)
            return [];
        const out = [];
        for (const [path, prefix] of [[win.get_gtk_window_object_path?.(), 'win'], [win.get_gtk_application_object_path?.(), 'app']]) {
            if (!path)
                continue;
            const r = await dbusCall(bus, path, 'org.gtk.Actions', 'DescribeAll', null, '(a{s(bgav)})');
            if (!r)
                continue;
            const all = r.deepUnpack()[0];
            for (const [name, desc] of Object.entries(all)) {
                const [enabled, ptype] = [desc[0], desc[1]];
                if (!enabled || ptype !== '' || SKIP_ACTION.test(name))
                    continue;
                out.push({
                    title: human(name), sub: `${prefix === 'win' ? 'This window' : 'This app'} · ${prefix}.${name}`,
                    icon: 'system-run-symbolic', group: 1,
                    run: () => dbusCall(bus, path, 'org.gtk.Actions', 'Activate',
                        new GLib.Variant('(sava{sv})', [name, [], {}]), null),
                });
            }
        }
        return out;
    }

    _collect(win) {
        const items = [];
        const tracker = Shell.WindowTracker.get_default();
        const app = win ? tracker.get_window_app(win) : null;
        // launcher actions of the focused app
        const info = app?.get_app_info();
        for (const a of info?.list_actions?.() ?? []) {
            items.push({title: info.get_action_name(a), sub: `${app.get_name()} · launcher action`, gicon: app.get_icon(), group: 1,
                run: () => info.launch_action(a, global.create_app_launch_context(0, -1))});
        }
        if (app)
            items.push({title: `New ${app.get_name()} window`, sub: app.get_name(), gicon: app.get_icon(), group: 1,
                run: () => app.open_new_window(-1)});
        // Kuro commands
        const kc = globalThis.kuroCommands;
        for (const c of kc?.list ?? []) {
            const title = typeof c.name === 'function' ? c.name() : c.name;
            items.push({title, sub: `Kuro · ${c.words}`, icon: c.icon, group: 2, run: () => kc.run(c)});
        }
        // quick toggles
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const dark = iface.get_string('color-scheme') === 'prefer-dark';
        items.push({title: `Switch to ${dark ? 'light' : 'dark'} mode`, sub: `Appearance · dark / light (now ${dark ? 'dark' : 'light'})`, icon: 'weather-clear-night-symbolic', group: 2,
            run: () => iface.set_string('color-scheme', dark ? 'default' : 'prefer-dark')});
        const color = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        const nl = color.get_boolean('night-light-enabled');
        items.push({title: `Night light ${nl ? 'off' : 'on'}`, sub: 'Displays', icon: 'night-light-symbolic', group: 2,
            run: () => color.set_boolean('night-light-enabled', !nl)});
        // settings pages
        for (const [panel, name] of PANELS)
            items.push({title: name, sub: 'Settings', icon: 'preferences-system-symbolic', group: 3,
                run: () => Gio.Subprocess.new(['gnome-control-center', panel], Gio.SubprocessFlags.NONE)});
        // windows
        const ws = global.workspace_manager.get_active_workspace();
        for (const w of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)) {
            if (w === win)
                continue;
            const a = tracker.get_window_app(w);
            items.push({title: `Go to ${w.get_title() ?? a?.get_name() ?? 'window'}`,
                sub: `${a?.get_name() ?? ''}${w.get_workspace() !== ws ? ' · other workspace' : ''}`, gicon: a?.get_icon(), group: 4,
                run: () => Main.activateWindow(w)});
        }
        return items;
    }

    show() {
        if (this._root || Main.sessionMode.isLocked)
            return;
        const win = global.display.focus_window;
        Main.overview.hide();
        this._items = this._collect(win);
        this._win = win;
        const pm = Main.layoutManager.primaryMonitor;
        this._root = new St.Widget({reactive: true, x: pm.x, y: pm.y, width: pm.width, height: pm.height});
        const box = new St.BoxLayout({style_class: 'kuro-palette', orientation: Clutter.Orientation.VERTICAL});
        box.set_width(Math.min(720, pm.width - 80));
        this._entry = new St.Entry({style_class: 'kuro-palette-entry', can_focus: true,
            hint_text: win ? `Run anything… (actions of ${Shell.WindowTracker.get_default().get_window_app(win)?.get_name() ?? 'this window'} first)` : 'Run anything…'});
        box.add_child(this._entry);
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'kuro-palette-list'});
        box.add_child(this._list);
        this._root.add_child(box);
        box.connect('notify::allocation', () => box.set_position(Math.round((pm.width - box.width) / 2), Math.round(pm.height * 0.16)));
        Main.layoutManager.addTopChrome(this._root);
        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.SYSTEM_MODAL});
        this._entry.grab_key_focus();
        this._sel = 0;
        this._entry.clutter_text.connect('text-changed', () => {
            this._sel = 0;
            this._render();
        });
        this._entry.clutter_text.connect('key-press-event', (_a, ev) => this._key(ev));
        this._root.connect('button-press-event', (_a, ev) => {
            const [x, y] = ev.get_coords();
            const [bx, by] = box.get_transformed_position();
            if (x < bx || y < by || x > bx + box.width || y > by + box.height)
                this.close();
            return Clutter.EVENT_PROPAGATE;
        });
        this._render();
        // GTK actions arrive a moment later (D-Bus)
        this._gtkActions(win).then(more => {
            if (!this._root || this._win !== win)
                return;
            this._items.push(...more);
            this._render();
        });
    }

    _matches() {
        const q = this._entry.get_text().trim();
        const scored = [];
        for (const it of this._items) {
            const s = q ? Math.max(score(q, it.title), score(q, `${it.title} ${it.sub}`) - 40) : 10 - it.group;
            if (s > 0)
                scored.push([s - it.group * (q ? 2 : 0), it]);
        }
        scored.sort((a, b) => b[0] - a[0]);
        return scored.slice(0, MAX).map(x => x[1]);
    }

    _render() {
        if (!this._root)
            return;
        this._list.destroy_all_children();
        this._shown = this._matches();
        if (!this._shown.length)
            this._list.add_child(new St.Label({style_class: 'kuro-palette-empty', text: 'Nothing by that name'}));
        this._shown.forEach((it, i) => {
            const row = new St.Button({style_class: `kuro-palette-row${i === this._sel ? ' selected' : ''}`, x_expand: true,
                can_focus: false});
            const hb = new St.BoxLayout({x_expand: true});
            hb.add_child(it.gicon ? new St.Icon({gicon: it.gicon, icon_size: 22, style_class: 'kuro-palette-icon'})
                : new St.Icon({icon_name: it.icon ?? 'system-run-symbolic', icon_size: 18, style_class: 'kuro-palette-icon'}));
            const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            col.add_child(new St.Label({style_class: 'kuro-palette-title', text: it.title}));
            col.add_child(new St.Label({style_class: 'kuro-palette-sub', text: it.sub ?? ''}));
            hb.add_child(col);
            if (i < 9)
                hb.add_child(new St.Label({style_class: 'kuro-palette-num', text: i === this._sel ? '↵' : `Alt+${i + 1}`,
                    y_align: Clutter.ActorAlign.CENTER}));
            row.set_child(hb);
            row.connect('clicked', () => this._run(it));
            this._list.add_child(row);
        });
    }

    _key(ev) {
        const sym = ev.get_key_symbol();
        const alt = ev.get_state() & Clutter.ModifierType.MOD1_MASK;
        if (sym === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Up || sym === Clutter.KEY_Tab) {
            const n = this._shown?.length ?? 0;
            if (n)
                this._sel = (this._sel + (sym === Clutter.KEY_Up ? n - 1 : 1)) % n;
            this._render();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            const it = this._shown?.[this._sel];
            if (it)
                this._run(it);
            return Clutter.EVENT_STOP;
        }
        if (alt && sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
            const it = this._shown?.[sym - Clutter.KEY_1];
            if (it)
                this._run(it);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _run(it) {
        const win = this._win;
        this.close();
        // give focus back to the window first, so its own actions act on it
        if (win && !win.minimized)
            Main.activateWindow(win);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            try {
                it.run();
            } catch (e) {
                Main.notifyError('Command palette', `${it.title}: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    close() {
        if (!this._root)
            return;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        Main.layoutManager.removeChrome(this._root);
        this._root.destroy();
        this._root = null;
        this._win = null;
    }

    destroy() {
        this.close();
    }
}
