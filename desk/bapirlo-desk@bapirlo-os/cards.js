// Kuro Desk — the round-14 desktop cards (used by widgets.js):
//   NOW PLAYING  cover, title, artist of the active MPRIS player + a live visualizer. The bars
//                come from `cava` (raw ascii on stdout), which runs ONLY while the card can be
//                seen AND something is playing — otherwise there is no process at all.
//   TO-DO        a short list kept in ~/.local/state/bapirlo/desk/todo.json. Tick / remove / add
//                in edit mode (Super+Alt+E, or Super+Alt+D jumps straight to "add"); the terminal
//                has `bapirlo-todo add|done|list`. The file is watched, so both stay in step.
//   NOTES        one free-text note, ~/.local/state/bapirlo/desk/notes.txt, typed in edit mode.
//   SCREEN TIME  today's total, top apps and this week (counted by screentime.js, kept on this computer).
// Each card: {actor, setEditing(on), tick(visible), focus(), destroy()}.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {PlayerManager} from './mpris.js';
import {resolveArt} from './art.js';
import {STATE_DIR, label, readJson, writeJson} from './util.js';
import {dayKey, hm, readDay} from './screentime.js';

const TODO_FILE = GLib.build_filenamev([STATE_DIR, 'desk', 'todo.json']);
const NOTES_FILE = GLib.build_filenamev([STATE_DIR, 'desk', 'notes.txt']);
const CAVA_CONF = GLib.build_filenamev([STATE_DIR, 'desk', 'cava-widget.conf']);
const BARS = 24;
const VIZ_H = 36;
const TODO_SHOWN = 7;
const DONE_KEEP_S = 24 * 3600;   // ticked items stay (struck through) for a day, then go

function cardBox(title, extra) {
    const box = new St.BoxLayout({style_class: `bdw-card ${extra}`, orientation: Clutter.Orientation.VERTICAL});
    box.add_child(label(title, 'bdw-title', false));
    return box;
}

function watch(path, cb) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    const mon = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
    mon.connect('changed', (_m, _f, _o, ev) => {
        if (ev === Gio.FileMonitorEvent.CHANGES_DONE_HINT || ev === Gio.FileMonitorEvent.CREATED ||
            ev === Gio.FileMonitorEvent.MOVED_IN || ev === Gio.FileMonitorEvent.RENAMED ||
            ev === Gio.FileMonitorEvent.DELETED)
            cb();
    });
    return mon;
}

// is the press on something that wants the click itself (button, text field)?
export function isControl(actor, card) {
    for (let a = actor; a && a !== card; a = a.get_parent()) {
        if (a instanceof St.Button || a instanceof St.Entry || (a instanceof Clutter.Text && a.editable))
            return true;
    }
    return false;
}

// ================================================================ now playing
export class NowPlayingCard {
    constructor() {
        this._cancel = new Gio.Cancellable();
        this.actor = cardBox('NOW PLAYING', 'bdw-nowplaying');
        const row = new St.BoxLayout({style_class: 'bdw-np-row'});
        this._art = new St.Icon({style_class: 'bdw-np-art', icon_name: 'audio-x-generic-symbolic', icon_size: 56});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._title = label('Nothing playing', 'bdw-np-title');
        this._artist = label('', 'bdw-np-artist');
        this._app = label('', 'bdw-np-app');
        text.add_child(this._title);
        text.add_child(this._artist);
        text.add_child(this._app);
        row.add_child(this._art);
        row.add_child(text);
        this.actor.add_child(row);

        this._viz = new St.BoxLayout({style_class: 'bdw-viz', x_expand: true, height: VIZ_H});
        this._bars = [];
        for (let i = 0; i < BARS; i++) {
            const b = new St.Widget({style_class: 'bdw-viz-bar', x_expand: true, height: VIZ_H,
                y_align: Clutter.ActorAlign.END, scale_y: 0.05});
            b.set_pivot_point(0.5, 1);
            this._viz.add_child(b);
            this._bars.push(b);
        }
        this.actor.add_child(this._viz);

        this._players = new PlayerManager();
        this._players.connect('active-changed', () => this._follow());
        this._visible = false;
        this._follow();
    }

    _follow() {
        this._player?.disconnectObject(this);
        this._player = this._players.active;
        this._player?.connectObject('changed', () => this._draw(), 'track-changed', () => this._draw(true), this);
        this._draw(true);
    }

