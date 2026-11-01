"""Kuro Settings — the Battery & power and Screen time pages (used by bapirlo-settings).

Battery & power  level, charging/discharging and the watts going in or out right now (sysfs, every
                 5 s while the page is shown), the last 24 h of battery level and power draw (UPower's
                 own history over D-Bus — nothing extra records it), health and capacity, the 80 %
                 charge limit (bapirlo-charge) and the power mode (power-profiles-daemon).
Screen time      today, the last 7 days as bars, and the top apps today / this week. Counted by the
                 desk extension (screentime.js) into ~/.local/state/bapirlo/screentime/DATE.json —
                 only on this computer.
"""
import datetime
import glob
import json
import os
import threading

from gi.repository import Adw, Gio, GLib, Gtk

try:
    gi_unix = __import__("gi.repository.GioUnix", fromlist=["GioUnix"])
    DesktopAppInfo = gi_unix.DesktopAppInfo
except ImportError:
    DesktopAppInfo = Gio.DesktopAppInfo

HOME = os.path.expanduser("~")
STATE = os.path.join(os.environ.get("XDG_STATE_HOME", os.path.join(HOME, ".local/state")), "bapirlo")
ST_DIR = os.path.join(STATE, "screentime")
ACCENT = (1.0, 0.275, 0.333)       # #FF4655
PAPER = (0.95, 0.91, 0.925)

CSS = """
.kuro-big { font-family: Bangers; font-size: 40pt; letter-spacing: 1px; color: #FF4655; }
.kuro-sub { color: #CAB5BF; font-size: 11pt; }
.kuro-card { background-color: rgba(22,16,21,0.94); border: 1px solid rgba(225,29,46,0.22);
             border-radius: 16px; padding: 14px 18px; }
.kuro-graph-title { font-weight: 700; color: #F2E9EC; }
.kuro-graph-note { color: #8E7680; font-size: 9pt; }
"""


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def num(path):
    try:
        return float(read(path))
    except ValueError:
        return None


def hm(s):
    t = round(s / 60)
    h, m = divmod(t, 60)
    return (f"{h} h {m} m" if m else f"{h} h") if h else (f"{m} m" if m else "<1 m")


# ---------------------------------------------------------------- battery
def battery_dir():
    for d in sorted(glob.glob("/sys/class/power_supply/*")):
        if read(os.path.join(d, "type")) == "Battery" and read(os.path.join(d, "scope"), "System") == "System":
            return d
    return None


def battery_now(d):
    """{pct, status, watts (+ in / − out), health, full_ah, design_ah, cycles, limit, model}"""
    v = num(f"{d}/voltage_now")
    p = num(f"{d}/power_now")
    c = num(f"{d}/current_now")
    watts = (p / 1e6) if p else ((v * c / 1e12) if v and c else None)
    status = read(f"{d}/status", "Unknown")
    if watts is not None and status == "Discharging":
        watts = -watts
    full = num(f"{d}/charge_full") or num(f"{d}/energy_full")
    design = num(f"{d}/charge_full_design") or num(f"{d}/energy_full_design")
    unit = "Ah" if os.path.exists(f"{d}/charge_full") else "Wh"
    cycles = num(f"{d}/cycle_count")
    return {
        "pct": num(f"{d}/capacity"), "status": status, "watts": watts,
        "health": round(full / design * 100) if full and design else None,
        "full": full / 1e6 if full else None, "design": design / 1e6 if design else None, "unit": unit,
        "cycles": int(cycles) if cycles else None,
        "limit": num(f"{d}/charge_control_end_threshold"),
        "model": " ".join(x for x in (read(f"{d}/manufacturer"), read(f"{d}/model_name"),
                                      read(f"{d}/technology")) if x),
    }


