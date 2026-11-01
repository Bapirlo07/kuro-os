// Kuro Creature — an original little ink spirit that lives on top of your windows.
//   · walks along the top edge of the window you're using (rides it when you move it), else the floor
//   · eyes follow the pointer; naps after 3 min idle (Zzz); bedtime → night cap + sleeps
//   · cheers when a download lands in ~/Downloads, dances when the song changes (any MPRIS player)
//   · click = pet (hearts) · drag = carry it, let go = it falls onto whatever window is below
//   · hides in the overview and when the monitor is fullscreen
//   · grows up: scarf after 3 days together, tail after 10, halo after 30 (~/.local/state/bapirlo/pet.json)
// Show/hide: bapirlo-pet hide|show|toggle (~/.config/bapirlo/pet.json) · off: gnome-extensions disable bapirlo-pet@bapirlo-os
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {drawKuro} from './draw.js';

const SIZE = 72;                     // logical px
const FPS = 30;
const IDLE_FPS = 12;
const SLEEP_AFTER = 180 * 1000;      // ms of no input
const STATE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'bapirlo']);
const PET_STATE = GLib.build_filenamev([STATE_DIR, 'pet.json']);
const BEDTIME = GLib.build_filenamev([STATE_DIR, 'bedtime.json']);
const ACCENT = GLib.build_filenamev([STATE_DIR, 'accent', 'last.json']);
const CONF = GLib.build_filenamev([GLib.get_user_config_dir(), 'bapirlo', 'pet.json']);
const COLOURS = {ink: '#0F0A0A', crimson: '#E4003D', accent3_bright: '#F9C8C7'};
const STAGES = [0, 3, 10, 30];       // days together → stage
const STAGE_NEWS = ['', 'Got a scarf!', 'Grew a tail!', 'I glow now ✦'];

function readJSON(path, fallback) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return {...fallback, ...JSON.parse(new TextDecoder().decode(bytes))};
    } catch {
        return {...fallback};
    }
}

function writeJSON(path, data) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, JSON.stringify(data, null, 1));
    } catch (e) {
        console.warn(`Kuro creature: ${e.message}`);
    }
}

// GNOME 49+ has is_maximized(); older shells get_maximized() flags (3 = both)
const maximized = w => (w.is_maximized ? w.is_maximized() : w.get_maximized?.() === 3);
const today = () => GLib.DateTime.new_now_local().format('%F');
const rand = (a, b) => a + Math.random() * (b - a);

export default class KuroPetExtension extends Extension {
    enable() {
        this._colours = {...COLOURS, ...readJSON(ACCENT, {})};
        this._mem = readJSON(PET_STATE, {born: today(), days: [], pets: 0});
        this._seeDay();

        // pose + physics
        this._x = 0; this._y = 0;            // feet centre, stage coords
        this._vx = 0; this._vy = 0;
        this._facing = 1;
        this._mood = 'idle';
        this._moodUntil = 0;
        this._t = 0;
        this._step = 0;
        this._squash = 1;
        this._blinkUntil = 0;
        this._nextBlink = GLib.get_monotonic_time() + 3e6;
        this._surface = null;                 // Meta.Window we stand on, or null = floor
        this._lastSurfaceRect = null;
        this._hop = null;                     // {x0,y0,x1,y1,start,dur}
        this._carry = null;
        this._placed = false;

        this._actor = new St.Widget({reactive: true, width: SIZE, height: SIZE, track_hover: true,
            name: 'kuro-pet'});
        this._canvas = new St.DrawingArea({width: SIZE, height: SIZE});
        this._canvas.connect('repaint', area => this._paint(area));
        this._actor.add_child(this._canvas);
        this._bubble = new St.Label({style_class: 'kuro-pet-bubble', opacity: 0, visible: false});

        const ui = Main.layoutManager.uiGroup;
        ui.insert_child_above(this._actor, global.window_group);
        ui.insert_child_above(this._bubble, this._actor);

        this._actor.connect('button-press-event', (_a, ev) => this._press(ev));
        this._actor.connect('motion-event', (_a, ev) => this._motion(ev));
        this._actor.connect('button-release-event', (_a, ev) => this._release(ev));

        global.display.connectObject(
            'notify::focus-window', () => this._retarget(),
            'in-fullscreen-changed', () => this._updateVisible(), this);
        Main.overview.connectObject('showing', () => this._updateVisible(),
            'hidden', () => this._updateVisible(), this);
        global.workspace_manager.connectObject('active-workspace-changed', () => this._retarget(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._retarget(), this);

        this._watchDownloads();
        this._watchMusic();
        // a thumbs-up to the webcam (Kuro Air Gestures) → Kuro waves back
        this._gestureSub = Gio.DBus.session.signal_subscribe(null, 'org.bapirlo.Gestures', 'Done',
            '/org/bapirlo/Gestures', null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                const [name] = params.deepUnpack();
                if (name === 'kuro-cheer') {
                    if (this._mood === 'sleep')
                        this._mood = 'idle';
                    this._feel('happy', 2200, ['👋 Hi!', '👍 Yeah!', '✦ Hehe'][Math.floor(Math.random() * 3)]);
                    if (!this._hop && !this._fall && !this._carry)
                        this._startHop(this._x, this._y);
                }
            });
        this._watchFile(BEDTIME, () => this._readBedtime());
        this._watchFile(CONF, () => this._updateVisible());
        this._watchFile(ACCENT, () => {
            this._colours = {...COLOURS, ...readJSON(ACCENT, {})};
            this._canvas.queue_repaint();
        });
        this._readBedtime();
        this._idle = global.backend.get_core_idle_monitor();

        this._retarget(true);
        this._updateVisible();
        this._schedule(FPS);
        this._after(2500, () => this._say(this._greeting(), 3000));
        // other Kuro extensions can make Kuro talk (round 21: focus tunnel)
        globalThis.kuroPet = {_owner: this, say: (text, ms = 3000) => this._say(text, ms)};
    }

