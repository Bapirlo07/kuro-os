// Kuro Bar — numbered workspace chips (1, 2, 3 …).
//   active = crimson pill with a white number · has windows = bright number + ember underline
//   empty = dim number
//   click a dot = go there (click the active one = overview) · scroll = previous / next
//   right-click (or Menu key) a dot = Remove workspace / Add workspace / Own wallpaper…
// A workspace can have its own wallpaper (bapirlo-wallpaper workspace): when a switch settles, the
// wallpaper engine is told which workspace is on screen — only if any workspace has one.
// Removing a workspace never closes anything: its windows move to the previous workspace
// (the next one when it is the first). Works with dynamic and static workspaces.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Group, attachTooltip, hideTooltip, EASE} from './util.js';

const WALL_CONF = GLib.build_filenamev([GLib.get_user_config_dir(), 'bapirlo', 'wallpaper.json']);
const WALL_WS = GLib.build_filenamev([GLib.get_user_state_dir(), 'bapirlo', 'wallpaper', 'workspace']);
const WALL_SETTLE_MS = 900;     // flicking through workspaces never re-themes on the way

const CHIP = 22;   // width of an inactive number
const PILL = 34;   // width of the active pill
const MOVE_MS = 220;
const REMOVE_MS = 260;
const ADD_MS = 240;
const MAX_WORKSPACES = 12;
const ADD_KEY = 'Super+Shift+N';
const REMOVE_KEY = 'Super+Shift+W';

const hasWindows = ws => ws.list_windows().some(w =>
    !w.skip_taskbar && !w.is_on_all_workspaces() &&
    w.get_window_type() !== Meta.WindowType.DESKTOP);

const osd = (icon, label) =>
    Main.osdWindowManager.showAll(Gio.ThemedIcon.new(icon), label, null, null);

