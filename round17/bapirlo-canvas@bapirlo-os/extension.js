// Kuro Infinite Desktop — hold Super and scroll down to zoom OUT of your screen (or Super+Z):
// every workspace becomes an island with its live windows, laid out on a map painted from Kuro World.
//   scroll ............ zoom (towards the pointer)        drag the map ....... fly around
//   click an island ... dive into it (that workspace)     click a window ..... dive in and focus it
//   Esc / Super+Z ..... back to where you were            scroll all the way in = dive into the island under the pointer
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const WORLD = GLib.build_filenamev([GLib.get_home_dir(), 'Pictures', 'wallpapers', 'bapirlo', 'kuro-world.png']);
const GAP = 0.32;                 // gap between islands, in monitor widths
const EASE = Clutter.AnimationMode.EASE_OUT_CUBIC;

function fileUri(path) {
    return Gio.File.new_for_path(path).get_uri();
}

class Canvas {
    constructor(ext) {
        this._ext = ext;
        this._mon = Main.layoutManager.primaryMonitor;
        const m = this._mon;
        this._root = new St.Widget({reactive: true, x: m.x, y: m.y, width: m.width, height: m.height,
            style_class: 'kuro-canvas', clip_to_allocation: true});
        Main.layoutManager.uiGroup.add_child(this._root);

        const n = global.workspace_manager.get_n_workspaces();
        this._active = global.workspace_manager.get_active_workspace_index();
        // islands along a gentle wave; world units = real pixels at zoom 1
        this._islands = [];
        const W = m.width, H = m.height;
        const cols = n <= 4 ? n : Math.ceil(n / 2);
        this._positions = [];
        for (let i = 0; i < n; i++) {
            const c = i % cols, r = Math.floor(i / cols);
            this._positions.push([c * W * (1 + GAP), r * H * (1 + GAP * 1.6) + Math.sin(c * 1.3) * H * 0.18]);
        }
        const minX = Math.min(...this._positions.map(p => p[0])) - W * 2.5;
        const minY = Math.min(...this._positions.map(p => p[1])) - H * 2.5;
        const maxX = Math.max(...this._positions.map(p => p[0])) + W * 3.5;
        const maxY = Math.max(...this._positions.map(p => p[1])) + H * 3.5;
        this._bounds = {minX, minY, maxX, maxY};

        this._world = new Clutter.Actor({reactive: false});
        this._root.add_child(this._world);

        // the map: Kuro World (or the wallpaper), big and dimmed
        const bgUri = GLib.file_test(WORLD, GLib.FileTest.EXISTS) ? fileUri(WORLD)
            : new Gio.Settings({schema_id: 'org.gnome.desktop.background'}).get_string('picture-uri-dark');
        const map = new St.Widget({x: minX, y: minY, width: maxX - minX, height: maxY - minY,
            style: `background-image: url("${bgUri}"); background-size: cover; background-position: center;`});
        this._world.add_child(map);
        this._world.add_child(new St.Widget({x: minX, y: minY, width: maxX - minX, height: maxY - minY,
            style: 'background-color: rgba(6, 4, 10, 0.55);'}));

        const wall = new Gio.Settings({schema_id: 'org.gnome.desktop.background'}).get_string('picture-uri-dark');
        for (let i = 0; i < n; i++)
            this._island(i, wall);

        // input
        this._root.connect('scroll-event', (_a, ev) => this._scroll(ev));
        this._root.connect('button-press-event', (_a, ev) => this._press(ev));
        this._root.connect('motion-event', (_a, ev) => this._motion(ev));
        this._root.connect('button-release-event', (_a, ev) => this._release(ev));
        this._root.connect('key-press-event', (_a, ev) => {
            const k = ev.get_key_symbol();
            if (k === Clutter.KEY_Escape || (k === Clutter.KEY_z && (ev.get_state() & Clutter.ModifierType.MOD4_MASK)))
                this.dive(this._active);
            return Clutter.EVENT_STOP;
        });

        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});
        this._root.grab_key_focus();

        // start exactly over the real screen, then pull back
        this._zFit = Math.min(m.width / (maxX - minX - W * 5), m.height / (maxY - minY - H * 5)) * 0.95;
        this._zoom = 1;
        const [ax, ay] = this._positions[this._active];
        this._tx = -ax;
        this._ty = -ay;
        this._apply(false);
        this._zoomTo(Math.max(this._zFit, 0.42), m.width / 2, m.height / 2, 420);
    }

    _island(i, wallUri) {
        const m = this._mon;
        const [x, y] = this._positions[i];
        const isl = new St.Widget({x, y, width: m.width, height: m.height, reactive: true,
            style_class: i === this._active ? 'kuro-island active' : 'kuro-island',
            style: `background-image: url("${wallUri}"); background-size: cover;`});
        isl.clip_to_allocation = true;
        this._world.add_child(isl);
        const ws = global.workspace_manager.get_workspace_by_index(i);
        const wins = global.display.sort_windows_by_stacking(ws.list_windows())
            .filter(w => !w.minimized && w.get_monitor() === Main.layoutManager.primaryIndex &&
                [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG].includes(w.window_type));
        for (const w of wins) {
            const actor = w.get_compositor_private();
            if (!actor)
                continue;
            const [wx, wy] = actor.get_position();
            const clone = new Clutter.Clone({source: actor, x: wx - m.x, y: wy - m.y, reactive: true});
            clone.connect('button-release-event', (_a, ev) => {
                if (this._dragged)
                    return Clutter.EVENT_PROPAGATE;
                this.dive(i, w);
                return Clutter.EVENT_STOP;
            });
            isl.add_child(clone);
        }
        const label = new St.Label({style_class: 'kuro-island-label',
            text: `${i + 1}${i === this._active ? ' · you are here' : ''}  ·  ${wins.length} window${wins.length === 1 ? '' : 's'}`});
        label.set_position(x, y + m.height + 28);
        label.set_scale(4, 4);
        this._world.add_child(label);
        isl.connect('button-release-event', () => {
            if (!this._dragged)
                this.dive(i);
            return Clutter.EVENT_STOP;
        });
        this._islands.push(isl);
    }

    // ---------- camera ----------
    _apply(animate, ms = 260) {
        const props = {scale_x: this._zoom, scale_y: this._zoom,
            translation_x: this._tx * this._zoom, translation_y: this._ty * this._zoom};
        this._world.remove_all_transitions();
        if (animate)
            this._world.ease({...props, duration: ms, mode: EASE});
        else
            Object.assign(this._world, props);
    }

    // keep the world point under (sx, sy) fixed while zooming
    _zoomTo(z, sx, sy, ms = 220) {
        const zMin = Math.min(this._zFit * 0.85, 0.3);
        z = Math.max(zMin, Math.min(1, z));
        const wx = sx / this._zoom - this._tx, wy = sy / this._zoom - this._ty;
        this._zoom = z;
        this._tx = sx / z - wx;
        this._ty = sy / z - wy;
        this._apply(true, ms);
    }

    _scroll(ev) {
        const [sx, sy] = ev.get_coords();
        const lx = sx - this._mon.x, ly = sy - this._mon.y;
        let dy = 0;
        const dir = ev.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP)
            dy = -1;
        else if (dir === Clutter.ScrollDirection.DOWN)
            dy = 1;
        else if (dir === Clutter.ScrollDirection.SMOOTH)
            dy = ev.get_scroll_delta()[1];
        if (!dy)
            return Clutter.EVENT_STOP;
        const z = this._zoom * Math.pow(0.86, dy);
        if (z >= 0.985 && dy < 0) {            // zoomed all the way in → dive into what's under the pointer
            const i = this._islandAt(lx, ly);
            this.dive(i ?? this._active);
            return Clutter.EVENT_STOP;
        }
        this._zoomTo(z, lx, ly);
        return Clutter.EVENT_STOP;
    }

    _islandAt(lx, ly) {
        const wx = lx / this._zoom - this._tx, wy = ly / this._zoom - this._ty;
        const m = this._mon;
        const i = this._positions.findIndex(([x, y]) => wx >= x && wx <= x + m.width && wy >= y && wy <= y + m.height);
        return i < 0 ? null : i;
    }

    _press(ev) {
        const [x, y] = ev.get_coords();
        this._pan = {x, y, tx: this._tx, ty: this._ty};
        this._dragged = false;
        return Clutter.EVENT_PROPAGATE;
    }

    _motion(ev) {
        if (!this._pan)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = ev.get_coords();
        if (Math.hypot(x - this._pan.x, y - this._pan.y) > 8)
            this._dragged = true;
        if (this._dragged) {
            this._tx = this._pan.tx + (x - this._pan.x) / this._zoom;
            this._ty = this._pan.ty + (y - this._pan.y) / this._zoom;
            this._apply(false);
        }
        return Clutter.EVENT_STOP;
    }

    _release() {
        this._pan = null;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._dragged = false;
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_PROPAGATE;
    }

    // fly into island i (and focus window w), then hand the real desktop back
    dive(i, w = null) {
        if (this._diving)
            return;
        this._diving = true;
        const [x, y] = this._positions[i];
        this._zoom = 1;
        this._tx = -x;
        this._ty = -y;
        this._apply(true, 380);
        const ws = global.workspace_manager.get_workspace_by_index(i);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 360, () => {
            const t = global.display.get_current_time_roundtrip();     // a real timestamp (0 gets ignored)
            if (w)
                Main.activateWindow(w, t, i);
            else if (i !== this._active)
                ws.activate(t);
            this._root.ease({opacity: 0, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => this._ext.close()});
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._root?.destroy();
        this._root = null;
    }
}

