// Kuro Air Gestures — the shell half. The camera half (bapirlo-gestures, a MediaPipe daemon that owns
// org.bapirlo.GesturesCam while it runs) calls us on the session bus at org.bapirlo.Gestures:
//   Pointer(x, y, pinch, pose)   hand position 0..1 over the primary monitor → the glowing hand dot.
//                                pinch tap = click · pinch + move = grab the window under the dot and carry it
//   Hand(pts, pose, progress, mode, hint)   21 hand points (camera picture, mirrored) → skeleton in the hand view;
//                                progress 0..1 = how far a "hold still" has got → ring around the dot
//   Status(state, hint)          looking | tracking | dark | paused | nocam | off → top-bar icon + hand view
//   Gesture(name)                swipe-left/right/up/down, palm, fist, thumb-up/down, shaka, victory-left/right, rock
//   Dial(kind, delta)            fist / victory moved up or down while held → volume / scroll
//   Hand2(pts, pose, progress)  round 28: the SECOND hand (empty pts = gone) → drawn in the hand view too.
//                                Two-hand gestures: 🤏🤏 pull apart / together = Dial("spread") · ✋✋ still = two-palms
//   Mirror(bytes)                192×108 RGB camera thumbnail (only while "Show camera picture" is on)
//   Lost() · Say(text) · Help()
// What each gesture does lives in ~/.config/bapirlo/gestures.json ("actions"), reloaded when it changes.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {GuardCover} from './guard.js';
import {AirDraw, DRAW_ICON} from './draw.js';
import {DEFAULT_DRAW} from './draw-shapes.js';

const IFACE = `<node><interface name="org.bapirlo.Gestures">
  <method name="Pointer"><arg type="d" direction="in"/><arg type="d" direction="in"/><arg type="b" direction="in"/><arg type="s" direction="in"/></method>
  <method name="Hand"><arg type="ad" direction="in"/><arg type="s" direction="in"/><arg type="d" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
  <method name="Hand2"><arg type="ad" direction="in"/><arg type="s" direction="in"/><arg type="d" direction="in"/></method>
  <method name="Status"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
  <method name="Lost"/>
  <method name="Gesture"><arg type="s" direction="in"/></method>
  <method name="Dial"><arg type="s" direction="in"/><arg type="d" direction="in"/></method>
  <method name="Mirror"><arg type="ay" direction="in"/></method>
  <method name="Say"><arg type="s" direction="in"/></method>
  <method name="Help"/>
  <method name="Guard"><arg type="b" direction="in"/></method>
  <method name="GuardSnooze"><arg type="u" direction="in"/></method>
  <signal name="Done"><arg type="s"/></signal>
</interface></node>`;

