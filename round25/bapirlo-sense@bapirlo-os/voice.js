// Kuro Sense — "Hey Kuro" voice commands. Offline: helpers/kuro-voice.py (faster-whisper base.en on the CPU)
// turns speech into text; THIS file turns text into an action. Nothing leaves the laptop.
//   Super+K           listen for one command (press again = done talking). The mic is open only while the pill
//                     says "Listening…" (GNOME's red mic dot shows it).
//   wake-word (off)   the helper keeps the mic open and waits for "Hey Kuro …" — handy, but the mic dot stays on
//                     and it uses some battery.
// What it understands (anything else → the closest Kuro command from the search/palette list, if it's a clear match):
//   open|launch <app> · close window · minimise · maximise / fullscreen · show desktop · overview / app grid
//   next / previous song · pause / play / resume · volume up / down / to N · mute / unmute
//   dark mode / light mode · lock (the) screen · screenshot · workspace N · search (for) <words>
//   what time is it · battery · what's using (the) battery / cpu
// The helper runs as kuro-voice.service (started on first use); it talks back with VoiceState(state, text):
//   listening · thinking · heard <text> · nothing · error <why>
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UNIT = 'kuro-voice.service';
const SOCK = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'kuro-voice.sock']);
const WAKE = /^(hey|hi|okay|ok|a|hay|he)?[\s,]*(kuro|curo|kurо|cuero|kiro|kirro|guro|coro|kuru|curro|cairo|kudo|kudos|crow|carol)\b[\s,.!]*/i;

export class Voice {
    constructor(settings) {
        this._s = settings;
        this._state = 'idle';
        Main.wm.addKeybinding('voice-key', settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.listen());
        settings.connectObject('changed::wake-word', () => this._syncWake(), 'changed::voice', () => this._syncWake(), this);
        this._syncWake();
    }

    status() {
        if (!this._s.get_boolean('voice'))
            return 'off';
        return this._s.get_boolean('wake-word') ? `wake word on (${this._state})` : this._state;
    }

    // ---------- talking to the helper ----------
    _startUnit(cb) {
        Gio.DBus.session.call('org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager',
            'StartUnit', new GLib.Variant('(ss)', [UNIT, 'replace']), null, Gio.DBusCallFlags.NONE, 3000, null, (c, res) => {
                try {
                    c.call_finish(res);
                } catch (e) {
                    this._pill('error', `Voice helper didn't start: ${e.message}`);
                    return;
                }
                cb?.();
            });
    }

