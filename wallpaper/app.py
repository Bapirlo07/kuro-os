"""Kuro Wallpapers — one window, two tabs (GTK4 / libadwaita).

Wallpapers tab (WallpaperPage, below) and Theme tab (Theme Studio, studio/studio_page.py).
`bapirlo-wallpapers --page theme [PICTURE]` opens on the Theme tab (Super+Alt+T, the Control Centre tile).

Wallpapers tab — top: what's on screen now, its colours, and the mode (Fixed / Time of day / Shuffle) with the
"colours follow the wallpaper" switch. Below: every wallpaper — yours first, then the Kuro ones —
click one to use it, drop files anywhere on the window to add them, right-click for time-of-day tags,
remove / hide. All the work happens in lib/bapirlo_wallpaper.py (the same code bin/bapirlo-wallpaper
and the 10-minute timer use).
"""
import os
import sys
import threading

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk, Pango  # noqa: E402

HERE = os.path.dirname(os.path.realpath(__file__))
OS_DIR = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(OS_DIR, "lib"))
sys.path.insert(0, os.path.join(OS_DIR, "studio"))
import bapirlo_wallpaper as W  # noqa: E402
import bapirlo_wallmedia as M  # noqa: E402
from studio_page import StudioPage  # noqa: E402

APP_ID = "os.bapirlo.Wallpapers"
FILTERS = [("all", "All"), ("mine", "Yours"), ("live", "Live"), ("dawn", "Dawn"), ("day", "Day"),
           ("dusk", "Dusk"), ("night", "Night")]
MODE_LABELS = {"fixed": "Fixed", "time": "Time of day", "shuffle": "Shuffle"}
SWATCHES = ("crimson", "ember", "accent2", "accent3", "surface", "paper")


def bg(fn, done=None, fail=None):
    """Run fn() in a thread; hand the result (or the exception) back on the GTK main loop."""
    def work():
        try:
            r = fn()
        except Exception as e:  # noqa: BLE001 — shown to the user
            GLib.idle_add(fail or (lambda e: print("wallpapers:", e, file=sys.stderr)), e)
        else:
            if done:
                GLib.idle_add(done, r)
    threading.Thread(target=work, daemon=True).start()


def lbl(text="", css=(), xalign=0.0, ellipsize=False, wrap=False, **kw):
    w = Gtk.Label(label=text, xalign=xalign, css_classes=list(css), **kw)
    if ellipsize:
        w.set_ellipsize(Pango.EllipsizeMode.END)
    if wrap:
        w.set_wrap(True)
        w.set_wrap_mode(Pango.WrapMode.WORD_CHAR)
    return w


def btn(text=None, css=("kuro",), cb=None, icon=None, tip=None):
    b = Gtk.Button(css_classes=list(css))
    if icon and text:
        b.set_child(Adw.ButtonContent(icon_name=icon, label=text))
    elif icon:
        b.set_icon_name(icon)
    else:
        b.set_label(text)
    if cb:
        b.connect("clicked", lambda *_: cb())
    if tip:
        b.set_tooltip_text(tip)
    return b


def pretty(item):
    s = item["name"].replace("_", " ").replace("-", " ").strip()
    return (s[:34] + "…" if len(s) > 35 else s) or "Wallpaper"


def ext_settings(uuid, schema_id):
    """Settings of one of our shell extensions, from its installed schemas (None if not installed)."""
    d = os.path.join(GLib.get_user_data_dir(), "gnome-shell", "extensions", uuid, "schemas")
    if not os.path.isdir(d):
        return None
    src = Gio.SettingsSchemaSource.new_from_directory(d, Gio.SettingsSchemaSource.get_default(), False)
    schema = src.lookup(schema_id, False)
    return Gio.Settings.new_full(schema, None, None) if schema else None


def mmss(t):
    return f"{int(t) // 60}:{t % 60:04.1f}"


