// Kuro X-ray peek — hold Super+Alt+X: a round lens follows the pointer and shows what is BEHIND the window
// under it (the next windows down, then the desktop). Let go of Super to close it.
// How: the lens holds Clutter.Clones of the wallpaper and of every window below the top one, shifted so they
// line up with the real ones, and a tiny shader cuts the lens into a soft circle. Nothing is moved or hidden.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// soft round mask. GNOME 51 dropped Shell.GLSLEffect → Clutter.ShaderEffect + a static Cogl snippet there.
const MASK = `
    float r = length(cogl_tex_coord_in[0].xy - vec2(0.5));
    cogl_color_out *= 1.0 - smoothstep(0.485, 0.5, r);`;
const CircleMask = Shell.GLSLEffect
    ? GObject.registerClass(class KuroCircleMask extends Shell.GLSLEffect {
        vfunc_build_pipeline() {
            this.add_glsl_snippet(Shell.SnippetHook.FRAGMENT, '', MASK, false);
        }
    })
    : GObject.registerClass(class KuroCircleMask extends Clutter.ShaderEffect {
        vfunc_get_static_snippet() {
            return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, '', MASK);
        }
    });

const SKIP = new Set([Meta.WindowType.DESKTOP, Meta.WindowType.DOCK]);
const SUPER = Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK;

export class XRay {
    constructor(settings) {
        this._settings = settings;
    }

    start() {
        if (this._lens || Main.overview.visible)
            return;
        const R = this._settings.get_int('xray-radius');
        this._R = R;
        this._lens = new St.Widget({width: 2 * R, height: 2 * R, reactive: false, clip_to_allocation: true});
        this._lens.add_effect(new CircleMask());
        this._inner = new Clutter.Actor();
        this._lens.add_child(this._inner);
        this._ring = new St.Widget({style_class: 'kuro-xray-ring', width: 2 * R, height: 2 * R, reactive: false,
            style: `border-radius: ${R}px;`});
        this._tag = new St.Label({style_class: 'kuro-xray-tag', text: 'X-ray', reactive: false});
        for (const a of [this._lens, this._ring, this._tag]) {
            a.opacity = 0;
            Main.layoutManager.uiGroup.add_child(a);
            a.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._top = undefined;
        this._tick();
        this._timer = GLib.timeout_add(GLib.PRIORITY_HIGH, 16, () => this._tick());
    }

    _topAt(x, y) {
        const actors = global.get_window_actors();
        for (let i = actors.length - 1; i >= 0; i--) {
            const a = actors[i];
            const w = a.meta_window;
            if (!a.visible || !w || w.minimized || SKIP.has(w.window_type) || !w.showing_on_its_workspace?.())
                continue;
            const r = w.get_frame_rect();
            if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
                return {actor: a, index: i};
        }
        return null;
    }

    _rebuild(top) {
        this._inner.destroy_all_children();
        const bg = Main.layoutManager._backgroundGroup;
        if (bg)
            this._inner.add_child(new Clutter.Clone({source: bg, x: bg.x, y: bg.y}));
        const actors = global.get_window_actors();
        const below = top ? actors.slice(0, top.index) : [];
        for (const a of below) {
            const w = a.meta_window;
            if (!a.visible || !w || w.minimized)
                continue;
            this._inner.add_child(new Clutter.Clone({source: a, x: a.x, y: a.y}));
        }
        const app = top ? Shell.WindowTracker.get_default().get_window_app(top.actor.meta_window) : null;
        this._tag.text = top ? `X-ray · behind ${app?.get_name() ?? top.actor.meta_window.get_title() ?? 'window'}` : 'X-ray';
    }

    _tick() {
        if (!this._lens)
            return GLib.SOURCE_REMOVE;
        const [x, y, mods] = global.get_pointer();
        if (!(mods & SUPER) || Main.overview.visible) {
            this.stop();
            return GLib.SOURCE_REMOVE;
        }
        const top = this._topAt(x, y);
        if (top?.actor !== this._top) {
            this._top = top?.actor;
            this._rebuild(top);
        }
        const R = this._R;
        this._lens.set_position(x - R, y - R);
        this._inner.set_position(-(x - R), -(y - R));
        this._ring.set_position(x - R, y - R);
        this._tag.set_position(Math.round(x - this._tag.width / 2), y + R + 8);
        return GLib.SOURCE_CONTINUE;
    }

    get active() {
        return !!this._lens;
    }

    stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        for (const a of [this._lens, this._ring, this._tag]) {
            a?.ease({opacity: 0, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => a.destroy()});
        }
        this._lens = this._ring = this._tag = this._inner = null;
        this._top = undefined;
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        for (const a of [this._lens, this._ring, this._tag])
            a?.destroy();
        this._lens = this._ring = this._tag = this._inner = null;
    }
}
