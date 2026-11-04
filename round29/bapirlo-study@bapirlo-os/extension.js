// Kuro Study — your Lectern studies in the top bar (GNOME Shell 50/51). Replaces Kuro Creature + Kuro Optics.
//   · a chip in the top bar shows the one thing that matters now: the class starting soon (or running),
//     else how many flashcards are due, else the nearest deadline this week
//   · click it: this week, today's classes (room + time), deadlines with days left, cards due per module,
//     Lectern's plan for today, and "Focus on…" — starts a Kuro Bar focus block that is written into
//     Lectern's study log for that module when it ends
//   · Focus Lock (lockdown.js): during a focus block every app but Lectern is blocked; the iPhone side is
//     ~/bapirlo-os/bin/kuro-phone-focus (an iOS Shortcuts automation asks it whether you're in focus)
//   · Super+Shift+X: select text anywhere (a slide, a PDF, a web page), press it → a flashcard dialog with the
//     text already in. Short text becomes the question, longer text the answer. Pick the module, Enter = save.
// All data work is done by ~/bapirlo-os/bin/kuro-study, which reads Lectern's files and only ever writes
// to them while Lectern is closed (new cards / focus time wait in a queue until then; backups first).
// Off switch: gnome-extensions disable bapirlo-study@bapirlo-os
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FocusLock} from './lockdown.js';

const TOOL = GLib.build_filenamev([GLib.get_home_dir(), 'bapirlo-os', 'bin', 'kuro-study']);
const REFRESH_S = 60;
const SHORT = 90;                       // selections up to this long (one line) become the question

function run(argv) {
    return new Promise(resolve => {
        try {
            const p = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            p.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    const [, out, err] = proc.communicate_utf8_finish(res);
                    resolve({ok: proc.get_successful(), out: out ?? '', err: err ?? ''});
                } catch (e) {
                    resolve({ok: false, out: '', err: String(e)});
                }
            });
        } catch (e) {
            resolve({ok: false, out: '', err: String(e)});
        }
    });
}

function mins(s) {
    s = Math.max(0, Math.round(s / 60));
    return s < 60 ? `${s}m` : `${Math.floor(s / 60)}h${s % 60 ? ` ${s % 60}m` : ''}`;
}

function daysText(d) {
    return d < 0 ? 'overdue' : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `${d} days`;
}

