// Kuro Cosmos — shared GPU helpers.
//   ShaderActor  a plain actor that paints one rectangle with a Cogl pipeline + fragment snippet. No offscreen
//                buffer (cheap): good for procedural things (aurora sky, wormhole streaks) and for drawing a
//                texture (a window/screen snapshot) through a shader (glass shards).
//   WarpEffect   Clutter.ShaderEffect for distorting something that is already on screen (a container of
//                Clones of the wallpaper + windows): black-hole lensing, supernova shockwave.
//   screenClone  that container (wallpaper + windows of one monitor, live) — nothing real is moved.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

let _white = null;
function cogl() {
    return global.stage.context.get_backend().get_cogl_context();
}

// 1×1 white texture: a pipeline needs a layer for cogl_tex_coord_in[0] to exist
function white() {
    _white ??= Cogl.Texture2D.new_from_data(cogl(), 1, 1, Cogl.PixelFormat.RGBA_8888, 4, new Uint8Array([255, 255, 255, 255]));
    return _white;
}

const _templates = new Map();

// decl: GLSL declarations (uniforms + functions); body: sets cogl_color_out. uv = cogl_tex_coord_in[0].xy (0..1).
// Output is premultiplied alpha (Clutter blends ONE, ONE_MINUS_SRC_ALPHA).
export const ShaderActor = GObject.registerClass(
class KuroShaderActor extends Clutter.Actor {
    _init(decl, body, params = {}) {
        const {texture = null, ...rest} = params;
        super._init(rest);
        // one template pipeline (and snippet) per shader, copied per actor → Cogl compiles it once
        const key = `${decl}\u0000${body}`;
        let tpl = _templates.get(key);
        if (!tpl) {
            tpl = Cogl.Pipeline.new(cogl());
            tpl.set_layer_texture(0, white());
            tpl.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl, body));
            _templates.set(key, tpl);
        }
        this._pipeline = tpl.copy();
        if (texture)
            this._pipeline.set_layer_texture(0, texture);
        this._locs = new Map();
        this._region = null;   // [x1, y1, x2, y2] texture coords to draw (default whole texture)
    }

    setTexture(tex) {
        this._pipeline.set_layer_texture(0, tex ?? white());
        this.queue_redraw();
    }

    // draw only part of the texture (shards): texture coords for this actor's rectangle
    setRegion(x1, y1, x2, y2) {
        this._region = [x1, y1, x2, y2];
        this.queue_redraw();
    }

    _loc(name) {
        let l = this._locs.get(name);
        if (l === undefined) {
            l = this._pipeline.get_uniform_location(name);
            this._locs.set(name, l);
        }
        return l;
    }

    // set('t', 1.5) · set('col', [r, g, b]) (vec2..vec4) · set('pts', [x0, y0, x1, y1, …], 2) (vec2 array)
    set(name, v, components = 0) {
        const l = this._loc(name);
        if (l < 0)
            return this;
        if (Array.isArray(v)) {
            const n = components || v.length;
            if (n < 1 || n > 4 || v.length % n)
                throw new Error(`Kuro Cosmos: uniform ${name}: ${v.length} values don't make vec${n}s`);
            this._pipeline.set_uniform_float(l, n, v.length / n, v);
        } else {
            this._pipeline.set_uniform_1f(l, v);
        }
        this.queue_redraw();
        return this;
    }

    vfunc_paint_node(root) {
        const n = new Clutter.PipelineNode(this._pipeline);
        root.add_child(n);
        const box = new Clutter.ActorBox({x1: 0, y1: 0, x2: this.width, y2: this.height});
        if (this._region)
            n.add_texture_rectangle(box, ...this._region);
        else
            n.add_rectangle(box);
    }
});

