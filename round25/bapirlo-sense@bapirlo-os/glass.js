// Kuro Sense — Liquid Glass.
// Behind every visible bar pill (Kuro Bar "islands" look: left / centre / right; any other look: the whole bar),
// the dock's background and the expanded Dynamic Island sits a GlassPane: a live Clone of the wallpaper (so a
// live video wallpaper shows through, moving) drawn through a shader that
//   · bends the picture at the rounded edges like a thick glass lens (samples pulled in from just outside),
//   · splits colours a little there (chromatic edge),
//   · frosts it slightly, darkens it for readability (glass-tint) and
//   · adds a thin specular rim lit from the top-left (+ the music glow from pulse.js).
// The pills' own CSS backgrounds turn see-through while this runs (uiGroup classes kuro-liquid*, stylesheet.css).
// It refracts the WALLPAPER, not windows — the bar and dock sit over the wallpaper nearly always; where a
// window is behind the dock you still see glass over the wallpaper (like Blur my Shell's "static" mode).
// Panes follow their pill through allocation / translation / visibility changes of the pill and every
// ancestor (dock slide-in, bar reveal over fullscreen apps). Hidden in the overview and on the lock screen.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PAD = 18;   // px of wallpaper around the pill the edge refraction can pull in

const DECL = `
uniform sampler2D tex;
uniform vec2 size;
uniform vec4 shape;
uniform float radius;
uniform float strength;
uniform float tintA;
uniform float glow;
uniform vec3 glowCol;
float sdRound(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const BODY = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 p = uv * size - (shape.xy + shape.zw) * 0.5;
vec2 hb = max((shape.zw - shape.xy) * 0.5, vec2(1.0));
float r = min(radius, min(hb.x, hb.y));
float d = sdRound(p, hb, r);
vec2 g = vec2(sdRound(p + vec2(1.0, 0.0), hb, r) - sdRound(p - vec2(1.0, 0.0), hb, r),
              sdRound(p + vec2(0.0, 1.0), hb, r) - sdRound(p - vec2(0.0, 1.0), hb, r));
vec2 n = length(g) > 1e-4 ? normalize(g) : vec2(0.0);
float bevel = clamp(min(hb.x, hb.y) * 0.9, 4.0, 16.0);
float edge = clamp(1.0 + d / bevel, 0.0, 1.0);
float bend = edge * edge * strength * 14.0;
vec2 o = n * bend / size;
vec2 px = 1.0 / size;
vec3 col;
col.r = texture2D(tex, uv + o * 1.18).r;
col.g = texture2D(tex, uv + o).g;
col.b = texture2D(tex, uv + o * 0.82).b;
vec3 fr = texture2D(tex, uv + o + vec2(1.5, 0.0) * px).rgb + texture2D(tex, uv + o - vec2(1.5, 0.0) * px).rgb
        + texture2D(tex, uv + o + vec2(0.0, 1.5) * px).rgb + texture2D(tex, uv + o - vec2(0.0, 1.5) * px).rgb;
col = mix(col, fr * 0.25, 0.3);
col = mix(col, vec3(0.04, 0.03, 0.035), tintA);
float top = clamp(1.0 - (p.y + hb.y) / max(hb.y * 2.0, 1.0), 0.0, 1.0);
col += vec3(0.05) * top * top;
float rimW = 1.0 - smoothstep(0.0, 1.6, abs(d + 0.8));
float lit = max(dot(n, normalize(vec2(-0.45, -1.0))), 0.0);
float back = max(dot(n, normalize(vec2(0.45, 1.0))), 0.0);
col += rimW * (vec3(0.55) * lit + vec3(0.18) * back);
col += rimW * glow * glowCol * 1.3 + edge * edge * glow * glowCol * 0.22;
float a = clamp(0.5 - d, 0.0, 1.0);
cogl_color_out = vec4(col * a, a);
`;

let GlassEffect = null;
function glassEffect() {
    GlassEffect ??= GObject.registerClass({GTypeName: `KuroGlassEffect_${GLib.uuid_string_random().slice(0, 8)}`},
        class extends Clutter.ShaderEffect {
            vfunc_get_static_snippet() {
                return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECL, BODY);
            }

            set(u) {
                this.set_uniform_value('tex', 0);
                for (const [k, v] of Object.entries(u)) {
                    if (Array.isArray(v))
                        this.set_uniform_float(k, v.length, v);
                    else
                        this.set_uniform_float(k, 1, [v]);
                }
                this.queue_repaint();
            }
        });
    return new GlassEffect();
}