class LoopDialog(Adw.Dialog):
    """Cut a seamless loop out of a video: pick where it starts, how long, how soft the seam."""

    def __init__(self, win, item):
        super().__init__(title="Make a seamless loop", content_width=620)
        self.win, self.item = win, item
        self.info = M.probe(item["path"])
        self.dur = self.info["duration"] or 10.0
        self.cancelled = False
        self._frame_gen = 0
        self._frame_timer = 0

        tv = Adw.ToolbarView()
        hb = Adw.HeaderBar()
        tv.add_top_bar(hb)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, margin_start=20, margin_end=20,
                      margin_top=6, margin_bottom=20, css_classes=["page-wallpapers", "loop-dialog"])
        self.pic = Gtk.Picture(content_fit=Gtk.ContentFit.COVER, height_request=300, can_shrink=True, css_classes=["now"])
        box.append(self.pic)
        box.append(lbl(f"{pretty(item)} — {self.dur:.1f} s, {self.info['width']}×{self.info['height']}, "
                       f"{self.info['fps']:.0f} fps", ["dim"], ellipsize=True))

        grid = Gtk.Grid(column_spacing=12, row_spacing=10)
        self.start = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, max(0.1, self.dur), 0.1)
        self.start.set_hexpand(True)
        self.start.set_draw_value(False)
        self.start_lbl = lbl("0:00.0", ["dim"], width_chars=7)
        self.start.connect("value-changed", lambda *_: self.changed())
        grid.attach(lbl("Starts at", ["dim"]), 0, 0, 1, 1)
        grid.attach(self.start, 1, 0, 1, 1)
        grid.attach(self.start_lbl, 2, 0, 1, 1)

        self.length = Gtk.SpinButton.new_with_range(2, max(2, min(60, self.dur)), 0.5)
        self.length.set_value(min(10, max(2, self.dur - 1.5)))
        self.length.set_digits(1)
        self.length.connect("value-changed", lambda *_: self.changed())
        grid.attach(lbl("Length", ["dim"]), 0, 1, 1, 1)
        grid.attach(self.length, 1, 1, 1, 1)
        grid.attach(lbl("seconds", ["faint"]), 2, 1, 1, 1)

        self.fade = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 3, 0.1)
        self.fade.set_value(1.0)
        self.fade.set_draw_value(False)
        self.fade_lbl = lbl("1.0 s", ["dim"], width_chars=7)
        self.fade.connect("value-changed", lambda *_: self.changed())
        grid.attach(lbl("Seam blend", ["dim"]), 0, 2, 1, 1)
        grid.attach(self.fade, 1, 2, 1, 1)
        grid.attach(self.fade_lbl, 2, 2, 1, 1)

        sw, sh = M.screen_size()
        self.sizes = [(sw, sh)] + [z for z in ((1920, 1200), (1280, 800)) if z != (sw, sh)]
        self.size = Gtk.DropDown.new_from_strings([f"{w}×{h}" + (" (your screen)" if i == 0 else "")
                                                   for i, (w, h) in enumerate(self.sizes)])
        src_fps = round(self.info["fps"]) or 30
        self.fpss = sorted({min(60, src_fps), 30})[::-1]
        self.fps = Gtk.DropDown.new_from_strings([f"{f} fps" for f in self.fpss])
        row = Gtk.Box(spacing=8)
        row.append(self.size)
        row.append(self.fps)
        grid.attach(lbl("Size", ["dim"]), 0, 3, 1, 1)
        grid.attach(row, 1, 3, 2, 1)
        box.append(grid)

        self.hint = lbl("", ["faint"], wrap=True)
        box.append(self.hint)
        self.bar = Gtk.ProgressBar(visible=False, show_text=True)
        box.append(self.bar)
        btns = Gtk.Box(spacing=10, halign=Gtk.Align.END)
        btns.append(btn("Cancel", ("kuro",), self.close))
        self.go = btn("Make loop", ("kuro", "accent"), self.make)
        btns.append(self.go)
        box.append(btns)
        tv.set_content(box)
        self.set_child(tv)
        self.connect("closed", lambda *_: setattr(self, "cancelled", True))
        self.changed()

    def bounds(self):
        ln, fd = self.length.get_value(), self.fade.get_value()
        fd = min(fd, ln / 2)
        return ln, fd, max(0.0, self.dur - ln - fd)

    def changed(self):
        ln, fd, max_start = self.bounds()
        adj = self.start.get_adjustment()
        adj.set_upper(max(0.1, max_start))
        if self.start.get_value() > max_start:
            self.start.set_value(max_start)
        st = self.start.get_value()
        self.start_lbl.set_label(mmss(st))
        self.fade_lbl.set_label(f"{fd:.1f} s")
        ok = self.dur >= ln + fd - 0.05
        self.go.set_sensitive(ok)
        self.hint.set_label(
            (f"Uses {mmss(st)} – {mmss(st + ln + fd)}. The last {fd:.1f} s blend into the first, so the end flows "
             "back to the start without a jump. No sound; made on the Intel graphics.")
            if ok else f"The video is only {self.dur:.1f} s — make the loop shorter or the blend softer.")
        if self._frame_timer:
            GLib.source_remove(self._frame_timer)
        self._frame_timer = GLib.timeout_add(250, self.show_frame)

    def show_frame(self):
        self._frame_timer = 0
        self._frame_gen += 1
        gen, t, path = self._frame_gen, self.start.get_value(), self.item["path"]
        out = os.path.join(M.CACHE, "loop-frame.jpg")

        def work():
            os.makedirs(M.CACHE, exist_ok=True)
            import subprocess
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", path, "-frames:v", "1",
                            "-vf", "scale=640:-2", out], check=True, timeout=30)
            with open(out, "rb") as f:
                return f.read()

        def done(data):
            if gen == self._frame_gen:
                self.pic.set_paintable(Gdk.Texture.new_from_bytes(GLib.Bytes.new(data)))
        bg(work, done)
        return GLib.SOURCE_REMOVE

    def make(self):
        ln, fd, _ = self.bounds()
        st = self.start.get_value()
        size = self.sizes[self.size.get_selected()]
        fps = self.fpss[self.fps.get_selected()]
        src = self.item["path"]
        out = M.loop_name(src, W.LIBRARY)
        self.go.set_sensitive(False)
        self.bar.set_visible(True)
        self.bar.set_fraction(0)
        self.bar.set_text("Making the loop…")

        def prog(f):
            GLib.idle_add(lambda: (self.bar.set_fraction(f), self.bar.set_text(f"{f * 100:.0f} %"))[0] and False)

        def done(path):
            self.win.walls.loop_made(path)
            self.close()

        def fail(e):
            self.bar.set_visible(False)
            self.go.set_sensitive(True)
            self.hint.set_label(f"Couldn't make it: {e}")
        bg(lambda: M.make_loop(src, st, ln, fd, out, size=size, fps=fps, progress=prog), done, fail)