    _draw(track = false) {
        const p = this._player;
        if (!p?.title) {
            this._title.text = 'Nothing playing';
            this._artist.text = '';
            this._app.text = '';
            this._art.gicon = null;
            this._art.icon_name = 'audio-x-generic-symbolic';
        } else {
            this._title.text = p.title;
            this._artist.text = p.artists.join(', ');
            this._app.text = `${p.playing ? '▶' : '❚❚'}  ${p.app?.get_name() ?? p.identity}`;
            if (track)
                this._loadArt(p);
        }
        this._syncCava();
    }

    async _loadArt(p) {
        const url = p.artUrl;
        try {
            const path = await resolveArt(url, this._cancel);
            if (this._player !== p || p.artUrl !== url)
                return;
            if (path)
                this._art.gicon = Gio.FileIcon.new(Gio.File.new_for_path(path));
            else
                this._art.icon_name = p.app?.get_icon()?.to_string() ?? 'audio-x-generic-symbolic';
        } catch {}
    }

    setEditing() {}
    focus() {}

    tick(visible) {
        this._visible = visible;
        this._syncCava();
    }

    // cava only while seen + playing
    _syncCava() {
        const want = this._visible && !!this._player?.playing;
        this._viz.visible = !!this._player?.playing;
        if (want && !this._cava)
            this._startCava();
        else if (!want && this._cava)
            this._stopCava();
    }

    _startCava() {
        try {
            GLib.file_set_contents(CAVA_CONF, `# written by bapirlo-desk (cards.js) for the Now Playing card
[general]
bars = ${BARS}
framerate = 30
sleep_timer = 3
[input]
method = pipewire
source = auto
[output]
method = raw
channels = mono
raw_target = /dev/stdout
data_format = ascii
ascii_max_range = 100
bar_delimiter = 59
frame_delimiter = 10
[smoothing]
noise_reduction = 70
`);
            const proc = Gio.Subprocess.new(['cava', '-p', CAVA_CONF],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE | Gio.SubprocessFlags.STDIN_PIPE);
            const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
            const cancel = new Gio.Cancellable();
            this._cava = {proc, cancel};
            const read = () => stream.read_line_async(GLib.PRIORITY_LOW, cancel, (s, res) => {
                let line;
                try {
                    [line] = s.read_line_finish_utf8(res);
                } catch {
                    return;
                }
                if (line === null) {   // cava quit
                    if (this._cava?.proc === proc)
                        this._cava = null;
                    return;
                }
                const v = line.split(';');
                for (let i = 0; i < BARS; i++)
                    this._bars[i].scale_y = Math.max(0.05, Math.min(1, (parseInt(v[i], 10) || 0) / 100));
                read();
            });
            read();
        } catch (e) {
            logError(e, 'bapirlo-desk: cava for the Now Playing card');
            this._cava = null;
        }
    }

    _stopCava() {
        this._cava.cancel.cancel();
        this._cava.proc.force_exit();
        this._cava = null;
        for (const b of this._bars)
            b.scale_y = 0.05;
    }

    destroy() {
        if (this._cava)
            this._stopCava();
        this._cancel.cancel();
        this._player?.disconnectObject(this);
        this._players.destroy();
        this.actor.destroy();
    }
}

// ================================================================ to-do
export function readTodos() {
    const now = GLib.get_real_time() / 1e6;
    return (readJson(TODO_FILE, {})?.items ?? [])
        .filter(it => typeof it?.text === 'string' && (!it.done || now - (it.doneAt ?? now) < DONE_KEEP_S));
}

export class TodoCard {
    constructor() {
        this.actor = cardBox('TO-DO', 'bdw-todo');
        this._sub = label('', 'bdw-sub', false);
        this._list = new St.BoxLayout({style_class: 'bdw-list bdw-todo-list', orientation: Clutter.Orientation.VERTICAL});
        this._entry = new St.Entry({style_class: 'bdw-entry', hint_text: 'Add a to-do…  (Enter)', can_focus: true,
            x_expand: true, visible: false});
        this._entry.clutter_text.connect('activate', () => this._add());
        this.actor.add_child(this._sub);
        this.actor.add_child(this._list);
        this.actor.add_child(this._entry);
        this._editing = false;
        this._mon = watch(TODO_FILE, () => this._load());
        this._load();
    }

