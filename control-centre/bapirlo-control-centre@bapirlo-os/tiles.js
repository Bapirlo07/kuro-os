// Kuro Control Centre — tiles.
// Most tiles MIRROR GNOME's own quick-settings items (Wi-Fi, Bluetooth, DND, Night Light, dark
// mode, Caffeine, volume, brightness): they read the stock item's state and forward clicks to it,
// and "expanding" a tile borrows the stock item's own menu (network list, device list…).
// So the backends are GNOME's, the Control Centre only draws them. No timers while closed.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {buildMixer} from './mixer.js';

export const EASE = Clutter.AnimationMode.EASE_OUT_QUAD;
const HOME = GLib.get_home_dir();
const BIN = GLib.build_filenamev([HOME, 'bapirlo-os', 'bin']);
const LOW_DISK_GB = 15;

export function spawn(argv) {
    try {
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
    } catch (e) {
        logError(e, `bapirlo-cc: ${argv[0]} failed`);
    }
}

// GUI apps (Settings, Disk Usage, Files): GTK4 renders with Vulkan, and enumerating the NVIDIA
// ICD wakes the sleeping dGPU — the whole screen stalls ~1.7 s while it powers up. Intel only.
const IGPU_VK = '/usr/share/vulkan/icd.d/intel_icd.json';
export function spawnApp(argv) {
    try {
        const l = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        if (GLib.file_test(IGPU_VK, GLib.FileTest.EXISTS))
            l.setenv('VK_DRIVER_FILES', IGPU_VK, true);
        l.spawnv(argv);
    } catch (e) {
        logError(e, `bapirlo-cc: ${argv[0]} failed`);
    }
}

function label(text, style, ellipsize = true) {
    const l = new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER});
    l.clutter_text.ellipsize = ellipsize ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE;
    return l;
}

// ------------------------------------------------------------------ where the stock items live
const qs = () => Main.panel.statusArea.quickSettings;
const stockItem = (indicator, i = 0) => qs()?.[indicator]?.quickSettingsItems?.[i] ?? null;
const byClass = (list, name) => (list ?? []).find(c => c.constructor?.name === name) ?? null;

export const FIND = {
    wifi: () => byClass(qs()?._network?.quickSettingsItems, 'NMWirelessToggle'),
    bluetooth: () => stockItem('_bluetooth'),
    dnd: () => stockItem('_doNotDisturb'),
    nightlight: () => stockItem('_nightLight'),
    darkmode: () => stockItem('_darkMode'),
    caffeine: () => byClass(qs()?.menu?._grid?.get_children(), 'CaffeineToggle'),
    volume: () => stockItem('_volumeOutput'),
    brightness: () => stockItem('_brightness'),
    battery: () => stockItem('_system')?.powerToggle ?? null,
    power: () => stockItem('_system') ?? null,   // its menu = Power Off / Restart / Log Out
};