def studio_palette():
    try:
        import studio as S
        return (S.active() or {}).get("palette")
    except Exception:  # noqa: BLE001
        return None


class Tile(Gtk.Box):
    def __init__(self, win, item):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=6, css_classes=["tile"])
        self.win, self.item = win, item
        self.pic = Gtk.Picture(content_fit=Gtk.ContentFit.COVER, width_request=232, height_request=145,
                               css_classes=["thumb"], can_shrink=True)
        over = Gtk.Overlay(child=self.pic)
        badges = Gtk.Box(spacing=4, halign=Gtk.Align.START, valign=Gtk.Align.START, margin_start=8, margin_top=8)
        if item["live"]:
            badges.append(lbl("LIVE", ["badge", "live"]))
        for t in item["tags"]:
            badges.append(lbl(t.upper(), ["badge"]))
        if item.get("hidden"):
            badges.append(lbl("HIDDEN", ["badge"]))
        over.add_overlay(badges)
        self.append(over)
        row = Gtk.Box(spacing=4)
        row.append(lbl(pretty(item), ["name"], ellipsize=True, hexpand=True))
        menu = Gtk.MenuButton(icon_name="view-more-symbolic", css_classes=["flat-kuro"], valign=Gtk.Align.CENTER,
                              tooltip_text="Time of day, remove…")
        menu.set_popover(self.build_menu())
        self.menu = menu
        row.append(menu)
        self.append(row)
        click = Gtk.GestureClick(button=3)
        click.connect("pressed", lambda *_: menu.popup())
        self.add_controller(click)
        self.set_tooltip_text(item["path"])

    def build_menu(self):
        pop = Gtk.Popover()
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2, margin_top=6, margin_bottom=6,
                      margin_start=6, margin_end=6)
        box.append(lbl("Show at", ["faint"], margin_start=4, margin_bottom=2))
        self.checks = {}
        for s in W.SLOTS:
            c = Gtk.CheckButton(label=s.capitalize(), active=s in self.item["tags"])
            c.connect("toggled", lambda *_: self.win.retag(self.item, [k for k, v in self.checks.items() if v.get_active()]))
            self.checks[s] = c
            box.append(c)
        box.append(Gtk.Separator(margin_top=4, margin_bottom=4))
        box.append(btn("Use this one", ("flat-kuro",), lambda: (pop.popdown(), self.win.choose(self.item))))
        if self.item["live"]:
            box.append(btn("Make a seamless loop…", ("flat-kuro",), lambda: (pop.popdown(), self.win.make_loop(self.item))))
        box.append(btn("Show in Files", ("flat-kuro",), lambda: (pop.popdown(), self.win.reveal(self.item))))
        if self.item.get("hidden"):
            box.append(btn("Show again", ("flat-kuro",), lambda: (pop.popdown(), self.win.unhide(self.item))))
        else:
            box.append(btn("Move to Bin" if self.item["mine"] else "Hide", ("flat-kuro", "danger"),
                           lambda: (pop.popdown(), self.win.remove(self.item))))
        pop.set_child(box)
        return pop

    def set_current(self, on):
        if on:
            self.pic.add_css_class("picked")
        else:
            self.pic.remove_css_class("picked")