def upower_history(kind, seconds=86400, points=240):
    """[(unix_time, value)] oldest first, from UPower's battery history ('charge' % or 'rate' W)"""
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SYSTEM)
        dev = bus.call_sync("org.freedesktop.UPower", "/org/freedesktop/UPower", "org.freedesktop.UPower",
                            "EnumerateDevices", None, GLib.VariantType("(ao)"), 0, 3000, None).unpack()[0]
        bat = next((p for p in dev if "battery_BAT" in p), None)
        if not bat:
            return []
        rows = bus.call_sync("org.freedesktop.UPower", bat, "org.freedesktop.UPower.Device", "GetHistory",
                             GLib.Variant("(suu)", (kind, seconds, points)), GLib.VariantType("(a(udu))"),
                             0, 3000, None).unpack()[0]
    except GLib.Error:
        return []
    return sorted((t, v) for t, v, _state in rows if t)


def time_left():
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SYSTEM)
        props = bus.call_sync("org.freedesktop.UPower", "/org/freedesktop/UPower/devices/DisplayDevice",
                              "org.freedesktop.DBus.Properties", "GetAll",
                              GLib.Variant("(s)", ("org.freedesktop.UPower.Device",)),
                              GLib.VariantType("(a{sv})"), 0, 3000, None).unpack()[0]
        return props.get("TimeToEmpty", 0), props.get("TimeToFull", 0)
    except GLib.Error:
        return 0, 0


class Graph(Gtk.DrawingArea):
    """a small line/area graph over the last 24 h, or bars (one per day)"""

    def __init__(self, height=120, bars=False):
        super().__init__(content_height=height, hexpand=True)
        self.points, self.bars, self.ymax, self.labels, self.span = [], bars, 100, [], None
        self.set_draw_func(self.draw)

    def set(self, points, ymax=None, labels=None, span=None):
        self.points = points
        self.span = span            # (t0, t1): fixed time axis
        self.ymax = ymax or max([v for _t, v in points] + [1])
        self.labels = labels or []
        self.queue_draw()

    def draw(self, _a, cr, w, h, *_):
        pad_b = 16 if self.labels else 2
        gh = h - pad_b
        cr.set_source_rgba(*PAPER, 0.08)
        for i in range(1, 4):
            cr.rectangle(0, round(gh * i / 4), w, 1)
        cr.fill()
        if not self.points:
            return
        if self.bars:
            n = len(self.points)
            bw = w / n
            for i, (_k, v) in enumerate(self.points):
                bh = max(2, gh * v / self.ymax) if v else 0
                cr.set_source_rgba(*ACCENT, 1 if i == n - 1 else 0.55)
                x = i * bw + bw * 0.18
                cr.rectangle(x, gh - bh, bw * 0.64, bh)
                cr.fill()
        else:
            t0, t1 = self.span or (self.points[0][0], max(self.points[-1][0], self.points[0][0] + 1))
            xy = [(max(0, (t - t0) / (t1 - t0)) * w, gh - gh * min(v, self.ymax) / self.ymax) for t, v in self.points]
            cr.move_to(xy[0][0], gh)
            for x, y in xy:
                cr.line_to(x, y)
            cr.line_to(xy[-1][0], gh)
            cr.close_path()
            cr.set_source_rgba(*ACCENT, 0.18)
            cr.fill()
            cr.move_to(*xy[0])
            for x, y in xy[1:]:
                cr.line_to(x, y)
            cr.set_source_rgba(*ACCENT, 1)
            cr.set_line_width(2)
            cr.stroke()
        if self.labels:
            cr.set_source_rgba(*PAPER, 0.55)
            cr.select_font_face("Inter")
            cr.set_font_size(10)
            n = len(self.labels)
            for i, text in enumerate(self.labels):
                ext = cr.text_extents(text)
                x = (i + 0.5) * w / n - ext.width / 2 if self.bars else (0 if i == 0 else w - ext.width if i == n - 1 else w / 2 - ext.width / 2)
                cr.move_to(x, h - 3)
                cr.show_text(text)