const IFACE = `<node><interface name="org.bapirlo.Canvas"><method name="Open"/></interface></node>`;

export default class KuroCanvasExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // bapirlo-whats-new and scripts can open it:  gdbus call --session -d org.bapirlo.Canvas -o /org/bapirlo/Canvas -m org.bapirlo.Canvas.Open
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, {Open: () => this.open()});
        this._dbus.export(Gio.DBus.session, '/org/bapirlo/Canvas');
        this._owner = Gio.bus_own_name(Gio.BusType.SESSION, 'org.bapirlo.Canvas', Gio.BusNameOwnerFlags.REPLACE,
            null, null, null);
        Main.wm.addKeybinding('canvas-toggle', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL, () => this.toggle());
        // Super + scroll down anywhere on the desktop
        this._captured = global.stage.connect('captured-event', (_s, ev) => {
            if (this._canvas || ev.type() !== Clutter.EventType.SCROLL || Main.overview.visible ||
                !(ev.get_state() & Clutter.ModifierType.MOD4_MASK))
                return Clutter.EVENT_PROPAGATE;
            const dir = ev.get_scroll_direction();
            const down = dir === Clutter.ScrollDirection.DOWN ||
                (dir === Clutter.ScrollDirection.SMOOTH && ev.get_scroll_delta()[1] > 0.3);
            if (!down)
                return Clutter.EVENT_PROPAGATE;
            this.open();
            return Clutter.EVENT_STOP;
        });
    }

    disable() {
        if (this._owner)
            Gio.bus_unown_name(this._owner);
        this._owner = 0;
        this._dbus?.unexport();
        this._dbus = null;
        Main.wm.removeKeybinding('canvas-toggle');
        if (this._captured)
            global.stage.disconnect(this._captured);
        this._captured = 0;
        this.close();
        for (const id of [this._unmuteId, this._waitId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._unmuteId = this._waitId = 0;
        if (this._muted)
            GObject.signal_handlers_unblock_matched(global.display, {signalId: 'overlay-key'});
        this._muted = false;
        this._settings = null;
    }

    // letting go of Super after Super+scroll would open the overview / ArcMenu on top of us:
    // mute the overlay key while the canvas is up, and until Super is released afterwards
    _muteSuper(on) {
        if (on && !this._muted) {
            GObject.signal_handlers_block_matched(global.display, {signalId: 'overlay-key'});
            this._muted = true;
        } else if (!on && this._muted) {
            const release = () => {
                const [, , mods] = global.get_pointer();
                if (mods & Clutter.ModifierType.MOD4_MASK)
                    return GLib.SOURCE_CONTINUE;          // still holding Super
                this._unmuteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    GObject.signal_handlers_unblock_matched(global.display, {signalId: 'overlay-key'});
                    this._muted = false;
                    this._unmuteId = 0;
                    return GLib.SOURCE_REMOVE;
                });
                this._waitId = 0;
                return GLib.SOURCE_REMOVE;
            };
            this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, release);
        }
    }

    open() {
        if (this._canvas || Main.overview.visible)
            return;
        if (this._unmuteId || this._waitId) {                 // reopened before the unmute ran
            GLib.source_remove(this._unmuteId || this._waitId);
            this._unmuteId = this._waitId = 0;
        }
        this._muteSuper(true);
        try {
            this._canvas = new Canvas(this);
        } catch (e) {
            console.error(`Kuro canvas: ${e.stack ?? e}`);
            this.close();
        }
    }

    close() {
        const was = !!this._canvas;
        this._canvas?.destroy();
        this._canvas = null;
        if (was)
            this._muteSuper(false);
    }

    toggle() {
        if (this._canvas)
            this._canvas.dive(global.workspace_manager.get_active_workspace_index());
        else
            this.open();
    }
}