const CONF = GLib.build_filenamev([GLib.get_user_config_dir(), 'bapirlo', 'gestures.json']);
const MIRROR_FLAG = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'kuro-gestures-mirror']);
const DEFAULT_ACTIONS = {
    'swipe-left': 'ws-next', 'swipe-right': 'ws-prev', 'swipe-up': 'overview', 'swipe-down': 'minimize',
    'palm': 'desktop', 'fist': 'media-toggle', 'thumb-up': 'volume-up', 'thumb-down': 'volume-down',
    'shaka': 'apps', 'dial-victory': 'scroll', 'pinch-tap': 'click',
    'victory-left': 'media-prev', 'victory-right': 'media-next',
    // round 28: both hands
    'dial-spread': 'zoom', 'two-palms': 'overview',
    // round 20: 🤟 retired; these still exist but do nothing unless you set them in gestures.json
    'rock': 'none', 'fist-left': 'none', 'fist-right': 'none', 'victory': 'none', 'dial-fist': 'none',
};
// how each gesture is made (cheat sheet), in the order shown
const HOW = [
    ['☝', 'Point', 'move the red dot'],
    ['🤏', 'Pinch tap', 'pinch-tap'],
    ['🤏', 'Pinch + move', 'carry a window · fling = throw'],
    ['👈', 'Swipe left', 'swipe-left'], ['👉', 'Swipe right', 'swipe-right'],
    ['☝', 'Swipe up (open hand)', 'swipe-up'], ['👇', 'Swipe down (open hand)', 'swipe-down'],
    ['✋', 'Palm, hold still', 'palm'],
    ['✊', 'Fist, hold still', 'fist'],
    ['👍', 'Thumbs up, keep holding', 'thumb-up'], ['👎', 'Thumbs down, keep holding', 'thumb-down'],
    ['✌', 'Two fingers, move up / down', 'dial-victory'],
    ['✌', 'Two fingers, flick left / right', 'victory-left|victory-right'],
    ['🤙', 'Shaka (thumb + pinky), hold', 'shaka'],
    ['🤟', 'Hold 🤟 and draw a shape', 'draw'],
    ['🤏🤏', 'Pinch with both hands, pull apart / together', 'dial-spread'],
    ['✋✋', 'Both palms, hold still', 'two-palms'],
];
const NICE = {
    'ws-next': 'Next workspace  →', 'ws-prev': '←  Previous workspace', 'overview': 'Overview',
    'minimize': 'Minimise window', 'desktop': 'Show desktop', 'media-toggle': 'Play / pause',
    'media-next': 'Next track  ⏭', 'media-prev': '⏮  Previous track', 'kuro-cheer': 'Kuro says hi',
    'close-window': 'Close window', 'search': 'Kuro Search', 'screenshot': 'Screenshot',
    'volume': 'Volume', 'volume-up': 'Volume up', 'volume-down': 'Volume down', 'apps': 'Open an app', 'scroll': 'Scroll', 'click': 'Click', 'canvas': 'Zoom canvas', 'help': 'Cheat sheet',
    'lock': 'Lock screen', 'zoom': 'Zoom', 'none': 'nothing',
};
const POSE_ICON = {
    'palm': '✋', 'fist': '✊', 'thumb-up': '👍', 'thumb-down': '👎', 'rock': '🤟', 'shaka': '🤙', 'victory': '✌', 'point': '☝',
    ...Object.fromEntries(Object.entries(DRAW_ICON).map(([k, v]) => [`draw-${k}`, `✍ ${v}`])),
};
const STATE_TEXT = {
    looking: 'Looking for your hand…', tracking: 'I see your hand', dark: 'Too dark to see',
    paused: 'Paused (screen locked)', nocam: 'No camera', off: 'Off',
};
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
    [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
const TAP_MS = 350, TAP_PX = 34;
const RED = [0.894, 0, 0.239];

const maximized = w => (w.is_maximized ? w.is_maximized() : w.get_maximized?.() === 3);

export default class KuroGesturesExtension extends Extension {
    enable() {
        this._actions = {...DEFAULT_ACTIONS};
        this._conf = {};
        this._loadConf();
        this._confMon = Gio.File.new_for_path(CONF).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._confMon.connect('changed', () => this._loadConf());

        // dot + ring (drawn), and a small label under it for dials
        this._dot = new St.DrawingArea({width: 56, height: 56, opacity: 0, reactive: false});
        this._dot.connect('repaint', a => this._paintDot(a));
        this._dotLabel = new St.Label({style_class: 'kuro-dot-label', opacity: 0, reactive: false});
        this._toast = new St.Label({style_class: 'kuro-gesture-toast', opacity: 0, reactive: false});
        for (const a of [this._dot, this._dotLabel, this._toast])
            Main.layoutManager.uiGroup.add_child(a);
        this._pinch = false;
        this._progress = 0;
        this._pose = '';
        this._mode = '';
        this._state = 'off';
        this._hint = '';
        this._pts = null;
        this._pts2 = null;
        this._minimized = null;

        this._buildHud();
        this._draw = new AirDraw(this);

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/bapirlo/Gestures');
        this._owner = Gio.bus_own_name(Gio.BusType.SESSION, 'org.bapirlo.Gestures',
            Gio.BusNameOwnerFlags.REPLACE, null, null, null);
        // always-there on/off button at the top left (grey = off, red = on)
        this._toggleBtn = new KuroGestureToggle(this);
        Main.panel.addToStatusArea('kuro-gestures-toggle', this._toggleBtn, 99, 'left');
        // the top-bar icon is there only while the camera half runs
        this._camWatch = Gio.bus_watch_name(Gio.BusType.SESSION, 'org.bapirlo.GesturesCam',
            Gio.BusNameWatcherFlags.NONE, () => this._camUp(true), () => this._camUp(false));
    }

    disable() {
        this._guard?.destroy();
        this._guard = null;
        this._draw?.destroy();
        this._draw = null;
        this._drop();
        this._setMirror(false);
        if (this._camWatch)
            Gio.bus_unwatch_name(this._camWatch);
        if (this._owner)
            Gio.bus_unown_name(this._owner);
        this._camWatch = this._owner = 0;
        this._dbus?.unexport();
        this._dbus = null;
        this._confMon?.cancel();
        this._confMon = null;
        for (const id of ['_toastId', '_hudHideId', '_labelId', '_helpId']) {
            if (this[id])
                GLib.source_remove(this[id]);
            this[id] = 0;
        }
        this._closeHelp();
        this._indicator?.destroy();
        this._indicator = null;
        this._toggleBtn?.destroy();
        this._toggleBtn = null;
        for (const k of ['_dot', '_dotLabel', '_toast', '_hud', '_flash']) {
            this[k]?.destroy();
            this[k] = null;
        }
        this._vptr = this._vkbd = null;
    }

    // ---------- settings ----------
    _loadConf() {
        try {
            const [, bytes] = GLib.file_get_contents(CONF);
            this._conf = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            this._conf = {};
        }
        this._actions = {...DEFAULT_ACTIONS, ...(this._conf.actions ?? {})};
        this._hudMode = this._conf.hud ?? 'auto';           // auto | always | off
        this._updateHudVisibility();
    }

    _saveConf(patch) {
        const c = {...this._conf, ...patch};
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(CONF), 0o755);
            GLib.file_set_contents(CONF, JSON.stringify(c, null, 2));
        } catch (e) {
            console.warn(`Kuro gestures: ${e.message}`);
        }
        this._conf = c;
        this._hudMode = c.hud ?? 'auto';
        this._updateHudVisibility();
    }

    // ---------- D-Bus methods ----------
    Pointer(x, y, pinch, pose) {
        const m = Main.layoutManager.primaryMonitor;
        const px = m.x + Math.max(0, Math.min(1, x)) * m.width;
        const py = m.y + Math.max(0, Math.min(1, y)) * m.height;
        const now = GLib.get_monotonic_time();
        if (this._last) {               // velocity for throws (px/s), smoothed
            const dt = Math.max(1, now - this._last.t) / 1e6;
            const k = 0.5;
            this._vx = (this._vx ?? 0) * (1 - k) + ((px - this._last.x) / dt) * k;
            this._vy = (this._vy ?? 0) * (1 - k) + ((py - this._last.y) / dt) * k;
        }
        this._last = {x: px, y: py, t: now};
        this._px = px;
        this._py = py;
        this._pose = pose;
        this._draw?.feed(px, py, pose);
        if (pinch !== this._pinch) {
            this._pinch = pinch;
            this._dot.queue_repaint();
        }

        // round 20: no easing (it trailed ~60 ms behind every new sample) and only re-stack when something
        // covered the dot, instead of re-sorting the whole uiGroup 30 times a second
        const parent = this._dot.get_parent();
        if (parent && parent.get_last_child() !== this._dot)
            this._raise(this._dot);
        if (this._dot.opacity !== 255) {
            this._dot.remove_transition('opacity');
            this._dot.opacity = 255;
        }
        this._dot.set_position(Math.round(px - 28), Math.round(py - 28));
        if (this._dotLabel.opacity)
            this._dotLabel.set_position(Math.round(px + 26), Math.round(py + 14));

        // pinch: quick tap = click, hold or move = carry the window
        if (pinch && !this._pinchAt) {
            this._pinchAt = {x: px, y: py, t: now, carrying: false};
        } else if (pinch && this._pinchAt) {
            const p = this._pinchAt;
            if (!p.carrying && (Math.hypot(px - p.x, py - p.y) > TAP_PX || now - p.t > TAP_MS * 1000)) {
                p.carrying = true;
                this._pick(p.x, p.y);
            }
            if (this._grab)
                this._carry(px, py);
        } else if (!pinch && this._pinchAt) {
            const p = this._pinchAt;
            this._pinchAt = null;
            if (this._grab)
                this._drop(true);
            else if (!p.carrying)
                this._run('pinch-tap', {x: p.x, y: p.y});
        }
    }

    Hand(pts, pose, progress, mode, hint) {
        this._pts = pts;
        this._pose = pose;
        if (Math.abs(progress - this._progress) > 0.01 || mode !== this._mode) {
            this._progress = progress;
            this._mode = mode;
            this._dot.queue_repaint();
        }
        if (mode !== 'dial' && this._dialing)
            this._endDial();
        this._setHud('tracking', hint);
        if (this._hud?.visible)          // the hand drawing is only redrawn while you can see it
            this._skel.queue_repaint();
    }

    Hand2(pts, pose, progress) {
        this._pts2 = pts.length >= 42 ? pts : null;
        this._pose2 = pose;
        if (this._hud?.visible)
            this._skel.queue_repaint();
    }

    Status(state, hint) {
        this._setHud(state, hint);
    }

    Lost() {
        this._draw?.cancel();
        this._drop(false);
        this._pinchAt = null;
        this._last = null;
        this._vx = this._vy = 0;
        this._pts = null;
        this._pts2 = null;
        this._progress = 0;
        this._endDial();
        this._skel?.queue_repaint();
        this._dot?.ease({opacity: 0, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._setHud('looking', '');
    }

    Gesture(name) {
        // old (round 17) names still work as actions
        if (NICE[name] && !this._actions[name])
            this._do(name, name);
        else
            this._run(name);
    }

    Dial(kind, delta) {
        const action = this._actions[`dial-${kind}`] ?? 'none';
        if (!this._dialing) {
            this._dialing = {action, acc: 0};
            this._showDotLabel(NICE[action] ?? action);
        }
        const d = this._dialing;
        if (action === 'volume') {
            this._volumeBy(delta * 0.22);
        } else if (action === 'zoom') {
            this._zoomBy(delta);
        } else if (action === 'scroll') {
            d.acc += delta;
            const step = 0.14;
            while (Math.abs(d.acc) >= step) {
                // natural: hand up → page moves up (you see what's below)
                this._scroll(d.acc > 0 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP);
                d.acc -= Math.sign(d.acc) * step;
            }
        }
    }

    Mirror(bytes) {
        if (!this._mirrorOn || !this._camImg)
            return;
        try {
            const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            if (data.length !== 192 * 108 * 3)
                return;
            const ctx = global.stage.context.get_backend().get_cogl_context();
            this._camContent ??= St.ImageContent.new_with_preferred_size(192, 108);
            this._camContent.set_bytes(ctx, new GLib.Bytes(data), Cogl.PixelFormat.RGB_888, 192, 108, 192 * 3);
            if (this._camImg.content !== this._camContent)
                this._camImg.content = this._camContent;
            this._camImg.show();
        } catch (e) {
            if (!this._mirrorWarned)
                console.warn(`Kuro gestures mirror: ${e.message}`);
            this._mirrorWarned = true;
        }
    }

    // other Kuro helpers (Kuro Knock) borrow the toast
    // Round 21: shoulder-surf guard (see guard.js)
    Guard(on) {
        this._guard ??= new GuardCover();
        this._guard.set(on);
    }

    GuardSnooze(seconds) {
        this._guard ??= new GuardCover();
        this._guard.snooze(seconds);
    }

    Say(text) {
        this._say(text);
    }

    Help() {
        this._openHelp();
    }

    // ---------- gesture → action ----------
    _run(gesture, at = null) {
        const action = this._actions[gesture] ?? 'none';
        if (action === 'none' || !action)
            return;
        this._do(action, gesture, at);
    }

    _do(action, gesture, at = null) {
        const ws = global.workspace_manager.get_active_workspace();
        const t = global.get_current_time();
        let label = NICE[action] ?? action;
        if (action.startsWith('cmd:')) {
            try {
                GLib.spawn_command_line_async(`sh -c ${GLib.shell_quote(action.slice(4))}`);
            } catch (e) {
                console.warn(`Kuro gestures: ${e.message}`);
            }
            label = gesture;
        } else {
            switch (action) {
            case 'ws-next':
            case 'ws-prev': {
                const to = ws.get_neighbor(action === 'ws-next' ? Meta.MotionDirection.RIGHT : Meta.MotionDirection.LEFT);
                if (to && to !== ws)
                    to.activate(t);
                break;
            }
            case 'overview':
                Main.overview.toggle();
                break;
            case 'minimize':
                if (Main.overview.visible) {
                    Main.overview.hide();
                    label = 'Back';
                } else {
                    const w = global.display.focus_window;
                    if (w?.can_minimize())
                        w.minimize();
                }
                break;
            case 'desktop':
                this._toggleDesktop(ws);
                break;
            case 'media-toggle':
            case 'media-next':
            case 'media-prev':
                this._spawn(['playerctl', {'media-toggle': 'play-pause', 'media-next': 'next',
                    'media-prev': 'previous'}[action]]);
                break;
            case 'close-window': {
                const w = (this._px !== undefined ? this._windowAt(this._px, this._py) : null) ??
                    global.display.focus_window;
                if (!w || w.window_type !== Meta.WindowType.NORMAL)
                    return;
                label = `Close ${w.get_wm_class() ?? 'window'}`;
                w.delete(t);
                break;
            }
            case 'search':
                this._openSearch();
                break;
            case 'volume-up':
            case 'volume-down':
                this._volumeBy(action === 'volume-up' ? 0.05 : -0.05);
                label = null;           // the volume OSD already shows it (and it repeats while held)
                break;
            case 'apps':
                if (Main.overview.dash?.showAppsButton?.checked && Main.overview.visible)
                    Main.overview.hide();
                else
                    Main.overview.showApps();   // then point + pinch tap an icon to open it
                break;
            case 'screenshot':
                this._screenshot();
                break;
            case 'click':
                this._click(at?.x ?? this._px, at?.y ?? this._py);
                label = null;
                break;
            case 'canvas':
                Gio.DBus.session.call('org.bapirlo.Canvas', '/org/bapirlo/Canvas', 'org.bapirlo.Canvas', 'Open',
                    null, null, Gio.DBusCallFlags.NONE, -1, null, null);
                break;
            case 'help':
                this._openHelp();
                break;
            case 'lock':
                Main.screenShield?.lock(true);
                break;
            case 'kuro-cheer':
                break;                  // Kuro listens for the Done signal itself
            default:
                return;
            }
        }
        if (label)
            this._say(`${POSE_ICON[gesture] ?? ''}  ${label}`.trim());
        this._lastDid = label ?? this._lastDid;
        this._dbus?.emit_signal('Done', new GLib.Variant('(s)', [action]));
    }

    _spawn(argv) {
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`Kuro gestures: ${e.message}`);
        }
    }

    // ---------- virtual mouse / keyboard ----------
    _seat() {
        return (Clutter.get_default_backend?.() ?? global.stage.context.get_backend()).get_default_seat();
    }

    _click(x, y) {
        if (x === undefined)
            return;
        this._vptr ??= this._seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const t = GLib.get_monotonic_time();
        this._vptr.notify_absolute_motion(t, x, y);
        this._vptr.notify_button(t + 1000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        this._vptr.notify_button(t + 40000, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        // little ripple so you see where it clicked
        const r = new St.Widget({style_class: 'kuro-click-ripple', reactive: false, width: 40, height: 40,
            x: x - 20, y: y - 20, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        Main.layoutManager.uiGroup.add_child(r);
        r.ease({scale_x: 1.8, scale_y: 1.8, opacity: 0, duration: 380, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => r.destroy()});
    }

    _scroll(dir) {
        if (this._px === undefined)
            return;
        this._vptr ??= this._seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const t = GLib.get_monotonic_time();
        const [cx, cy] = global.get_pointer();
        if (Math.hypot(cx - this._px, cy - this._py) > 4)
            this._vptr.notify_absolute_motion(t, this._px, this._py);
        this._vptr.notify_discrete_scroll(t + 500, dir, Clutter.ScrollSource.WHEEL);
    }

    _openSearch() {
        // the mini search popup is Super+Space; press it on a virtual keyboard
        this._vkbd ??= this._seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const k = this._vkbd, t = GLib.get_monotonic_time();
        k.notify_keyval(t, Clutter.KEY_Super_L, Clutter.KeyState.PRESSED);
        k.notify_keyval(t + 2000, Clutter.KEY_space, Clutter.KeyState.PRESSED);
        k.notify_keyval(t + 4000, Clutter.KEY_space, Clutter.KeyState.RELEASED);
        k.notify_keyval(t + 6000, Clutter.KEY_Super_L, Clutter.KeyState.RELEASED);
    }

    // ---------- volume ----------
    _volumeBy(frac) {
        const ctl = Volume.getMixerControl?.();
        const sink = ctl?.get_default_sink();
        if (!sink)
            return;
        const max = ctl.get_vol_max_norm();
        const v = Math.max(0, Math.min(max, sink.volume + frac * max));
        sink.volume = v;
        if (sink.is_muted && v > 0)
            sink.change_is_muted(false);
        sink.push_volume();
        const level = v / max;
        const icon = Gio.ThemedIcon.new(level === 0 ? 'audio-volume-muted-symbolic'
            : level < 0.34 ? 'audio-volume-low-symbolic'
                : level < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic');
        try {
            if (Main.osdWindowManager.showAll)
                Main.osdWindowManager.showAll(icon, null, level, 1);
            else
                Main.osdWindowManager.show(-1, icon, null, level, 1);
        } catch {}
        this._showDotLabel(`Volume ${Math.round(level * 100)}%`);
    }

    // round 28: two-hand zoom = GNOME's own screen magnifier (Accessibility → Zoom), centred on the dot
    _zoomBy(delta) {
        this._magSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.magnifier'});
        this._a11yApps ??= new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.applications'});
        const on = this._a11yApps.get_boolean('screen-magnifier-enabled');
        let f = on ? this._magSettings.get_double('mag-factor') : 1;
        f = Math.min(8, Math.max(1, f * Math.exp(delta * 0.9)));
        if (f < 1.06) {
            if (on)
                this._a11yApps.set_boolean('screen-magnifier-enabled', false);
            this._showDotLabel('Zoom off');
            return;
        }
        this._magSettings.set_double('mag-factor', Math.round(f * 100) / 100);
        if (!on)
            this._a11yApps.set_boolean('screen-magnifier-enabled', true);
        try {
            if (this._px !== undefined)
                Main.magnifier?.getZoomRegions?.()[0]?.scrollContentsTo?.(this._px, this._py);
        } catch {}
        this._showDotLabel(`Zoom ${f.toFixed(1)}×`);
    }

    _endDial() {
        if (!this._dialing)
            return;
        this._dialing = null;
        this._dotLabel?.ease({opacity: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _showDotLabel(text) {
        this._dotLabel.text = text;
        this._raise(this._dotLabel);
        if (this._px !== undefined)
            this._dotLabel.set_position(Math.round(this._px + 26), Math.round(this._py + 14));
        this._dotLabel.remove_transition('opacity');
        this._dotLabel.opacity = 255;
    }

    // ---------- screenshot ----------
    async _screenshot() {
        const dir = GLib.build_filenamev([GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ??
            GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']), 'Screenshots']);
        GLib.mkdir_with_parents(dir, 0o755);
        const name = `Kuro gesture ${GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S')}.png`;
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
        try {
            this._dot.hide();
            const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            await new Shell.Screenshot().screenshot(false, stream);
            stream.close(null);
            const [, bytes] = file.load_contents(null);
            St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(bytes));
            this._flashScreen();
            this._say('📸  Saved to Pictures/Screenshots (and copied)');
        } catch (e) {
            console.warn(`Kuro gestures screenshot: ${e.message}`);
            this._say('Screenshot failed');
        } finally {
            this._dot?.show();
        }
    }

    _flashScreen() {
        const m = Main.layoutManager.primaryMonitor;
        this._flash?.destroy();
        this._flash = new St.Widget({style: 'background-color: white;', reactive: false,
            x: m.x, y: m.y, width: m.width, height: m.height, opacity: 200});
        Main.layoutManager.uiGroup.add_child(this._flash);
        this._flash.ease({opacity: 0, duration: 450, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                this._flash?.destroy();
                this._flash = null;
            }});
    }

    // ---------- pinch: grab / carry / drop a window ----------
    _windowAt(x, y) {
        const ws = global.workspace_manager.get_active_workspace();
        const wins = global.display.sort_windows_by_stacking(ws.list_windows()).reverse();
        return wins.find(w => {
            if (w.minimized || w.window_type !== Meta.WindowType.NORMAL || !w.showing_on_its_workspace())
                return false;
            const r = w.get_frame_rect();
            return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        }) ?? null;
    }

    _pick(px, py) {
        const w = this._windowAt(px, py);
        if (!w || w.is_fullscreen())
            return;
        if (maximized(w)) {               // GNOME 49+: unmaximize(); older: unmaximize(flags)
            if (Meta.MaximizeFlags && w.unmaximize.length >= 1)
                w.unmaximize(Meta.MaximizeFlags.BOTH);
            else
                w.unmaximize();
        }
        w.activate(global.get_current_time());
        const r = w.get_frame_rect();
        this._grab = {win: w, dx: px - r.x, dy: py - r.y};
        w.connectObject('unmanaged', () => (this._grab = null), this);
        globalThis.kuroPhysics?.hold?.(w, true);
    }

    _carry(px, py) {
        const {win, dx, dy} = this._grab;
        win.move_frame(true, Math.round(px - dx), Math.round(py - dy));
    }

    _drop(throwIt = false) {
        if (!this._grab)
            return;
        const {win} = this._grab;
        win.disconnectObject(this);
        globalThis.kuroPhysics?.hold?.(win, false);
        const speed = Math.hypot(this._vx ?? 0, this._vy ?? 0);
        if (throwIt && speed > 900)
            globalThis.kuroPhysics?.fling?.(win, this._vx, this._vy);
        this._grab = null;
    }

    _toggleDesktop(ws) {
        if (this._minimized?.length) {
            for (const w of this._minimized)
                w.unminimize?.();
            this._minimized[0]?.activate(global.get_current_time());
            this._minimized = null;
            return;
        }
        this._minimized = ws.list_windows().filter(w => !w.minimized && w.window_type === Meta.WindowType.NORMAL &&
            !w.is_skip_taskbar()).reverse();
        for (const w of this._minimized)
            w.minimize();
    }

    // ---------- the dot ----------
    _paintDot(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const cx = w / 2, cy = h / 2;
        const r = this._pinch ? 8 : 12;
        // glow
        cr.setSourceRGBA(...RED, 0.22);
        cr.arc(cx, cy, r + 6, 0, 2 * Math.PI);
        cr.fill();
        // dot
        cr.setSourceRGBA(...RED, this._pinch ? 0.9 : 0.35);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 0.92, 0.94, 0.95);
        cr.setLineWidth(2);
        cr.stroke();
        // hold ring
        if (this._progress > 0.02) {
            cr.setLineWidth(4);
            cr.setSourceRGBA(1, 1, 1, 0.18);
            cr.arc(cx, cy, 22, 0, 2 * Math.PI);
            cr.stroke();
            cr.setSourceRGBA(...RED, 1);
            cr.arc(cx, cy, 22, -Math.PI / 2, -Math.PI / 2 + this._progress * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    }

    // ---------- hand view (HUD) ----------
    _buildHud() {
        this._hud = new St.BoxLayout({style_class: 'kuro-hud', orientation: Clutter.Orientation.VERTICAL, opacity: 0, reactive: true,
            visible: false});
        if (this._hud.set_orientation)
            this._hud.set_orientation(Clutter.Orientation.VERTICAL);
        const head = new St.BoxLayout({style_class: 'kuro-hud-head'});
        this._hudBullet = new St.Widget({style_class: 'kuro-hud-bullet looking', y_align: Clutter.ActorAlign.CENTER});
        this._hudTitle = new St.Label({style_class: 'kuro-hud-title', text: STATE_TEXT.looking,
            y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._hudPose = new St.Label({style_class: 'kuro-hud-pose', text: '', y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._hudBullet);
        head.add_child(this._hudTitle);
        head.add_child(this._hudPose);

        const stage = new St.Widget({style_class: 'kuro-hud-stage', width: 192, height: 108,
            x_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout()});
        this._camImg = new St.Widget({width: 192, height: 108, visible: false});
        this._skel = new St.DrawingArea({width: 192, height: 108});
        this._skel.connect('repaint', a => this._paintSkel(a));
        stage.add_child(this._camImg);
        stage.add_child(this._skel);

        this._hudHint = new St.Label({style_class: 'kuro-hud-hint', text: '', visible: false});
        this._hudHint.clutter_text.line_wrap = true;
        this._hudFoot = new St.Label({style_class: 'kuro-hud-foot', text: 'Click me for the cheat sheet'});
        this._hudFoot.clutter_text.line_wrap = true;

        this._hud.add_child(head);
        this._hud.add_child(stage);
        this._hud.add_child(this._hudHint);
        this._hud.add_child(this._hudFoot);
        this._hud.connect('button-press-event', () => {
            this._openHelp();
            return Clutter.EVENT_STOP;
        });
        Main.layoutManager.addTopChrome(this._hud);
        this._placeHud();
        Main.layoutManager.connectObject('monitors-changed', () => this._placeHud(), this);
    }

    _placeHud() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m || !this._hud)
            return;
        const [, nw] = this._hud.get_preferred_width(-1);
        const [, nh] = this._hud.get_preferred_height(nw);
        this._hud.set_position(m.x + m.width - nw - 16, m.y + m.height - Math.max(nh, 200) - 110);
    }

    _setHud(state, hint) {
        const changed = state !== this._state || hint !== this._hint;
        this._state = state;
        this._hint = hint;
        if (changed) {
            this._hudBullet.set_style_class_name(`kuro-hud-bullet ${state}`);
            this._hudTitle.text = STATE_TEXT[state] ?? state;
            this._hudHint.text = hint ? `💡 ${hint}` : '';
            this._hudHint.visible = !!hint;
            this._indicator?.setState(state, hint);
            this._placeHud();
        }
        const pose = state === 'tracking' ? this._pose : '';
        const p = pose ? `${POSE_ICON[pose] ?? ''}` : '';
        if (this._hudPose.text !== p)
            this._hudPose.text = p;
        this._updateHudVisibility();
    }

    _updateHudVisibility() {
        if (!this._hud)
            return;
        const camOn = this._camRunning;
        let want;
        if (!camOn || this._hudMode === 'off')
            want = false;
        else if (this._hudMode === 'always' || this._mirrorOn)
            want = true;
        else
            want = this._state === 'tracking' || this._state === 'dark' || !!this._hint;
        if (want) {
            if (this._hudHideId) {
                GLib.source_remove(this._hudHideId);
                this._hudHideId = 0;
            }
            if (!this._hud.visible || this._hud.opacity < 255) {
                this._hud.show();
                this._hud.remove_transition('opacity');
                this._hud.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        } else if (this._hud.visible && !this._hudHideId) {
            // hang around a moment after the hand goes, so it doesn't flicker
            this._hudHideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, camOn ? 2500 : 0, () => {
                this._hudHideId = 0;
                this._hud?.ease({opacity: 0, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._hud?.opacity === 0 && this._hud.hide()});
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _paintSkel(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        if (!this._mirrorOn) {           // faint camera frame + the area that maps to the screen
            cr.setSourceRGBA(1, 1, 1, 0.05);
            cr.rectangle(0, 0, w, h);
            cr.fill();
        }
        const p = this._pts;
        const bones = (q, dots) => {
            const X = i => q[i * 2] * w, Y = i => q[i * 2 + 1] * h;
            cr.setLineCap(1);
            cr.setLineWidth(2.2);
            cr.setSourceRGBA(1, 0.93, 0.95, 0.85);
            for (const [a, b] of BONES) {
                cr.moveTo(X(a), Y(a));
                cr.lineTo(X(b), Y(b));
            }
            cr.stroke();
            for (let i = 0; i < 21; i++) {
                const tip = [4, 8, 12, 16, 20].includes(i);
                cr.setSourceRGBA(...dots, 1);
                cr.arc(X(i), Y(i), tip ? 3.2 : 2.2, 0, 2 * Math.PI);
                cr.fill();
            }
        };
        if (p && p.length >= 42) {
            const X = i => p[i * 2] * w, Y = i => p[i * 2 + 1] * h;
            if (this._pts2)                    // the second hand, in a softer colour so you can tell them apart
                bones(this._pts2, [1, 0.55, 0.7]);
            bones(p, RED);
            if (this._pinch) {
                cr.setSourceRGBA(1, 1, 1, 0.9);
                cr.arc((X(4) + X(8)) / 2, (Y(4) + Y(8)) / 2, 6, 0, 2 * Math.PI);
                cr.setLineWidth(2);
                cr.stroke();
            }
        } else {
            cr.setSourceRGBA(1, 1, 1, 0.35);
            cr.selectFontFace('Sans', 0, 0);
            cr.setFontSize(11);
            const t = this._state === 'dark' ? 'too dark' : 'no hand yet';
            const ext = cr.textExtents(t);
            cr.moveTo((w - ext.width) / 2, h / 2 + 4);
            cr.showText(t);
        }
        cr.$dispose();
    }

    _setMirror(on) {
        this._mirrorOn = on;
        try {
            if (on)
                GLib.file_set_contents(MIRROR_FLAG, '1');
            else if (GLib.file_test(MIRROR_FLAG, GLib.FileTest.EXISTS))
                Gio.File.new_for_path(MIRROR_FLAG).delete(null);
        } catch {}
        if (!on && this._camImg) {
            this._camImg.hide();
            this._camImg.content = null;
            this._camContent = null;
        }
        this._skel?.queue_repaint();
        this._updateHudVisibility();
    }

    // ---------- top-bar icon ----------
    _camUp(up) {
        this._camRunning = up;
        this._toggleBtn?.setOn(up);
        if (up && !this._indicator) {
            this._indicator = new KuroGestureIndicator(this);
            Main.panel.addToStatusArea('kuro-gestures', this._indicator, 0, 'right');
            this._indicator.setState(this._state === 'off' ? 'looking' : this._state, this._hint);
        } else if (!up && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
            this.Lost();
            this._state = 'off';
        }
        this._updateHudVisibility();
    }

    // ---------- cheat sheet ----------
    _openHelp() {
        if (this._help) {
            this._closeHelp();
            return;
        }
        const m = Main.layoutManager.primaryMonitor;
        const box = new St.BoxLayout({style_class: 'kuro-help', orientation: Clutter.Orientation.VERTICAL, reactive: true});
        if (box.set_orientation)
            box.set_orientation(Clutter.Orientation.VERTICAL);
        box.add_child(new St.Label({style_class: 'kuro-help-title', text: 'Air gestures'}));
        box.add_child(new St.Label({style_class: 'kuro-help-sub',
            text: 'Hold a pose still → the ring fills → it happens.   Move while holding ✊ or ✌ → dial.'}));
        const grid = new St.Widget({layout_manager: new Clutter.GridLayout({column_spacing: 14, row_spacing: 6})});
        const gl = grid.layout_manager;
        HOW.filter(h => h[2] !== 'draw').forEach(([icon, how, what], i) => {
            const col = i % 2 ? 3 : 0;
            const row = Math.floor(i / 2);
            const doing = what.includes(' ') ? what
                : what.split('|').map(g => NICE[this._actions[g]] ?? this._actions[g] ?? '—').join(' / ');
            gl.attach(new St.Label({style_class: 'kuro-help-icon', text: icon}), col, row, 1, 1);
            gl.attach(new St.Label({style_class: 'kuro-help-how', text: how}), col + 1, row, 1, 1);
            gl.attach(new St.Label({style_class: 'kuro-help-what', text: doing}), col + 2, row, 1, 1);
        });
        box.add_child(grid);
        // air-draw shapes get their own line (too many to fit one grid cell)
        const draw = {...DEFAULT_DRAW, ...(this._conf?.draw ?? {})};
        const shapes = Object.entries(DRAW_ICON).filter(([k]) => (draw[k] ?? 'none') !== 'none')
            .map(([k, v]) => `${v} ${NICE[draw[k]] ?? draw[k]}`).join('   ·   ');
        if (shapes) {
            const line = new St.BoxLayout({style: 'spacing: 14px; padding-top: 6px;'});
            line.add_child(new St.Label({style_class: 'kuro-help-icon', text: '🤟'}));
            line.add_child(new St.Label({style_class: 'kuro-help-how', text: 'Hold 🤟 and draw'}));
            line.add_child(new St.Label({style_class: 'kuro-help-what', text: shapes}));
            box.add_child(line);
        }
        box.add_child(new St.Label({style_class: 'kuro-help-sub',
            text: 'Change what they do: top-bar ✋ → "Change what gestures do…"   ·   click to close'}));
        box.connect('button-press-event', () => {
            this._closeHelp();
            return Clutter.EVENT_STOP;
        });
        Main.layoutManager.addTopChrome(box);
        const [, nw] = box.get_preferred_width(-1);
        const [, nh] = box.get_preferred_height(nw);
        box.set_position(Math.round(m.x + (m.width - nw) / 2), Math.round(m.y + (m.height - nh) / 2));
        box.opacity = 0;
        box.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._help = box;
        this._helpId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
            this._helpId = 0;
            this._closeHelp();
            return GLib.SOURCE_REMOVE;
        });
    }

    _closeHelp() {
        if (this._helpId)
            GLib.source_remove(this._helpId);
        this._helpId = 0;
        if (!this._help)
            return;
        Main.layoutManager.removeChrome(this._help);
        this._help.destroy();
        this._help = null;
    }

    // ---------- toast ----------
    _raise(a) {
        a.get_parent()?.set_child_above_sibling(a, null);
    }

    _say(text) {
        const m = Main.layoutManager.primaryMonitor;
        this._toast.text = text;
        this._raise(this._toast);
        const [, nw] = this._toast.get_preferred_width(-1);
        this._toast.set_position(Math.round(m.x + (m.width - nw) / 2), m.y + Math.round(m.height * 0.12));
        this._toast.remove_all_transitions();
        this._toast.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (this._toastId)
            GLib.source_remove(this._toastId);
        this._toastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1400, () => {
            this._toast?.ease({opacity: 0, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._toastId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }
}

const KuroGestureIndicator = GObject.registerClass(
class KuroGestureIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Kuro Air Gestures');
        this._ext = ext;
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${ext.path}/icons/kuro-hand-symbolic.svg`),
            style_class: 'system-status-icon kuro-gest-icon looking',
        });
        this.add_child(this._icon);

        this._status = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._status);
        this._hintItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._hintItem.label.add_style_class_name('kuro-gest-menu-hint');
        this.menu.addMenuItem(this._hintItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const hud = new PopupMenu.PopupSwitchMenuItem('Show hand view', ext._hudMode !== 'off');
        hud.connect('toggled', (_i, on) => ext._saveConf({hud: on ? 'auto' : 'off'}));
        this.menu.addMenuItem(hud);
        const cam = new PopupMenu.PopupSwitchMenuItem('Show camera picture in it', !!ext._mirrorOn);
        cam.connect('toggled', (_i, on) => {
            if (on && ext._hudMode === 'off') {
                ext._saveConf({hud: 'auto'});
                hud.setToggleState(true);
            }
            ext._setMirror(on);
        });
        this.menu.addMenuItem(cam);
        const far = new PopupMenu.PopupSwitchMenuItem('Extra sensitive (far away / dim room)',
            ext._conf.sensitivity === 'high');
        far.connect('toggled', (_i, on) => ext._saveConf({sensitivity: on ? 'high' : 'normal'}));
        this.menu.addMenuItem(far);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction('Gesture cheat sheet', () => ext._openHelp());
        this.menu.addAction('Change what gestures do…', () => {
            if (!GLib.file_test(CONF, GLib.FileTest.EXISTS))
                ext._saveConf({actions: {...DEFAULT_ACTIONS}});
            else if (!ext._conf.actions)
                ext._saveConf({actions: {...DEFAULT_ACTIONS}});
            ext._spawn(['gio', 'open', CONF]);
        });
        this.menu.addAction('Turn air gestures off', () => ext._spawn(['bapirlo-gestures', 'off']));
        this.setState('looking', '');
    }

    setState(state, hint) {
        this._icon.set_style_class_name(`system-status-icon kuro-gest-icon ${state}`);
        this._status.label.text = STATE_TEXT[state] ?? state;
        this._hintItem.label.text = hint ? `💡 ${hint}` : '';
        this._hintItem.visible = !!hint;
    }
});

const KuroGestureToggle = GObject.registerClass(
class KuroGestureToggle extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Air gestures on / off', true);
        this._ext = ext;
        this.add_style_class_name('kuro-gest-toggle');
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${ext.path}/icons/kuro-hand-symbolic.svg`),
            style_class: 'system-status-icon kuro-gest-toggle-icon',
        });
        this.add_child(this._icon);
        this.setOn(false);
    }

    setOn(on) {
        this._on = on;
        this._busy = false;
        this._icon.set_style_class_name(`system-status-icon kuro-gest-toggle-icon ${on ? 'on' : 'off'}`);
        this._icon.opacity = 255;
    }

    destroy() {
        if (this._tid)
            GLib.source_remove(this._tid);
        this._tid = 0;
        super.destroy();
    }

    vfunc_event(event) {
        const t = event.type();
        if (t === Clutter.EventType.BUTTON_RELEASE || t === Clutter.EventType.TOUCH_END) {
            if (!this._busy) {
                this._busy = true;
                this._icon.opacity = 120;               // dim while the camera starts / stops
                this._ext._spawn(['bapirlo-gestures', this._on ? 'off' : 'on']);
                this._ext._say(this._on ? '✋  Air gestures off' : '✋  Air gestures on — raise a hand');
                if (this._tid)
                    GLib.source_remove(this._tid);
                this._tid = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
                    this._tid = 0;
                    if (this._busy)
                        this.setOn(this._on);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});