def graph_card(title, note, graph):
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, css_classes=["kuro-card"])
    top = Gtk.Box(spacing=8)
    top.append(Gtk.Label(label=title, xalign=0, hexpand=True, css_classes=["kuro-graph-title"]))
    note_l = Gtk.Label(label=note, xalign=1, css_classes=["kuro-graph-note"])
    top.append(note_l)
    box.append(top)
    box.append(graph)
    box.note = note_l
    return box


class PowerPage:
    def __init__(self, app, run, bin_dir):
        self.app, self.run, self.bin = app, run, bin_dir
        self.dir = battery_dir()
        self.page = Adw.PreferencesPage()
        app.header(self.page, "BATTERY & POWER", "What the battery is doing right now, the last 24 hours, "
                                                 "its health, the charge limit and the power mode.")
        g = Adw.PreferencesGroup()
        hero = Gtk.Box(spacing=18, css_classes=["kuro-card"])
        self.big = Gtk.Label(label="—", css_classes=["kuro-big"])
        hero.append(self.big)
        col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, valign=Gtk.Align.CENTER, spacing=2)
        self.state = Gtk.Label(xalign=0, css_classes=["kuro-graph-title"])
        self.watts = Gtk.Label(xalign=0, css_classes=["kuro-sub"])
        col.append(self.state)
        col.append(self.watts)
        hero.append(col)
        g.add(hero)
        self.page.add(g)

        g = Adw.PreferencesGroup()
        self.level = Graph()
        self.rate = Graph(height=90)
        self.level_card = graph_card("Battery level", "last 24 h", self.level)
        self.rate_card = graph_card("Power draw", "last 24 h", self.rate)
        self.level_card.set_margin_bottom(10)
        g.add(self.level_card)
        g.add(self.rate_card)
        self.page.add(g)

        g = Adw.PreferencesGroup(title="Health")
        self.health = Adw.ActionRow(title="Health")
        self.capacity = Adw.ActionRow(title="Capacity")
        self.cycles = Adw.ActionRow(title="Charge cycles")
        for r in (self.health, self.capacity, self.cycles):
            r.add_css_class("property")
            g.add(r)
        self.page.add(g)

        g = Adw.PreferencesGroup(title="Charging &amp; power mode")
        self.limit = Adw.SwitchRow(title="Stop charging at 80 %",
                                   subtitle="Keeps the battery healthy when you're mostly plugged in. "
                                            "Off = charge to 100 % (travel).")
        self.limit_h = self.limit.connect("notify::active", self.on_limit)
        g.add(self.limit)
        self.mode = Adw.ComboRow(title="Power mode", subtitle="Plugging in / out switches it by itself",
                                 model=Gtk.StringList.new(["Quiet", "Balanced", "Performance"]))
        self.mode_h = self.mode.connect("notify::selected", self.on_mode)
        g.add(self.mode)
        self.page.add(g)

        self.tick_id = 0
        self.page.connect("map", lambda *_: self.start())
        self.page.connect("unmap", lambda *_: self.stop())

    def start(self):
        self.refresh()
        self.history()
        if not self.tick_id:
            self.tick_id = GLib.timeout_add_seconds(5, self.refresh)

    def stop(self):
        if self.tick_id:
            GLib.source_remove(self.tick_id)
            self.tick_id = 0

    def refresh(self):
        if not self.dir:
            self.big.set_label("—")
            self.state.set_label("No battery found")
            return True
        b = battery_now(self.dir)
        self.big.set_label(f"{b['pct']:.0f}%" if b["pct"] is not None else "—")
        empty, full = time_left()
        st = {"Charging": "Charging", "Discharging": "On battery", "Full": "Full",
              "Not charging": "Plugged in · holding"}.get(b["status"], b["status"])
        if b["status"] == "Charging" and full:
            st += f" · full in {hm(full)}"
        elif b["status"] == "Discharging" and empty:
            st += f" · {hm(empty)} left"
        self.state.set_label(st)
        w = b["watts"]
        self.watts.set_label("" if w is None else
                             f"{abs(w):.1f} W {'going in' if w > 0 else 'being used'}" if abs(w) > 0.05 else "0 W")
        self.health.set_subtitle(f"{b['health']} %" if b["health"] else "not reported")
        if b["full"] and b["design"]:
            self.capacity.set_subtitle(f"{b['full']:.2f} {b['unit']} now · {b['design']:.2f} {b['unit']} when new")
        else:
            self.capacity.set_subtitle("not reported")
        self.cycles.set_subtitle(str(b["cycles"]) if b["cycles"] else "not reported by this battery")
        self.limit.handler_block(self.limit_h)
        self.limit.set_active(bool(b["limit"]) and b["limit"] < 100)
        self.limit.set_sensitive(b["limit"] is not None)
        self.limit.handler_unblock(self.limit_h)
        prof = self.run("powerprofilesctl", "get")
        self.mode.handler_block(self.mode_h)
        self.mode.set_selected({"power-saver": 0, "balanced": 1, "performance": 2}.get(prof, 1))
        self.mode.handler_unblock(self.mode_h)
        return True

    def history(self):
        level = upower_history("charge")
        rate = upower_history("rate")
        now = datetime.datetime.now()
        labels = [(now - datetime.timedelta(hours=24)).strftime("%H:%M"), "12 h ago", "now"]
        span = (now.timestamp() - 86400, now.timestamp())
        self.level.set(level, 100, labels, span)
        self.rate.set(rate, max([v for _t, v in rate] + [10]), labels, span)
        if rate:
            avg = sum(v for _t, v in rate) / len(rate)
            self.rate_card.note.set_label(f"average {avg:.1f} W · peak {max(v for _t, v in rate):.0f} W")
        else:
            self.rate_card.note.set_label("no history yet")

    def on_limit(self, row, _p):
        arg = "daily" if row.get_active() else "travel"
        self.run(os.path.join(self.bin, "bapirlo-charge"), arg, timeout=20)
        self.app.toast("Charging stops at 80 %" if arg == "daily" else "Charging to 100 %")
        GLib.timeout_add_seconds(1, lambda: self.refresh() and False)

    def on_mode(self, row, _p):
        prof = ["power-saver", "balanced", "performance"][row.get_selected()]
        self.run("powerprofilesctl", "set", prof)