class Pane {
    constructor(target, anchor, owner) {
        this.target = target;
        this._owner = owner;
        this.glow = 0;
        this.glowCol = [0.894, 0, 0.239];
        this.layer = new Clutter.Actor({reactive: false, clip_to_allocation: true, name: 'kuro-glass'});
        this._clone = new Clutter.Clone({source: Main.layoutManager._backgroundGroup});
        this.layer.add_child(this._clone);
        this._fx = glassEffect();
        this.layer.add_effect(this._fx);
        Main.layoutManager.uiGroup.insert_child_below(this.layer, anchor);
        // follow the pill and every ancestor up to uiGroup
        const queue = () => owner.queueSync();
        for (let a = target; a && a !== Main.layoutManager.uiGroup; a = a.get_parent()) {
            a.connectObject('notify::allocation', queue, 'notify::translation-x', queue, 'notify::translation-y', queue,
                'notify::visible', queue, 'notify::mapped', queue, 'notify::opacity', queue, 'notify::scale-x', queue, this);
        }
        target.connectObject('destroy', () => owner.rebuildSoon(), this);
    }

    sync(show, strength, tint) {
        const t = this.target;
        const [w, h] = t.get_transformed_size();
        if (!show || !t.mapped || w < 8 || h < 8 || t.opacity < 10) {
            this.layer.hide();
            return;
        }
        const [x, y] = t.get_transformed_position();
        if (![x, y, w, h].every(Number.isFinite)) {   // not allocated yet (login): NaN would poison the layer
            this.layer.hide();
            return;
        }
        // padded rect, clipped to the screen (an offscreen buffer can't reach past the stage edge)
        const lx = Math.max(0, Math.round(x) - PAD), ly = Math.max(0, Math.round(y) - PAD);
        const lw = Math.min(global.stage.width, Math.round(x + w) + PAD) - lx;
        const lh = Math.min(global.stage.height, Math.round(y + h) + PAD) - ly;
        if (lw < 8 || lh < 8) {
            this.layer.hide();
            return;
        }
        this.layer.set_position(lx, ly);
        this.layer.set_size(lw, lh);
        this._clone.set_position(-lx, -ly);
        let radius = 16;
        try {
            if (t instanceof St.Widget)
                radius = t.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
        } catch {}
        this._u = {size: [lw, lh], shape: [x - lx, y - ly, x + w - lx, y + h - ly], radius, strength, tintA: tint};
        this._push();
        this.layer.opacity = t.opacity;
        this.layer.show();
    }

    setGlow(g, col) {
        this.glow = g;
        if (col)
            this.glowCol = col;
        if (this._u && this.layer.visible)
            this._push();
    }

    _push() {
        this._fx.set({...this._u, glow: this.glow, glowCol: this.glowCol});
    }

    destroy() {
        try {
            for (let a = this.target; a; a = a.get_parent())
                a.disconnectObject(this);
        } catch {}
        this.layer.destroy();
    }
}

