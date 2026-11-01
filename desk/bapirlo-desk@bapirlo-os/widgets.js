// Kuro Desk — widgets on the wallpaper (primary screen), behind every window.
//   CLOCK     big time + date
//   CALENDAR  month grid, today in the accent, a dot under days with events (Google Calendar via EDS)
//   UP NEXT   the next 7 days: events + tasks due, today/tomorrow/overdue in the accent
//   WEATHER   now + the next three days for ~/.config/bapirlo/location.json (Open-Meteo, every 30 min)
//   SYSTEM    CPU · memory · temperature · battery · free disk, small bars
//   NOW PLAYING / TO-DO / NOTES   see cards.js (live visualizer; to-do + note typed in edit mode)
// Lives in Main.layoutManager._backgroundGroup, so windows, the desktop icons' window and the
// dock all sit above it and it never takes a click. Lightweight: stats tick every 5 s ONLY while
// the desktop on the primary screen can be seen (no fullscreen / maximised window covering it,
// not in a game); the calendar only redraws on agenda changes and at midnight.
// Colours come from Theme Studio's palette (~/.local/state/bapirlo/studio/active.json), so the
// cards follow the wallpaper; the CSS is written to ~/.local/state/bapirlo/desk/widgets.css.
// EDIT MODE (Super+Alt+E, or os.bapirlo.Desk.EditWidgets): the layer lifts above the windows,
// cards drag anywhere (snapping to edges and to each other), the toolbar shows / hides each card;
// Esc, Done or a click on empty space puts it back behind the windows. Which cards show is the
// `widgets-cards` setting; dragged positions go to ~/.local/state/bapirlo/desk/widgets.json.
// DODGE (`widgets-dodge`): bapirlo-wallpaper writes where the wallpaper's subject is
// (~/.local/state/bapirlo/wallpaper/subject.json); a card that would cover it slides to the
// nearest free spot beside it (its saved spot is kept, so it comes back on the next wallpaper).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {HOME, STATE_DIR, dayName, hhmm, label, readJson, startOfDay, writeJson} from './util.js';
import {weatherOf} from './briefing.js';
import {NotesCard, NowPlayingCard, ScreenTimeCard, TodoCard, isControl} from './cards.js';

const TICK_S = 5;
const WEATHER_S = 30 * 60;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MARGIN = 24;
const GAP = 16;          // between cards in the automatic row
const SNAP = 32;         // dropped this close to an edge / a neighbour → snap to it
const DOCK_CLEAR = 96;   // keep the row above the (intellihide) dock

export const CARDS = [
    ['clock', 'Clock'],
    ['calendar', 'Calendar'],
    ['upnext', 'Up next'],
    ['weather', 'Weather'],
    ['system', 'System'],
    ['nowplaying', 'Now playing'],
    ['todo', 'To-do'],
    ['notes', 'Notes'],
    ['screentime', 'Screen time'],
];

// cards with their own object (cards.js), made only while shown
const PARTS = {nowplaying: NowPlayingCard, todo: TodoCard, notes: NotesCard, screentime: ScreenTimeCard};

const LAYOUT = GLib.build_filenamev([STATE_DIR, 'desk', 'widgets.json']);
const PALETTE = GLib.build_filenamev([STATE_DIR, 'studio', 'active.json']);
const CSS_FILE = GLib.build_filenamev([STATE_DIR, 'desk', 'widgets.css']);
const SUBJECT = GLib.build_filenamev([STATE_DIR, 'wallpaper', 'subject.json']);
const DODGE_MAX_AREA = 0.40;   // a "subject" bigger than this is scenery — nothing to dodge
const DODGE_EASE_MS = 450;
// Hanabi's video renderer is a real, screen-sized NORMAL window (the wallpaper draws a clone of it).
// mutter often won't keep it minimised and treats it as maximised, so it must never count as an app
// window covering the desktop — otherwise the cards hide whenever a live wallpaper is on.
const isRenderer = w => (w.title ?? '').includes('io.github.jeffshee.HanabiRenderer');

// Kuro defaults, used until Theme Studio has written a palette (same as stylesheet.css)
const DEFAULTS = {night: '#161015', paper: '#F2E9EC', crimson: '#E11D2E', ember: '#FF4655', sakura: '#F08AA4'};