    disable() {
        if (globalThis.kuroPet?._owner === this)
            delete globalThis.kuroPet;
        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = 0;
        for (const id of this._timeouts ?? [])
            GLib.source_remove(id);
        this._timeouts = null;
        this._grab?.dismiss();
        this._grab = null;
        for (const m of this._monitors ?? [])
            m.cancel();
        this._monitors = null;
        for (const sub of [this._musicSub, this._gestureSub]) {
            if (sub)
                Gio.DBus.session.signal_unsubscribe(sub);
        }
        this._musicSub = this._gestureSub = 0;
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._surface?.disconnectObject(this);
        this._surface = null;
        this._bubble?.destroy();
        this._actor?.destroy();
        this._bubble = this._actor = this._canvas = null;
        writeJSON(PET_STATE, this._mem);
    }

    // ---------- memory / growing up ----------
    _seeDay() {
        const d = today();
        if (!this._mem.days.includes(d)) {
            this._mem.days.push(d);
            this._mem.days = this._mem.days.slice(-400);
            writeJSON(PET_STATE, this._mem);
        }
        const n = this._mem.days.length;
        const stage = STAGES.reduce((s, need, i) => (n >= need ? i : s), 0);
        if (this._stage !== undefined && stage > this._stage)
            this._after(1500, () => this._feel('happy', 4000, STAGE_NEWS[stage]));
        this._stage = stage;
    }

    _greeting() {
        const h = GLib.DateTime.new_now_local().get_hour();
        const n = this._mem.days.length;
        if (n <= 1)
            return 'Hi! I\'m Kuro ✦';
        if (h < 5)
            return 'Still up?';
        if (h < 12)
            return 'Morning!';
        if (h < 18)
            return 'Hey again!';
        return 'Evening ✦';
    }