    // send one line; the helper may still be loading the model, so retry for ~8 s
    _send(line, tries = 32) {
        const client = new Gio.SocketClient();
        client.connect_async(Gio.UnixSocketAddress.new(SOCK), null, (_c, res) => {
            try {
                const conn = client.connect_finish(res);
                conn.get_output_stream().write_all(new TextEncoder().encode(`${line}\n`), null);
                conn.close(null);
            } catch {
                if (tries > 0) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                        this._send(line, tries - 1);
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    this._pill('error', 'Voice helper isn\'t answering — try: bapirlo-sense voice test');
                }
            }
        });
    }

    _syncWake() {
        const on = this._s.get_boolean('voice') && this._s.get_boolean('wake-word');
        if (on)
            this._startUnit(() => this._send('wake 1'));
        else if (GLib.file_test(SOCK, GLib.FileTest.EXISTS))
            this._send('wake 0', 2);
    }

    listen() {
        if (!this._s.get_boolean('voice'))
            return;
        if (this._state === 'listening') {
            this._send('stop', 2);
            return;
        }
        this._pill('starting', 'Getting ready…');
        this._startUnit(() => this._send('listen'));
    }

    // from the helper
    state(state, text) {
        this._state = state === 'heard' || state === 'nothing' || state === 'error' ? 'idle' : state;
        switch (state) {
        case 'listening': this._pill('listening', 'Listening…'); break;
        case 'thinking': this._pill('thinking', 'Thinking…'); break;
        case 'nothing': this._pill('nothing', "Didn't hear anything", 1600); break;
        case 'error': this._pill('error', text || 'Voice error', 3000); break;
        case 'heard': {
            const wake = text.match(WAKE);
            const cmd = (wake ? text.slice(wake[0].length) : text).trim();
            const said = this.command(cmd);
            this._pill('done', said, 2600, cmd);
            break;
        }
        }
    }

    // ---------- text → action. Returns what it did (shown in the pill) ----------
    command(raw) {
        const t = raw.toLowerCase().replace(/[^\p{L}\p{N}%' ]+/gu, ' ').replace(/\s+/g, ' ').trim()
            .replace(/^(please|can you|could you|would you)\s+/, '').replace(/\s+please$/, '');
        if (!t)
            return 'Say a command after "Hey Kuro"';
        let m;
        if ((m = t.match(/^(open|launch|start|run)\s+(.+)$/)))
            return this._open(m[2]);
        if (/^(close|quit)( (this|the|that))?( window| app)?$/.test(t))
            return this._win(w => w.delete(global.get_current_time()), 'Closed the window');
        if (/^minimi[sz]e/.test(t))
            return this._win(w => w.minimize(), 'Minimised');
        if (/^(maximi[sz]e|full ?screen|make it (big|bigger|full))/.test(t))
            return this._win(w => (w.is_maximized?.() ? w.unmaximize() : w.maximize()), 'Maximised');
        if (/^(show )?(the )?desktop$/.test(t)) {
            global.workspace_manager.get_active_workspace().list_windows().forEach(w => w.minimize());
            return 'Showing the desktop';
        }
        if (/(overview|app grid|all apps|show apps|activities)/.test(t)) {
            /app/.test(t) ? Main.overview.showApps() : Main.overview.show();
            return 'Overview';
        }
        if (/^(next|skip)( (song|track|one))?$/.test(t))
            return this._media('Next', 'Next song');
        if (/^(previous|last|go back)( (song|track|one))?$/.test(t))
            return this._media('Previous', 'Previous song');
        if (/^(pause|stop)( (the )?(music|song|video|it))?$/.test(t))
            return this._media('Pause', 'Paused');
        if (/^(play|resume|continue)( (the )?(music|song|video|it))?$/.test(t))
            return this._media('Play', 'Playing');
        if ((m = t.match(/volume (to |at )?(\d{1,3})( ?%| percent)?$/)))
            return this._spawn(['pactl', 'set-sink-volume', '@DEFAULT_SINK@', `${Math.min(150, +m[2])}%`], `Volume ${m[2]} %`);
        if (/(volume up|louder|turn it up)/.test(t))
            return this._spawn(['pactl', 'set-sink-volume', '@DEFAULT_SINK@', '+10%'], 'Volume up');
        if (/(volume down|quieter|turn it down|softer)/.test(t))
            return this._spawn(['pactl', 'set-sink-volume', '@DEFAULT_SINK@', '-10%'], 'Volume down');
        if (/^(mute|silence)/.test(t))
            return this._spawn(['pactl', 'set-sink-mute', '@DEFAULT_SINK@', '1'], 'Muted');
        if (/^unmute/.test(t))
            return this._spawn(['pactl', 'set-sink-mute', '@DEFAULT_SINK@', '0'], 'Sound on');
        if (/(dark|light) (mode|theme)/.test(t)) {
            const dark = /dark/.test(t);
            new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_string('color-scheme', dark ? 'prefer-dark' : 'default');
            return dark ? 'Dark mode' : 'Light mode';
        }
        if (/^lock( the)?( screen| computer| laptop)?$/.test(t)) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
                Main.screenShield?.lock(true);
                return GLib.SOURCE_REMOVE;
            });
            return 'Locking';
        }
        if ((m = t.match(/(?:workspace|desktop) (\d|one|two|three|four|five|six)$/))) {
            const n = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6}[m[1]] ?? +m[1];
            const ws = global.workspace_manager.get_workspace_by_index(n - 1);
            if (!ws)
                return `There's no workspace ${n}`;
            ws.activate(global.get_current_time());
            return `Workspace ${n}`;
        }
        if ((m = t.match(/^(search|find|look up|look for)( for)? (.+)$/))) {
            Main.overview.show();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                try {
                    Main.overview._overview.controls._searchEntry.set_text(m[3]);
                } catch {}
                return GLib.SOURCE_REMOVE;
            });
            return `Searching "${m[3]}"`;
        }
        if (/(what time|what's the time|whats the time|the time)/.test(t)) {
            const now = GLib.DateTime.new_now_local();
            return `It's ${now.format('%H:%M')} · ${now.format('%A %e %B')}`;
        }
        if (/(using|eating|draining).*(battery|cpu|power)|(battery|cpu) hog/.test(t))
            return this._hogs();
        if (/^(battery|how much battery|battery level|charge)/.test(t))
            return this._battery();
        return this._kuroCommand(t);
    }

    _open(name) {
        const q = name.replace(/^(the|my)\s+/, '').replace(/\s+(app|application|please)$/, '');
        const sys = Shell.AppSystem.get_default();
        const ids = Shell.AppSystem.search(q).flat();
        const app = ids.map(id => sys.lookup_app(id)).find(a => a);
        if (!app)
            return `Couldn't find an app called "${q}"`;
        app.activate();
        return `Opening ${app.get_name()}`;
    }

    _win(fn, said) {
        const w = global.display.focus_window;
        if (!w)
            return 'No window is focused';
        fn(w);
        return said;
    }

    _media(method, said) {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, null, Gio.DBusCallFlags.NONE, 2000, null, (c, res) => {
                try {
                    const [names] = c.call_finish(res).deepUnpack();
                    const players = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.'));
                    // prefer the one playing; else the first (Spotify usually)
                    let pick = players[0];
                    let left = players.length;
                    const go = () => pick && Gio.DBus.session.call(pick, '/org/mpris/MediaPlayer2',
                        'org.mpris.MediaPlayer2.Player', method, null, null, Gio.DBusCallFlags.NONE, 1500, null, null);
                    if (!left)
                        return;
                    for (const n of players) {
                        Gio.DBus.session.call(n, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Get',
                            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'PlaybackStatus']), null,
                            Gio.DBusCallFlags.NONE, 1000, null, (c2, r2) => {
                                try {
                                    if (c2.call_finish(r2).deepUnpack()[0].deepUnpack() === 'Playing')
                                        pick = n;
                                } catch {}
                                if (--left === 0)
                                    go();
                            });
                    }
                } catch {}
            });
        return said;
    }

    _spawn(argv, said) {
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            return `Couldn't: ${e.message}`;
        }
        return said;
    }

    _battery() {
        try {
            const [, out] = GLib.spawn_command_line_sync('cat /sys/class/power_supply/BAT1/capacity /sys/class/power_supply/BAT1/status');
            const [pct, st] = new TextDecoder().decode(out).trim().split('\n');
            return `Battery ${pct} % · ${st?.toLowerCase() ?? ''}`;
        } catch {
            return 'Battery: unknown';
        }
    }

    _hogs() {
        try {
            const [, out] = GLib.spawn_command_line_sync('ps -eo comm,%cpu --sort=-%cpu --no-headers');
            const top = new TextDecoder().decode(out).trim().split('\n').slice(0, 3)
                .map(l => l.trim().split(/\s+/)).map(([c, p]) => `${c} ${p}%`);
            return `Top CPU: ${top.join(' · ')}`;
        } catch {
            return "Couldn't read the CPU use";
        }
    }

    // anything else: the clearest match in Kuro's command list (the same one search and the palette use)
    _kuroCommand(t) {
        const cmds = globalThis.kuroCommands?.list ?? [];
        const said = t.split(' ').filter(w => w.length > 2 && !['the', 'and', 'turn', 'switch', 'set', 'make', 'put', 'please'].includes(w));
        let best = null, bestScore = 0, second = 0;
        for (const c of cmds) {
            const name = typeof c.name === 'function' ? c.name() : c.name;
            const hay = `${c.words} ${name}`.toLowerCase();
            const score = said.reduce((s, w) => s + (new RegExp(`\\b${w.replace(/[^\p{L}\p{N}]/gu, '')}`, 'u').test(hay) ? 1 : 0), 0);
            if (score > bestScore) {
                second = bestScore;
                bestScore = score;
                best = [c, name];
            } else if (score > second) {
                second = score;
            }
        }
        if (best && bestScore >= 1 && bestScore > second && bestScore / Math.max(1, said.length) >= 0.4) {
            try {
                globalThis.kuroCommands.run(best[0]);
                return best[1];
            } catch (e) {
                return `Couldn't run "${best[1]}": ${e.message}`;
            }
        }
        return `Didn't understand "${t}"`;
    }

    // ---------- the pill under the bar ----------
    _pill(kind, label, hideMs = 0, heard = '') {
        if (!this._box) {
            this._box = new St.BoxLayout({style_class: 'kuro-voice-pill', reactive: false, opacity: 0});
            this._dot = new St.Widget({style_class: 'kuro-voice-dot', y_align: Clutter.ActorAlign.CENTER});
            const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
            this._label = new St.Label({style_class: 'kuro-voice-label'});
            this._heard = new St.Label({style_class: 'kuro-voice-heard'});
            col.add_child(this._label);
            col.add_child(this._heard);
            this._box.add_child(this._dot);
            this._box.add_child(col);
            Main.layoutManager.addTopChrome(this._box);
        }
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = 0;
        this._label.text = label;
        this._heard.text = heard ? `“${heard}”` : '';
        this._heard.visible = !!heard;
        this._dot.remove_all_transitions();
        this._dot.opacity = 255;
        if (kind === 'listening')
            this._breathe();
        this._dot.style = kind === 'error' || kind === 'nothing' ? 'background-color: #8a8484;'
            : kind === 'done' ? 'background-color: #2fd37a;' : '';
        const m = Main.layoutManager.primaryMonitor;
        this._box.get_preferred_width(-1);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._box)
                return GLib.SOURCE_REMOVE;
            this._box.set_position(Math.round(m.x + (m.width - this._box.width) / 2), m.y + Main.panel.height + 14);
            return GLib.SOURCE_REMOVE;
        });
        this._box.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (hideMs) {
            this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, hideMs, () => {
                this._hideId = 0;
                this._box?.ease({opacity: 0, duration: 260, mode: Clutter.AnimationMode.EASE_IN_QUAD});
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _breathe() {
        if (!this._dot)
            return;
        this._dot.ease({opacity: 90, duration: 520, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => this._dot?.ease({opacity: 255, duration: 520, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                onComplete: () => this._state === 'listening' && this._breathe()})});
    }

    destroy() {
        Main.wm.removeKeybinding('voice-key');
        this._s.disconnectObject(this);
        if (this._hideId)
            GLib.source_remove(this._hideId);
        if (this._box)
            Main.layoutManager.removeChrome(this._box);
        this._box?.destroy();
        this._box = this._dot = this._label = this._heard = null;
    }
}