// ------------------------------------------------------------------ base tile
// size: 'small' = 1 cell (round icon + caption), 'wide' = 2 cells, 'full' = whole row
export const Tile = GObject.registerClass({
    Signals: {'expand': {}, 'activated': {}},
}, class BapirloTile extends St.Widget {
    _init(id, size, cc) {
        super._init({
            style_class: `bcc-tile bcc-${size}`,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this.tileId = id;
        this.tileSize = size;
        this.span = {small: 1, wide: 2, full: 4}[size];
        this._cc = cc;
        this._delegate = this;   // DND target in edit mode
        this.expandable = false;

        this.button = new St.Button({
            style_class: 'bcc-tile-button', x_expand: true, y_expand: true, can_focus: true,
            track_hover: true, button_mask: St.ButtonMask.PRIMARY,   // right-click: own gesture below
        });
        this.add_child(this.button);
        this.button.connect('clicked', (_b, mouseButton) => {
            if (this._cc.editing)
                return;
            if (this._longPressed) {
                this._longPressed = false;
                return;
            }
            this.activate(mouseButton);
        });
        const lp = new Clutter.LongPressGesture({required_button: Clutter.BUTTON_PRIMARY});
        lp.connect('recognize', () => {
            if (this._cc.editing || !this.expandable)
                return;
            this._longPressed = true;
            this.requestExpand();
        });
        this.button.add_action(lp);
        // St.Button's own gesture only reports the primary button on GNOME 51
        const rc = new Clutter.ClickGesture({required_button: Clutter.BUTTON_SECONDARY});
        rc.connect('recognize', () => {
            if (!this._cc.editing)
                this.requestExpand();
        });
        this.button.add_action(rc);

        // edit-mode remove badge
        this._badge = new St.Button({
            style_class: 'bcc-badge', child: new St.Icon({icon_name: 'list-remove-symbolic', icon_size: 12}),
            x_expand: true, y_expand: true,   // BinLayout only honours START with expand
            x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START, visible: false,
            translation_x: 3, translation_y: 3,
        });
        this._badge.connect('clicked', () => this._cc.removeTile(this.tileId));
        this.add_child(this._badge);
    }

    requestExpand() {
        if (this.expandable)
            this.emit('expand');
    }

    setEditing(on) {
        this._badge.visible = on;
        this.button.reactive = !on;
        if (on)
            this.add_style_pseudo_class('editing');
        else
            this.remove_style_pseudo_class('editing');
    }

    setActive(on) {
        if (on)
            this.add_style_pseudo_class('checked');
        else
            this.remove_style_pseudo_class('checked');
    }

    activate() {}

    // detail page: {title, icon, actor, onClose?} or null
    buildDetail() {
        return null;
    }

    // refresh things that are only read while open (disk space…)
    onOpen() {}

    // DND (edit mode): drop another tile on this one = move it here
    handleDragOver(source) {
        return source instanceof Tile && source !== this
            ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source) {
        if (!(source instanceof Tile) || source === this)
            return false;
        this._cc.moveTile(source.tileId, this.tileId);
        return true;
    }
});

// small: big round icon with a caption under it · wide: icon + title + subtitle
function buildFace(tile) {
    const icon = new St.Icon({style_class: 'bcc-icon'});
    const circle = new St.Bin({style_class: 'bcc-icon-circle', child: icon, y_align: Clutter.ActorAlign.CENTER});
    const title = label('', 'bcc-title');
    const sub = label('', 'bcc-subtitle');
    let box;
    if (tile.tileSize === 'small') {
        box = new St.BoxLayout({style_class: 'bcc-face-small', orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        circle.x_align = Clutter.ActorAlign.CENTER;
        title.x_align = Clutter.ActorAlign.CENTER;
        // captions wrap to two centred lines instead of being cut off
        title.clutter_text.set({ellipsize: Pango.EllipsizeMode.NONE, line_wrap: true,
            line_alignment: Pango.Alignment.CENTER});
        box.add_child(circle);
        box.add_child(title);
        sub.visible = false;
    } else {
        box = new St.BoxLayout({style_class: 'bcc-face-wide', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'bcc-text'});
        text.add_child(title);
        text.add_child(sub);
        box.add_child(circle);
        box.add_child(text);
    }
    // shown on wide tiles that open a list (Wi-Fi networks, Bluetooth devices)
    const chevron = new St.Icon({style_class: 'bcc-chevron', icon_name: 'go-next-symbolic',
        y_align: Clutter.ActorAlign.CENTER, visible: false});
    if (tile.tileSize !== 'small')
        box.add_child(chevron);
    tile.button.child = box;
    return {icon, circle, title, sub, box, chevron};
}

// ------------------------------------------------------------------ mirror of a stock toggle
export const MirrorTile = GObject.registerClass(
class BapirloMirrorTile extends Tile {
    _init(id, size, cc, {find, title, icon, subtitle = null}) {
        super._init(id, size, cc);
        this._find = find;
        this._fallback = {title, icon};
        this._subtitleFn = subtitle;
        this.face = buildFace(this);
        this._attach();
    }

    _attach() {
        const item = this._find();
        if (item === this._item)
            return;
        this._item?.disconnectObject(this);
        this._item = item;
        item?.connectObject(
            'notify::checked', () => this._sync(),
            'notify::title', () => this._sync(),
            'notify::subtitle', () => this._sync(),
            'notify::icon-name', () => this._sync(),
            'notify::gicon', () => this._sync(),
            'notify::visible', () => this._sync(),
            'notify::menu-enabled', () => this._sync(),
            'destroy', () => {
                this._item = null;
                this._sync();
            }, this);
        this._sync();
    }

    onOpen() {
        this._attach();   // an extension item (Caffeine) may have appeared since
    }

    _sync() {
        const it = this._item;
        const {face} = this;
        this.expandable = !!it?.menu && it.menuEnabled !== false;
        face.chevron.visible = this.expandable && this.tileSize === 'wide';
        face.title.text = it?.title || this._fallback.title;
        const sub = this._subtitleFn ? this._subtitleFn(it) : it?.subtitle;
        face.sub.text = sub || (it ? (it.checked ? 'On' : 'Off') : 'Unavailable');
        if (it?.gicon)
            face.icon.gicon = it.gicon;
        else
            face.icon.icon_name = it?.icon_name || this._fallback.icon;
        this.setActive(!!it?.checked && it.visible);
        this.button.reactive = !!it && it.visible && !this._cc.editing;
        if (it && !it.visible)
            this.add_style_pseudo_class('insensitive');
        else
            this.remove_style_pseudo_class('insensitive');
    }

    // wide tiles with a menu (Wi-Fi, Bluetooth) work like macOS: the round icon toggles,
    // the rest of the tile opens the list. Keyboard (button 0) still toggles.
    activate(mouseButton = 0) {
        const it = this._item;
        if (!it)
            return;
        if (mouseButton && this.tileSize === 'wide' && this.expandable && !this._pointerOnIcon()) {
            this.requestExpand();
            return;
        }
        if (it.toggle_mode)
            it.checked = !it.checked;
        else
            it.emit('clicked', Clutter.BUTTON_PRIMARY);
    }

    _pointerOnIcon() {
        const SLOP = 6;   // a little extra so the circle is easy to hit
        const [x, y] = global.get_pointer();
        const c = this.face.circle;
        const [ok, lx, ly] = c.transform_stage_point(x, y);
        return ok && lx >= -SLOP && ly >= -SLOP && lx <= c.width + SLOP && ly <= c.height + SLOP;
    }

    buildDetail() {
        const it = this._item;
        if (!it?.menu)
            return null;
        return borrowMenu(it, this.face.title.text, this.face.icon, {scanSpinner: it._scanningSpinner});
    }

    destroy() {
        this._item?.disconnectObject(this);
        super.destroy();
    }
});

// Show a stock QuickToggleMenu's content inside the Control Centre. The menu's box is moved
// into the detail page and handed back when the page closes. The menu is never open()ed (that
// would take a second modal grab); instead it is told it is open so Wi-Fi starts scanning,
// Bluetooth re-sorts devices, etc.
// GNOME 51 gives every quick-settings item with a menu its own PopupMenuManager, which answers
// "open-state-changed" with Main.pushModal(menu.actor) — and menu.actor stays behind, hidden, in
// the closed stock panel: every click and key then goes to an invisible actor (desktop frozen,
// Esc / click-outside call the no-op close below). So the menu leaves that manager while borrowed.
export function borrowMenu(item, title, iconActor, {scanSpinner = null} = {}) {
    const menu = item.menu;
    // the manager belongs to the item that created the menu (for Power Off: a hidden ShutdownItem)
    const mgr = menu.sourceActor?._menuManager ?? item._menuManager ?? null;
    mgr?.removeMenu(menu);
    const box = menu.box;
    const home = box.get_parent();
    home?.remove_child(box);
    const holder = new St.BoxLayout({style_class: 'bcc-borrowed', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
    holder.add_child(box);
    box.opacity = 255;
    box.add_style_class_name('bcc-borrowed-box');
    // the page has its own header; and don't let the menu stretch to fill the page
    const header = menu._header;
    const headerWas = header?.visible;
    header?.hide();
    const stretch = box.get_children().map(c => [c, c.y_expand]);
    box.y_expand = false;
    stretch.forEach(([c]) => (c.y_expand = false));
    const wasOpen = menu.isOpen;
    menu.isOpen = true;
    menu.emit('open-state-changed', true);
    // items close "their" menu when activated; keep the Control Centre open instead
    const origClose = menu.close;
    menu.close = () => false;
    // each step on its own: one failing must not leave the menu half borrowed
    const steps = [
        () => (menu.close = origClose),
        () => {
            menu.isOpen = wasOpen;
            menu.emit('open-state-changed', false);
        },
        () => box.remove_style_class_name('bcc-borrowed-box'),
        () => header && (header.visible = headerWas),
        () => {
            stretch.forEach(([c, y]) => (c.y_expand = y));
            box.y_expand = true;
        },
        () => {
            if (box.get_parent() === holder)
                holder.remove_child(box);
            if (home && !box.get_parent())
                home.add_child(box);
        },
        () => mgr?.addMenu(menu),   // after the "closed" signal, so it never grabs
    ];
    return {
        title, gicon: iconActor.gicon, icon: iconActor.icon_name, actor: holder,
        menuActor: menu.actor,
        // the stock Wi-Fi spinner lives in the (hidden) header; it is visible while a scan runs
        scanning: scanSpinner ? () => scanSpinner.opacity > 0 : null,
        onClose: () => {
            for (const s of steps) {
                try {
                    s();
                } catch (e) {
                    logError(e, 'bapirlo-cc: returning a borrowed menu');
                }
            }
        },
    };
}

// ------------------------------------------------------------------ slider mirror (volume / brightness)
export const SliderTile = GObject.registerClass(
class BapirloSliderTile extends Tile {
    _init(id, cc, {find, title, icon, mixer = false}) {
        super._init(id, 'full', cc);
        this._find = find;
        this._mixer = mixer;     // Sound: the page also has a slider per app
        this._title = title;
        this._fallbackIcon = icon;
        this.button.reactive = false;
        this.button.can_focus = false;

        const row = new St.BoxLayout({style_class: 'bcc-slider-row', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._iconBtn = new St.Button({style_class: 'bcc-slider-icon', can_focus: true,
            child: new St.Icon({icon_name: icon, icon_size: 18}), y_align: Clutter.ActorAlign.CENTER});
        this._iconBtn.connect('clicked', () => this._item?._iconButton?.emit('clicked', Clutter.BUTTON_PRIMARY));
        this.slider = new Slider(0);
        this.slider.accessible_name = title;
        const bin = new St.Bin({style_class: 'bcc-slider-bin', child: this.slider, x_expand: true, reactive: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._value = label('', 'bcc-slider-value', false);
        this._more = new St.Button({style_class: 'bcc-slider-more', can_focus: true, visible: false,
            child: new St.Icon({icon_name: 'go-next-symbolic', icon_size: 14}), y_align: Clutter.ActorAlign.CENTER});
        this._more.connect('clicked', () => this.requestExpand());
        const head = label(title, 'bcc-slider-title', false);
        const col = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'bcc-slider-col'});
        const top = new St.BoxLayout({x_expand: true});
        top.add_child(head);
        top.add_child(new St.Widget({x_expand: true}));
        top.add_child(this._value);
        col.add_child(top);
        const line = new St.BoxLayout({x_expand: true, style_class: 'bcc-slider-line'});
        line.add_child(this._iconBtn);
        line.add_child(bin);
        line.add_child(this._more);
        col.add_child(line);
        row.add_child(col);
        this.insert_child_below(row, this._badge);

        this.slider.connect('notify::value', () => {
            if (this._syncing || !this._item)
                return;
            this._item.slider.value = this.slider.value;   // the stock slider applies it
            this._syncValue();
        });
        this._attach();
    }

    _attach() {
        const item = this._find();
        if (item === this._item)
            return;
        this._item?.slider?.disconnectObject(this);
        this._item?.disconnectObject(this);
        this._item = item;
        item?.slider.connectObject('notify::value', () => this._sync(), this);
        item?.connectObject(
            'notify::visible', () => this._sync(),
            'notify::menu-enabled', () => this._sync(),
            'notify::icon-name', () => this._sync(),
            'notify::gicon', () => this._sync(), this);
        this._sync();
    }

    onOpen() {
        this._attach();
    }

    _sync() {
        const it = this._item;
        this.visible = !!it && it.visible;
        if (!it)
            return;
        this._syncing = true;
        this.slider.value = it.slider.value;
        this._syncing = false;
        const icon = this._iconBtn.child;
        if (it.gicon)
            icon.gicon = it.gicon;
        else
            icon.icon_name = it.iconName || it.icon_name || this._fallbackIcon;
        this.expandable = this._mixer || (!!it.menu && it.menuEnabled);
        this._more.visible = this.expandable;
        this._syncValue();
    }

    _syncValue() {
        const max = this._item?.slider?.maximum_value ?? 1;
        this._value.text = `${Math.round(this.slider.value / (max || 1) * 100)}%`;
    }

    setEditing(on) {
        super.setEditing(on);
        this.slider.reactive = !on;
    }

    buildDetail() {
        const it = this._item;
        const d = it?.menu && it.menuEnabled !== false ? borrowMenu(it, this._title, this._iconBtn.child) : null;
        if (!this._mixer)
            return d;
        const mix = buildMixer();
        const page = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'bcc-sound-page'});
        if (d)
            page.add_child(d.actor);
        page.add_child(mix.actor);
        const icon = this._iconBtn.child;
        return {...(d ?? {title: this._title, gicon: icon.gicon, icon: icon.icon_name}), actor: page,
            onClose: () => {
                mix.destroy();
                d?.onClose?.();
            }};
    }

    destroy() {
        this._item?.slider?.disconnectObject(this);
        this._item?.disconnectObject(this);
        super.destroy();
    }
});

// ------------------------------------------------------------------ power profile (Balanced / Performance / Quiet)
const PP_BUS = 'org.freedesktop.UPower.PowerProfiles';
const PP_PATH = '/org/freedesktop/UPower/PowerProfiles';
const PPProxy = Gio.DBusProxy.makeProxyWrapper(`<node><interface name="${PP_BUS}">
  <property name="ActiveProfile" type="s" access="readwrite"/>
  <property name="ActiveProfileHolds" type="aa{sv}" access="read"/>
</interface></node>`);
const PROFILES = [
    ['power-saver', 'Quiet', 'power-profile-power-saver-symbolic'],
    ['balanced', 'Balanced', 'power-profile-balanced-symbolic'],
    ['performance', 'Performance', 'power-profile-performance-symbolic'],
];

export const PowerTile = GObject.registerClass(
class BapirloPowerTile extends Tile {
    _init(id, cc) {
        super._init(id, 'wide', cc);
        this.face = buildFace(this);
        this.expandable = true;
        this._cancel = new Gio.Cancellable();
        this._proxy = new PPProxy(Gio.DBus.system, PP_BUS, PP_PATH, (p, e) => {
            if (e)
                return;
            this._proxy.connectObject('g-properties-changed', () => this._sync(), this);
            this._sync();
        }, this._cancel);
        this._sync();
    }

    get profile() {
        return this._proxy?.ActiveProfile ?? null;
    }

    _sync() {
        const p = PROFILES.find(x => x[0] === this.profile);
        this.face.title.text = 'Power Mode';
        const game = (this._proxy?.ActiveProfileHolds ?? []).some(h => h.ApplicationId?.deepUnpack?.() === 'bapirlo-game');
        this.face.sub.text = p ? `${p[1]}${game ? ' · game' : ''}` : 'Unavailable';
        this.face.icon.icon_name = p?.[2] ?? 'power-profile-balanced-symbolic';
        this.setActive(this.profile === 'performance');
        this._detailSync?.();
    }

    setProfile(profile) {
        Gio.DBus.system.call(PP_BUS, PP_PATH, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [PP_BUS, 'ActiveProfile', new GLib.Variant('s', profile)]),
            null, Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION, 5000, this._cancel, (c, r) => {
                try {
                    c.call_finish(r);
                } catch (e) {
                    logError(e, 'bapirlo-cc: could not set power profile');
                }
            });
    }

    activate() {   // click cycles Quiet → Balanced → Performance
        const i = PROFILES.findIndex(x => x[0] === this.profile);
        this.setProfile(PROFILES[(i + 1) % PROFILES.length][0]);
    }

    buildDetail() {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bcc-list'});
        const rows = PROFILES.map(([key, name, icon]) => {
            const row = new St.Button({style_class: 'bcc-row', can_focus: true, x_expand: true});
            const inner = new St.BoxLayout({x_expand: true});
            inner.add_child(new St.Icon({icon_name: icon, style_class: 'bcc-row-icon'}));
            inner.add_child(label(name, 'bcc-row-label'));
            inner.add_child(new St.Widget({x_expand: true}));
            const tick = new St.Icon({icon_name: 'object-select-symbolic', style_class: 'bcc-row-tick'});
            inner.add_child(tick);
            row.child = inner;
            row.connect('clicked', () => this.setProfile(key));
            box.add_child(row);
            return [key, row, tick];
        });
        box.add_child(new St.Label({style_class: 'bcc-note', text: 'Plugging in/out switches automatically (bapirlo-perfd). Games hold Performance.'}));
        box.get_last_child().clutter_text.line_wrap = true;
        this._detailSync = () => rows.forEach(([key, row, tick]) => {
            tick.opacity = key === this.profile ? 255 : 0;
            if (key === this.profile)
                row.add_style_pseudo_class('checked');
            else
                row.remove_style_pseudo_class('checked');
        });
        this._detailSync();
        return {title: 'Power Mode', icon: 'power-profile-balanced-symbolic', actor: box,
            onClose: () => (this._detailSync = null)};
    }

    destroy() {
        this._cancel.cancel();
        this._proxy?.disconnectObject(this);
        super.destroy();
    }
});

// ------------------------------------------------------------------ screen recording (gpu-screen-recorder)
const SD = 'org.freedesktop.systemd1';
const UnitProxy = Gio.DBusProxy.makeProxyWrapper(`<node><interface name="org.freedesktop.systemd1.Unit">
  <property name="ActiveState" type="s" access="read"/>
</interface></node>`);
const unitPath = n => `/org/freedesktop/systemd1/unit/${n.replace(/[^A-Za-z0-9]/g, c => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;

function watchUnit(name, cb, cancellable) {
    const p = new UnitProxy(Gio.DBus.session, SD, unitPath(name), (px, e) => {
        if (e)
            return;
        px.connect('g-properties-changed', () => cb(px.ActiveState));
        cb(px.ActiveState);
    }, cancellable);
    return p;
}

export const RecordTile = GObject.registerClass(
class BapirloRecordTile extends Tile {
    _init(id, cc) {
        super._init(id, 'small', cc);
        this.face = buildFace(this);
        this.face.title.text = 'Screen Rec';
        this.face.icon.icon_name = 'media-record-symbolic';
        this.expandable = true;
        this._cancel = new Gio.Cancellable();
        this._rec = 'inactive';
        this._replay = 'inactive';
        // transient units only exist while running; systemd still answers for the path
        this._p1 = watchUnit('bapirlo-record.service', s => {
            this._rec = s;
            this._sync();
        }, this._cancel);
        this._p2 = watchUnit('bapirlo-replay.service', s => {
            this._replay = s;
            this._sync();
        }, this._cancel);
    }

    get recording() {
        return this._rec === 'active' || this._rec === 'activating';
    }

    _sync() {
        this.setActive(this.recording);
        this.face.title.text = this.recording ? 'Recording' : 'Screen Rec';
        if (this.recording)
            this.add_style_class_name('bcc-recording');
        else
            this.remove_style_class_name('bcc-recording');
        this._detailSync?.();
    }

    activate() {
        spawn([`${BIN}/bapirlo-record`, 'toggle']);
        if (!this.recording)
            this._cc.close();   // get the panel out of the first frames
    }

    buildDetail() {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bcc-list'});
        const add = (icon, text, fn) => {
            const row = new St.Button({style_class: 'bcc-row', can_focus: true, x_expand: true});
            const inner = new St.BoxLayout({x_expand: true});
            inner.add_child(new St.Icon({icon_name: icon, style_class: 'bcc-row-icon'}));
            const l = label(text, 'bcc-row-label');
            inner.add_child(l);
            row.child = inner;
            row.connect('clicked', fn);
            box.add_child(row);
            return l;
        };
        const recL = add('media-record-symbolic', '', () => this.activate());
        const bufL = add('view-refresh-symbolic', '', () => spawn([`${BIN}/bapirlo-replay`, 'toggle']));
        add('document-save-symbolic', 'Save last 30 s', () => spawn([`${BIN}/bapirlo-replay`, 'save']));
        add('folder-videos-symbolic', 'Open Videos folder', () => {
            spawnApp(['xdg-open', GLib.build_filenamev([HOME, 'Videos'])]);
            this._cc.close();
        });
        this._detailSync = () => {
            recL.text = this.recording ? 'Stop recording' : 'Record screen';
            bufL.text = this._replay === 'active' ? 'Instant replay: on' : 'Instant replay: off';
        };
        this._detailSync();
        return {title: 'Screen Recording', icon: 'media-record-symbolic', actor: box,
            onClose: () => (this._detailSync = null)};
    }

    destroy() {
        this._cancel.cancel();
        super.destroy();
    }
});

// ------------------------------------------------------------------ battery
// health and the charge limit come straight from sysfs (msi-ec); the limit is changed through
// pkexec bapirlo-charge 80|100 (polkit os.bapirlo.charge-limit: no password at the laptop)
const BAT_SYS = '/sys/class/power_supply/BAT1';
const CHARGE_HELPER = '/usr/local/lib/bapirlo/bapirlo-charge';
const LIMITS = [
    ['80', 'Daily · stop at 80%', 'battery-good-symbolic', 'Kinder to the battery — the everyday choice'],
    ['100', 'Travel · charge to 100%', 'battery-full-charging-symbolic', 'Full range for a day away from a plug'],
];

function readSys(name) {
    try {
        const [ok, b] = GLib.file_get_contents(`${BAT_SYS}/${name}`);
        return ok ? new TextDecoder().decode(b).trim() : '';
    } catch {
        return '';
    }
}

export function batteryHealth() {
    const full = Number(readSys('charge_full') || readSys('energy_full'));
    const design = Number(readSys('charge_full_design') || readSys('energy_full_design'));
    const unit = readSys('charge_full') ? 'Ah' : 'Wh';
    return {
        pct: full > 0 && design > 0 ? Math.round(full / design * 100) : null,
        full: full / 1e6, design: design / 1e6, unit,
        cycles: Number(readSys('cycle_count')) || 0,   // this EC reports 0 = unknown
        limit: readSys('charge_control_end_threshold'),
    };
}

export const BatteryTile = GObject.registerClass(
class BapirloBatteryTile extends Tile {
    _init(id, cc) {
        super._init(id, 'wide', cc);
        this.face = buildFace(this);
        this.expandable = true;
        // fill bar behind the face; a soft sweep runs only while charging AND the panel is open
        this._fill = new St.Widget({style_class: 'bcc-battery-fill', x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.START});
        this._sweep = new St.Widget({style_class: 'bcc-battery-sweep', x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.START, opacity: 0});
        this.insert_child_below(this._fill, this.button);
        this.insert_child_above(this._sweep, this._fill);
        this.connect('notify::width', () => this._layoutFill());
        this._attach();
    }

    _attach() {
        const t = FIND.battery();
        if (t === this._item)
            return;
        this._item?.disconnectObject(this);
        this._item = t;
        t?.connectObject('notify::title', () => this._sync(), 'notify::gicon', () => this._sync(),
            'notify::visible', () => this._sync(), this);
        t?._proxy?.connectObject('g-properties-changed', () => this._sync(), this);
        this._sync();
    }

    onOpen() {
        this._attach();
        this._animate(true);
    }

    onClose() {
        this._animate(false);
    }

    get _pct() {
        return this._item?._proxy?.Percentage ?? 0;
    }

    get charging() {
        return this._item?._proxy?.State === 1;
    }

    _sync() {
        const it = this._item;
        this.visible = !!it && it.visible;
        if (!it)
            return;
        const st = it._proxy?.State;
        this.face.title.text = `${Math.round(this._pct)}%`;
        const limit = readSys('charge_control_end_threshold');
        this.face.sub.text = (st === 1 ? 'Charging' : st === 4 ? 'Full' : st === 5 ? 'Plugged in' : 'On battery') +
            (limit === '100' ? ' · Travel' : limit ? ` · limit ${limit}%` : '');
        if (it.gicon)
            this.face.icon.gicon = it.gicon;
        this.setActive(this.charging);
        if (this._pct <= 15 && !this.charging)
            this.add_style_class_name('bcc-low');
        else
            this.remove_style_class_name('bcc-low');
        this._layoutFill();
        if (this._cc.isOpen)
            this._animate(true);
    }

    _layoutFill() {
        if (!this.get_stage())
            return;
        this._fill.width = Math.round(this.width * Math.min(100, this._pct) / 100);
    }

    _animate(on) {
        this._sweep.remove_all_transitions();
        if (!on || !this.charging) {
            this._sweep.opacity = 0;
            return;
        }
        const w = this.width || 170;
        this._sweep.width = Math.round(w * 0.35);
        const run = () => {
            this._sweep.translation_x = -this._sweep.width;
            this._sweep.opacity = 255;
            this._sweep.ease({translation_x: w, duration: 1600, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                onComplete: () => {
                    if (this._cc.isOpen && this.charging)
                        this._sweepId = GLib.timeout_add(GLib.PRIORITY_LOW, 700, () => {
                            this._sweepId = 0;
                            run();
                            return GLib.SOURCE_REMOVE;
                        });
                }});
        };
        run();
    }

    activate() {
        this.requestExpand();
    }

    buildDetail() {
        const it = this._item;
        if (!it)
            return null;
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bcc-list'});
        const p = it._proxy;
        const fmt = s => (s > 0 ? `${Math.floor(s / 3600)} h ${Math.round(s % 3600 / 60)} min` : '—');
        const rows = [
            ['Level', `${Math.round(this._pct)}%`],
            [this.charging ? 'Time to full' : 'Time left', fmt(this.charging ? p?.TimeToFull : p?.TimeToEmpty)],
        ];
        const h = batteryHealth();
        if (h.pct !== null)
            rows.push(['Health', `${h.pct}%  (${h.full.toFixed(2)} of ${h.design.toFixed(2)} ${h.unit})`]);
        if (h.cycles > 0)
            rows.push(['Charge cycles', `${h.cycles}`]);
        for (const [k, v] of rows) {
            const r = new St.BoxLayout({style_class: 'bcc-kv'});
            r.add_child(label(k, 'bcc-kv-key'));
            r.add_child(new St.Widget({x_expand: true}));
            r.add_child(label(v, 'bcc-kv-val', false));
            box.add_child(r);
        }
        box.add_child(label('CHARGE LIMIT', 'bcc-kv-key'));
        box.get_last_child().style = 'padding: 8px 10px 2px 10px; font-weight: 700;';
        const limitRows = LIMITS.map(([value, name, icon]) => {
            const row = new St.Button({style_class: 'bcc-row', can_focus: true, x_expand: true});
            const inner = new St.BoxLayout({x_expand: true});
            inner.add_child(new St.Icon({icon_name: icon, style_class: 'bcc-row-icon'}));
            inner.add_child(label(name, 'bcc-row-label'));
            inner.add_child(new St.Widget({x_expand: true}));
            const tick = new St.Icon({icon_name: 'object-select-symbolic', style_class: 'bcc-row-tick'});
            inner.add_child(tick);
            row.child = inner;
            row.connect('clicked', () => this.setLimit(value));
            box.add_child(row);
            return [value, row, tick];
        });
        const note = new St.Label({style_class: 'bcc-note', text: ''});
        note.clutter_text.line_wrap = true;
        box.add_child(note);
        this._limitSync = () => {
            const now = readSys('charge_control_end_threshold');
            for (const [value, row, tick] of limitRows) {
                tick.opacity = value === now ? 255 : 0;
                if (value === now)
                    row.add_style_pseudo_class('checked');
                else
                    row.remove_style_pseudo_class('checked');
            }
            note.text = LIMITS.find(l => l[0] === now)?.[3] ?? (now ? `Limit ${now}% (set elsewhere)` : 'No charge limit control (msi-ec not loaded?)');
        };
        this._limitSync();
        const btn = new St.Button({style_class: 'bcc-row', can_focus: true, x_expand: true,
            child: label('Power settings…', 'bcc-row-label')});
        btn.connect('clicked', () => {
            spawnApp(['gnome-control-center', 'power']);
            this._cc.close();
        });
        box.add_child(btn);
        return {title: 'Battery', gicon: it.gicon, actor: box, onClose: () => (this._limitSync = null)};
    }

    setLimit(value) {
        if (!GLib.file_test(CHARGE_HELPER, GLib.FileTest.IS_EXECUTABLE)) {
            Main.notify('Charge limit', 'The helper is not installed yet — run 1400-round14-install.sh');
            return;
        }
        try {
            const proc = Gio.Subprocess.new(['pkexec', CHARGE_HELPER, value],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_check_async(null, (p, r) => {
                try {
                    p.wait_check_finish(r);
                } catch (e) {
                    logError(e, 'bapirlo-cc: charge limit');
                }
                this._limitSync?.();
                this._sync();
            });
        } catch (e) {
            logError(e, 'bapirlo-cc: charge limit');
        }
    }

    destroy() {
        if (this._sweepId)
            GLib.source_remove(this._sweepId);
        this._item?._proxy?.disconnectObject(this);
        this._item?.disconnectObject(this);
        super.destroy();
    }
});

// ------------------------------------------------------------------ storage (free space on /)
export const StorageTile = GObject.registerClass(
class BapirloStorageTile extends Tile {
    _init(id, cc) {
        super._init(id, 'wide', cc);
        this.face = buildFace(this);
        this.face.title.text = 'Storage';
        this.face.icon.icon_name = 'drive-harddisk-symbolic';
        this.expandable = true;
        this._bar = new St.Widget({style_class: 'bcc-storage-bar', x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.END});
        this._used = new St.Widget({style_class: 'bcc-storage-used', x_align: Clutter.ActorAlign.START});
        this._bar.add_child(this._used);
        this._bar.layout_manager = new Clutter.BinLayout();
        this.insert_child_above(this._bar, this.button);
        this.onOpen();
    }

    onOpen() {
        // async: the shell must never wait on the disk
        this._cancel?.cancel();
        this._cancel = new Gio.Cancellable();
        Gio.File.new_for_path('/').query_filesystem_info_async('filesystem::free,filesystem::size',
            GLib.PRIORITY_DEFAULT, this._cancel, (f, res) => {
                try {
                    const info = f.query_filesystem_info_finish(res);
                    this._free = info.get_attribute_uint64('filesystem::free');
                    this._size = info.get_attribute_uint64('filesystem::size');
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    this._free = this._size = 0;
                }
                this._show();
            });
        if (this._size === undefined) {   // first open: the answer is a moment away
            this.face.sub.text = '…';
            this._detailText = 'Checking free space…';
        }
    }

    _show() {
        const gb = this._free / 1e9;
        this.face.sub.text = `${gb.toFixed(gb < 100 ? 1 : 0)} GB free`;
        this._detailText = `${gb.toFixed(1)} GB free of ${Math.round(this._size / 1e9)} GB on the Linux drive`;
        const low = gb < LOW_DISK_GB;
        if (low)
            this.add_style_class_name('bcc-low');
        else
            this.remove_style_class_name('bcc-low');
        this.setActive(false);
        this.face.title.text = low ? 'Storage low' : 'Storage';
        const frac = this._size ? 1 - this._free / this._size : 0;
        const w = () => {
            if (this._bar.get_stage())
                this._used.width = Math.round(Math.max(0, this._bar.width) * frac);
        };
        this._bar.disconnectObject(this);
        this._bar.connectObject('notify::width', w, this);
        w();
    }

    activate() {
        this.requestExpand();
    }

    buildDetail() {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bcc-list'});
        const status = label(this._detailText, 'bcc-note', false);
        box.add_child(status);
        const add = (icon, text, fn) => {
            const row = new St.Button({style_class: 'bcc-row', can_focus: true, x_expand: true});
            const inner = new St.BoxLayout({x_expand: true});
            inner.add_child(new St.Icon({icon_name: icon, style_class: 'bcc-row-icon'}));
            const l = label(text, 'bcc-row-label');
            inner.add_child(l);
            row.child = inner;
            row.connect('clicked', () => fn(l));
            box.add_child(row);
        };
        add('edit-clear-all-symbolic', 'Clean up (caches, old packages, logs)', l => {
            l.text = 'Cleaning… (asks for your password)';
            spawn([`${BIN}/bapirlo-cleanup-now`]);
        });
        add('baobab-symbolic', 'Show what uses space', () => {
            spawnApp(['baobab', '/']);
            this._cc.close();
        });
        return {title: 'Storage', icon: 'drive-harddisk-symbolic', actor: box};
    }

    destroy() {
        this._cancel?.cancel();
        this._bar.disconnectObject(this);
        super.destroy();
    }
});

// ------------------------------------------------------------------ now playing → opens the media dropdown
export const MediaTile = GObject.registerClass(
class BapirloMediaTile extends Tile {
    _init(id, cc) {
        super._init(id, 'full', cc);
        this.add_style_class_name('bcc-media');
        const box = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'bcc-media-box'});
        this._art = new St.Bin({style_class: 'bcc-media-art', child: new St.Icon({icon_name: 'emblem-music-symbolic', icon_size: 18})});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._t = label('', 'bcc-title');
        this._a = label('', 'bcc-subtitle');
        text.add_child(this._t);
        text.add_child(this._a);
        this._pp = new St.Button({style_class: 'bcc-media-btn', can_focus: true, child: new St.Icon({icon_name: 'media-playback-start-symbolic', icon_size: 16}),
            y_align: Clutter.ActorAlign.CENTER});
        this._pp.connect('clicked', () => this._player?.playPause?.());
        this._next = new St.Button({style_class: 'bcc-media-btn', can_focus: true, child: new St.Icon({icon_name: 'media-skip-forward-symbolic', icon_size: 16}),
            y_align: Clutter.ActorAlign.CENTER});
        this._next.connect('clicked', () => this._player?.next?.());
        box.add_child(this._art);
        box.add_child(text);
        box.add_child(this._pp);
        box.add_child(this._next);
        this.button.child = box;
    }

    get _btn() {
        return Main.panel.statusArea['bapirlo-media'] ?? null;
    }

    onOpen() {
        const b = this._btn;
        b?.connectObject('notify::style-class', () => this._sync(), this);
        this._sync();
    }

    onClose() {
        this._btn?.disconnectObject(this);
    }

    _sync() {
        const b = this._btn;
        const p = b?._view?.player ?? null;
        this._player = p;
        const active = !!p?.title;
        this._t.text = active ? p.title : 'Nothing playing';
        this._a.text = active ? (p.artists?.join(', ') || p.identity || '') : (b ? 'Open the media panel' : 'Media extension off');
        this._pp.visible = this._next.visible = active;
        this._pp.child.icon_name = p?.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        if (b?._thumbPath && active) {
            this._art.child = null;
            this._art.set_style(`background-image: url("file://${b._thumbPath}");`);
        } else {
            this._art.set_style(null);
            if (!this._art.child)
                this._art.child = new St.Icon({icon_name: 'emblem-music-symbolic', icon_size: 18});
        }
        this.setActive(!!p?.playing);
    }

    activate() {
        const b = this._btn;
        if (!b)
            return;
        this._cc.close();
        b.toggle();
    }

    destroy() {
        this._btn?.disconnectObject(this);
        super.destroy();
    }
});

// ------------------------------------------------------------------ script-backed switches (round 7)
// AirPlay, Remote access, Live Captions, Vault, Live Wallpaper: a bin/ script (+ `args`) answers
// `status` (exit 0 = on) and does `toggle`. The state is read only when the panel opens and shortly after a click — nothing
// runs while the Control Centre is closed.
export const CommandTile = GObject.registerClass(
class BapirloCommandTile extends Tile {
    _init(id, cc, {title, onTitle = title, icon, script, args = []}) {
        super._init(id, 'small', cc);
        this.face = buildFace(this);
        this._title = title;
        this._onTitle = onTitle;
        this._cmd = [`${BIN}/${script}`, ...args];
        this.face.icon.icon_name = icon;
        this.face.title.text = title;
        this._on = false;
        this.onOpen();
    }

    _set(on) {
        this._on = on;
        this.setActive(on);
        this.face.title.text = on ? this._onTitle : this._title;
    }

    onOpen() {
        this._cancel?.cancel();
        this._cancel = new Gio.Cancellable();
        let proc;
        try {
            proc = Gio.Subprocess.new([...this._cmd, 'status'],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            this.reactive = false;
            return;
        }
        proc.wait_check_async(this._cancel, (p, res) => {
            try {
                p.wait_check_finish(res);
                this._set(true);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._set(false);
            }
        });
    }

    activate() {
        this._set(!this._on);   // answer the click at once; the re-checks below correct it
        spawn([...this._cmd, 'toggle']);
        for (const ms of [1500, 4000]) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timers.delete(id);
                this.onOpen();
                return GLib.SOURCE_REMOVE;
            });
            (this._timers ??= new Set()).add(id);
        }
    }

    destroy() {
        this._cancel?.cancel();
        for (const id of this._timers ?? [])
            GLib.source_remove(id);
        super.destroy();
    }
});

// ------------------------------------------------------------------ Theme Studio
// Tap: open the app. Expand (right-click / long-press): the saved themes — tap one to switch to it
// (studio/bapirlo-studio apply ID, cross-faded by bapirlo-studio@bapirlo-os). The list is read
// only when the page opens: a handful of tiny JSON files.
const STUDIO_DIR = GLib.build_filenamev([HOME, 'bapirlo-os', 'studio']);
const STUDIO_PRESETS = GLib.build_filenamev([GLib.get_user_data_dir(), 'bapirlo', 'theme-studio', 'presets']);
const STUDIO_ACTIVE = GLib.build_filenamev([GLib.get_user_state_dir(), 'bapirlo', 'studio', 'active.json']);

function readJson(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

export const StudioTile = GObject.registerClass(
class BapirloStudioTile extends Tile {
    _init(id, cc) {
        super._init(id, 'small', cc);
        this.face = buildFace(this);
        this.face.icon.icon_name = 'bapirlo-studio-symbolic';
        this.face.title.text = 'Theme Studio';
        this.expandable = true;
    }

    activate() {
        spawnApp([`${STUDIO_DIR}/bapirlo-theme-studio`]);
        this._cc.close();
    }

    _presets() {
        const out = [{id: 'original', name: 'Original Kuro OS', created: Infinity}];
        try {
            const en = Gio.File.new_for_path(STUDIO_PRESETS).enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const p = readJson(GLib.build_filenamev([STUDIO_PRESETS, info.get_name(), 'preset.json']));
                if (p?.id && p?.name)
                    out.push(p);
            }
        } catch {}
        return out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    }

    buildDetail() {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'bcc-list'});
        const active = readJson(STUDIO_ACTIVE)?.preset ?? 'original';
        for (const p of this._presets()) {
            const row = new St.Button({style_class: 'bcc-row', can_focus: true, x_expand: true});
            const inner = new St.BoxLayout({x_expand: true});
            inner.add_child(new St.Icon({icon_name: 'bapirlo-studio-symbolic', style_class: 'bcc-row-icon'}));
            inner.add_child(Object.assign(label(p.name, 'bcc-row-label'), {x_expand: true}));
            if (p.id === active) {
                row.add_style_pseudo_class('checked');
                inner.add_child(new St.Icon({icon_name: 'object-select-symbolic', style_class: 'bcc-row-tick'}));
            }
            row.child = inner;
            row.connect('clicked', () => {
                if (p.id !== active)
                    spawn([`${STUDIO_DIR}/bapirlo-studio`, 'apply', p.id]);
                this._cc.close();
            });
            box.add_child(row);
        }
        const open = new St.Button({style_class: 'bcc-row', can_focus: true, x_expand: true});
        const oi = new St.BoxLayout({x_expand: true});
        oi.add_child(new St.Icon({icon_name: 'list-add-symbolic', style_class: 'bcc-row-icon'}));
        oi.add_child(label('New theme from a wallpaper…', 'bcc-row-label'));
        open.child = oi;
        open.connect('clicked', () => this.activate());
        box.add_child(open);
        return {title: 'Theme Studio', icon: 'bapirlo-studio-symbolic', actor: box};
    }
});