    // ---------- timers ----------
    _schedule(fps) {
        if (this._fps === fps && this._tick)
            return;
        if (this._tick)
            GLib.source_remove(this._tick);
        this._fps = fps;
        this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(1000 / fps), () => {
            try {
                this._frame();
            } catch (e) {
                console.error(`Kuro creature: ${e.stack ?? e}`);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _after(ms, fn) {
        this._timeouts ??= new Set();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts?.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    // ---------- where can Kuro stand? ----------
    _workArea() {
        const i = global.display.get_current_monitor();
        return Main.layoutManager.getWorkAreaForMonitor(i);
    }

    _usable(w) {
        if (!w || w.minimized || w.is_fullscreen() || maximized(w) || w.window_type !== Meta.WindowType.NORMAL || w.is_skip_taskbar() ||
            !w.showing_on_its_workspace() || !w.located_on_workspace(global.workspace_manager.get_active_workspace()))
            return false;
        const r = w.get_frame_rect();
        const wa = Main.layoutManager.getWorkAreaForMonitor(w.get_monitor());
        return r.width >= 180 && r.y - SIZE > wa.y + 4;
    }

    _floor() {
        const wa = this._workArea();
        return {x0: wa.x + SIZE, x1: wa.x + wa.width - SIZE, y: wa.y + wa.height};
    }

    _ledge() {
        if (this._surface && this._usable(this._surface)) {
            const r = this._surface.get_frame_rect();
            return {x0: r.x + SIZE * 0.45, x1: r.x + r.width - SIZE * 0.45, y: r.y, rect: r};
        }
        return this._floor();
    }

    _setSurface(w) {
        if (this._surface === w)
            return;
        this._surface?.disconnectObject(this);
        this._surface = w;
        this._lastSurfaceRect = null;
        w?.connectObject('unmanaged', () => this._setSurface(null), this);
    }

    // focus moved / workspace changed → hop to the new window's top (or the floor)
    _retarget(instant = false) {
        if (this._carry)
            return;
        const w = global.display.focus_window;
        this._setSurface(this._usable(w) ? w : null);
        const l = this._ledge();
        const x = Math.min(Math.max(this._x || (l.x0 + l.x1) / 2, l.x0), l.x1);
        if (instant || !this._placed) {
            this._x = x; this._y = l.y; this._placed = true;
            this._place();
            return;
        }
        if (Math.abs(l.y - this._y) > 2 || this._x < l.x0 || this._x > l.x1)
            this._startHop(x, l.y);
    }

    _startHop(x1, y1) {
        const dist = Math.hypot(x1 - this._x, y1 - this._y);
        this._hop = {x0: this._x, y0: this._y, x1, y1, start: GLib.get_monotonic_time(),
            dur: Math.min(900, 350 + dist * 0.6) * 1000, peak: Math.max(40, Math.min(160, dist * 0.35))};
        this._facing = x1 >= this._x ? 1 : -1;
        this._squash = 1.25;
    }

    // ---------- the frame loop ----------
    _frame() {
        if (!this._actor.visible) {
            this._updateVisible();
            return;
        }
        const now = GLib.get_monotonic_time();
        const dt = 1 / this._fps;
        this._t += dt;

        // a new day together? (checked once a minute)
        if (!this._dayCheck || now - this._dayCheck > 60e6) {
            this._dayCheck = now;
            this._seeDay();
        }

        // nap / wake
        const idleMs = this._idle.get_idletime();
        if (this._bedtime || idleMs > SLEEP_AFTER) {
            if (this._mood !== 'sleep' && !this._carry && !this._hop)
                this._sleep();
        } else if (this._mood === 'sleep') {
            this._feel('surprised', 900);
            this._after(900, () => this._say('Oh! You\'re back', 2200));
        }
        if (this._moodUntil && now > this._moodUntil) {
            this._moodUntil = 0;
            this._mood = 'idle';
        }

        if (this._carry) {
            // dangling from the pointer
            const [px, py] = global.get_pointer();
            this._x = px - this._carry.dx;
            this._y = py - this._carry.dy;
            this._squash += (0.85 - this._squash) * 0.3;
        } else if (this._fall) {
            this._vy += 1600 * dt;
            this._y += this._vy * dt;
            if (this._y >= this._fall.y) {
                this._y = this._fall.y;
                this._fall = null;
                this._vy = 0;
                this._squash = 1.35;
                this._feel(Math.random() < 0.5 ? 'surprised' : 'happy', 700);
            }
        } else if (this._hop) {
            const h = this._hop;
            const k = Math.min(1, (now - h.start) / h.dur);
            this._x = h.x0 + (h.x1 - h.x0) * k;
            this._y = h.y0 + (h.y1 - h.y0) * k - h.peak * 4 * k * (1 - k);
            this._squash += ((k < 0.5 ? 0.85 : 1) - this._squash) * 0.25;
            if (k >= 1) {
                this._hop = null;
                this._squash = 1.3;
            }
        } else {
            const l = this._ledge();
            // ride the window if it moved (dragged, resized, thrown…)
            if (l.rect) {
                const prev = this._lastSurfaceRect;
                if (prev && (prev.x !== l.rect.x || prev.y !== l.rect.y)) {
                    this._x += l.rect.x - prev.x;
                    this._y = l.y;
                }
                this._lastSurfaceRect = {x: l.rect.x, y: l.rect.y};
            }
            if (Math.abs(this._y - l.y) > 2) {
                this._retarget();
            } else {
                this._y = l.y;
                this._behave(l, dt, now);
            }
            this._x = Math.min(Math.max(this._x, l.x0), l.x1);
        }
        this._squash += (1 - this._squash) * 0.18;

        // blink
        if (now > this._nextBlink) {
            this._blinkUntil = now + 140000;
            this._nextBlink = now + rand(2.5, 6) * 1e6;
        }
        this._place();
        this._canvas.queue_repaint();
        // round 21 lag pass: full speed only while Kuro moves; standing still the sway/blink look the same at
        // 12 fps, and every frame here makes the whole compositor draw a frame
        const moving = this._mood === 'walk' || this._hop || this._fall || this._carry;
        this._schedule(this._mood === 'sleep' ? 8 : moving ? FPS : IDLE_FPS);
    }

    _behave(l, dt, now) {
        if (this._mood === 'sleep' || this._mood === 'surprised')
            return;
        if (this._mood === 'dance' || this._mood === 'happy') {
            // little bounces
            if (Math.sin(this._t * 9) > 0.96 && this._mood === 'dance')
                this._facing *= -1;
            this._squash = 1 + Math.sin(this._t * 12) * 0.08;
            return;
        }
        if (this._mood === 'walk') {
            this._x += this._vx * dt;
            this._step += Math.abs(this._vx) * dt * 0.35;
            if ((this._vx < 0 && this._x <= l.x0) || (this._vx > 0 && this._x >= l.x1)) {
                this._vx = -this._vx;
                this._facing = Math.sign(this._vx);
            }
            if (now > this._moodUntil - 1 && Math.random() < 0.004)
                this._mood = 'idle';
        } else if (Math.random() < 0.006) {
            this._mood = 'walk';
            this._vx = (Math.random() < 0.5 ? -1 : 1) * rand(24, 40);
            this._facing = Math.sign(this._vx);
        } else {
            // idle: face the pointer
            const [px] = global.get_pointer();
            if (Math.abs(px - this._x) > 30)
                this._facing = px > this._x ? 1 : -1;
        }
    }

    _sleep() {
        this._mood = 'sleep';
        this._moodUntil = 0;
        this._say(this._bedtime ? 'Good night… z' : 'z z z', 0);
    }

    _feel(mood, ms, text) {
        if (this._carry)
            return;
        this._mood = mood;
        this._moodUntil = GLib.get_monotonic_time() + ms * 1000;
        if (text)
            this._say(text, Math.max(ms, 2200));
        else if (this._bubbleSleep)
            this._hideBubble();
    }

    // ---------- drawing ----------
    _place() {
        this._actor.set_position(Math.round(this._x - SIZE / 2), Math.round(this._y - SIZE + 2));
        if (this._bubble.visible) {
            const [bw, bh] = this._bubble.get_size();
            this._bubble.set_position(Math.round(this._x - bw / 2), Math.round(this._y - SIZE - bh + 4));
        }
    }

    _paint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const now = GLib.get_monotonic_time();
        const [px, py] = global.get_pointer();
        const dx = (px - this._x) * this._facing, dy = py - (this._y - SIZE / 2);
        const d = Math.max(1, Math.hypot(dx, dy));
        try {
            drawKuro(cr, w, h, {
                mood: this._carry ? 'surprised' : this._mood,
                t: this._t,
                step: this._step,
                squash: this._squash,
                look: {x: 1.3 * dx / d, y: 1.1 * dy / d},
                blink: now < this._blinkUntil,
                stage: this._stage,
                cap: this._bedtime,
                facing: this._facing,
            }, this._colours);
        } finally {
            cr.$dispose();
        }
    }

    _say(text, ms) {
        if (!this._bubble)
            return;
        this._bubble.text = text;
        this._bubble.show();
        this._bubble.remove_all_transitions();
        this._bubble.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._place();
        this._bubbleSleep = ms === 0;
        this._bubbleSerial = (this._bubbleSerial ?? 0) + 1;
        const serial = this._bubbleSerial;
        if (ms > 0)
            this._after(ms, () => serial === this._bubbleSerial && this._hideBubble());
    }

    _hideBubble() {
        this._bubbleSleep = false;
        this._bubble?.ease({opacity: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._bubble?.hide()});
    }

    _updateVisible() {
        const conf = readJSON(CONF, {visible: true});
        const mon = global.display.get_current_monitor();
        const show = conf.visible !== false && !Main.overview.visible &&
            !global.display.get_monitor_in_fullscreen(mon);
        if (show !== this._actor.visible) {
            this._actor.visible = show;
            if (!show)
                this._bubble.hide();
            else
                this._retarget(true);
        }
        this._schedule(show ? FPS : 1);
    }

    // ---------- touching ----------
    _press(ev) {
        if (ev.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = ev.get_coords();
        this._press0 = {px, py, dx: px - this._x, dy: py - this._y, moved: false};
        this._grab = global.stage.grab(this._actor);
        return Clutter.EVENT_STOP;
    }

    _motion(ev) {
        if (!this._press0)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = ev.get_coords();
        if (!this._carry && Math.hypot(px - this._press0.px, py - this._press0.py) > 6) {
            this._carry = {dx: this._press0.dx, dy: this._press0.dy};
            this._hop = null;
            this._fall = null;
            this._say(['Whoa!', 'Wheee!', 'Where to?'][Math.floor(Math.random() * 3)], 1200);
        }
        return Clutter.EVENT_STOP;
    }

    _release() {
        this._grab?.dismiss();
        this._grab = null;
        const wasCarry = this._carry;
        this._press0 = null;
        this._carry = null;
        if (wasCarry) {
            this._dropAt(this._x, this._y);
        } else {
            this._mem.pets = (this._mem.pets ?? 0) + 1;
            writeJSON(PET_STATE, this._mem);
            this._feel('happy', 1800, ['♥', '♥ ♥', 'hehe', '♥'][this._mem.pets % 4]);
            this._squash = 1.3;
        }
        return Clutter.EVENT_STOP;
    }

    // land on the first usable window top below the drop point, else the floor
    _dropAt(x, y) {
        const ws = global.workspace_manager.get_active_workspace();
        const wins = global.display.sort_windows_by_stacking(ws.list_windows()).reverse();
        let land = null;
        for (const w of wins) {
            if (!this._usable(w))
                continue;
            const r = w.get_frame_rect();
            if (x >= r.x + 16 && x <= r.x + r.width - 16 && r.y >= y - 4) {
                if (!land || r.y < land.get_frame_rect().y)
                    land = w;
            }
            // a window above covering this spot blocks what's below it
            if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height)
                break;
        }
        this._setSurface(land);
        const l = this._ledge();
        this._x = Math.min(Math.max(x, l.x0), l.x1);
        this._fall = {y: l.y};
        this._vy = 0;
    }

    // ---------- the world around it ----------
    _watchFile(path, cb) {
        this._monitors ??= [];
        try {
            const m = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.NONE, null);
            m.connect('changed', (_m, _f, _o, type) => {
                if (type === Gio.FileMonitorEvent.CHANGES_DONE_HINT || type === Gio.FileMonitorEvent.CREATED ||
                    type === Gio.FileMonitorEvent.DELETED)
                    cb();
            });
            this._monitors.push(m);
        } catch (e) {
            console.warn(`Kuro creature: can't watch ${path}: ${e.message}`);
        }
    }

    _readBedtime() {
        const was = this._bedtime;
        this._bedtime = !!readJSON(BEDTIME, {on: false}).on;
        if (was && !this._bedtime && this._mood === 'sleep') {
            this._mood = 'idle';
            this._say('Morning ✦', 2500);
        }
        this._canvas?.queue_repaint();
    }

    _watchDownloads() {
        const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        if (!dir)
            return;
        this._monitors ??= [];
        try {
            const m = Gio.File.new_for_path(dir).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            m.connect('changed', (_m, file, other, type) => {
                let f = null;
                if (type === Gio.FileMonitorEvent.RENAMED)      // foo.crdownload → foo
                    f = other;
                else if (type === Gio.FileMonitorEvent.MOVED_IN)
                    f = file;
                else if (type === Gio.FileMonitorEvent.CHANGES_DONE_HINT)
                    f = file;
                const name = f?.get_basename();
                if (!name || name.startsWith('.') || /\.(part|crdownload|tmp|download|partial)$/i.test(name))
                    return;
                const now = GLib.get_monotonic_time();
                if (this._lastDl && now - this._lastDl < 4e6)
                    return;
                this._lastDl = now;
                if (this._mood === 'sleep')
                    return;
                const short = name.length > 22 ? `${name.slice(0, 19)}…` : name;
                this._feel('happy', 2600, `Got it! ${short}`);
                if (!this._hop && !this._fall)
                    this._startHop(this._x, this._y);         // jump on the spot
            });
            this._monitors.push(m);
        } catch (e) {
            console.warn(`Kuro creature: ${e.message}`);
        }
    }

    _watchMusic() {
        this._musicSub = Gio.DBus.session.signal_subscribe(null, 'org.freedesktop.DBus.Properties',
            'PropertiesChanged', '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player',
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                const [, changed] = params.deepUnpack();
                const meta = changed.Metadata?.deepUnpack?.();
                if (!meta)
                    return;
                const title = meta['xesam:title']?.deepUnpack?.();
                if (!title || title === this._lastTitle)
                    return;
                const first = this._lastTitle === undefined;
                this._lastTitle = title;
                if (first || this._mood === 'sleep')
                    return;
                const short = title.length > 24 ? `${title.slice(0, 21)}…` : title;
                this._feel('dance', 4000, `♪ ${short}`);
            });
    }
}
