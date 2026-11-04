// Kuro Sense — head-tracked 3D wallpaper.
// The camera daemon (job "head") sends Head(x, y, z) ~30×/s: x/y = where your face is, -1…1 from the centre of
// what the camera sees, already mirrored (lean right → x > 0) and re-centred slowly to how you usually sit;
// z = how near you are (1 = usual). Kuro Live Wallpaper's parallax asks globalThis.kuroHead.get() for its
// "eye": while a fresh head position exists it replaces the pointer, so leaning makes near things in the
// depth map slide against far ones — the screen behaves like a window. No head for 0.6 s → pointer again.
import GLib from 'gi://GLib';

const FRESH_US = 600 * 1000;

export class Head {
    constructor(settings) {
        this._s = settings;
        this._x = this._y = 0;
        this._z = 1;
        this._at = 0;
        globalThis.kuroHead = {get: () => this.get(), _owner: this};
    }

    update(x, y, z) {
        this._x = x;
        this._y = y;
        this._z = z;
        this._at = GLib.get_monotonic_time();
    }

    // [x, y] in -1…1 (the live wallpaper's pointer space), or null when there's no fresh head
    get() {
        if (GLib.get_monotonic_time() - this._at > FRESH_US)
            return null;
        const k = 1.6 * (this._s.get_double('head-strength') || 1);
        const c = v => Math.max(-1, Math.min(1, v * k));
        return [c(this._x), c(this._y)];
    }

    status() {
        return GLib.get_monotonic_time() - this._at < FRESH_US ? 'tracking' : 'idle';
    }

    destroy() {
        if (globalThis.kuroHead?._owner === this)
            delete globalThis.kuroHead;
    }
}
