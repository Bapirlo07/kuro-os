// Kuro Wormhole — switching workspace flies you through a short tunnel: stars streak out from the centre,
// a ring of light rushes past, then the new workspace is there. Sits on top of GNOME's own slide (which it
// mostly hides at the peak) and takes ~0.6 s. Not in the overview, not while something is fullscreen.
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ShaderActor, animate, accent} from './gfx.js';

const DURATION = 620;

const DECL = `
uniform float t;
uniform float k;
uniform float aspect;
uniform float dir;
uniform vec3 tint;
float h1(float n) { return fract(sin(n) * 43758.5453); }`;
const BODY = `
vec2 uv = cogl_tex_coord_in[0].xy - 0.5;
uv.x *= aspect;
uv.x -= dir * 0.08 * sin(k * 3.14159);          // lean toward where we're going
float r = length(uv);
float a = atan(uv.y, uv.x);
float env = sin(k * 3.14159);                    // 0 → 1 → 0
float spd = 1.5 + 6.0 * env;
// streaks: 90 angular lanes, each with a star travelling outward
float lane = floor((a + 3.14159) / 6.28318 * 90.0);
float la = (lane + 0.5) / 90.0 * 6.28318 - 3.14159;
float off = abs(sin(a - la)) * r;                // distance to the lane centre line
float z = fract(h1(lane * 7.13) + t * spd * (0.4 + h1(lane) * 0.6));
float head = z * 1.1;
float len = 0.05 + 0.35 * env;
float along = smoothstep(head - len, head, r) * (1.0 - smoothstep(head, head + 0.01, r));
float streak = along * exp(-off * off * 9000.0) * (0.4 + h1(lane * 3.1));
// tunnel rings rushing past
float ring = exp(-pow(fract(log(r + 0.02) * 2.0 - t * 4.0) - 0.5, 2.0) * 60.0) * smoothstep(0.05, 0.4, r);
vec3 glow = (vec3(0.85, 0.9, 1.0) * streak * 1.6 + tint * ring * 0.35 + vec3(1.0) * exp(-r * 9.0) * 0.9) * env;
float av = env * 0.85;                           // dark veil over the old/new workspace at the peak
cogl_color_out = vec4(vec3(0.02, 0.02, 0.06) * av + glow, av);`;

export class Wormhole {
    constructor(settings) {
        this._settings = settings;
        this._last = global.workspace_manager.get_active_workspace_index();
        global.workspace_manager.connectObject('active-workspace-changed', () => this._changed(), this);
    }

    _changed() {
        const i = global.workspace_manager.get_active_workspace_index();
        const dir = Math.sign(i - this._last) || 1;
        this._last = i;
        if (!this._settings.get_boolean('wormhole') || Main.overview.visible || Main.sessionMode.isLocked)
            return;
        const focus = global.display.focus_window;
        if (focus?.is_fullscreen())
            return;
        this.fly(dir);
    }

    fly(dir = 1) {
        this._stop();
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon || globalThis.kuroLite)
            return;
        const a = new ShaderActor(DECL, BODY, {x: mon.x, y: mon.y, width: mon.width, height: mon.height, reactive: false});
        Main.layoutManager.uiGroup.insert_child_above(a, global.window_group);
        a.set('aspect', mon.width / mon.height).set('dir', dir).set('tint', accent());
        this._actor = a;
        // a slight zoom-through on the windows themselves
        const wg = global.window_group;
        wg.set_pivot_point(0.5, 0.5);
        this._tl = animate(a, DURATION, (_dt, secs, k) => {
            a.set('t', secs).set('k', k);
            const s = 1 + 0.06 * Math.sin(k * Math.PI);
            wg.set_scale(s, s);
        }, () => this._stop());
    }

    _stop() {
        this._tl?.stop();
        this._actor?.destroy();
        this._actor = this._tl = null;
        global.window_group.set_scale(1, 1);
    }

    destroy() {
        global.workspace_manager.disconnectObject(this);
        this._stop();
    }
}