# ---------------------------------------------------------------- screen time
def st_day(day):
    try:
        with open(os.path.join(ST_DIR, f"{day:%Y-%m-%d}.json")) as f:
            return json.load(f).get("apps", {})
    except (OSError, ValueError):
        return {}


class ScreenTimePage:
    def __init__(self, app):
        self.app = app
        self.page = Adw.PreferencesPage()
        app.header(self.page, "SCREEN TIME", "Time with each app in front of you — counted only while you're "
                                             "there (not locked, not idle) and kept only on this computer.")
        g = Adw.PreferencesGroup()
        hero = Gtk.Box(spacing=18, css_classes=["kuro-card"])
        self.big = Gtk.Label(label="—", css_classes=["kuro-big"])
        hero.append(self.big)
        col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, valign=Gtk.Align.CENTER, spacing=2)
        col.append(Gtk.Label(label="today", xalign=0, css_classes=["kuro-graph-title"]))
        self.sub = Gtk.Label(xalign=0, css_classes=["kuro-sub"])
        col.append(self.sub)
        hero.append(col)
        g.add(hero)
        self.page.add(g)
        g = Adw.PreferencesGroup()
        self.week = Graph(height=130, bars=True)
        self.week_card = graph_card("Last 7 days", "", self.week)
        g.add(self.week_card)
        self.page.add(g)
        self.today_g = None
        self.week_g = None
        self.page.connect("map", lambda *_: self.refresh())

    def apps_group(self, title, totals):
        g = Adw.PreferencesGroup(title=title)
        if not totals:
            g.add(Adw.ActionRow(title="Nothing counted yet"))
            return g
        top = sorted(totals.items(), key=lambda kv: -kv[1]["s"])[:8]
        for app_id, e in top:
            row = Adw.ActionRow(title=GLib.markup_escape_text(e["name"]))
            info = None
            try:
                info = DesktopAppInfo.new(app_id)
            except TypeError:
                pass
            if info and info.get_icon():
                row.add_prefix(Gtk.Image(gicon=info.get_icon(), pixel_size=28))
            else:
                row.add_prefix(Gtk.Image(icon_name="application-x-executable-symbolic", pixel_size=28))
            row.add_suffix(Gtk.Label(label=hm(e["s"]), css_classes=["mono"]))
            g.add(row)
        return g

    def refresh(self):
        today = datetime.date.today()
        days = [today - datetime.timedelta(days=i) for i in range(6, -1, -1)]
        per_day = {d: st_day(d) for d in days}
        totals = [(d, sum(e["s"] for e in per_day[d].values())) for d in days]
        t_today = totals[-1][1]
        week = {}
        for d in days:
            for app_id, e in per_day[d].items():
                w = week.setdefault(app_id, {"name": e["name"], "s": 0})
                w["s"] += e["s"]
        self.big.set_label(hm(t_today) if t_today else "—")
        avg = sum(s for _d, s in totals) / 7
        self.sub.set_label(f"7-day average {hm(avg)}")
        self.week.set(totals, max([s for _d, s in totals] + [3600]), [f"{d:%a}" for d in days])
        self.week_card.note.set_label(f"total {hm(sum(s for _d, s in totals))}")
        for attr, title, data in (("today_g", "Today", per_day[today]), ("week_g", "Last 7 days", week)):
            old = getattr(self, attr)
            if old:
                self.page.remove(old)
            g = self.apps_group(title, data)
            self.page.add(g)
            setattr(self, attr, g)


