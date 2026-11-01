// Kuro Screen watch — Super+Shift+W, then drag a box around any part of the screen: Kuro keeps an eye on it
// and tells you when it changes (a build finishing, a reply arriving, a price dropping, a download bar
// filling up). A thin outline marks the area; its little tag shows how long it's been watching and has an
// ✕ to stop. Checked every 3 s by comparing a small picture of the area; tiny changes (a blinking cursor)
// are ignored. Several areas can be watched at once. Nothing leaves the computer.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const EVERY_S = 3;
const SAMPLE = 48;           // compare at 48 px wide
const CHANGED = 0.012;       // fraction of sample pixels that must differ

function capture(x, y, w, h) {
    return new Promise(resolve => {
        const shot = new Shell.Screenshot();
        const stream = Gio.MemoryOutputStream.new_resizable();
        shot.screenshot_area(x, y, w, h, stream, (o, res) => {
            try {
                o.screenshot_area_finish(res);
                stream.close(null);
                const bytes = stream.steal_as_bytes();
                const pb = GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(bytes), null);
                const sh = Math.max(1, Math.round(SAMPLE * h / w));
                const small = pb.scale_simple(SAMPLE, sh, GdkPixbuf.InterpType.BILINEAR);
                resolve({px: small.get_pixels(), n: small.get_n_channels(), stride: small.get_rowstride(), w: SAMPLE, h: sh, png: bytes});
            } catch (e) {
                console.warn(`Kuro watch: capture: ${e.message}`);
                resolve(null);
            }
        });
    });
}

function differs(a, b) {
    if (!a || !b || a.w !== b.w || a.h !== b.h)
        return true;
    let diff = 0;
    for (let y = 0; y < a.h; y++) {
        for (let x = 0; x < a.w; x++) {
            const i = y * a.stride + x * a.n;
            const d = Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) + Math.abs(a.px[i + 2] - b.px[i + 2]);
            if (d > 60)
                diff++;
        }
    }
    return diff / (a.w * a.h) > CHANGED;
}

export class Watch {
    constructor() {
        this._watches = [];
    }