export class Glass {
    constructor(settings) {
        this._s = settings;
        this._panes = [];
        this._classes = [];
        this._dockStyle = null;
        this._bar = barSettings();
        this._bar?.connectObject('changed::bar-look', () => this.rebuildSoon(), this);
        settings.connectObject('changed::glass', () => this.rebuild(), 'changed::glass-strength', () => this.queueSync(),
            'changed::glass-tint', () => this.queueSync(), this);
        Main.overview.connectObject('showing', () => this.queueSync(), 'hidden', () => this.queueSync(), this);
        Main.sessionMode.connectObject('updated', () => this.queueSync(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this.rebuildSoon(), this);
        // late arrivals: the dock and the expanded island are (re)created by other extensions
        Main.layoutManager.uiGroup.connectObject('child-added', (_g, a) => {
            if (a.name === 'dashtodockContainer' || a.has_style_class_name?.('bapirlo-island'))
                this.rebuildSoon();
        }, this);
        this.rebuild();
        globalThis.kuroGlass = {glow: (g, col) => this.glow(g, col), _owner: this};
    }

    status() {
        return this._s.get_boolean('glass') ? `${this._panes.length} panes` : 'off';
    }

    // music glow on every rim (pulse.js)
    glow(g, col) {
        for (const p of this._panes)
            p.setGlow(g, col);
    }

    _targets() {
        const out = [];
        const look = this._bar?.get_string('bar-look') ?? 'classic';
        const pb = Main.layoutManager.panelBox;
        if (look === 'islands') {
            for (const b of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox])
                if (b)
                    out.push([b, pb]);
        } else {
            out.push([Main.panel, pb]);
        }
        const dock = Main.layoutManager.uiGroup.get_children().find(a => a.name === 'dashtodockContainer');
        const bg = dock && findStyled(dock, 'dash-background');
        if (bg)
            out.push([bg, dock]);
        for (const isl of Main.layoutManager.uiGroup.get_children().filter(a => a.has_style_class_name?.('bapirlo-island')))
            out.push([isl, isl]);
        return [out, look];
    }

    rebuild() {
        this._clear();
        if (!this._s.get_boolean('glass'))
            return;
        const [targets, look] = this._targets();
        for (const [t, anchor] of targets) {
            try {
                this._panes.push(new Pane(t, anchor, this));
            } catch (e) {
                console.error(`Kuro Glass: pane: ${e.stack ?? e}`);
            }
        }
        const ui = Main.layoutManager.uiGroup;
        this._classes = ['kuro-liquid', look === 'islands' ? 'kuro-liquid-islands' : 'kuro-liquid-bar'];
        this._classes.forEach(c => ui.add_style_class_name(c));
        // Dash to Dock may paint its background colour as an inline style (beats any stylesheet)
        const dockPane = this._panes.find(p => p.target.has_style_class_name?.('dash-background'));
        if (dockPane) {
            const bg = dockPane.target;
            this._dockStyle = [bg, bg.get_style()];
            bg.set_style(`${bg.get_style() ?? ''} background-color: rgba(12, 9, 10, 0.10);`);
        }
        this.queueSync();
    }

    rebuildSoon() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._rebuildId = 0;
            this.rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    queueSync() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const show = !Main.overview.visible && !Main.sessionMode.isLocked && Main.sessionMode.currentMode !== 'unlock-dialog';
        const strength = this._s.get_double('glass-strength');
        const tint = this._s.get_double('glass-tint');
        for (const p of this._panes) {
            try {
                p.sync(show, strength, tint);
            } catch (e) {
                console.error(`Kuro Glass: sync: ${e.message}`);
            }
        }
    }

    _clear() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._panes.forEach(p => p.destroy());
        this._panes = [];
        const ui = Main.layoutManager.uiGroup;
        this._classes.forEach(c => ui.remove_style_class_name(c));
        this._classes = [];
        if (this._dockStyle) {
            const [bg, st] = this._dockStyle;
            try {
                bg.set_style(st);
            } catch {}
            this._dockStyle = null;
        }
    }

    destroy() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = 0;
        this._clear();
        this._bar?.disconnectObject(this);
        this._s.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.uiGroup.disconnectObject(this);
        if (globalThis.kuroGlass?._owner === this)
            delete globalThis.kuroGlass;
    }
}

function findStyled(actor, cls) {
    if (actor.has_style_class_name?.(cls))
        return actor;
    for (const c of actor.get_children()) {
        const f = findStyled(c, cls);
        if (f)
            return f;
    }
    return null;
}

// Kuro Bar's settings (the bar look) — the bar ships its own schema dir; null if it isn't loaded
export function barSettings() {
    const ext = Main.extensionManager.lookup('bapirlo-bar@bapirlo-os');
    const dir = ext?.dir?.get_child('schemas');
    try {
        const src = dir?.query_exists(null)
            ? Gio.SettingsSchemaSource.new_from_directory(dir.get_path(), Gio.SettingsSchemaSource.get_default(), false)
            : Gio.SettingsSchemaSource.get_default();
        const schema = src.lookup('org.gnome.shell.extensions.bapirlo-bar', true);
        return schema ? new Gio.Settings({settings_schema: schema}) : null;
    } catch {
        return null;
    }
}
