// Kuro Air-draw (round 21) — hold 🤟 and draw a shape in the air; let go of the pose and the shape runs an action.
// A glowing trail follows the red dot while you draw. Shapes are matched with a small "$1 recognizer"
// (resample → scale → compare to templates, searching ±35° of tilt), so size and speed don't matter but
// direction does (a circle can be drawn either way round).
// Change what each shape does in ~/.config/bapirlo/gestures.json → "draw": {"circle": "search", ...}
// (same action names as "actions", including "cmd:<shell command>"; "none" turns a shape off).
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DEFAULT_DRAW, pathLength, recognise} from './draw-shapes.js';
export {DEFAULT_DRAW};

export const DRAW_POSE = 'rock';
export const DRAW_ICON = {
    'circle': '◯', 'check': '✓', 'z': 'Z', 'triangle': '△', 'caret': '^', 'l': 'L',
};

const MIN_PATH = 160;          // px of hand travel before it counts as a drawing
const ENTER = 3;               // samples of the pose before drawing starts
const LEAVE = 4;               // samples without it before the drawing ends
const MIN_SCORE = 0.8;

// ---------- the shell side ----------
export class AirDraw {
    constructor(ext) {
        this._ext = ext;
        this._pts = null;
        this._in = 0;
        this._out = 0;
    }

    /** every Pointer() sample */
    feed(x, y, pose) {
        if (pose === DRAW_POSE) {
            this._out = 0;
            if (!this._pts) {
                if (++this._in >= ENTER)
                    this._begin();
                return;
            }
            const last = this._pts[this._pts.length - 1];
            if (!last || Math.hypot(x - last[0], y - last[1]) > 2) {
                this._pts.push([x, y]);
                this._trail.queue_repaint();
            }
        } else {
            this._in = 0;
            if (this._pts && ++this._out >= LEAVE)
                this._end(true);
        }
    }

    get drawing() {
        return this._pts !== null;
    }

    /** hand lost — drop the drawing without running anything */
    cancel() {
        this._in = this._out = 0;
        if (this._pts)
            this._end(false);
    }

    _begin() {
        this._pts = [];
        const m = Main.layoutManager.primaryMonitor;
        this._trail?.destroy();
        this._trail = new St.DrawingArea({x: m.x, y: m.y, width: m.width, height: m.height, reactive: false});
        this._trail.connect('repaint', a => this._paint(a, m));
        Main.layoutManager.uiGroup.add_child(this._trail);
    }

    _paint(area, m) {
        const cr = area.get_context();
        const p = this._pts ?? [];
        if (p.length > 1) {
            cr.setLineCap(1);       // round
            cr.setLineJoin(1);
            for (const [w, a] of [[16, 0.18], [8, 0.4], [3.5, 1]]) {
                cr.setSourceRGBA(0.95, 0.22, 0.3, a);
                cr.setLineWidth(w);
                cr.moveTo(p[0][0] - m.x, p[0][1] - m.y);
                for (let i = 1; i < p.length; i++)
                    cr.lineTo(p[i][0] - m.x, p[i][1] - m.y);
                cr.stroke();
            }
        }
        cr.$dispose();
    }

    _end(run) {
        const pts = this._pts;
        this._pts = null;
        this._in = this._out = 0;
        const trail = this._trail;
        this._trail = null;
        trail?.ease({opacity: 0, duration: 350, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => trail.destroy()});
        if (!run || !pts || pts.length < 8 || pathLength(pts) < MIN_PATH)
            return;
        const {name, score} = recognise(pts);
        const map = {...DEFAULT_DRAW, ...(this._ext._conf?.draw ?? {})};
        if (!name || score < MIN_SCORE) {
            this._ext._say('✍  Didn\'t catch that shape');
            return;
        }
        const action = map[name] ?? 'none';
        if (action === 'none')
            return;
        this._ext._do(action, `draw-${name}`);
    }

    destroy() {
        this._pts = null;
        this._trail?.destroy();
        this._trail = null;
    }
}