# ---------------------------------------------------------------- bedtime (Modes & tools page)
def bedtime_group(app, run, bin_dir):
    """Bedtime: schedule switch, bedtime / wake-up times, night wallpaper, start now (bapirlo-bedtime)."""
    cmd = os.path.join(bin_dir, "bapirlo-bedtime")
    try:
        c = json.loads(run(cmd, "json") or "{}")
    except ValueError:
        c = {}
    g = Adw.PreferencesGroup(title="Bedtime", description="Quiet mode, Do Not Disturb, a warmer screen and a "
                                                          "night wallpaper until the morning. What it changed goes back at wake-up.")
    now_btn = Gtk.Button(label="End now" if c.get("active") else "Start now", valign=Gtk.Align.CENTER,
                         css_classes=["kuro"])
    g.set_header_suffix(now_btn)

    sched = Adw.SwitchRow(title="Every night", active=bool(c.get("enabled", True)))
    sched.connect("notify::active", lambda r, _p: run(cmd, "on" if r.get_active() else "disable"))
    g.add(sched)

    times = Adw.ActionRow(title="Bedtime → wake up")
    start = Gtk.Entry(text=c.get("start", "23:00"), max_width_chars=5, width_chars=5, valign=Gtk.Align.CENTER)
    end = Gtk.Entry(text=c.get("end", "07:00"), max_width_chars=5, width_chars=5, valign=Gtk.Align.CENTER)
    save = Gtk.Button(label="Save", valign=Gtk.Align.CENTER, css_classes=["kuro"])

    def on_save(*_):
        out = run(cmd, "set", start.get_text().strip(), end.get_text().strip())
        app.toast(f"Bedtime {start.get_text()} → {end.get_text()}" if out else "Times are HH:MM, e.g. 23:00")
    save.connect("clicked", on_save)
    for w in (start, Gtk.Label(label="→"), end, save):
        times.add_suffix(w)
    g.add(times)

    wall = Adw.SwitchRow(title="Night wallpaper", subtitle="A wallpaper tagged “night” — the colours follow it",
                         active=bool(c.get("wallpaper", True)))
    wall.connect("notify::active", lambda r, _p: run(cmd, "wallpaper", "on" if r.get_active() else "off"))
    g.add(wall)

    def on_now(b):
        active = b.get_label() == "End now"
        b.set_sensitive(False)

        def work():
            return run(cmd, "off" if active else "now", timeout=120)

        def done(_r):
            b.set_label("Start now" if active else "End now")
            b.set_sensitive(True)
            app.toast("Bedtime ended" if active else "Bedtime started")
        threading.Thread(target=lambda: GLib.idle_add(done, work()), daemon=True).start()
    now_btn.connect("clicked", on_now)
    return g


