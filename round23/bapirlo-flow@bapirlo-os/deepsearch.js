// Kuro Deep search (shell part) — a section "Inside your files" in search (overview, ArcMenu, Super+Space):
// files whose CONTENTS match what you typed, with the matching words shown. The index is built by
// bin/bapirlo-deepsearch (user timer, every 30 min) — this only asks it, for 3+ letters, after a short pause.
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function ask(words) {
    return new Promise(resolve => {
        try {
            const p = Gio.Subprocess.new(['bapirlo-deepsearch', 'query', ...words, '--json'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            p.communicate_utf8_async(null, null, (pp, res) => {
                try {
                    resolve(JSON.parse(pp.communicate_utf8_finish(res)[1] || '[]'));
                } catch {
                    resolve([]);
                }
            });
        } catch {
            resolve([]);
        }
    });
}

class DeepProvider {
    constructor(dir) {
        this.id = 'bapirlo-deepsearch';
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;
        this.appInfo = GioUnix.DesktopAppInfo.new_from_filename(GLib.build_filenamev([dir, 'kuro-deepsearch.desktop']));
        this._results = new Map();
    }

    async _search(terms, cancellable) {
        const words = terms.filter(w => w.length > 0);
        if (words.join('').length < 3)
            return [];
        // wait until typing pauses (the overview asks on every key)
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => (r(), GLib.SOURCE_REMOVE)));
        if (cancellable?.is_cancelled())
            return [];
        const found = await ask(words);
        this._results.clear();
        for (const f of found)
            this._results.set(f.path, f);
        return found.map(f => f.path);
    }

    getInitialResultSet(terms, cancellable) {
        return this._search(terms, cancellable);
    }

    getSubsearchResultSet(_previous, terms, cancellable) {
        return this._search(terms, cancellable);
    }

    getResultMetas(ids) {
        return Promise.resolve(ids.filter(id => this._results.has(id)).map(id => {
            const r = this._results.get(id);
            const gicon = Gio.content_type_get_icon(Gio.content_type_guess(r.path, null)[0]);
            return {id, name: r.name, description: `${r.snippet.replace(/\[|\]/g, '')} — ${r.where}`,
                createIcon: size => new St.Icon({gicon, icon_size: size ?? 24})};
        }));
    }

    filterResults(results, max) {
        return results.slice(0, Math.min(max, 5));
    }

    activateResult(id) {
        try {
            Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(id).get_uri(), global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError('Deep search', e.message);
        }
    }
}

export class DeepSearch {
    constructor(settings, dir) {
        this._settings = settings;
        this._dir = dir;
        this._settings.connectObject('changed::deep-search', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const on = this._settings.get_boolean('deep-search');
        if (on && !this._provider) {
            this._provider = new DeepProvider(this._dir);
            Main.overview.searchController.addProvider(this._provider);
        } else if (!on && this._provider) {
            Main.overview.searchController.removeProvider(this._provider);
            this._provider = null;
        }
    }

    destroy() {
        this._settings.disconnectObject(this);
        if (this._provider)
            Main.overview.searchController.removeProvider(this._provider);
        this._provider = null;
    }
}
