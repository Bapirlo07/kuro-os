// Kuro Shoulder-surf guard — the shell half. The camera daemon calls Guard(true) when a second face is
// behind you: every monitor gets a blurred, tinted cover above everything and notification banners are held.
// Guard(false) (no second face for 1.5 s) takes it away. Click the cover = "it's fine" → snoozed 2 min.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class GuardCover {
    constructor() {
        this._covers = [];
        this._snoozeUntil = 0;
        this._shown = false;
    }

    set(on) {
        if (on && GLib.get_monotonic_time() < this._snoozeUntil)
            return;
        if (on === this._shown)
            return;
        this._shown = on;
        on ? this._show() : this._hide();
    }

    snooze(seconds) {
        this._snoozeUntil = GLib.get_monotonic_time() + seconds * 1e6;
        this.set(false);
    }

    _show() {
        for (const m of Main.layoutManager.monitors) {
            const cover = new St.Widget({reactive: true, x: m.x, y: m.y, width: m.width, height: m.height,
                style: 'background-color: rgba(14,10,13,0.55);', opacity: 0, layout_manager: new Clutter.BinLayout()});
            const fx = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, brightness: 0.6});
            if ('radius' in fx) fx.radius = 80; else fx.sigma = 40;
            cover.add_effect(fx);
            cover.add_child(new St.Label({text: '👀  Someone is looking — screen hidden\nClick if it\'s fine (2 min)',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 20px; color: #F2E9EC; text-align: center;'}));
            cover.connect('button-press-event', () => {
                this.snooze(120);
                return Clutter.EVENT_STOP;
            });
            Main.layoutManager.uiGroup.add_child(cover);     // last child = above panels and banners
            cover.ease({opacity: 255, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._covers.push(cover);
        }
        Main.messageTray.bannerBlocked = true;
    }

    _hide() {
        Main.messageTray.bannerBlocked = false;
        for (const c of this._covers)
            c.ease({opacity: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => c.destroy()});
        this._covers = [];
    }

    destroy() {
        if (this._shown)
            this._hide();
        this._shown = false;
    }
}