    _load() {
        this._items = readTodos();
        this._draw();
    }

    _save() {
        writeJson(TODO_FILE, {items: this._items});
        this._draw();
    }

    _add() {
        const text = this._entry.text.trim();
        if (!text)
            return;
        this._items.push({id: `${GLib.get_real_time()}`, text, done: false, at: Math.floor(GLib.get_real_time() / 1e6)});
        this._entry.text = '';
        this._save();
    }

    _draw() {
        this._list.destroy_all_children();
        const open = this._items.filter(it => !it.done);
        this._sub.text = open.length ? `${open.length} to do` : 'All done';
        const order = [...open, ...this._items.filter(it => it.done)];
        const shown = this._editing ? order : order.slice(0, TODO_SHOWN);
        if (!shown.length && !this._editing)
            this._list.add_child(label('Super+Alt+D to add one', 'bdw-empty', false));
        for (const it of shown) {
            const row = new St.BoxLayout({style_class: 'bdw-todo-item'});
            const box = new St.Button({style_class: 'bdw-check', can_focus: this._editing, reactive: this._editing,
                child: new St.Icon({icon_name: 'object-select-symbolic', icon_size: 12, opacity: it.done ? 255 : 0}),
                y_align: Clutter.ActorAlign.CENTER});
            if (it.done)
                box.add_style_pseudo_class('checked');
            box.connect('clicked', () => {
                it.done = !it.done;
                it.doneAt = it.done ? Math.floor(GLib.get_real_time() / 1e6) : undefined;
                this._save();
            });
            row.add_child(box);
            const text = label(it.text, it.done ? 'bdw-todo-text bdw-done' : 'bdw-todo-text');
            text.x_expand = true;
            row.add_child(text);
            // due day (round 23: Kuro Flow text → task, bapirlo-todo add --due)
            if (it.due && !it.done && /^\d{4}-\d\d-\d\d$/.test(it.due)) {
                const [y, mo, d] = it.due.split('-').map(Number);
                const dueDay = GLib.DateTime.new_local(y, mo, d, 0, 0, 0);
                const now = GLib.DateTime.new_now_local();
                const today = GLib.DateTime.new_local(now.get_year(), now.get_month(), now.get_day_of_month(), 0, 0, 0);
                const days = Math.round(dueDay.difference(today) / 86400e6);
                const when = days < 0 ? 'overdue' : days === 0 ? 'today' : days === 1 ? 'tomorrow'
                    : days < 7 ? dueDay.format('%a') : dueDay.format('%-d %b');
                row.add_child(label(when, days < 0 ? 'bdw-todo-due bdw-overdue' : days === 0 ? 'bdw-todo-due bdw-today' : 'bdw-todo-due'));
            }
            if (this._editing) {
                const del = new St.Button({style_class: 'bdw-todo-del', can_focus: true,
                    child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
                    y_align: Clutter.ActorAlign.CENTER});
                del.connect('clicked', () => {
                    this._items = this._items.filter(x => x !== it);
                    this._save();
                });
                row.add_child(del);
            }
            this._list.add_child(row);
        }
        if (!this._editing && order.length > TODO_SHOWN)
            this._list.add_child(label(`+ ${order.length - TODO_SHOWN} more`, 'bdw-more', false));
    }

    setEditing(on) {
        this._editing = on;
        this._entry.visible = on;
        if (!on)
            this._entry.text = '';
        this._draw();
    }

    focus() {
        global.stage.set_key_focus(this._entry);
    }

    tick() {}

    destroy() {
        this._mon.cancel();
        this.actor.destroy();
    }
}

// ================================================================ notes
export class NotesCard {
    constructor() {
        this.actor = cardBox('NOTES', 'bdw-notes');
        this._view = label('', 'bdw-notes-text', false);
        this._view.clutter_text.set({line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END});
        this._entry = new St.Entry({style_class: 'bdw-entry bdw-notes-entry', can_focus: true, x_expand: true,
            hint_text: 'Type anything…', visible: false});
        this._entry.clutter_text.set({single_line_mode: false, activatable: false, line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR, y_align: Clutter.ActorAlign.START, y_expand: true});
        this._entry.clutter_text.connect('text-changed', () => this._queueSave());
        this.actor.add_child(this._view);
        this.actor.add_child(this._entry);
        this._mon = watch(NOTES_FILE, () => {
            if (!this._saving)
                this._load();
        });
        this._load();
    }

