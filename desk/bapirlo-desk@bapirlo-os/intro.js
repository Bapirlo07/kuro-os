// Kuro Desk — the login intro (setting "login-intro").
// The session comes up behind black; GNOME's own startup animation runs unseen. Then, ~2.6 s:
//   greeting + date in the middle · the wallpaper (or live video) fades up from black while settling
//   from a slight zoom · the top bar slides down · the dock rises · the desk widgets cascade in.
// Only when the extension starts WITH the session (not on re-enable), never over the lock screen.
// os.bapirlo.Desk.Intro() replays it any time (fades to black first). Anything that interrupts it
// (disable, a second play) puts every actor back where it was; the black cover also has a hard
// time-out, so it can never stay up.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {greeting} from './briefing.js';

const COVER_TIMEOUT_S = 15;
const EASE = {
    fade: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
    settle: Clutter.AnimationMode.EASE_OUT_CUBIC,
    slide: Clutter.AnimationMode.EASE_OUT_EXPO,
    pop: Clutter.AnimationMode.EASE_OUT_BACK,
};

export class LoginIntro {
    constructor(widgets) {
        this._widgets = widgets;           // () => the DeskWidgets part, or undefined
        this._timers = new Set();
        this._moved = [];                  // [actor, {prop: rest value}] to put back
    }

    // at enable() while the shell is still starting: black over everything until startup-complete
    cover() {
        this._makeCover(255);
        Main.layoutManager.uiGroup.add_child(this._cover);
        this._after(COVER_TIMEOUT_S * 1000, () => this._finish());
    }

    // startup-complete (or a replay): run the sequence
    play({replay = false} = {}) {
        if (replay) {
            this._finish();
            this._makeCover(0);
            Main.layoutManager.uiGroup.add_child(this._cover);
            this._cover.ease({opacity: 255, duration: 350, mode: EASE.fade, onStopped: () => this._run()});
        } else if (this._cover && !Main.sessionMode.isLocked) {
            this._run();
        } else {
            this._finish();
        }
    }

    destroy() {
        this._finish();
    }

    _makeCover(opacity) {
        this._cover?.destroy();
        this._cover = new St.Widget({style_class: 'bapirlo-intro-cover', reactive: false, opacity});
        this._cover.add_constraint(new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.ALL}));
    }

    _after(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    // remember the resting value, jump to the start value; the ease brings it back
    _from(actor, start) {
        const rest = {};
        for (const k of Object.keys(start))
            rest[k] = actor[k];
        const entry = [actor, rest];
        this._moved.push(entry);
        // Hanabi can swap the wallpaper actor out mid-intro; forget it so _finish never touches a dead actor
        actor.connectObject('destroy', () => {
            this._moved = this._moved.filter(e => e !== entry);
        }, this);
        actor.remove_all_transitions();
        Object.assign(actor, start);
        return rest;
    }

    _dock() {
        return Main.layoutManager.uiGroup.get_children().filter(a => a.name === 'dashtodockContainer' && a.visible);
    }

    _cards() {
        const w = this._widgets();
        if (!w?.actor?.visible || w.editing)
            return [];
        return Object.values(w._cards ?? {}).filter(c => c.visible && c.mapped !== false)
            .sort((a, b) => (a.x + a.y * 0.5) - (b.x + b.y * 0.5));
    }

    _run() {
        const lm = Main.layoutManager;
        // the wallpaper, widgets and cover sit below the windows from here on (windows that open
        // during the intro aren't hidden)
        lm.uiGroup.set_child_above_sibling(this._cover, lm._backgroundGroup);

        // set every start position first, all under the black
        const panel = lm.panelBox;
        const panelRest = this._from(panel, {translation_y: -(panel.height + 24)});
        const docks = this._dock().map(d => [d, this._from(d, {translation_y: d.height + 48})]);
        const cards = this._cards().map(c => {
            c.set_pivot_point(0.5, 0.5);
            return [c, this._from(c, {opacity: 0, translation_y: 36, scale_x: 0.9, scale_y: 0.9})];
        });
        const bgs = (lm._bgManagers ?? []).map(m => m.backgroundActor).filter(Boolean).map(a => {
            a.set_pivot_point(0.5, 0.5);
            return [a, this._from(a, {scale_x: 1.08, scale_y: 1.08})];
        });

        const hello = this._hello();
        lm.uiGroup.add_child(hello);
        hello.set_pivot_point(0.5, 0.5);
        Object.assign(hello, {opacity: 0, scale_x: 0.94, scale_y: 0.94});
        hello.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 700, mode: EASE.settle});
        this._after(1300, () => hello.ease({opacity: 0, translation_y: -24, duration: 500, mode: EASE.fade}));

        this._after(350, () => {
            this._cover.ease({opacity: 0, duration: 1100, mode: EASE.fade});
            for (const [a, rest] of bgs)
                a.ease({...rest, duration: 2200, mode: EASE.settle});
        });
        this._after(1050, () => panel.ease({...panelRest, duration: 650, mode: EASE.slide}));
        this._after(1200, () => {
            for (const [d, rest] of docks)
                d.ease({...rest, duration: 700, mode: EASE.pop});
        });
        cards.forEach(([c, rest], i) =>
            this._after(1350 + i * 90, () => c.ease({...rest, duration: 550, mode: EASE.pop})));
        this._after(2700 + cards.length * 90, () => this._finish());
    }

    _hello() {
        const now = GLib.DateTime.new_now_local();
        const name = (GLib.get_real_name() || GLib.get_user_name()).split(' ')[0];
        const box = new St.BoxLayout({style_class: 'bapirlo-intro-hello', orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Label({text: `${greeting(now.get_hour())}, ${name}`, style_class: 'bapirlo-intro-title',
            x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({text: now.format('%A %-d %B'), style_class: 'bapirlo-intro-date',
            x_align: Clutter.ActorAlign.CENTER}));
        const m = Main.layoutManager.primaryMonitor;
        const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), reactive: false,
            x: m.x, y: m.y, width: m.width, height: m.height});
        holder.add_child(box);
        this._helloActor = holder;
        return holder;
    }

    // put everything back exactly; safe to call any number of times
    _finish() {
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        for (const [actor, rest] of this._moved) {
            try {
                actor.remove_all_transitions();
                Object.assign(actor, rest);
            } catch {}                          // e.g. a wallpaper actor swapped out meanwhile
        }
        for (const [actor] of this._moved)
            actor.disconnectObject(this);
        this._moved = [];
        this._helloActor?.destroy();
        this._helloActor = null;
        this._cover?.destroy();
        this._cover = null;
    }
}