export function readPalette() {
    const pal = {...DEFAULTS};
    const got = readJson(PALETTE, {})?.palette ?? {};
    for (const k of Object.keys(pal)) {
        if (/^#[0-9a-fA-F]{6}$/.test(got[k] ?? ''))
            pal[k] = got[k];
    }
    return pal;
}

// only colours — sizes and spacing stay in stylesheet.css. `.bdw-layer` in front of every rule
// makes these win over the extension stylesheet's Kuro colours.
function paletteCss(pal) {
    const c = (name, a = 1) => {
        const h = pal[name];
        const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
        return a === 1 ? h : `rgba(${r}, ${g}, ${b}, ${a})`;
    };
    const L = '.bdw-layer';
    return `/* written by bapirlo-desk (widgets.js) from the Theme Studio palette */
${L} .bdw-card { background-color: ${c('night', 0.84)}; border-color: ${c('crimson', 0.28)}; color: ${c('paper')}; }
${L} .bdw-card:dragging { border-color: ${c('ember', 0.9)}; }
${L} .bdw-title, ${L} .bdw-clock-time { color: ${c('ember')}; }
${L} .bdw-sub, ${L} .bdw-empty, ${L} .bdw-item-time, ${L} .bdw-clock-date, ${L} .bdw-wx-sub { color: ${c('paper', 0.62)}; }
${L} .bdw-dow, ${L} .bdw-more { color: ${c('paper', 0.5)}; }
${L} .bdw-day-num { color: ${c('paper', 0.9)}; }
${L} .bdw-other .bdw-day-num { color: ${c('paper', 0.28)}; }
${L} .bdw-today { background-color: ${c('crimson')}; box-shadow: 0 0 10px ${c('crimson', 0.55)}; }
${L} .bdw-dot { background-color: ${c('sakura')}; }
${L} .bdw-today .bdw-dot { background-color: #ffffff; }
${L} .bdw-chip { color: ${c('paper', 0.86)}; background-color: ${c('paper', 0.09)}; }
${L} .bdw-chip.bdw-urgent { color: #ffffff; background-color: ${c('crimson', 0.85)}; }
${L} .bdw-meter-name { color: ${c('paper', 0.72)}; }
${L} .bdw-track { background-color: ${c('paper', 0.10)}; }
${L} .bdw-fill { background-color: ${c('paper')}; }
${L} .bdw-fill.bdw-hot { background-color: ${c('ember')}; }
${L} .bdw-st-bar { background-color: ${c('ember')}; }
${L} .bdw-wx-icon, ${L} .bdw-wx-day-icon { color: ${c('paper')}; }
${L} .bdw-wx-day-name { color: ${c('paper', 0.6)}; }
${L}.bdw-editing { background-color: rgba(0, 0, 0, 0.38); }
${L} .bdw-edit-bar { background-color: ${c('night', 0.96)}; border-color: ${c('crimson', 0.45)}; color: ${c('paper')}; }
${L} .bdw-edit-title { color: ${c('ember')}; }
${L} .bdw-edit-hint { color: ${c('paper', 0.6)}; }
${L} .bdw-edit-chip { color: ${c('paper', 0.75)}; background-color: ${c('paper', 0.07)}; border-color: ${c('paper', 0.14)}; }
${L} .bdw-edit-chip:hover { background-color: ${c('paper', 0.14)}; }
${L} .bdw-edit-chip:checked { color: #ffffff; background-color: ${c('crimson', 0.85)}; border-color: ${c('crimson')}; }
${L} .bdw-edit-done { color: #ffffff; background-color: ${c('crimson')}; }
${L} .bdw-edit-done:hover { background-color: ${c('ember')}; }
${L} .bdw-np-art { color: ${c('paper', 0.5)}; background-color: ${c('paper', 0.06)}; }
${L} .bdw-np-artist, ${L} .bdw-np-app, ${L} .bdw-todo-text.bdw-done { color: ${c('paper', 0.6)}; }
${L} .bdw-viz-bar { background-color: ${c('ember', 0.9)}; }
${L} .bdw-check { border-color: ${c('paper', 0.45)}; color: #ffffff; }
${L} .bdw-check:checked { background-color: ${c('crimson')}; border-color: ${c('crimson')}; }
${L} .bdw-todo-del { color: ${c('paper', 0.5)}; }
${L} .bdw-todo-del:hover { color: ${c('ember')}; }
${L} .bdw-entry { color: ${c('paper')}; background-color: ${c('paper', 0.07)}; border-color: ${c('crimson', 0.4)}; }
${L} .bdw-entry:focus { border-color: ${c('ember')}; }
`;
}

function card(title) {
    const box = new St.BoxLayout({style_class: 'bdw-card', orientation: Clutter.Orientation.VERTICAL});
    box.add_child(label(title, 'bdw-title', false));
    return box;
}

function meter(name) {
    const row = new St.BoxLayout({style_class: 'bdw-meter', orientation: Clutter.Orientation.VERTICAL});
    const top = new St.BoxLayout({x_expand: true});
    top.add_child(label(name, 'bdw-meter-name', false));
    const value = label('–', 'bdw-meter-value', false);
    value.x_expand = true;
    value.x_align = Clutter.ActorAlign.END;
    top.add_child(value);
    const track = new St.Widget({style_class: 'bdw-track', x_expand: true, layout_manager: new Clutter.BinLayout()});
    const fill = new St.Widget({style_class: 'bdw-fill', x_expand: true, y_expand: true,
        x_align: Clutter.ActorAlign.START});
    track.add_child(fill);
    row.add_child(top);
    row.add_child(track);
    let last = 0;
    const draw = () => {
        if (track.width > 0)
            fill.width = Math.max(4, Math.round(track.width * last));
    };
    track.connect('notify::width', draw);   // the first values arrive before the first layout
    return {row, value, track, fill, set(frac, text, hot = false) {
        value.text = text;
        last = Math.min(1, Math.max(0, frac));
        draw();
        if (hot)
            fill.add_style_class_name('bdw-hot');
        else
            fill.remove_style_class_name('bdw-hot');
    }};
}

export class DeskWidgets {
    constructor(settings, agenda) {
        this._settings = settings;
        this._agenda = agenda;
        this._cancel = new Gio.Cancellable();
        this._prevCpu = null;
        this._tempPath = this._findTemp();
        this._batPath = this._findBattery();
        this._layout = readJson(LAYOUT, {})?.cards ?? {};
        this._editing = false;
        this._drag = null;
        this._cssFile = null;
        this._weatherAt = 0;

        this.actor = new St.Widget({style_class: 'bdw-layer', reactive: false});
        this._cards = {};
        this._parts = {};
        this._buildClock();
        this._buildCalendar();
        this._buildUpNext();
        this._buildWeather();
        this._buildSystem();
        for (const [id, c] of Object.entries(this._cards)) {
            this.actor.add_child(c);
            this._makeDraggable(id, c);
            c.connect('notify::size', () => this._queuePlace());
        }
        Main.layoutManager._backgroundGroup.add_child(this.actor);

        Main.layoutManager.connectObject('monitors-changed', () => this._queuePlace(), this);
        this._settings.connectObject(
            'changed::widgets-corner', () => this._queuePlace(),
            'changed::widgets-dodge', () => this._queuePlace(true),
            'changed::widgets-cards', () => this._syncCards(), this);
        // the background group gets rebuilt (wallpaper change, monitors) — stay on top of it
        Main.layoutManager._backgroundGroup.connectObject('child-added', (g, child) => {
            if (child !== this.actor && this.actor.get_parent() === g)
                g.set_child_above_sibling(this.actor, null);
        }, this);
        Main.sessionMode.connectObject('updated', () => {
            if (Main.sessionMode.isLocked)
                this.endEdit();
        }, this);
        this._agenda.connectObject('changed', () => this._syncAgenda(), this);
        this._agenda.hold();

        this._palMonitor = Gio.File.new_for_path(PALETTE).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._palMonitor.connect('changed', () => this._queueTheme());
        this._subjectMonitor = Gio.File.new_for_path(SUBJECT).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._subjectMonitor.connect('changed', () => this._queuePlace(true));
        this._applyTheme();

        this._syncCards();
        this._syncAgenda();
        this._scheduleMidnight();
        this._scheduleClock();
        this._tick();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, TICK_S, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ------------------------------------------------------------ theme
    _queueTheme() {
        if (this._themeId)
            return;
        this._themeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._themeId = 0;
            this._applyTheme();
            this._reloadLayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Theme Studio swaps in the new wallpaper's saved layout right before it writes the palette
    _reloadLayout() {
        if (this._editing)
            return;
        this._layout = readJson(LAYOUT, {})?.cards ?? {};
        this._queuePlace();
    }

    _applyTheme() {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        if (this._cssFile)
            theme.unload_stylesheet(this._cssFile);
        this._cssFile = null;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(CSS_FILE), 0o755);
            GLib.file_set_contents(CSS_FILE, paletteCss(readPalette()));
            const file = Gio.File.new_for_path(CSS_FILE);
            theme.load_stylesheet(file);
            this._cssFile = file;
        } catch (e) {
            logError(e, 'bapirlo-desk: widget palette stylesheet');
        }
    }

    // ------------------------------------------------------------ which cards, where
    _shown() {
        const want = this._settings.get_strv('widgets-cards');
        return CARDS.map(([id]) => id).filter(id => want.includes(id));
    }

    _syncCards() {
        const shown = this._shown();
        for (const [id, Part] of Object.entries(PARTS)) {
            if (shown.includes(id) && !this._parts[id]) {
                const part = new Part();
                this._parts[id] = part;
                this._cards[id] = part.actor;
                this.actor.insert_child_below(part.actor, this._bar ?? null);
                this._makeDraggable(id, part.actor);
                part.actor.connect('notify::size', () => this._queuePlace());
                part.setEditing(this._editing);
            } else if (!shown.includes(id) && this._parts[id]) {
                this._parts[id].destroy();
                delete this._parts[id];
                delete this._cards[id];
            }
        }
        for (const [id, c] of Object.entries(this._cards))
            c.visible = shown.includes(id);
        for (const [id, chip] of Object.entries(this._chips ?? {}))
            chip.checked = shown.includes(id);
        if (shown.includes('weather'))
            this._weather();
        this._queuePlace();
    }

    _queuePlace(animate = false) {
        this._animate ||= animate;
        if (this._placeLater)
            return;
        // never move actors from inside a size notification — do it right before the next frame
        this._placeLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._placeLater = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    // the area cards may use, in layer coordinates (the layer covers the primary monitor)
    _bounds() {
        const m = Main.layoutManager.primaryMonitor;
        return {w: m.width, h: m.height, top: Main.panel.height + MARGIN, bottom: m.height - DOCK_CLEAR};
    }

    _place() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m)
            return;
        this.actor.set_position(m.x, m.y);
        this.actor.set_size(m.width, m.height);
        const b = this._bounds();
        const shown = this._shown();
        // cards that were dragged keep their spot (fractions of the free space, so a new
        // resolution keeps them in the same corner); the rest line up from the chosen corner
        const auto = [];
        for (const id of shown) {
            const c = this._cards[id];
            const p = this._layout[id];
            if (!p) {
                auto.push(id);
                continue;
            }
            const [w, h] = [c.width, c.height];
            c.set_position(Math.round(MARGIN + p.fx * Math.max(0, b.w - w - 2 * MARGIN)),
                Math.round(b.top + p.fy * Math.max(0, b.bottom - h - b.top)));
        }
        const corner = this._settings.get_string('widgets-corner');
        const right = corner.endsWith('right');
        const top = corner.startsWith('top');
        let along = MARGIN;
        for (const id of right ? auto.reverse() : auto) {
            const c = this._cards[id];
            const [w, h] = [c.width, c.height];
            c.set_position(Math.round(right ? b.w - along - w : along), Math.round(top ? b.top : b.bottom - h));
            along += w + GAP;
        }
        this._dodge(b, shown);
        if (this._bar)
            this._bar.set_position(Math.round((b.w - this._bar.width) / 2), Main.panel.height + MARGIN);
    }

    // the wallpaper's subject in layer coordinates, or null (off, editing, unknown, or too big)
    _subjectRect() {
        if (this._editing || !this._settings.get_boolean('widgets-dodge'))
            return null;
        const box = readJson(SUBJECT, null)?.box;
        if (!Array.isArray(box) || box.length !== 4 || box.some(v => typeof v !== 'number'))
            return null;
        const [x0, y0, x1, y1] = box;
        if (x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) > DODGE_MAX_AREA)
            return null;
        const m = Main.layoutManager.primaryMonitor;
        return {x: x0 * m.width, y: y0 * m.height, w: (x1 - x0) * m.width, h: (y1 - y0) * m.height};
    }

    // _place() has put every card on its own spot; move the ones covering the subject
    _dodge(b, shown) {
        const animate = this._animate;
        this._animate = false;
        const cards = shown.map(id => this._cards[id]).filter(c => c?.visible);
        const target = new Map(cards.map(c => [c, {x: c.x, y: c.y, w: c.width, h: c.height}]));
        const r = this._subjectRect();
        if (r) {
            const hit = (a, q, pad = 0) => a.x < q.x + q.w + pad && q.x < a.x + a.w + pad &&
                a.y < q.y + q.h + pad && q.y < a.y + a.h + pad;
            const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
            const taken = cards.filter(c => !hit(target.get(c), r)).map(c => target.get(c));
            for (const c of cards.filter(k => hit(target.get(k), r))) {
                const a = target.get(c);
                const xs = [r.x - a.w - GAP, r.x + r.w + GAP];
                const ys = [r.y - a.h - GAP, r.y + r.h + GAP];
                const tries = [...xs.map(x => ({x, y: a.y})), ...ys.map(y => ({x: a.x, y})),
                    ...xs.flatMap(x => ys.map(y => ({x, y})))];
                let best = null, bestD = Infinity;
                for (const p of tries) {
                    const q = {x: clamp(p.x, MARGIN, b.w - a.w - MARGIN), y: clamp(p.y, b.top, b.bottom - a.h), w: a.w, h: a.h};
                    if (hit(q, r) || taken.some(t => hit(q, t, GAP / 2)))
                        continue;
                    const d = Math.hypot(q.x - a.x, q.y - a.y);
                    if (d < bestD) {
                        bestD = d;
                        best = q;
                    }
                }
                target.set(c, best ?? a);       // nowhere free: stay put rather than pile up
                taken.push(best ?? a);
            }
        }
        // put cards back where _place() left them first, then glide the moved ones (or jump, on layout changes)
        for (const [c, t] of target) {
            const [x, y] = [Math.round(t.x), Math.round(t.y)];
            if (c._bdwDodgeAt && animate && !this._editing) {
                const [fx, fy] = c._bdwDodgeAt;
                c.set_position(fx, fy);
                c.ease({x, y, duration: DODGE_EASE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else if (c.x !== x || c.y !== y) {
                c.remove_transition('x');
                c.remove_transition('y');
                c.set_position(x, y);
            }
            c._bdwDodgeAt = [x, y];
        }
    }

    _savePosition(id, x, y) {
        const c = this._cards[id];
        const b = this._bounds();
        const fw = Math.max(1, b.w - c.width - 2 * MARGIN);
        const fh = Math.max(1, b.bottom - c.height - b.top);
        const clamp = v => Math.min(1, Math.max(0, v));
        this._layout[id] = {fx: clamp((x - MARGIN) / fw), fy: clamp((y - b.top) / fh)};
        writeJson(LAYOUT, {cards: this._layout});
    }

    // ------------------------------------------------------------ edit mode
    get editing() {
        return this._editing;
    }

    toggleEdit() {
        if (this._editing)
            this.endEdit();
        else
            this.edit();
    }

    edit() {
        if (this._editing || Main.sessionMode.isLocked)
            return;
        this._editing = true;
        // up out of the wallpaper, just above the windows (still under the panel, overview, dialogs)
        Main.layoutManager._backgroundGroup.remove_child(this.actor);
        Main.layoutManager.uiGroup.insert_child_above(this.actor, global.window_group);
        this.actor.add_style_class_name('bdw-editing');
        this.actor.reactive = true;
        for (const c of Object.values(this._cards))
            c.reactive = true;
        for (const part of Object.values(this._parts))
            part.setEditing(true);
        this._buildEditBar();
        this._grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});
        global.stage.set_key_focus(this.actor);
        this.actor.connectObject(
            'key-press-event', (_a, ev) => {
                const key = ev.get_key_symbol();
                if (key === Clutter.KEY_Escape || key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
                    this.endEdit();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            },
            // a click on the empty, dimmed desktop is "done" too (presses on buttons bubble up here)
            'button-press-event', (_a, ev) => {
                if (global.stage.get_event_actor(ev) !== this.actor)
                    return Clutter.EVENT_PROPAGATE;
                this.endEdit();
                return Clutter.EVENT_STOP;
            }, this);
        this._queuePlace();
    }

    endEdit() {
        if (!this._editing)
            return;
        this._endDrag(false);
        this._editing = false;
        this.actor.disconnectObject(this);
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._bar?.destroy();
        this._bar = null;
        this._chips = null;
        for (const c of Object.values(this._cards))
            c.reactive = false;
        for (const part of Object.values(this._parts))
            part.setEditing(false);
        this.actor.reactive = false;
        this.actor.remove_style_class_name('bdw-editing');
        this.actor.get_parent()?.remove_child(this.actor);
        Main.layoutManager._backgroundGroup.add_child(this.actor);
        this._queuePlace();
        this._tick();
    }

    // Super+Alt+D: show the To-do card if needed, open edit mode, cursor in "Add a to-do…"
    quickTodo() {
        const want = this._settings.get_strv('widgets-cards');
        if (!want.includes('todo'))
            this._settings.set_strv('widgets-cards', [...want, 'todo']);   // _syncCards runs from changed::
        this.edit();
        this._parts.todo?.focus();
    }

    _buildEditBar() {
        const bar = new St.BoxLayout({style_class: 'bdw-edit-bar', orientation: Clutter.Orientation.VERTICAL});
        const row = new St.BoxLayout({style_class: 'bdw-edit-row'});
        row.add_child(label('WIDGETS', 'bdw-edit-title', false));
        this._chips = {};
        const shown = this._shown();
        for (const [id, name] of CARDS) {
            const chip = new St.Button({style_class: 'bdw-edit-chip', label: name, toggle_mode: true,
                checked: shown.includes(id), can_focus: true});
            chip.connect('clicked', () => {
                const now = this._settings.get_strv('widgets-cards').filter(x => x !== id);
                if (chip.checked)
                    now.push(id);
                this._settings.set_strv('widgets-cards', now);
            });
            this._chips[id] = chip;
            row.add_child(chip);
        }
        const reset = new St.Button({style_class: 'bdw-edit-chip bdw-edit-reset', label: 'Reset layout', can_focus: true});
        reset.connect('clicked', () => {
            this._layout = {};
            writeJson(LAYOUT, {cards: {}});
            this._queuePlace();
        });
        row.add_child(reset);
        const done = new St.Button({style_class: 'bdw-edit-done', label: 'Done', can_focus: true});
        done.connect('clicked', () => this.endEdit());
        row.add_child(done);
        bar.add_child(row);
        bar.add_child(label('Drag the cards anywhere · click a name to show or hide it · type in To-do / Notes · Esc when done',
            'bdw-edit-hint', false));
        bar.connect('notify::width', () => this._queuePlace());
        this.actor.add_child(bar);
        this._bar = bar;
    }

    // press → stage grab on the card; it follows the pointer until release, then snaps
    _makeDraggable(id, c) {
        c.connect('button-press-event', (_a, ev) => {
            if (!this._editing || this._drag || ev.get_button() !== Clutter.BUTTON_PRIMARY ||
                isControl(global.stage.get_event_actor(ev), c))
                return Clutter.EVENT_PROPAGATE;
            const [sx, sy] = ev.get_coords();
            this._drag = {id, c, dx: sx - this.actor.x - c.x, dy: sy - this.actor.y - c.y, grab: global.stage.grab(c)};
            this.actor.set_child_above_sibling(c, this._bar ?? null);
            c.add_style_pseudo_class('dragging');
            global.stage.set_cursor_type(Clutter.CursorType.GRABBING);
            return Clutter.EVENT_STOP;
        });
        c.connect('motion-event', (_a, ev) => {
            const d = this._drag;
            if (d?.c !== c)
                return Clutter.EVENT_PROPAGATE;
            if (!(ev.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                this._endDrag(true);   // the release went somewhere else (grab broken)
                return Clutter.EVENT_STOP;
            }
            const [sx, sy] = ev.get_coords();
            const b = this._bounds();
            c.set_position(
                Math.round(Math.min(Math.max(sx - this.actor.x - d.dx, 0), b.w - c.width)),
                Math.round(Math.min(Math.max(sy - this.actor.y - d.dy, Main.panel.height), b.h - c.height)));
            return Clutter.EVENT_STOP;
        });
        c.connect('button-release-event', (_a, ev) => {
            if (this._drag?.c !== c || ev.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._endDrag(true);
            return Clutter.EVENT_STOP;
        });
    }

    _endDrag(keep) {
        const d = this._drag;
        if (!d)
            return;
        this._drag = null;
        d.grab?.dismiss();
        d.c.remove_style_pseudo_class('dragging');
        global.stage.set_cursor_type(Clutter.CursorType.DEFAULT);
        if (!keep)
            return;
        const [x, y] = this._snap(d.id, d.c.x, d.c.y);
        d.c.ease({x, y, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._savePosition(d.id, x, y);
    }

    // screen edges first, then line up with the other cards (same top / bottom / left, or side by side)
    _snap(id, x, y) {
        const c = this._cards[id];
        const [w, h] = [c.width, c.height];
        const b = this._bounds();
        x = Math.min(Math.max(x, MARGIN), b.w - w - MARGIN);
        y = Math.min(Math.max(y, b.top), b.bottom - h);
        let [bx, by] = [SNAP, SNAP];
        const tryX = v => {
            if (Math.abs(v - x) < bx)
                [bx, x] = [Math.abs(v - x), v];
        };
        const tryY = v => {
            if (Math.abs(v - y) < by)
                [by, y] = [Math.abs(v - y), v];
        };
        const [x0, y0] = [x, y];
        tryX(MARGIN);
        tryX(b.w - w - MARGIN);
        tryY(b.top);
        tryY(b.bottom - h);
        for (const [oid, o] of Object.entries(this._cards)) {
            if (oid === id || !o.visible)
                continue;
            // only neighbours that overlap on the other axis count, so far-away cards don't pull
            const sameRow = y0 < o.y + o.height + SNAP && y0 + h > o.y - SNAP;
            const sameCol = x0 < o.x + o.width + SNAP && x0 + w > o.x - SNAP;
            if (sameRow) {
                tryX(o.x + o.width + GAP);
                tryX(o.x - w - GAP);
                tryY(o.y);
                tryY(o.y + o.height - h);
            }
            if (sameCol) {
                tryX(o.x);
                tryY(o.y + o.height + GAP);
                tryY(o.y - h - GAP);
            }
        }
        return [Math.round(x), Math.round(y)];
    }

    // ------------------------------------------------------------ clock
    _buildClock() {
        const c = new St.BoxLayout({style_class: 'bdw-card bdw-clock', orientation: Clutter.Orientation.VERTICAL});
        this._clockTime = label('', 'bdw-clock-time', false);
        this._clockDate = label('', 'bdw-clock-date', false);
        c.add_child(this._clockTime);
        c.add_child(this._clockDate);
        this._cards.clock = c;
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._iface.connectObject('changed::clock-format', () => this._drawClock(), this);
    }

    _drawClock() {
        const now = new Date();
        if (this._iface.get_string('clock-format') === '12h') {
            const h = now.getHours() % 12 || 12;
            this._clockTime.text = `${h}:${String(now.getMinutes()).padStart(2, '0')} ${now.getHours() < 12 ? 'AM' : 'PM'}`;
        } else {
            this._clockTime.text = hhmm(now);
        }
        this._clockDate.text = `${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`;
    }

    // redraw on the minute (a one-shot per minute, re-armed each time, so it never drifts)
    _scheduleClock() {
        this._drawClock();
        const now = new Date();
        const ms = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50;
        this._clockId = GLib.timeout_add(GLib.PRIORITY_LOW, ms, () => {
            this._clockId = 0;
            this._scheduleClock();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------ calendar
    _buildCalendar() {
        const c = card('');
        c.add_style_class_name('bdw-calendar');
        this._calTitle = c.get_first_child();
        this._calYear = label('', 'bdw-sub', false);
        this._grid = new St.Widget({style_class: 'bdw-grid', layout_manager: new Clutter.GridLayout({
            column_homogeneous: true, row_homogeneous: true})});
        c.add_child(this._calYear);
        c.add_child(this._grid);
        this._cards.calendar = c;
    }

    _drawCalendar() {
        const now = new Date();
        const today = startOfDay(now);
        this._calTitle.text = MONTHS[now.getMonth()].toUpperCase();
        this._calYear.text = `${now.getFullYear()}`;
        this._grid.destroy_all_children();
        const gl = this._grid.layout_manager;
        ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((d, i) =>
            gl.attach(label(d, 'bdw-dow', false), i, 0, 1, 1));
        const first = new Date(now.getFullYear(), now.getMonth(), 1);
        const lead = (first.getDay() + 6) % 7;   // Monday first (UK)
        const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
        const weeks = Math.ceil((lead + new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) / 7);
        for (let i = 0; i < weeks * 7; i++) {
            const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            const cell = new St.BoxLayout({style_class: 'bdw-day', orientation: Clutter.Orientation.VERTICAL,
                x_align: Clutter.ActorAlign.CENTER});
            const num = label(`${d.getDate()}`, 'bdw-day-num', false);
            num.x_align = Clutter.ActorAlign.CENTER;
            if (d.getMonth() !== now.getMonth())
                cell.add_style_class_name('bdw-other');
            if (d.getTime() === today.getTime())
                cell.add_style_class_name('bdw-today');
            cell.add_child(num);
            const dot = new St.Widget({style_class: 'bdw-dot', x_align: Clutter.ActorAlign.CENTER,
                opacity: this._agenda.hasEventsOn(d) ? 255 : 0});
            cell.add_child(dot);
            gl.attach(cell, i % 7, 1 + Math.floor(i / 7), 1, 1);
        }
    }

    // ------------------------------------------------------------ up next
    _buildUpNext() {
        const c = card('UP NEXT');
        c.add_style_class_name('bdw-upnext');
        this._sub = label('Next 7 days', 'bdw-sub', false);
        this._list = new St.BoxLayout({style_class: 'bdw-list', orientation: Clutter.Orientation.VERTICAL});
        c.add_child(this._sub);
        c.add_child(this._list);
        this._cards.upnext = c;
    }

    _drawUpNext() {
        this._list.destroy_all_children();
        const now = new Date();
        const items = this._agenda.upcoming(7, now);
        if (!this._agenda.loaded) {
            this._list.add_child(label('Reading your calendar…', 'bdw-empty'));
            return;
        }
        if (items.length === 0) {
            this._list.add_child(label('Nothing due this week', 'bdw-empty'));
            return;
        }
        for (const it of items.slice(0, 5)) {
            const row = new St.BoxLayout({style_class: 'bdw-item'});
            const day = dayName(it.when, now);
            const chip = label(it.overdue ? 'Overdue' : day, 'bdw-chip', false);
            if (it.overdue || day === 'Today' || day === 'Tomorrow')
                chip.add_style_class_name('bdw-urgent');
            row.add_child(chip);
            const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            text.add_child(label(it.summary, 'bdw-item-title'));
            text.add_child(label(it.kind === 'task' ? 'Due' : it.allDay ? 'All day' : hhmm(it.when), 'bdw-item-time', false));
            row.add_child(text);
            this._list.add_child(row);
        }
        if (items.length > 5)
            this._list.add_child(label(`+ ${items.length - 5} more`, 'bdw-more', false));
    }

    _syncAgenda() {
        this._drawCalendar();
        this._drawUpNext();
    }

    _scheduleMidnight() {
        const now = new Date();
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
        this._midnight = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, Math.ceil((next - now) / 1000), () => {
            this._agenda.refresh();
            this._syncAgenda();
            this._scheduleMidnight();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------ weather
    _buildWeather() {
        const c = card('WEATHER');
        c.add_style_class_name('bdw-weather');
        this._wxPlace = label('', 'bdw-sub', false);
        const now = new St.BoxLayout({style_class: 'bdw-wx-now'});
        this._wxIcon = new St.Icon({icon_name: 'weather-few-clouds-symbolic', style_class: 'bdw-wx-icon'});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._wxTemp = label('–', 'bdw-wx-temp', false);
        this._wxSub = label('Weather…', 'bdw-wx-sub');
        text.add_child(this._wxTemp);
        text.add_child(this._wxSub);
        now.add_child(this._wxIcon);
        now.add_child(text);
        this._wxDays = new St.BoxLayout({style_class: 'bdw-wx-days', x_expand: true});
        c.add_child(this._wxPlace);
        c.add_child(now);
        c.add_child(this._wxDays);
        this._cards.weather = c;
        this._soup = new Soup.Session({timeout: 10});
    }

    // at most every 30 min, and only while the card is on (the 5 s tick calls this)
    _weather() {
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._wxBusy || (this._weatherAt && now - this._weatherAt < WEATHER_S) ||
            !this._shown().includes('weather'))
            return;
        const loc = readJson(`${HOME}/.config/bapirlo/location.json`, null);
        if (!loc) {
            this._wxPlace.text = '';
            this._wxSub.text = 'No location set';
            return;
        }
        this._wxPlace.text = loc.name;
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
            '&current=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,' +
            'precipitation_probability_max&forecast_days=4&timezone=auto';
        const msg = Soup.Message.new('GET', url);
        this._wxBusy = true;
        this._soup.send_and_read_async(msg, GLib.PRIORITY_LOW, this._cancel, (s, res) => {
            this._wxBusy = false;
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== 200)
                    throw new Error(`HTTP ${msg.get_status()}`);
                const d = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                this._weatherAt = GLib.get_monotonic_time() / 1e6;
                const [text, icon] = weatherOf(d.current.weather_code, d.current.is_day === 1);
                this._wxIcon.icon_name = icon;
                this._wxTemp.text = `${Math.round(d.current.temperature_2m)}°`;
                this._wxSub.text = `${text} · H ${Math.round(d.daily.temperature_2m_max[0])}°  L ${Math.round(d.daily.temperature_2m_min[0])}°` +
                    ` · rain ${d.daily.precipitation_probability_max[0] ?? 0}%`;
                this._wxDays.destroy_all_children();
                for (let i = 1; i < Math.min(4, d.daily.time.length); i++) {
                    const day = new St.BoxLayout({style_class: 'bdw-wx-day', orientation: Clutter.Orientation.VERTICAL,
                        x_expand: true});
                    const when = new Date(`${d.daily.time[i]}T12:00`);
                    const name = label(DAYS[when.getDay()].slice(0, 3), 'bdw-wx-day-name', false);
                    const ic = new St.Icon({icon_name: weatherOf(d.daily.weather_code[i])[1], style_class: 'bdw-wx-day-icon',
                        x_align: Clutter.ActorAlign.CENTER});
                    const t = label(`${Math.round(d.daily.temperature_2m_max[i])}° ${Math.round(d.daily.temperature_2m_min[i])}°`,
                        'bdw-wx-day-temp', false);
                    for (const a of [name, t])
                        a.x_align = Clutter.ActorAlign.CENTER;
                    day.add_child(name);
                    day.add_child(ic);
                    day.add_child(t);
                    this._wxDays.add_child(day);
                }
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    this._wxSub.text = 'Weather unavailable (offline?)';
                    this._weatherAt = GLib.get_monotonic_time() / 1e6 - WEATHER_S + 300;   // retry in 5 min
                }
            }
        });
    }

    // ------------------------------------------------------------ system
    _buildSystem() {
        const c = card('SYSTEM');
        c.add_style_class_name('bdw-system');
        this._host = label(GLib.get_host_name(), 'bdw-sub', false);
        c.add_child(this._host);
        this._cpu = meter('CPU');
        this._mem = meter('Memory');
        this._temp = meter('Temperature');
        this._bat = meter('Battery');
        this._disk = meter('Disk free');
        for (const m of [this._cpu, this._mem, this._temp, this._bat, this._disk])
            c.add_child(m.row);
        if (!this._batPath)
            this._bat.row.hide();
        this._cards.system = c;
    }

    _findTemp() {
        // Intel package temperature (coretemp "Package id 0"), else the x86_pkg_temp zone
        try {
            const dir = Gio.File.new_for_path('/sys/class/hwmon');
            const en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (let info; (info = en.next_file(null));) {
                const base = `/sys/class/hwmon/${info.get_name()}`;
                const [, name] = GLib.file_get_contents(`${base}/name`);
                if (new TextDecoder().decode(name).trim() === 'coretemp')
                    return `${base}/temp1_input`;
            }
        } catch {}
        for (let i = 0; i < 16; i++) {
            try {
                const [, t] = GLib.file_get_contents(`/sys/class/thermal/thermal_zone${i}/type`);
                if (new TextDecoder().decode(t).trim() === 'x86_pkg_temp')
                    return `/sys/class/thermal/thermal_zone${i}/temp`;
            } catch {
                break;
            }
        }
        return null;
    }

    _findBattery() {
        for (const n of ['BAT0', 'BAT1', 'BAT2']) {
            const base = `/sys/class/power_supply/${n}`;
            if (GLib.file_test(`${base}/capacity`, GLib.FileTest.EXISTS))
                return base;
        }
        return null;
    }

    _desktopVisible() {
        if (Main.sessionMode.isLocked)
            return false;
        if (this._editing)
            return true;
        const primary = Main.layoutManager.primaryIndex;
        const ws = global.workspace_manager.get_active_workspace();
        // only real app windows count (DING's desktop window is a maximised DESKTOP-type window)
        return !ws.list_windows().some(w => !w.minimized && w.get_window_type() === Meta.WindowType.NORMAL &&
            !isRenderer(w) && w.get_monitor() === primary &&
            (w.is_fullscreen() || w.is_maximized()));
    }

    _read(path) {
        try {
            const [ok, b] = GLib.file_get_contents(path);
            return ok ? new TextDecoder().decode(b) : '';
        } catch {
            return '';
        }
    }

    _tick() {
        const seen = this._desktopVisible();
        for (const part of Object.values(this._parts))
            part.tick(seen);
        if (!seen)
            return;
        this._weather();
        if (!this._cards.system.visible)
            return;
        // CPU (all cores, since last tick)
        const f = this._read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
        const idle = f[3] + (f[4] ?? 0);
        const total = f.reduce((a, b) => a + b, 0);
        if (this._prevCpu) {
            const dt = total - this._prevCpu.total;
            const busy = dt > 0 ? 1 - (idle - this._prevCpu.idle) / dt : 0;
            this._cpu.set(busy, `${Math.round(busy * 100)} %`, busy > 0.85);
        }
        this._prevCpu = {idle, total};
        // memory
        const mi = {};
        for (const line of this._read('/proc/meminfo').split('\n')) {
            const [k, v] = line.split(':');
            if (v)
                mi[k] = parseInt(v, 10);
        }
        if (mi.MemTotal) {
            const used = 1 - mi.MemAvailable / mi.MemTotal;
            this._mem.set(used, `${((mi.MemTotal - mi.MemAvailable) / 1048576).toFixed(1)} / ${(mi.MemTotal / 1048576).toFixed(0)} GB`, used > 0.9);
        }
        // temperature
        if (this._tempPath) {
            const c = parseInt(this._read(this._tempPath), 10) / 1000;
            if (c > 0)
                this._temp.set((c - 30) / 70, `${Math.round(c)} °C`, c >= 85);
        } else {
            this._temp.row.hide();
        }
        // battery (sysfs, no D-Bus round trip)
        if (this._batPath) {
            const pct = parseInt(this._read(`${this._batPath}/capacity`), 10);
            const status = this._read(`${this._batPath}/status`).trim();
            if (pct >= 0) {
                const note = {Charging: ' · charging', Full: ' · full', 'Not charging': ' · plugged in'}[status] ?? '';
                this._bat.set(pct / 100, `${pct} %${note}`, pct <= 20 && status === 'Discharging');
            }
        }
        // disk (async; the root filesystem)
        Gio.File.new_for_path('/').query_filesystem_info_async('filesystem::free,filesystem::size',
            GLib.PRIORITY_LOW, this._cancel, (file, res) => {
                try {
                    const info = file.query_filesystem_info_finish(res);
                    const free = info.get_attribute_uint64('filesystem::free');
                    const size = info.get_attribute_uint64('filesystem::size');
                    this._disk.set(free / size, `${(free / 1e9).toFixed(0)} GB`, free < 15e9);
                } catch {}
            });
    }

    destroy() {
        this.endEdit();
        for (const part of Object.values(this._parts))
            part.destroy();
        this._parts = {};
        this._cancel.cancel();
        for (const id of [this._timer, this._midnight, this._clockId, this._themeId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._timer = this._midnight = this._clockId = this._themeId = 0;
        if (this._placeLater)
            global.compositor.get_laters().remove(this._placeLater);
        this._placeLater = 0;
        this._palMonitor.cancel();
        this._subjectMonitor.cancel();
        if (this._cssFile)
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._cssFile);
        this._cssFile = null;
        this._iface.disconnectObject(this);
        this._agenda.disconnectObject(this);
        this._agenda.release();
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager._backgroundGroup.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        global.display.disconnectObject(this);
        this.actor.destroy();
    }
}