function short(t, n) {
    t = (t || '').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function dot(color) {
    return new St.Widget({style_class: 'ks-dot', style: `background-color: ${color};`,
        y_align: Clutter.ActorAlign.CENTER});
}

// a menu row: coloured dot · main text · dim text on the right
const Row = GObject.registerClass(
class Row extends PopupMenu.PopupBaseMenuItem {
    _init(color, text, side, params = {}) {
        super._init({reactive: !!params.onActivate, can_focus: !!params.onActivate,
            style_class: `ks-row ${params.style ?? ''}`});
        if (color)
            this.add_child(dot(color));
        this.label = new St.Label({text, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ks-row-text'});
        this.label.clutter_text.ellipsize = 3;  // END
        this.add_child(this.label);
        if (side)
            this.add_child(new St.Label({text: side, style_class: 'ks-row-side', y_align: Clutter.ActorAlign.CENTER}));
        if (params.onActivate)
            this.connect('activate', params.onActivate);
    }
});

const StudyButton = GObject.registerClass(
class StudyButton extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Kuro Study');
        this._ext = ext;
        this.add_style_class_name('ks-button');
        const box = new St.BoxLayout({style_class: 'ks-chip'});
        this._icon = new St.Icon({icon_name: 'accessories-dictionary-symbolic', style_class: 'system-status-icon ks-icon'});
        this._label = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'ks-label'});
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);
        this.menu.actor.add_style_class_name('ks-menu');
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                ext.refresh();
        });
        this.update(null);
    }

    _section(title) {
        const h = new PopupMenu.PopupMenuItem(title, {reactive: false, style_class: 'ks-head'});
        this.menu.addMenuItem(h);
    }

    update(s) {
        this._s = s;
        this._updateChip(s);
        this.menu.removeAll();
        if (!s || !s.ok) {
            this.menu.addMenuItem(new Row(null, s ? 'Lectern has no data yet' : 'Reading Lectern…', ''));
            this.menu.addAction('Open Lectern', () => this._ext.openLectern());
            return;
        }
        const now = s.now;

        // ---- header
        const head = `Week ${s.week ?? '–'}${s.weekLabel ? ` · ${s.weekLabel}` : ''}`;
        const studied = Object.values(s.studied ?? {}).reduce((a, b) => a + b, 0);
        this.menu.addMenuItem(new Row(null, head, studied ? `${mins(studied * 60)} studied today` : '',
            {style: 'ks-title'}));

        // ---- classes
        this._section('Today');
        if (s.classes.length) {
            for (const c of s.classes) {
                const past = c.end <= now, live = c.start <= now && now < c.end;
                const side = live ? `now · ${mins(c.end - now)} left` : !past && c.start - now < 3600
                    ? `in ${mins(c.start - now)}` : c.time;
                this.menu.addMenuItem(new Row(c.color, `${c.code} ${c.type} · ${c.location}`, side,
                    {style: past ? 'ks-past' : live ? 'ks-live' : ''}));
            }
        } else {
            this.menu.addMenuItem(new Row(null, s.weekLabel ? `No classes — ${s.weekLabel.toLowerCase()}` : 'No classes today', ''));
        }
        if (s.next && s.next.day)
            this.menu.addMenuItem(new Row(s.next.color, `Next: ${s.next.code} ${s.next.type} · ${s.next.location}`,
                `${s.next.day} ${s.next.time.split('–')[0]}`, {style: 'ks-dim'}));

        // ---- deadlines
        if (s.deadlines.length) {
            this._section('Deadlines');
            for (const d of s.deadlines.slice(0, 5)) {
                const weight = d.weight ? ` · ${d.weight}%` : '';
                this.menu.addMenuItem(new Row(d.color, `${d.code}  ${short(d.title, 46)}${weight}`, daysText(d.days),
                    {style: d.days <= 3 ? 'ks-urgent' : ''}));
            }
        }

        // ---- cards + plan
        this._section('Revise');
        const byMod = Object.entries(s.cardsByModule ?? {}).sort((a, b) => b[1] - a[1]);
        const codes = Object.fromEntries((s.modules ?? []).map(m => [m.id, m]));
        const parts = byMod.slice(0, 3).map(([id, n]) => `${codes[id]?.code ?? (id || 'other')} ${n}`).join(' · ');
        this.menu.addMenuItem(new Row(null, s.cardsDue ? `${s.cardsDue} flashcards due` : 'No flashcards due',
            parts, {onActivate: () => this._ext.openLectern()}));
        for (const p of s.plan ?? []) {
            this.menu.addMenuItem(new Row(p.color, `${p.done ? '✓ ' : ''}${short(p.title, 44)}`, `${p.minutes} min`,
                {style: p.done ? 'ks-past' : ''}));
        }

        // ---- actions
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const focus = new PopupMenu.PopupSubMenuMenuItem('Focus on…');
        for (const m of s.modules ?? []) {
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'ks-row'});
            item.add_child(dot(m.color));
            item.add_child(new St.Label({text: `${m.code}  ${short(m.title, 34)}`, y_align: Clutter.ActorAlign.CENTER}));
            item.connect('activate', () => this._ext.focusOn(m));
            focus.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(focus);
        const lock = new PopupMenu.PopupSwitchMenuItem('Block other apps during focus',
            this._ext._settings.get_boolean('focus-lock'));
        lock.connect('toggled', (_i, on) => this._ext._settings.set_boolean('focus-lock', on));
        this.menu.addMenuItem(lock);
        this.menu.addAction('New flashcard from selection   ⇧❖X', () => this._ext.newCard());
        this.menu.addAction('Open Lectern', () => this._ext.openLectern());
        if (s.queued) {
            this.menu.addMenuItem(new Row(null, `${s.queued} waiting — goes into Lectern when you close it`, '',
                {style: 'ks-dim'}));
        }
    }

    _updateChip(s) {
        let text = '', cls = '';
        if (s && s.ok) {
            const now = s.now;
            const c = s.next && !s.next.day ? s.next : null;
            const dl = (s.deadlines ?? []).find(d => d.days >= 0 && d.days <= 3);
            if (c && c.start <= now) {
                text = `${c.code} · ${mins(c.end - now)} left`;
                cls = 'live';
            } else if (c && c.start - now <= 3600) {
                text = `${c.code} in ${mins(c.start - now)}`;
                cls = 'soon';
            } else if (dl) {
                text = `${short(dl.title.split(/[-–:]/)[0], 18)} · ${daysText(dl.days)}`;
                cls = 'urgent';
            } else if (s.cardsDue) {
                text = `${s.cardsDue}`;
            }
        }
        this._label.text = text;
        this._label.visible = !!text;
        this._label.set_style_class_name(`ks-label ${cls}`);
    }
});

