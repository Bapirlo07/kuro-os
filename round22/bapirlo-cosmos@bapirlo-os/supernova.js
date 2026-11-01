// Kuro Supernova — urgent notifications (critical ones such as battery very low, incoming calls) burst out
// of the island: a shockwave ring races across the screen and ripples the windows it passes through.
// Normal notifications stay quiet (the aurora sky shows those as shooting stars instead).
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {WarpEffect, screenClone, animate, accent} from './gfx.js';

const DURATION = 1100;

const DECL = `
uniform vec2 size;
uniform vec2 c;
uniform float rad;
uniform float k;
uniform vec3 tint;`;
const BODY = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 p = uv * size;
vec2 d = p - c;
float dist = length(d);
float w = 70.0 + 90.0 * k;                      // ring thickness grows as it travels
float x = (dist - rad) / w;
float wave = exp(-x * x * 3.0);
float fade = 1.0 - k;
// push pixels outward on the front, pull them in behind it
vec2 dir = dist > 0.5 ? d / dist : vec2(0.0);
vec2 q = p - dir * sin(x * 3.14159) * wave * 28.0 * fade;
vec4 col = texture2D(tex, clamp(q / size, 0.0, 1.0));
// chromatic edge + glowing front
vec2 qr = p - dir * sin(x * 3.14159) * wave * 34.0 * fade;
col.r = mix(col.r, texture2D(tex, clamp(qr / size, 0.0, 1.0)).r, wave * fade);
col.rgb += tint * wave * fade * 0.8;
// the core flash at the island
col.rgb += tint * exp(-dist / 120.0) * (1.0 - smoothstep(0.0, 0.35, k)) * 1.2;
cogl_color_out = vec4(clamp(col.rgb, 0.0, 1.0), 1.0) * cogl_color_in.a;`;

function isUrgent(n) {
    if (n.urgency === MessageTray.Urgency.CRITICAL)
        return true;
    const cat = n.category ?? n.notificationParams?.category ?? '';
    if (/^call/.test(cat))
        return true;
    return /incoming call|is calling|ringing/i.test(`${n.title ?? ''} ${n.body ?? ''}`);
}

export class Supernova {
    constructor(settings) {
        this._settings = settings;
        this._busy = false;
    }

    // called for every new notification (extension.js watches the tray)
    notification(n) {
        if (this._settings.get_boolean('supernova') && isUrgent(n))
            this.burst();
    }

    burst(rgb = null) {
        if (this._busy || Main.sessionMode.isLocked || globalThis.kuroLite)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        this._busy = true;
        const box = screenClone(mon);
        // above the windows but below the bar, so the island sits on top of the blast
        const fx = WarpEffect(DECL, BODY);
        box.add_effect(fx);
        const tint = rgb ?? accent();
        const cx = mon.width / 2, cy = 22;
        const far = Math.hypot(mon.width / 2, mon.height) + 200;
        this._box = box;
        this._tl = animate(box, DURATION, (_dt, _s, k) => {
            const e = 1 - Math.pow(1 - k, 2.2);
            fx.set({size: [mon.width, mon.height], c: [cx, cy], rad: far * e, k, tint});
        }, () => this._end());
    }


    _end() {
        this._box?.destroy();
        this._box = this._tl = null;
        this._busy = false;
    }

    destroy() {
        this._tl?.stop();
        this._end();
    }
}
