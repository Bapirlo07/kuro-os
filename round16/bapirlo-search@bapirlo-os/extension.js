// Kuro Search Actions — answers and actions in the overview search AND ArcMenu's search (ArcMenu
// picks up every provider added to the overview's SearchController).
//   · sums:   =12*7   2^10+sqrt(9)   15% of 80   80 + 15%          Enter copies the answer
//   · units:  5 km in mi   100 f to c   2 gb in mib   60 mph in km/h   Enter copies it
//   · Kuro:   wallpaper next · mode gaming · bedtime · focus 45 · grab text · update · battery …
// Off switch: gnome-extensions disable bapirlo-search@bapirlo-os
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {calculate, convert, format, looksLikeSum} from './calc.js';

const OS = GLib.build_filenamev([GLib.get_home_dir(), 'bapirlo-os']);
const SETTINGS = [`${OS}/settings-app/bapirlo-settings`];
const term = (title, ...cmd) => ['alacritty', '--class', 'bapirlo-search.term', '-T', title, '-e', ...cmd];

// words: what it answers to (every typed word must start one of them); run: argv, or (n) => argv
const COMMANDS = [
    {words: 'wallpaper next change skip', name: 'Next wallpaper', icon: 'preferences-desktop-wallpaper-symbolic',
        run: ['bapirlo-wallpaper', 'next']},
    {words: 'wallpaper shuffle random', name: 'Shuffle wallpapers every 3 hours', icon: 'media-playlist-shuffle-symbolic',
        run: ['bapirlo-wallpaper', 'mode', 'shuffle', '3']},
    {words: 'wallpapers theme studio colours', name: 'Open Wallpapers & Theme', icon: 'preferences-desktop-wallpaper-symbolic',
        run: ['bapirlo-wallpaper']},
    {words: 'live wallpaper video animated', name: 'Live wallpaper on / off', icon: 'video-x-generic-symbolic',
        run: ['bapirlo-wallpaper', 'live', 'toggle']},
    {words: 'workspace wallpaper own each', name: 'Give this workspace its own wallpaper (pick it)', icon: 'view-grid-symbolic',
        run: ['bapirlo-wallpaper', 'workspace', 'pick']},
    {words: 'mode gaming game turbo performance', name: 'Gaming mode on / off', icon: 'input-gaming-symbolic',
        run: ['bapirlo-mode', 'gaming', 'toggle']},
    {words: 'mode quiet silent eco fans', name: 'Quiet mode on / off', icon: 'weather-clear-night-symbolic',
        run: ['bapirlo-mode', 'quiet', 'toggle']},
    {words: 'mode dnd disturb notifications banners', name: 'Do Not Disturb on / off', icon: 'notifications-disabled-symbolic',
        run: ['bapirlo-mode', 'dnd', 'toggle']},
    {words: 'bedtime sleep night wind down', name: 'Bedtime now (until the morning)', icon: 'weather-clear-night-symbolic',
        run: ['bapirlo-bedtime', 'now']},
    {words: 'bedtime off wake morning end', name: 'End bedtime', icon: 'weather-clear-symbolic',
        run: ['bapirlo-bedtime', 'off']},
    {words: 'focus timer pomodoro block', name: n => `Focus block — ${n ?? 25} min`, icon: 'alarm-symbolic',
        run: n => ['bapirlo-focus', 'start', String(n ?? 25)]},
    {words: 'focus stop end', name: 'Stop the focus timer', icon: 'alarm-symbolic',
        run: ['bapirlo-focus', 'stop']},
    {words: 'grab text ocr read copy screen', name: 'Grab text from the screen (Super+Shift+T)', icon: 'edit-select-all-symbolic',
        run: ['bapirlo-capture', 'text']},
    {words: 'colour color picker pick', name: 'Colour picker (Super+Shift+C)', icon: 'color-select-symbolic',
        run: ['bapirlo-capture', 'pick']},
    {words: 'screenshot capture print', name: 'Screenshot', icon: 'camera-photo-symbolic',
        run: ['bapirlo-capture', 'shot']},
    {words: 'update upgrade packages system', name: 'Update Kuro OS (opens a terminal)', icon: 'software-update-available-symbolic',
        run: term('Kuro update', 'bapirlo-update')},
    {words: 'doctor health check problems', name: 'Kuro Doctor — check everything', icon: 'emblem-ok-symbolic',
        run: term('Kuro Doctor', 'bash', '-c', 'bapirlo-doctor; echo; read -rp "Enter closes"')},
    {words: 'cleanup clean space disk free', name: 'Free up space now', icon: 'user-trash-symbolic',
        run: term('Kuro cleanup', 'bash', '-c', 'bapirlo-cleanup-now; echo; read -rp "Enter closes"')},
    {words: 'battery power charge watts health', name: 'Battery & power', icon: 'battery-good-symbolic',
        run: [...SETTINGS, '--page=power']},
    {words: 'charge limit 80 daily', name: 'Stop charging at 80 %', icon: 'battery-good-charging-symbolic',
        run: ['bapirlo-charge', 'daily']},
    {words: 'charge full 100 travel', name: 'Charge to 100 % (travel)', icon: 'battery-full-charging-symbolic',
        run: ['bapirlo-charge', 'travel']},
    {words: 'screen time usage apps today', name: 'Screen time', icon: 'preferences-system-time-symbolic',
        run: [...SETTINGS, '--page=screentime']},
    {words: 'kuro settings extensions undo', name: 'Kuro Settings', icon: 'preferences-system-symbolic',
        run: SETTINGS},
    {words: 'world kuro wallpaper grow tree town', name: 'Kuro World — the wallpaper that grows with you', icon: 'weather-few-clouds-symbolic',
        run: ['bapirlo-world', 'set']},
    {words: 'gestures air hand camera webcam on off', name: 'Air gestures (webcam) on / off', icon: 'input-touchpad-symbolic',
        run: ['bapirlo-gestures', 'toggle']},
    {words: 'gestures air hand cheat sheet help list', name: 'Air gestures cheat sheet', icon: 'input-touchpad-symbolic',
        run: ['bapirlo-gestures', 'sheet']},
    {words: 'windows gravity fall drop pile physics', name: 'Drop every window into a pile', icon: 'go-bottom-symbolic',
        run: ['bapirlo-physics', 'gravity']},
    {words: 'windows float back home physics', name: 'Float the windows back', icon: 'go-top-symbolic',
        run: ['bapirlo-physics', 'float']},
    {words: 'zoom canvas infinite desktop islands map', name: 'Infinite desktop — zoom out (Super+Z · Super+scroll)', icon: 'zoom-out-symbolic',
        shell: () => {                       // runs inside the shell: open the canvas once the overview has gone
            const canvas = Main.extensionManager.lookup('bapirlo-canvas@bapirlo-os')?.stateObj;
            Main.overview.hide();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                canvas?.open();
                return GLib.SOURCE_REMOVE;
            });
        }},
    {words: 'knock microphone mic desk tap on off', name: 'Knock control (microphone) on / off', icon: 'audio-input-microphone-symbolic',
        run: ['bapirlo-knock', 'toggle']},
    {words: "what's whats new updates features kuro round", name: "What's new in Kuro OS", icon: 'starred-symbolic',
        run: [`${OS}/whats-new/bapirlo-whats-new`]},
    {words: 'study lectern flashcards cards revise uni class deadline', name: 'Open Lectern (study)', icon: 'accessories-dictionary-symbolic',
        run: ['gtk-launch', 'lectern']},
    // round 22 — Kuro Cosmos
    {words: 'aurora sky night stars northern lights wallpaper', name: 'Aurora sky wallpaper on / off', icon: 'weather-clear-night-symbolic',
        run: ['bapirlo-cosmos', 'aurora', 'toggle']},
    {words: 'constellation stars apps launcher sky', name: 'Constellation — your apps as stars (Super+Shift+Space)', icon: 'starred-symbolic',
        run: ['bapirlo-cosmos', 'demo', 'stars']},
    {words: 'moss tidy folders living old unused', name: 'Tidy up mossy folders', icon: 'folder-symbolic',
        run: ['bapirlo-cosmos', 'tidy']},
    {words: 'garden living plants dock dust glow', name: 'Living OS (garden, dock glow) on / off', icon: 'emblem-favorite-symbolic',
        run: ['bapirlo-cosmos', 'living', 'toggle']},
    {words: 'breathe breathing calm wallpaper', name: 'Breathing desktop on / off', icon: 'weather-few-clouds-symbolic',
        run: ['bapirlo-cosmos', 'breathe', 'toggle']},
    {words: 'black hole demo snack corner', name: 'Black hole — feed it a window', icon: 'process-stop-symbolic',
        run: ['bapirlo-cosmos', 'demo', 'blackhole']},
    {words: 'cosmos supernova wormhole shatter echo', name: 'Kuro Cosmos — what\'s new in round 22', icon: 'starred-symbolic',
        run: [`${OS}/whats-new/bapirlo-whats-new`]},
    {words: 'lock screen', name: 'Lock the screen', icon: 'system-lock-screen-symbolic',
        run: ['loginctl', 'lock-session']},
];