    // rubber-band selection
    pick() {
        if (this._sel || Main.sessionMode.isLocked)
            return;
        Main.overview.hide();
        const [W, H] = [global.stage.width, global.stage.height];
        const root = new St.Widget({reactive: true, width: W, height: H, style_class: 'kuro-watch-veil'});
        const box = new St.Widget({style_class: 'kuro-watch-box', visible: false});
        const hint = new St.Label({style_class: 'kuro-watch-hint', text: 'Drag a box around what to watch · Esc cancels'});
        root.add_child(box);
        root.add_child(hint);
        const pm = Main.layoutManager.primaryMonitor;
        hint.connect('notify::allocation', () => hint.set_position(Math.round(pm.x + pm.width / 2 - hint.width / 2), pm.y + 70));
        Main.layoutManager.addTopChrome(root);
        this._sel = root;
        this._selGrab = Main.pushModal(root, {actionMode: Shell.ActionMode.SYSTEM_MODAL});
        root.grab_key_focus();
        root.set_cursor_type?.(Clutter.CursorType.CROSSHAIR);
        let start = null;
        root.connect('button-press-event', (_a, ev) => {
            start = ev.get_coords();
            box.visible = true;
            box.set_position(...start);
            box.set_size(1, 1);
            return Clutter.EVENT_STOP;
        });
        root.connect('motion-event', (_a, ev) => {
            if (!start)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = ev.get_coords();
            box.set_position(Math.min(x, start[0]), Math.min(y, start[1]));
            box.set_size(Math.abs(x - start[0]), Math.abs(y - start[1]));
            return Clutter.EVENT_STOP;
        });
        root.connect('button-release-event', () => {
            if (!start)
                return Clutter.EVENT_STOP;
            const r = [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)];
            this._endPick();
            if (r[2] >= 16 && r[3] >= 12)
                this.add(...r);
            return Clutter.EVENT_STOP;
        });
        root.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() === Clutter.KEY_Escape)
                this._endPick();
            return Clutter.EVENT_STOP;
        });
    }

    _endPick() {
        if (!this._sel)
            return;
        if (this._selGrab)
            Main.popModal(this._selGrab);
        this._selGrab = null;
        Main.layoutManager.removeChrome(this._sel);
        this._sel.destroy();
        this._sel = null;
    }

    async add(x, y, w, h) {
        const frame = new St.Widget({style_class: 'kuro-watch-frame', x: x - 2, y: y - 2, width: w + 4, height: h + 4, reactive: false});
        const tag = new St.BoxLayout({style_class: 'kuro-watch-tag', reactive: true});
        const label = new St.Label({text: '👁  watching', y_align: Clutter.ActorAlign.CENTER});
        const close = new St.Button({style_class: 'kuro-watch-close', label: '✕', can_focus: true});
        tag.add_child(label);
        tag.add_child(close);
        Main.layoutManager.addTopChrome(frame);
        Main.layoutManager.addTopChrome(tag);
        tag.set_position(x, Math.max(0, y - 30));
        const wch = {x, y, w, h, frame, tag, label, t0: GLib.get_monotonic_time(), base: null, hits: 0};
        close.connect('clicked', () => this.remove(wch));
        this._watches.push(wch);
        // hide our own outline while we take the picture
        wch.base = await this._snap(wch);
        wch.timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, EVERY_S, () => {
            this._tick(wch);
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _snap(wch) {
        wch.frame.hide();
        wch.tag.hide();
        const s = await capture(wch.x, wch.y, wch.w, wch.h);
        if (this._watches.includes(wch)) {
            wch.frame.show();
            wch.tag.show();
        }
        return s;
    }

    async _tick(wch) {
        if (wch.busy || Main.sessionMode.isLocked || !this._watches.includes(wch))
            return;
        wch.busy = true;
        const mins = Math.floor((GLib.get_monotonic_time() - wch.t0) / 6e7);
        wch.label.text = `👁  watching${mins ? ` · ${mins} min` : ''}`;
        const now = await this._snap(wch);
        wch.busy = false;
        if (!now || !this._watches.includes(wch))
            return;
        if (differs(wch.base, now)) {
            // needs two looks in a row so a passing tooltip doesn't count
            wch.hits++;
            if (wch.hits >= 2) {
                wch.base = now;
                wch.hits = 0;
                this._changed(wch, now.png);
            }
        } else {
            wch.hits = 0;
        }
    }

    _changed(wch, png) {
        wch.frame.add_style_class_name('changed');
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
            wch.frame?.remove_style_class_name?.('changed');
            return GLib.SOURCE_REMOVE;
        });
        let gicon = Gio.ThemedIcon.new('find-location-symbolic');
        try {
            gicon = Gio.BytesIcon.new(png);
        } catch {}
        const source = MessageTray.getSystemSource();
        const n = new MessageTray.Notification({source, title: 'The area you\'re watching changed',
            body: 'Kuro is still watching it — click ✕ on its tag to stop.', gicon,
            urgency: MessageTray.Urgency.HIGH});
        n.addAction('Stop watching', () => this.remove(wch));
        source.addNotification(n);
    }

    remove(wch) {
        const i = this._watches.indexOf(wch);
        if (i < 0)
            return;
        this._watches.splice(i, 1);
        if (wch.timer)
            GLib.source_remove(wch.timer);
        for (const a of [wch.frame, wch.tag]) {
            Main.layoutManager.removeChrome(a);
            a.destroy();
        }
        wch.frame = wch.tag = null;
    }

    get count() {
        return this._watches.length;
    }

    destroy() {
        this._endPick();
        for (const w of [...this._watches])
            this.remove(w);
    }
}