class WallpaperPage(Gtk.Box):
    def __init__(self, win):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, css_classes=["page-wallpapers"])
        self.win = win
        self.toasts = win.toasts
        self.css = Gtk.CssProvider()
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), self.css,
                                                  Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)
        self.reload_css()
        self.filter = "all"
        self.show_hidden = False
        self.tiles = []
        self.busy = False
        self.syncing = False

        self.build_header()
        self.banner = lbl("Live engine not installed yet — videos show as a still frame", ["notice"], xalign=0.5)
        self.append(self.banner)
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14, margin_start=22, margin_end=22,
                       margin_bottom=18, margin_top=6, vexpand=True)
        body.append(self.build_now())
        body.append(self.build_filters())
        self.flow = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, activate_on_single_click=True,
                                homogeneous=True, row_spacing=14, column_spacing=14, min_children_per_line=3, max_children_per_line=8,
                                valign=Gtk.Align.START)
        self.flow.connect("child-activated", lambda _f, child: self.choose(child.get_child().item))
        self.empty = Adw.StatusPage(icon_name="folder-pictures-symbolic", title="Nothing here yet",
                                    description="Drop pictures or videos on this window, or press Add.",
                                    visible=False, css_classes=["compact"])
        sc = Gtk.ScrolledWindow(vexpand=True, hscrollbar_policy=Gtk.PolicyType.NEVER)
        col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        col.append(self.flow)
        col.append(self.empty)
        sc.set_child(col)
        body.append(sc)
        self.append(body)

        self.monitors = []
        for d in [W.LIBRARY] + [os.path.join(W.LIBRARY, s) for s in W.SLOTS]:
            os.makedirs(d, exist_ok=True)
            m = Gio.File.new_for_path(d).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, None)
            m.set_rate_limit(800)
            m.connect("changed", lambda *_: self.schedule_reload())
            self.monitors.append(m)
        self._reload_id = 0
        self.reload()

    # ------------------------------------------------------------------ look
    def reload_css(self):
        with open(os.path.join(HERE, "style.css")) as f:
            css = f.read()
        roles = studio_palette()
        if roles:
            try:
                import engine as E
                css = E.remap_text(css, E.Transform(roles))
            except Exception:  # noqa: BLE001 — the Kuro colours are fine too
                pass
        self.css.load_from_string(css)

    def build_header(self):
        """Header buttons — the window shows them while this tab is open."""
        self.head_start = Gtk.Box(spacing=6)
        self.head_start.append(btn("Add", ("kuro",), self.pick_files, icon="list-add-symbolic",
                                   tip="Add pictures or videos (or drop them on the window)"))
        self.head_start.append(btn(icon="folder-open-symbolic", css=("flat-kuro",), cb=self.open_folder,
                                   tip=f"Open {W.LIBRARY}"))
        self.head_end = Gtk.Box()
        self.head_end.append(btn(icon="media-skip-forward-symbolic", css=("flat-kuro",), cb=self.next_one,
                                 tip="Next wallpaper (Super+Alt+N)"))

    def build_now(self):
        card = Gtk.Box(spacing=20, css_classes=["card"])
        self.now_pic = Gtk.Picture(content_fit=Gtk.ContentFit.COVER, width_request=320, height_request=200,
                                   css_classes=["now"], can_shrink=True, hexpand=False, valign=Gtk.Align.CENTER)
        card.append(self.now_pic)
        info = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, hexpand=True, valign=Gtk.Align.CENTER)
        info.append(lbl("NOW SHOWING", ["heading"]))
        self.now_name = lbl("", ["title"], ellipsize=True)
        info.append(self.now_name)
        self.now_sub = lbl("", ["dim"], ellipsize=True)
        info.append(self.now_sub)
        self.swatches = Gtk.Box(spacing=6)
        info.append(self.swatches)

        modes = Gtk.Box(spacing=0, css_classes=["linked", "modes"])
        self.mode_btns = {}
        first = None
        for m, text in MODE_LABELS.items():
            b = Gtk.ToggleButton(label=text, css_classes=["mode"])
            if first:
                b.set_group(first)
            first = first or b
            b.connect("toggled", self.on_mode, m)
            self.mode_btns[m] = b
            modes.append(b)
        row = Gtk.Box(spacing=12)
        row.append(modes)
        self.hours = Gtk.SpinButton.new_with_range(1, 24, 1)
        self.hours.set_tooltip_text("Hours between changes")
        self.hours.connect("value-changed", self.on_hours)
        self.hours_box = Gtk.Box(spacing=6)
        self.hours_box.append(lbl("every", ["dim"]))
        self.hours_box.append(self.hours)
        self.hours_box.append(lbl("h", ["dim"]))
        row.append(self.hours_box)
        info.append(row)
        self.mode_hint = lbl("", ["faint"], ellipsize=True)
        info.append(self.mode_hint)

        trow = Gtk.Box(spacing=10)
        self.theme_sw = Gtk.Switch(valign=Gtk.Align.CENTER)
        self.theme_sw.connect("notify::active", self.on_theme)
        trow.append(self.theme_sw)
        trow.append(lbl("OS colours follow the wallpaper", ["dim"]))
        info.append(trow)
        card.append(info)
        card.append(self.build_extras())
        return card

    def build_extras(self):
        """LIVE EXTRAS: battery behaviour, lock screen, parallax, widgets dodge."""
        col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=9, valign=Gtk.Align.CENTER,
                      css_classes=["extras"], width_request=300)
        col.append(lbl("LIVE EXTRAS", ["heading"]))
        brow = Gtk.Box(spacing=8)
        brow.append(lbl("On battery", ["dim"], hexpand=True))
        bmodes = Gtk.Box(css_classes=["linked", "modes"])
        self.bat_btns = {}
        first = None
        for key, text, tip in (("lite", "Lighter", "Keeps moving: a 1280×800, 24 fps copy plays (pauses only when the battery is low)"),
                               ("pause", "Pause", "The video freezes while you're on battery")):
            b = Gtk.ToggleButton(label=text, css_classes=["mode"], tooltip_text=tip)
            if first:
                b.set_group(first)
            first = first or b
            b.connect("toggled", self.on_battery_mode, key)
            self.bat_btns[key] = b
            bmodes.append(b)
        brow.append(bmodes)
        col.append(brow)

        def switch_row(text, tip, cb):
            row = Gtk.Box(spacing=10, tooltip_text=tip)
            sw = Gtk.Switch(valign=Gtk.Align.CENTER)
            sw.connect("notify::active", cb)
            row.append(sw)
            row.append(lbl(text, ["dim"], hexpand=True))
            col.append(row)
            return sw, row
        self.lock_sw, _ = switch_row("Lock screen moves too", "The lock screen plays a 12 s loop of the live wallpaper",
                                     self.on_lock)
        self.dodge_sw, self.dodge_row = switch_row(
            "Widgets dodge the character", "Desk widgets that would cover the wallpaper's subject move beside it",
            self.on_dodge)
        self.par_sw, self.par_row = switch_row("Parallax", "The wallpaper follows the mouse a little (live ones too)",
                                               self.on_parallax)
        self.par_scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0.25, 3.0, 0.05)
        self.par_scale.set_draw_value(False)
        self.par_scale.set_hexpand(True)
        self.par_scale.set_tooltip_text("How far it moves")
        self.par_scale.connect("value-changed", self.on_parallax_strength)
        self.par_row.append(self.par_scale)
        self.ws_sw, self.ws_row = switch_row(
            "Own wallpaper for this workspace", "On: what you pick now shows only on this workspace (the colours follow "
            "when you switch to it). Off: it shows the normal wallpaper again", self.on_ws)
        self.ws_label = self.ws_row.get_last_child()
        self.desk = ext_settings("bapirlo-desk@bapirlo-os", "org.gnome.shell.extensions.bapirlo-desk")
        self.live = ext_settings("bapirlo-live@bapirlo-os", "org.gnome.shell.extensions.bapirlo-live")
        if self.desk:
            self.desk.connect("changed", lambda *_: self.sync_extras())
        if self.live:
            self.live.connect("changed", lambda *_: self.sync_extras())
        return col

    def sync_extras(self, c=None):
        c = c or W.conf()
        self.syncing = True
        self.bat_btns.get(c.get("battery"), self.bat_btns["lite"]).set_active(True)
        self.lock_sw.set_active(bool(c.get("lock_live")))
        self.lock_sw.set_sensitive(W.lock_ready())
        has_dodge = bool(self.desk and self.desk.props.settings_schema.has_key("widgets-dodge"))
        self.dodge_row.set_sensitive(has_dodge)
        self.dodge_sw.set_active(has_dodge and self.desk.get_boolean("widgets-dodge"))
        has_par = bool(self.live and self.live.props.settings_schema.has_key("parallax-strength"))
        self.par_row.set_sensitive(has_par)
        if has_par:
            self.par_sw.set_active(self.live.get_boolean("parallax"))
            self.par_scale.set_value(self.live.get_double("parallax-strength"))
        self.par_scale.set_sensitive(self.par_sw.get_active())
        n = W.current_workspace()
        self.ws_label.set_label(f"Own wallpaper for workspace {n}")
        self.ws_sw.set_active(bool(W.ws_wallpaper(c, n)))
        self.syncing = False

    def on_ws(self, sw, _p):
        if self.syncing:
            return
        n = W.current_workspace()
        if sw.get_active():
            path = W.state().get("path") or W.target()
            self.run(f"Workspace {n} keeps this wallpaper — pick another to change it…",
                     lambda: W.set_workspace(n, path), f"Workspace {n} has its own wallpaper now — pick one")
        else:
            self.run(f"Workspace {n} back to the normal wallpaper…", lambda: W.set_workspace(n, None))

    def own_workspace(self):
        """bapirlo-wallpaper workspace pick: switch it on for the workspace on screen."""
        if not self.ws_sw.get_active():
            self.ws_sw.set_active(True)

    def on_battery_mode(self, b, mode):
        if self.syncing or not b.get_active():
            return
        bg(lambda: W.set_battery(mode), lambda _r: self.toast(
            "On battery the video keeps moving (a lighter copy is being made)" if mode == "lite"
            else "On battery the video pauses"))

    def on_lock(self, sw, _p):
        if self.syncing:
            return
        on = sw.get_active()
        bg(lambda: W.set_lock_live(on), lambda _r: self.toast(
            "The lock screen will play the live wallpaper (ready in a minute)" if on else "Lock screen: still picture"))

    def on_dodge(self, sw, _p):
        if not self.syncing and self.desk:
            self.desk.set_boolean("widgets-dodge", sw.get_active())

    def on_parallax(self, sw, _p):
        self.par_scale.set_sensitive(sw.get_active())
        if not self.syncing and self.live:
            self.live.set_boolean("parallax", sw.get_active())

    def on_parallax_strength(self, sc):
        if not self.syncing and self.live:
            self.live.set_double("parallax-strength", round(sc.get_value(), 2))

    def build_filters(self):
        row = Gtk.Box(spacing=6)
        first = None
        for key, text in FILTERS:
            b = Gtk.ToggleButton(label=text, css_classes=["chip"], active=key == "all")
            if first:
                b.set_group(first)
            first = first or b
            b.connect("toggled", lambda b, k: b.get_active() and self.set_filter(k), key)
            row.append(b)
        row.append(Gtk.Box(hexpand=True))
        hid = Gtk.CheckButton(label="Show hidden")
        hid.connect("toggled", lambda c: (setattr(self, "show_hidden", c.get_active()), self.reload()))
        row.append(hid)
        return row

    # ------------------------------------------------------------------ data → widgets
    def schedule_reload(self):
        if not self._reload_id:
            self._reload_id = GLib.timeout_add(600, self._do_reload)

    def _do_reload(self):
        self._reload_id = 0
        self.reload()
        return False

    def reload(self):
        c, st = W.conf(), W.state()
        self.syncing = True
        self.mode_btns[c["mode"]].set_active(True)
        self.hours.set_value(c.get("shuffle_hours") or 3)
        self.hours_box.set_visible(c["mode"] == "shuffle")
        self.theme_sw.set_active(c["theme"])
        self.syncing = False
        self.sync_extras(c)
        self.banner.set_visible(not W.live_available())
        self.mode_hint.set_label({
            "fixed": "Stays on what you pick.",
            "time": "Dawn, day, dusk and night from sunrise and sunset — tag wallpapers with ⋯ to choose which.",
            "shuffle": "A different wallpaper every few hours."}[c["mode"]])

        while (child := self.flow.get_first_child()):
            self.flow.remove(child)
        self.tiles = []
        its = W.items(include_hidden=self.show_hidden)
        f = self.filter
        shown = [i for i in its if f == "all" or (f == "mine" and i["mine"]) or (f == "live" and i["live"])
                 or f in i["tags"]]
        for it in shown:
            t = Tile(self, it)
            t.set_current(it["path"] == st.get("path"))
            self.flow.append(t)
            self.tiles.append(t)
        self.empty.set_visible(not shown)
        self.update_now()
        paths = [t.item["path"] for t in self.tiles]
        bg(lambda: [(p, W.thumb(p)) for p in paths if os.path.exists(p)], self.set_thumbs)

    def set_thumbs(self, pairs):
        by = dict(pairs)
        for t in self.tiles:
            if t.item["path"] in by:
                t.pic.set_filename(by[t.item["path"]])

    def update_now(self):
        st = W.state()
        p = st.get("path") or ""
        if p and os.path.exists(p):
            bg(lambda: W.thumb(p, 480), self.now_pic.set_filename)
        name = os.path.splitext(os.path.basename(p))[0] if p else "—"
        self.now_name.set_label(name.replace("_", " ").replace("-", " "))
        c = W.conf()
        if st.get("live"):
            live = ("Live — a lighter copy plays on battery" if c.get("battery") == "lite" else "Live — pauses on battery") \
                + "; pauses with a maximised window and in the overview"
        elif not W.is_video(p):
            live = "Picture"
        elif not W.live_available():
            live = "Video (shown as a still frame until the live engine is installed)"
        else:
            live = "Video — live is switched off, so it shows a still frame (top-bar button or Control Centre)"
        self.now_sub.set_label(live)
        while (c := self.swatches.get_first_child()):
            self.swatches.remove(c)
        roles = studio_palette()
        if roles and W.conf()["theme"]:
            for k in SWATCHES:
                if k in roles:
                    sw = Gtk.Box(css_classes=["swatch"], tooltip_text=f"{k} {roles[k]}")
                    prov = Gtk.CssProvider()
                    prov.load_from_string(f"box {{ background-color: {roles[k]}; }}")
                    sw.get_style_context().add_provider(prov, Gtk.STYLE_PROVIDER_PRIORITY_USER + 2)
                    self.swatches.append(sw)
        for t in self.tiles:
            t.set_current(t.item["path"] == p)

    def set_filter(self, key):
        self.filter = key
        self.reload()

    # ------------------------------------------------------------------ actions
    def toast(self, text, timeout=3):
        self.toasts.add_toast(Adw.Toast(title=text, timeout=timeout))

    def run(self, what, fn, done_text=None):
        if self.busy:
            self.toast("Still applying the last one…")
            return
        self.busy = True
        self.win.set_cursor(Gdk.Cursor.new_from_name("progress"))
        self.toast(what, 2)

        def done(_r):
            self.busy = False
            self.win.set_cursor(None)
            self.win.theme_changed()
            if done_text:
                self.toast(done_text)

        def fail(e):
            self.busy = False
            self.win.set_cursor(None)
            self.toast(f"Couldn't do that: {e}", 6)
            self.reload()
        bg(fn, done, fail)

    def choose(self, item):
        theme = W.conf()["theme"]
        self.run("Applying" + (" — colours are updating…" if theme else "…"), lambda: W.choose(item["path"]))

    def next_one(self):
        self.run("Next wallpaper…", W.next_one)

    def make_loop(self, item):
        LoopDialog(self.win, item).present(self.win)

    def loop_made(self, path):
        self.reload()
        t = Adw.Toast(title=f"Loop ready: {os.path.basename(path)}", timeout=8, button_label="Use it")
        t.connect("button-clicked", lambda *_: self.choose({"path": path}))
        self.toasts.add_toast(t)

    def on_mode(self, b, mode):
        if self.syncing or not b.get_active():
            return
        self.hours_box.set_visible(mode == "shuffle")
        self.run(f"{MODE_LABELS[mode]}…", lambda: W.set_mode(mode))

    def on_hours(self, spin):
        if self.syncing:
            return
        h = int(spin.get_value())
        c = W.conf()
        c["shuffle_hours"] = h
        W.save_conf(c)

    def on_theme(self, sw, _p):
        if self.syncing:
            return
        on = sw.get_active()
        self.run("Matching the colours to the wallpaper…" if on else "Back to the original Kuro colours…",
                 lambda: W.set_theme(on))

    def retag(self, item, tags):
        W.set_tags(item["path"], tags)
        item["tags"] = tags
        self.schedule_reload()

    def remove(self, item):
        try:
            W.remove(item["path"])
        except GLib.Error as e:
            self.toast(f"Couldn't move it to the Bin: {e.message}", 6)
            return
        self.toast("Moved to the Bin" if item["mine"] else "Hidden — tick “Show hidden” to bring it back")
        self.reload()

    def unhide(self, item):
        W.unhide(item["path"])
        self.reload()

    def reveal(self, item):
        Gtk.FileLauncher(file=Gio.File.new_for_path(item["path"])).open_containing_folder(self.win, None, None)

    def open_folder(self):
        Gtk.FileLauncher(file=Gio.File.new_for_path(W.LIBRARY)).launch(self.win, None, None)

    def add_files(self, paths):
        slot = self.filter if self.filter in W.SLOTS else None

        def work():
            return W.add(paths, slot)

        def done(new):
            n = len(new)
            self.toast(f"Added {n} wallpaper{'s' if n != 1 else ''}" + (f" to {slot}" if slot and n else "")
                       if n else "Nothing new — already there, or not a picture / video")
            self.reload()
        bg(work, done, lambda e: self.toast(f"Couldn't add: {e}", 6))

    def pick_files(self):
        flt = Gtk.FileFilter(name="Pictures and videos")
        for ext in W.IMG_EXT + W.VID_EXT:
            flt.add_suffix(ext.lstrip("."))
        store = Gio.ListStore.new(Gtk.FileFilter)
        store.append(flt)
        dlg = Gtk.FileDialog(title="Add wallpapers", filters=store, default_filter=flt)

        def done(d, res):
            try:
                files = d.open_multiple_finish(res)
            except GLib.Error:
                return
            self.add_files([files.get_item(i).get_path() for i in range(files.get_n_items())])
        dlg.open_multiple(self.win, None, done)