export const WorkspaceDots = GObject.registerClass(
class BapirloWorkspaceDots extends Group {
    _init() {
        super._init('Kuro workspaces', 'bapirlo-ws');
        this._dots = [];
        this._workspaces = [];
        this._syncId = 0;
        this._scrollAcc = 0;
        this._scrollLock = 0;
        this._removing = null;
        this._growWs = null;
        this._menu = null;
        this._batch = false;
        this._menuManager = new PopupMenu.PopupMenuManager(this);

        global.workspace_manager.connectObject(
            'notify::n-workspaces', () => this._rebuild(),
            'workspaces-reordered', () => this._rebuild(),
            'active-workspace-changed', () => {
                this._sync(true);
                this._queueWallpaper();
            },
            this);
        this.connect('scroll-event', (_a, ev) => this._onScroll(ev));
        this._rebuild();
    }

    _rebuild() {
        if (this._batch)
            return;
        this._closeMenu();
        for (const ws of this._workspaces)
            ws.disconnectObject(this);
        this.box.destroy_all_children();
        this._dots = [];
        this._workspaces = [];

        const wm = global.workspace_manager;
        for (let i = 0; i < wm.n_workspaces; i++) {
            const ws = wm.get_workspace_by_index(i);
            ws.connectObject(
                'window-added', () => this._queueSync(),
                'window-removed', () => this._queueSync(),
                this);
            const dot = new St.Bin({
                style_class: 'bapirlo-ws-dot',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Label({
                    text: `${i + 1}`,
                    style_class: 'bapirlo-ws-num',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
            const hit = new St.Button({
                style_class: 'bapirlo-ws-hit',
                child: dot,
                can_focus: true,
                track_hover: true,
                accessible_name: `Workspace ${i + 1}`,
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            });
            hit.connect('clicked', () => {
                if (ws.active)
                    Main.overview.toggle();
                else
                    ws.activate(global.get_current_time());
            });
            hit.connect('button-press-event', (_a, ev) => {
                if (ev.get_button() !== Clutter.BUTTON_SECONDARY)
                    return Clutter.EVENT_PROPAGATE;
                this._openMenu(hit, ws);
                return Clutter.EVENT_STOP;
            });
            hit.connect('popup-menu', () => this._openMenu(hit, ws));
            attachTooltip(hit, () => `Workspace ${i + 1}${ws.active ? ' — click for overview' : ''}`);
            this.box.add_child(hit);
            this._dots.push(dot);
            this._workspaces.push(ws);
        }
        this._sync(false);

        // a workspace we just added grows in from nothing
        const grow = this._workspaces.indexOf(this._growWs);
        this._growWs = null;
        if (grow >= 0 && this.get_stage()) {
            const dot = this._dots[grow];
            const hit = dot.get_parent();
            hit.set({opacity: 0, scale_x: 0.2, scale_y: 0.2});
            dot.add_style_class_name('flash');
            hit.ease({
                opacity: 255, scale_x: 1, scale_y: 1,
                duration: ADD_MS,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
                // onComplete, not onStopped: a rebuild mid-animation destroys the dot
                onComplete: () => dot.remove_style_class_name('flash'),
            });
        }
    }

    _queueSync() {
        if (this._syncId)
            return;
        // window-added fires before the window is fully set up (skip_taskbar etc.)
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = 0;
            this._sync(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync(animate) {
        this._workspaces.forEach((ws, i) => {
            const dot = this._dots[i];
            dot.remove_style_class_name('active');
            dot.remove_style_class_name('occupied');
            if (ws.active)
                dot.add_style_class_name('active');
            else if (hasWindows(ws))
                dot.add_style_class_name('occupied');

            const width = (ws.active ? PILL : CHIP) *
                St.ThemeContext.get_for_stage(global.stage).scale_factor;
            dot.remove_transition('width');
            if (animate && dot.get_stage())
                dot.ease({width, duration: MOVE_MS, mode: EASE});
            else
                dot.width = width;
        });
    }

    // ------------------------------------------------------------ right-click menu

    _openMenu(hit, ws) {
        this._closeMenu();
        hideTooltip();
        const wm = global.workspace_manager;
        const index = this._workspaces.indexOf(ws);
        const menu = new PopupMenu.PopupMenu(hit, 0.5, St.Side.TOP);
        menu.actor.add_style_class_name('bapirlo-ws-menu');

        const title = new PopupMenu.PopupMenuItem(`Workspace ${index + 1}`, {reactive: false});
        title.add_style_class_name('bapirlo-ws-menu-title');
        menu.addMenuItem(title);

        const remove = this._menuItem(menu, 'Remove workspace', 'list-remove-symbolic', REMOVE_KEY,
            () => this.removeWorkspace(ws));
        const [ok, why] = this._canRemove(ws);
        remove.setSensitive(ok);
        if (!ok)
            remove.label.text = why;
        const add = this._menuItem(menu, 'Add workspace', 'list-add-symbolic', ADD_KEY,
            () => this.addWorkspace(ws));
        add.setSensitive(wm.n_workspaces < MAX_WORKSPACES);
        this._menuItem(menu, 'Own wallpaper…', 'preferences-desktop-wallpaper-symbolic', '', () => {
            if (!ws.active)
                ws.activate(global.get_current_time());
            this._writeWorkspace(index + 1);
            this._spawn(['bapirlo-wallpaper', 'workspace', 'pick']);
        });

        Main.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        menu.connect('open-state-changed', (_m, open) => {
            if (!open && this._menu === menu)
                this._closeMenu();
        });
        this._menu = menu;
        menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _menuItem(menu, text, icon, accel, callback) {
        const item = new PopupMenu.PopupImageMenuItem(text, icon);
        item.label.x_expand = true;
        item.add_child(new St.Label({
            text: accel,
            style_class: 'bapirlo-ws-accel',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        // run after the menu has closed so a rebuild never destroys it mid-signal
        item.connect('activate', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            callback();
            return GLib.SOURCE_REMOVE;
        }));
        menu.addMenuItem(item);
        return item;
    }

    _closeMenu() {
        const menu = this._menu;
        this._menu = null;
        if (!menu)
            return;
        // destroying from inside open-state-changed upsets the menu manager — defer it
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            menu.destroy();
            return GLib.SOURCE_REMOVE;
        });
        menu.close(BoxPointer.PopupAnimation.NONE);
    }

    // ------------------------------------------------------------ add / remove

    _canRemove(ws) {
        const wm = global.workspace_manager;
        if (wm.n_workspaces <= 1)
            return [false, 'Last workspace — can’t remove'];
        // dynamic: GNOME always keeps one empty workspace at the end and would recreate it
        if (Meta.prefs_get_dynamic_workspaces() && ws.index() === wm.n_workspaces - 1 && !hasWindows(ws))
            return [false, 'Empty — closes on its own'];
        return [true, ''];
    }

    removeWorkspace(ws = global.workspace_manager.get_active_workspace()) {
        const wm = global.workspace_manager;
        if (this._removing)
            return;
        const index = ws.index();
        const target = wm.get_workspace_by_index(index > 0 ? index - 1 : 1);
        const [ok, why] = this._canRemove(ws);
        if (!ok) {
            // on the spare empty workspace the shortcut just takes you back
            if (wm.n_workspaces > 1 && ws.active)
                target.activate(global.get_current_time());
            else
                osd('action-unavailable-symbolic', why);
            return;
        }

        this._removing = ws;
        const finish = () => {
            this._removing = null;
            this._doRemove(ws, target);
        };
        const dot = this._dots[this._workspaces.indexOf(ws)];
        const hit = dot?.get_parent();
        if (!hit?.get_stage()) {
            finish();
            return;
        }
        // flash ember, then shrink away while the neighbours close the gap
        dot.add_style_class_name('removing');
        hit.width = hit.width;
        hit.ease({
            opacity: 0, scale_x: 0.2, scale_y: 0.2, width: 0,
            duration: REMOVE_MS,
            mode: Clutter.AnimationMode.EASE_IN_BACK,
            onStopped: finish,
        });
    }

    _doRemove(ws, target) {
        const wm = global.workspace_manager;
        const alive = w => Array.from({length: wm.n_workspaces}, (_, i) => wm.get_workspace_by_index(i)).includes(w);
        if (!alive(ws) || !alive(target) || wm.n_workspaces <= 1) {
            this._rebuild();
            return;
        }
        const time = global.get_current_time();
        const label = `Workspace ${ws.index() + 1} removed`;
        let moved = 0;
        for (const w of ws.list_windows()) {
            if (w.is_on_all_workspaces() || w.get_transient_for() || w.is_override_redirect())
                continue;   // dialogs follow their parent, sticky windows stay sticky
            w.change_workspace(target);
            moved++;
        }
        if (ws.active)
            target.activate(time);
        // in dynamic mode GNOME may already have tidied the now-empty workspace away
        if (alive(ws))
            wm.remove_workspace(ws, time);
        else
            this._rebuild();
        osd('list-remove-symbolic', moved
            ? `${label} · ${moved} window${moved > 1 ? 's' : ''} moved`
            : label);
    }

    addWorkspace(after = global.workspace_manager.get_active_workspace()) {
        const wm = global.workspace_manager;
        const time = global.get_current_time();
        if (wm.n_workspaces >= MAX_WORKSPACES) {
            osd('action-unavailable-symbolic', `Already ${MAX_WORKSPACES} workspaces`);
            return;
        }
        // dynamic: an empty workspace would vanish the moment you leave it, so reuse it
        if (Meta.prefs_get_dynamic_workspaces() && !hasWindows(after)) {
            after.activate(time);
            osd('list-add-symbolic', `Workspace ${after.index() + 1} is empty — use this one`);
            return;
        }
        const pos = after.index() + 1;
        this._batch = true;                  // one rebuild for append + reorder
        let ws;
        try {
            ws = wm.append_new_workspace(false, time);
            if (ws.index() !== pos)
                wm.reorder_workspace(ws, pos);   // right after the one you are on, not at the end
        } finally {
            this._batch = false;
        }
        this._growWs = ws;
        this._rebuild();
        ws.activate(time);
        osd('list-add-symbolic', `Workspace ${pos + 1} added`);
    }

    // ------------------------------------------------------------ scrolling

    _onScroll(ev) {
        let dir = 0;
        switch (ev.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            dir = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            dir = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = ev.get_scroll_delta();
            this._scrollAcc += Math.abs(dy) > Math.abs(dx) ? dy : dx;
            if (Math.abs(this._scrollAcc) < 1)
                return Clutter.EVENT_STOP;
            dir = Math.sign(this._scrollAcc);
            this._scrollAcc = 0;
            break;
        }
        }
        const now = GLib.get_monotonic_time();
        if (!dir || now - this._scrollLock < 150000)   // one step per flick on touchpads
            return Clutter.EVENT_STOP;
        this._scrollLock = now;
        const wm = global.workspace_manager;
        const i = Math.max(0, Math.min(wm.get_active_workspace_index() + dir, wm.n_workspaces - 1));
        wm.get_workspace_by_index(i).activate(global.get_current_time());
        return Clutter.EVENT_STOP;
    }

    // ------------------------------------------------------------ a wallpaper per workspace
    _queueWallpaper() {
        if (this._wallId)
            GLib.source_remove(this._wallId);
        this._wallId = GLib.timeout_add(GLib.PRIORITY_LOW, WALL_SETTLE_MS, () => {
            this._wallId = 0;
            const n = global.workspace_manager.get_active_workspace_index() + 1;
            let own = {};
            try {
                own = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(WALL_CONF)[1])).workspaces ?? {};
            } catch {}
            if (Object.keys(own).length)
                this._spawn(['bapirlo-wallpaper', 'workspace', String(n)]);    // writes WALL_WS + changes it
            else
                this._writeWorkspace(n);
            return GLib.SOURCE_REMOVE;
        });
    }

    _writeWorkspace(n) {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(WALL_WS), 0o755);
            GLib.file_set_contents(WALL_WS, String(n));
        } catch (e) {
            logError(e, 'bapirlo-bar: workspace file');
        }
    }

    _spawn(argv) {
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, `bapirlo-bar: ${argv[0]}`);
        }
    }

    destroy() {
        if (this._wallId)
            GLib.source_remove(this._wallId);
        this._wallId = 0;
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._syncId = 0;
        this._menu?.destroy();
        this._menu = null;
        for (const ws of this._workspaces)
            ws.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        super.destroy();
    }
});