// distortion of whatever the actor it's attached to paints (tex = that actor, offscreen).
// Clutter caches a ShaderEffect's static snippet PER CLASS, so every shader gets its own registered subclass.
const _warpClasses = new Map();
export function WarpEffect(decl, body) {
    let C = _warpClasses.get(body);
    if (!C) {
        const snippetDecl = `uniform sampler2D tex;\n${decl}`;
        C = GObject.registerClass({GTypeName: `KuroWarpEffect${_warpClasses.size}_${GLib.uuid_string_random().slice(0, 8)}`},
            class extends Clutter.ShaderEffect {
                vfunc_get_static_snippet() {
                    return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, snippetDecl, body);
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
        _warpClasses.set(body, C);
    }
    return new C();
}

// live picture of one monitor's wallpaper + windows (Clones), as a child of uiGroup above the windows.
// Returns the container; caller adds effects and destroys it.
export function screenClone(monitor) {
    const box = new Clutter.Actor({x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
        clip_to_allocation: true, reactive: false});
    const bg = Main.layoutManager._backgroundGroup;
    if (bg)
        box.add_child(new Clutter.Clone({source: bg, x: -monitor.x, y: -monitor.y}));
    box.add_child(new Clutter.Clone({source: global.window_group, x: -monitor.x, y: -monitor.y}));
    Main.layoutManager.uiGroup.insert_child_above(box, global.window_group);
    return box;
}

// snapshot of an actor as a Cogl texture (null if it can't be painted)
export function snapshot(actor) {
    try {
        const c = actor.paint_to_content(null);
        return c?.get_texture?.() ?? null;
    } catch (e) {
        console.warn(`Kuro Cosmos: snapshot failed: ${e.message}`);
        return null;
    }
}

// Kuro's crimson (or the wallpaper accent from bapirlo-autotheme) as [r, g, b] 0..1
export function accent(key = 'crimson') {
    try {
        const f = GLib.build_filenamev([GLib.get_user_state_dir(), 'bapirlo', 'accent', 'last.json']);
        const [, b] = GLib.file_get_contents(f);
        const j = JSON.parse(new TextDecoder().decode(b));
        const k = JSON.parse(j.key ?? '{}');
        const hex = j[key] ?? k[key];
        if (/^#[0-9a-f]{6}$/i.test(hex ?? ''))
            return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    } catch {}
    return [0.894, 0.0, 0.239];
}

// Kuro Bar's settings (focus timer phase etc.) — the bar ships its own schema dir; null if not loaded
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

export function readJson(path, fallback = null) {
    try {
        const [, b] = GLib.file_get_contents(path);
        return JSON.parse(new TextDecoder().decode(b));
    } catch {
        return fallback;
    }
}

export const STATE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'bapirlo']);

// small helpers
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const now = () => Number(global.get_current_time?.() ?? 0) || Date.now();

// a frame clock that is simple to stop: calls fn(dtSeconds, elapsedSeconds) each new frame (via a Clutter
// timeline on the actor, so it runs at the monitor's real refresh, only while the actor is on stage)
// Running timelines are kept in a set until they end — a fire-and-forget timeline could otherwise be
// garbage-collected half way and never call onDone (left a dilation veil on screen once).
const _running = new Set();
export function animate(actor, durationMs, fn, onDone) {
    const tl = new Clutter.Timeline({actor, duration: durationMs});
    let last = 0;
    tl.connect('new-frame', (_t, ms) => {
        try {
            fn(Math.max(0, (ms - last) / 1000), ms / 1000, ms / durationMs);
        } catch (e) {
            console.error(`Kuro Cosmos animation: ${e.stack ?? e}`);
        }
        last = ms;
    });
    const end = () => {
        if (!_running.delete(tl))
            return;
        try {
            onDone?.();
        } catch (e) {
            console.error(`Kuro Cosmos animation end: ${e.stack ?? e}`);
        }
    };
    tl.connect('completed', end);
    tl.connect('stopped', end);
    // the actor going away mid-animation must still finish the job (cleanup in onDone)
    actor.connectObject?.('destroy', () => _running.has(tl) && (tl.stop(), end()), tl);
    _running.add(tl);
    tl.start();
    return tl;
}