class Window(Adw.ApplicationWindow):
    """The two tabs, one header: the tab switcher in the middle, the open tab's buttons either side."""

    def __init__(self, app, page="wallpapers"):
        super().__init__(application=app, title="Wallpapers", default_width=1240, default_height=820)
        self.add_css_class("bapirlo-wallpapers")
        self.toasts = Adw.ToastOverlay()
        self.walls = WallpaperPage(self)
        self.studio = StudioPage(self)
        self.stack = Adw.ViewStack(vexpand=True)
        self.stack.add_titled_with_icon(self.walls, "wallpapers", "Wallpapers", "preferences-desktop-wallpaper-symbolic")
        self.stack.add_titled_with_icon(self.studio, "theme", "Theme", "preferences-desktop-appearance-symbolic")

        hb = Adw.HeaderBar(css_classes=["flat"])
        hb.set_title_widget(Adw.ViewSwitcher(stack=self.stack, policy=Adw.ViewSwitcherPolicy.WIDE))
        self.head_start, self.head_end = Gtk.Stack(hhomogeneous=False), Gtk.Stack(hhomogeneous=False)
        for name, pg in (("wallpapers", self.walls), ("theme", self.studio)):
            self.head_start.add_named(pg.head_start, name)
            self.head_end.add_named(pg.head_end, name)
        hb.pack_start(self.head_start)
        hb.pack_end(self.head_end)
        tv = Adw.ToolbarView()
        tv.add_top_bar(hb)
        tv.set_content(self.stack)
        self.toasts.set_child(tv)
        self.set_content(self.toasts)

        drop = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        drop.connect("drop", self.on_drop)
        drop.connect("enter", lambda *_: (self.add_css_class("dropping"), Gdk.DragAction.COPY)[1])
        drop.connect("leave", lambda *_: self.remove_css_class("dropping"))
        self.add_controller(drop)

        self.stack.connect("notify::visible-child-name", lambda *_: self.on_page())
        self.show_page(page)
        self.on_page()

    def show_page(self, name):
        self.stack.set_visible_child_name("theme" if name in ("theme", "studio") else "wallpapers")

    def on_page(self):
        name = self.stack.get_visible_child_name()
        self.head_start.set_visible_child_name(name)
        self.head_end.set_visible_child_name(name)
        self.set_title("Theme Studio" if name == "theme" else "Wallpapers")
        if name == "theme":
            self.studio.refresh()
        else:
            self.walls.reload()

    def theme_changed(self):
        """Either tab changed the OS colours: both tabs re-read them."""
        self.walls.reload_css()
        self.studio.reload_css()
        self.walls.reload()
        self.studio.refresh()

    def open_files(self, paths):
        """Files opened from Files / a launcher / dropped: the Theme tab takes one picture, the Wallpapers tab all."""
        if self.stack.get_visible_child_name() == "theme":
            self.studio.add_picture(paths[0])
        else:
            self.walls.add_files(paths)

    def on_drop(self, _t, value, _x, _y):
        self.remove_css_class("dropping")
        paths = [f.get_path() for f in value.get_files() if f.get_path()]
        if paths:
            self.open_files(paths)
        return True