function spawn(argv) {
    try {
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
    } catch (e) {
        Main.notifyError('Kuro search', `${argv[0]}: ${e.message}`);
    }
}

function copy(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

class KuroProvider {
    constructor(dir) {
        this.id = 'bapirlo-search';
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;
        // the overview wants a real Gio.AppInfo for the section header (name + icon)
        this.appInfo = GioUnix.DesktopAppInfo.new_from_filename(GLib.build_filenamev([dir, 'kuro-search.desktop']));
        this._results = new Map();
    }

    _search(terms) {
        this._results.clear();
        const text = terms.join(' ');
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);

        const conv = convert(text);
        if (conv) {
            const v = format(conv.value, 6);
            this._results.set(`conv:${text}`, {name: `${v} ${conv.to}`, copy: v.replace(/,/g, ''),
                description: `${format(conv.input)} ${conv.from} · Enter copies it`, icon: 'accessories-calculator-symbolic'});
        } else if (looksLikeSum(text)) {
            const v = calculate(text);
            if (v !== null) {
                const f = format(v);
                this._results.set(`sum:${text}`, {name: `= ${f}`, copy: f.replace(/,/g, ''),
                    description: `${text.replace(/^=\s*/, '')} · Enter copies it`, icon: 'accessories-calculator-symbolic'});
            }
        }

        if (text.length >= 2) {
            const num = words.map(Number).find(n => Number.isInteger(n) && n > 0 && n <= 240);
            const typed = words.filter(w => !/^\d+$/.test(w));
            COMMANDS.forEach((c, i) => {
                const keys = c.words.split(' ');
                if (!typed.length || !typed.every(w => keys.some(k => k.startsWith(w))))
                    return;
                if (num !== undefined && typeof c.run !== 'function' && !c.words.includes(String(num)))
                    return;
                this._results.set(`cmd${i}:${num ?? ''}`, {
                    name: typeof c.name === 'function' ? c.name(num) : c.name,
                    description: 'Enter runs it',
                    icon: c.icon,
                    shell: c.shell,
                    run: typeof c.run === 'function' ? c.run(num) : c.run,
                });
            });
        }
        return [...this._results.keys()];
    }

    getInitialResultSet(terms, _cancellable) {
        return Promise.resolve(this._search(terms));
    }

    getSubsearchResultSet(_previous, terms, cancellable) {
        return this.getInitialResultSet(terms, cancellable);
    }

    getResultMetas(ids, _cancellable) {
        return Promise.resolve(ids.filter(id => this._results.has(id)).map(id => {
            const r = this._results.get(id);
            return {id, name: r.name, description: r.description,
                // compact rows: small icons in the overview, ArcMenu and the Super+Space runner
                createIcon: size => new St.Icon({icon_name: r.icon, icon_size: Math.min(size ?? 16, 16)})};
        }));
    }

    filterResults(results, max) {
        return results.slice(0, Math.min(max, 4));
    }

    activateResult(id, _terms) {
        const r = this._results.get(id);
        if (!r)
            return;
        if (r.copy !== undefined) {
            copy(r.copy);
            Main.osdWindowManager.showAll(Gio.Icon.new_for_string('edit-copy-symbolic'), `Copied ${r.copy}`, null, null);
        } else if (r.shell) {
            r.shell();
        } else {
            spawn(r.run);
        }
    }
}

export default class BapirloSearchExtension extends Extension {
    enable() {
        this._provider = new KuroProvider(this.path);
        Main.overview.searchController.addProvider(this._provider);
        this._putFirst();
        // Kuro Flow's command palette (Super+Shift+P) offers the same commands (round 23)
        globalThis.kuroCommands = {list: COMMANDS, run: c => (c.shell ? c.shell() : spawn(typeof c.run === 'function' ? c.run() : c.run))};
    }

    // Kuro answers go on top, in a tighter list (stylesheet.css: .kuro-compact)
    _putFirst() {
        const view = Main.overview.searchController._searchResults;
        const list = view?._providers;
        const i = list?.indexOf(this._provider) ?? -1;
        if (i > 0) {
            list.splice(i, 1);
            list.unshift(this._provider);
        }
        const display = this._provider.display;
        if (display) {
            display.add_style_class_name('kuro-compact');
            display.get_parent()?.set_child_at_index(display, 0);
        }
    }

    disable() {
        delete globalThis.kuroCommands;
        Main.overview.searchController.removeProvider(this._provider);
        this._provider = null;
    }
}