const CardDialog = GObject.registerClass(
class CardDialog extends ModalDialog.ModalDialog {
    _init(ext, text, modules, preselect) {
        super._init({styleClass: 'ks-dialog', destroyOnClose: true});
        this._ext = ext;
        this._module = preselect;

        const box = this.contentLayout;
        box.add_child(new St.Label({text: 'New flashcard', style_class: 'ks-dialog-title'}));

        const oneLine = text && text.length <= SHORT && !text.includes('\n');
        this._front = this._entry('Question (front)', oneLine ? text : '', false);
        this._back = this._entry('Answer (back) — optional', oneLine ? '' : text, true);
        box.add_child(this._front);
        box.add_child(this._back);

        const chips = new St.BoxLayout({style_class: 'ks-chips'});
        this._chips = [];
        for (const m of [{id: '', code: 'None', color: '#6b5a60'}, ...modules]) {
            const b = new St.Button({label: m.code, style_class: 'ks-chip-btn', can_focus: true,
                style: `border-color: ${m.color};`});
            b._mod = m;
            b.connect('clicked', () => this._pick(m.id));
            chips.add_child(b);
            this._chips.push(b);
        }
        box.add_child(chips);
        this._pick(preselect);

        this._hint = new St.Label({text: 'Enter = save · Ctrl+Enter in the answer = save · Esc = cancel',
            style_class: 'ks-hint'});
        box.add_child(this._hint);

        this.addButton({label: 'Cancel', action: () => this.close(), key: Clutter.KEY_Escape});
        this.addButton({label: 'Save card', action: () => this._save(), default: true});
        this.setInitialKeyFocus(this._front.clutter_text.text ? this._back : this._front);

        this._front.clutter_text.connect('activate', () => this._save());
        this._back.clutter_text.connect('key-press-event', (_a, ev) => {
            const k = ev.get_key_symbol();
            if ((k === Clutter.KEY_Return || k === Clutter.KEY_KP_Enter) &&
                (ev.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
                this._save();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _entry(hint, text, multi) {
        const e = new St.Entry({hint_text: hint, text: text ?? '', can_focus: true, x_expand: true,
            style_class: `ks-entry${multi ? ' multi' : ''}`});
        if (multi) {
            e.clutter_text.single_line_mode = false;
            e.clutter_text.activatable = false;
            e.clutter_text.line_wrap = true;
            e.clutter_text.line_wrap_mode = 2;  // WORD_CHAR
        }
        return e;
    }

    _pick(id) {
        this._module = id;
        for (const b of this._chips) {
            const on = b._mod.id === id;
            b.set_style_class_name(`ks-chip-btn${on ? ' on' : ''}`);
            b.set_style(on ? `border-color: ${b._mod.color}; background-color: ${b._mod.color}33;`
                : `border-color: ${b._mod.color}66;`);
        }
    }

    async _save() {
        const front = this._front.text.trim(), back = this._back.text.trim();
        if (!front) {
            this._hint.text = 'The question is empty — write what you want to be asked.';
            this._hint.add_style_class_name('ks-hint-bad');
            this._front.grab_key_focus();
            return;
        }
        this.close();
        this._ext.saveCard(this._module, front, back);
    }
});

export default class KuroStudy extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._summary = null;
        this._lock = new FocusLock(this._settings);
        this._button = new StudyButton(this);
        Main.panel.addToStatusArea('kuro-study', this._button, 1, 'right');
        Main.wm.addKeybinding('card-new', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.newCard());
        this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REFRESH_S, () => {
            this.refresh(true);
            return GLib.SOURCE_CONTINUE;
        });
        // first read a little after login, so it doesn't compete with everything else starting
        this._first = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 4, () => {
            this._first = 0;
            this.refresh(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        Main.wm.removeKeybinding('card-new');
        for (const id of [this._tick, this._first])
            if (id)
                GLib.source_remove(id);
        this._tick = this._first = 0;
        this._dialog?.close();
        this._dialog = null;
        this._button?.destroy();
        this._button = null;
        this._lock?.destroy();
        this._lock = null;
        this._settings = null;
    }

    async refresh(flush = false) {
        if (this._busy)
            return;
        this._busy = true;
        if (flush)
            await run([TOOL, 'flush']);
        const r = await run([TOOL, 'summary', '--json']);
        this._busy = false;
        if (!this._button)
            return;
        try {
            this._summary = JSON.parse(r.out);
        } catch {
            this._summary = null;
            if (r.err)
                console.warn(`[kuro-study] ${r.err.trim()}`);
        }
        // keep an open menu where it is; it rebuilds next time it opens
        if (!this._button.menu.isOpen || !this._button._s)
            this._button.update(this._summary);
        else
            this._button._updateChip(this._summary);
    }

    _guessModule() {
        const s = this._summary;
        if (!s)
            return this._settings.get_string('last-module');
        const now = s.now;
        // the class you're in, or one that ended in the last 2 h
        const recent = (s.classes ?? []).filter(c => c.start <= now && c.end > now - 7200).pop();
        if (recent)
            return recent.module;
        return this._settings.get_string('last-module');
    }

    newCard() {
        if (this._dialog)
            return;
        St.Clipboard.get_default().get_text(St.ClipboardType.PRIMARY, (_c, primary) => {
            const go = text => {
                text = (text ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
                if (text.length > 4000)
                    text = text.slice(0, 4000);
                const mods = this._summary?.modules ?? [];
                this._dialog = new CardDialog(this, text, mods, this._guessModule());
                this._dialog.connect('destroy', () => {
                    this._dialog = null;
                });
                this._dialog.open();
            };
            if (primary && primary.trim())
                go(primary);
            else
                St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c2, clip) => go(clip));
        });
    }

    async saveCard(module, front, back) {
        this._settings?.set_string('last-module', module ?? '');
        const r = await run([TOOL, 'add', module ?? '', front, back]);
        Main.notify('Kuro Study', r.ok ? `Flashcard ${r.out.trim()}` : `Couldn't save the card: ${r.err.trim()}`);
        this.refresh();
    }

    async focusOn(m) {
        this._settings?.set_string('last-module', m.id);
        const r = await run([TOOL, 'focus', m.id]);
        if (!r.ok)
            Main.notify('Kuro Study', `Couldn't start focus: ${r.err.trim()}`);
    }

    openLectern() {
        const app = Shell.AppSystem.get_default().lookup_app('lectern.desktop');
        if (app)
            app.activate();
        else
            Main.notify('Kuro Study', 'Lectern is not installed (lectern.desktop missing).');
    }
}