class App(Adw.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_OPEN)
        self.win = None
        self.page = "wallpapers"
        self.add_main_option("page", 0, GLib.OptionFlags.NONE, GLib.OptionArg.STRING,
                             "Open on this tab: wallpapers or theme", "PAGE")
        self.add_main_option("workspace", 0, GLib.OptionFlags.NONE, GLib.OptionArg.INT,
                             "Pick a wallpaper for this workspace only (bapirlo-wallpaper workspace pick)", "N")

    def do_handle_local_options(self, opts):
        page = opts.lookup_value("page", GLib.VariantType.new("s"))
        if page:
            # also reaches a window that is already open (the action runs in the first instance)
            self.register(None)
            self.activate_action("page", GLib.Variant("s", page.get_string()))
        if opts.contains("workspace"):
            self.register(None)
            self.activate_action("page", GLib.Variant("s", "wallpapers"))
            self.activate_action("own-workspace", None)
        return -1

    def do_startup(self):
        Adw.Application.do_startup(self)
        Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.FORCE_DARK)
        a = Gio.SimpleAction.new("quit", None)
        a.connect("activate", lambda *_: self.quit())
        self.add_action(a)
        self.set_accels_for_action("app.quit", ["<Ctrl>q", "<Ctrl>w"])
        a = Gio.SimpleAction.new("page", GLib.VariantType.new("s"))
        a.connect("activate", self.on_page_action)
        self.add_action(a)
        a = Gio.SimpleAction.new("own-workspace", None)
        a.connect("activate", self.on_own_workspace)
        self.add_action(a)

    def on_own_workspace(self, *_):
        self.do_activate()
        GLib.idle_add(lambda: self.win.walls.own_workspace() and False)

    def on_page_action(self, _a, value):
        self.page = value.get_string()
        if self.win:
            self.win.show_page(self.page)

    def do_activate(self):
        if not self.win:
            self.win = Window(self, self.page)
        self.win.present()

    def do_open(self, files, _n, _hint):
        self.do_activate()
        paths = [f.get_path() for f in files if f.get_path()]
        if paths:
            self.win.open_files(paths)


def main():
    return App().run(sys.argv)