# ------------------------------------------------------------------ Snippets (round 23, Kuro Flow text expander)
SNIPPETS = os.path.join(GLib.get_user_config_dir(), "bapirlo", "snippets.json")
BUILTIN_SNIPPETS = [(";date", "today's date"), (";time", "the time"), (";now", "date and time"), (";iso", "2026-11-01 style"),
                    (";week", "week number"), (";shrug", "¯\\_(ツ)_/¯")]


def load_snippets():
    try:
        with open(SNIPPETS, encoding="utf-8") as f:
            d = json.load(f)
        return {k: v for k, v in d.items() if isinstance(v, str)}
    except (OSError, ValueError):
        return {}


def save_snippets(d):
    os.makedirs(os.path.dirname(SNIPPETS), exist_ok=True)
    tmp = SNIPPETS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=1, ensure_ascii=False)
    os.replace(tmp, SNIPPETS)


class SnippetsPage:
    """Type the key, then a space, in any app → the text. The shell picks changes up at once."""

    def __init__(self, app):
        self.app = app
        self.page = Adw.PreferencesPage()
        app.header(self.page, "SNIPPETS", "Type a key like ;addr and then a space in any app — it turns into the "
                                          "text. Works in GTK apps, browsers and Office; not in terminals or "
                                          "password boxes.")
        self.group = Adw.PreferencesGroup(title="Your snippets")
        add = Gtk.Button(icon_name="list-add-symbolic", valign=Gtk.Align.CENTER, css_classes=["flat"],
                         tooltip_text="New snippet")
        add.connect("clicked", self.on_add)
        self.group.set_header_suffix(add)
        self.page.add(self.group)
        b = Adw.PreferencesGroup(title="Built in")
        for k, what in BUILTIN_SNIPPETS:
            b.add(Adw.ActionRow(title=k, subtitle=what))
        self.page.add(b)
        self.rows = []
        self.reload()

    def reload(self):
        for r in self.rows:
            self.group.remove(r)
        self.rows = []
        snips = load_snippets()
        if not snips:
            snips = {";addr": "", ";mail": ""}
        for k, v in snips.items():
            self.add_row(k, v)

    def add_row(self, key, value):
        row = Adw.ExpanderRow(title=key or "new snippet", subtitle=(value[:60] + "…") if len(value) > 60 else value)
        ke = Adw.EntryRow(title="Key (no spaces, e.g. ;sig)", text=key)
        ve = Adw.EntryRow(title="Text it becomes", text=value)
        rm = Adw.ActionRow(title="Remove this snippet")
        rb = Gtk.Button(icon_name="user-trash-symbolic", valign=Gtk.Align.CENTER, css_classes=["flat", "destructive-action"])
        rm.add_suffix(rb)
        for w in (ke, ve):
            w.connect("changed", lambda *_: (row.set_title(ke.get_text() or "new snippet"), row.set_subtitle(ve.get_text()[:60]), self.save()))
        rb.connect("clicked", lambda *_: (self.group.remove(row), self.rows.remove(row), self.save()))
        row.add_row(ke)
        row.add_row(ve)
        row.add_row(rm)
        row._entries = (ke, ve)
        self.group.add(row)
        self.rows.append(row)
        return row

    def on_add(self, *_):
        r = self.add_row("", "")
        r.set_expanded(True)

    def save(self):
        d = {}
        for r in self.rows:
            k, v = (e.get_text() for e in r._entries)
            k = k.strip()
            if k and " " not in k and v:
                d[k] = v
        save_snippets(d)