    _read() {
        try {
            const [ok, b] = GLib.file_get_contents(NOTES_FILE);
            return ok ? new TextDecoder().decode(b) : '';
        } catch {
            return '';
        }
    }

    _load() {
        const text = this._read();
        this._view.text = text.trim() || 'Super+Alt+E, then type here';
        if (text.trim())
            this._view.remove_style_class_name('bdw-empty');
        else
            this._view.add_style_class_name('bdw-empty');
        if (!this._entry.visible)
            this._entry.text = text;
    }

    _queueSave() {
        if (!this._entry.visible || this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_LOW, 800, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _save() {
        if (this._entry.text === this._read())
            return;
        this._saving = true;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(NOTES_FILE), 0o755);
            GLib.file_set_contents(NOTES_FILE, this._entry.text);
        } catch (e) {
            logError(e, 'bapirlo-desk: saving notes');
        }
        // the monitor fires a moment later — ignore our own write
        GLib.timeout_add(GLib.PRIORITY_LOW, 1500, () => {
            this._saving = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    setEditing(on) {
        if (on) {
            this._entry.text = this._read();
        } else if (this._entry.visible) {
            if (this._saveId)
                GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._save();
        }
        this._entry.visible = on;
        this._view.visible = !on;
        this._load();
    }

    focus() {
        global.stage.set_key_focus(this._entry);
    }

    tick() {}

    destroy() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._save();
        }
        this._mon.cancel();
        this.actor.destroy();
    }
}

// ================================================================ screen time
// today's total, the top apps as bars, and this week (Monday on). Data: screentime.js
export class ScreenTimeCard {
    constructor() {
        this.actor = cardBox('SCREEN TIME', 'bdw-screentime');
        const top = new St.BoxLayout({style_class: 'bdw-st-top'});
        this._total = label('', 'bdw-st-total', false);
        this._week = label('', 'bdw-st-week', false);
        this._week.x_expand = true;
        this._week.x_align = Clutter.ActorAlign.END;
        top.add_child(this._total);
        top.add_child(this._week);
        this.actor.add_child(top);
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bdw-st-list'});
        this.actor.add_child(this._list);
        this._last = 0;
        this._load();
    }

    _load() {
        this._last = GLib.get_monotonic_time();
        const now = GLib.DateTime.new_now_local();
        const today = Object.entries(readDay(dayKey(now)).apps).sort((a, b) => b[1].s - a[1].s);
        const total = today.reduce((t, [, e]) => t + e.s, 0);
        let week = 0;
        for (let i = 0; i < now.get_day_of_week(); i++)       // 1 = Monday … 7 = Sunday
            week += Object.values(readDay(dayKey(now.add_days(-i))).apps).reduce((t, e) => t + e.s, 0);
        this._total.text = total ? hm(total) : '—';
        this._week.text = `this week ${hm(week)}`;
        this._list.destroy_all_children();
        if (!today.length) {
            this._list.add_child(label('Counts the app you\'re using, only on this computer.', 'bdw-empty', false));
            this._list.get_last_child().clutter_text.line_wrap = true;
            return;
        }
        const max = today[0][1].s;
        const sys = Shell.AppSystem.get_default();
        for (const [id, e] of today.slice(0, 4)) {
            const row = new St.BoxLayout({style_class: 'bdw-st-row'});
            const app = sys.lookup_app(id);
            row.add_child(app ? app.create_icon_texture(18) : new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 18}));
            const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            const line = new St.BoxLayout();
            const name = label(e.name, 'bdw-st-name');
            name.x_expand = true;
            line.add_child(name);
            line.add_child(label(hm(e.s), 'bdw-st-time', false));
            col.add_child(line);
            const track = new St.Widget({style_class: 'bdw-st-track', x_expand: true});
            const bar = new St.Widget({style_class: 'bdw-st-bar'});
            track.add_child(bar);
            track.connect('notify::width', () => bar.set_size(Math.max(4, Math.round(track.width * e.s / max)), track.height));
            col.add_child(track);
            row.add_child(col);
            this._list.add_child(row);
        }
    }

    setEditing() {}

    focus() {}

    tick(seen) {
        if (seen && GLib.get_monotonic_time() - this._last > 60e6)
            this._load();
    }

    destroy() {
        this.actor.destroy();
    }
}
