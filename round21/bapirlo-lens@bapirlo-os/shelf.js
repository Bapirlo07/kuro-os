// Kuro Window shelf — fling a window hard into the LEFT or RIGHT screen edge (mouse throw or air-gesture
// pinch-throw; Kuro Physics calls globalThis.kuroShelf.park) and it parks there: minimised, with a live
// thumbnail peeking out of that edge. Hover = slides out, click = window comes back where it was,
// middle-click = close it. Up to 5 per side; the shelf empties itself when windows close or come back.
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const W = 200;          // thumbnail width
const PEEK = 46;        // px showing while not hovered
const MAX = 5;

export class Shelf {
    constructor() {
        this._items = [];   // {win, side, card, home}
        globalThis.kuroShelf = {park: (win, side, home) => this.park(win, side, home), _owner: this};
        this._wsId = global.workspace_manager.connect('active-workspace-changed', () => this._layout());
        this._inOverview = Main.overview.visible;
        this._ovIds = [Main.overview.connect('showing', () => this._setVisible(false)),
            Main.overview.connect('hidden', () => this._setVisible(true))];
    }

    park(win, side, home = null) {
        if (!win || win.window_type !== Meta.WindowType.NORMAL || !win.can_minimize())
            return false;
        const sameSide = this._items.filter(i => i.side === side);
        if (sameSide.length >= MAX)
            this._restore(sameSide[0], false);
        const actor = win.get_compositor_private();
        if (!actor)
            return false;
        const r = win.get_frame_rect();
        const scale = W / Math.max(1, r.width);
        const h = Math.max(60, Math.round(r.height * scale));

        const card = new St.Button({style_class: 'kuro-shelf-card', reactive: true, track_hover: true,
            button_mask: (St.ButtonMask.PRIMARY ?? St.ButtonMask.ONE) | (St.ButtonMask.MIDDLE ?? St.ButtonMask.TWO)});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        box.set_orientation?.(Clutter.Orientation.VERTICAL);
        // the clone shows the frame (not the shadow): offset by the buffer→frame difference
        const buf = win.get_buffer_rect();
        const holder = new St.Widget({width: W, height: h, clip_to_allocation: true, style: 'border-radius: 10px;'});
        const clone = new Clutter.Clone({source: actor, x: (buf.x - r.x) * scale, y: (buf.y - r.y) * scale,
            scale_x: scale, scale_y: scale});
        holder.add_child(clone);
        box.add_child(holder);
        box.add_child(new St.Label({style_class: 'kuro-shelf-title', text: win.get_title() ?? ''}));
        card.set_child(box);
        Main.layoutManager.addTopChrome(card);

        const item = {win, side, card, home: home ?? {x: r.x, y: r.y}, monitor: win.get_monitor(), ws: win.get_workspace()};
        card.connect('clicked', (_b, button) => button === 2 ? this._close(item) : this._restore(item, true));
        card.connect('notify::hover', () => this._slide(item));
        win.connectObject('unmanaged', () => this._remove(item),
            'notify::minimized', () => !win.minimized && this._remove(item), this);
        this._items.push(item);
        win.minimize();
        this._layout(item);
        return true;
    }

    _x(item, out) {
        const m = Main.layoutManager.monitors[item.monitor] ?? Main.layoutManager.primaryMonitor;
        const w = item.card.width || W + 14;
        return item.side === 'left' ? m.x - w + (out ? w - 8 : PEEK) : m.x + m.width - (out ? w - 8 : PEEK);
    }

    _layout(fresh = null) {
        const ws = global.workspace_manager.get_active_workspace();
        for (const side of ['left', 'right']) {
            const list = this._items.filter(i => i.side === side);
            const byMon = new Map();
            for (const i of list) {
                if (!byMon.has(i.monitor))
                    byMon.set(i.monitor, []);
                byMon.get(i.monitor).push(i);
            }
            for (const [mi, items] of byMon) {
                const m = Main.layoutManager.monitors[mi] ?? Main.layoutManager.primaryMonitor;
                const gap = 14;
                const total = items.reduce((s, i) => s + i.card.get_preferred_height(-1)[1] + gap, -gap);
                let y = m.y + Math.max(40, Math.round((m.height - total) / 2));
                for (const i of items) {
                    const visible = !i.ws || i.win.is_on_all_workspaces() || i.ws === ws;
                    i.card.visible = visible && !this._inOverview;
                    const x = this._x(i, i.card.hover);
                    if (i === fresh) {         // fly in from the edge
                        i.card.set_position(i.side === 'left' ? m.x - W - 40 : m.x + m.width + 40, y);
                    }
                    i.card.ease({x, y, duration: 280, mode: Clutter.AnimationMode.EASE_OUT_BACK});
                    y += i.card.get_preferred_height(-1)[1] + gap;
                }
            }
        }
    }

    _slide(item) {
        item.card.ease({x: this._x(item, item.card.hover), duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _setVisible(on) {
        this._inOverview = !on;
        if (on)
            this._layout();
        else
            this._items.forEach(i => (i.card.visible = false));
    }

    _restore(item, focus) {
        const {win, home} = item;
        this._remove(item);
        if (win.minimized)
            win.unminimize();
        win.move_frame(true, home.x, home.y);
        if (focus)
            Main.activateWindow(win);
    }

    _close(item) {
        const win = item.win;
        this._remove(item);
        win.delete(global.get_current_time());
    }

    _remove(item) {
        const i = this._items.indexOf(item);
        if (i < 0)
            return;
        this._items.splice(i, 1);
        item.win.disconnectObject(this);
        const card = item.card;
        Main.layoutManager.removeChrome(card);
        card.destroy();
        this._layout();
    }

    get items() {
        return this._items;
    }

    destroy() {
        if (globalThis.kuroShelf?._owner === this)
            delete globalThis.kuroShelf;
        global.workspace_manager.disconnect(this._wsId);
        this._ovIds.forEach(id => Main.overview.disconnect(id));
        // the shell disables extensions while the screen is locked, so just drop the cards: the windows stay
        // minimised (dock / Alt+Tab bring them back) instead of all popping up after every unlock
        for (const item of [...this._items])
            this._remove(item);
    }
}
