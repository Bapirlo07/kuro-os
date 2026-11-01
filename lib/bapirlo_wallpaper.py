"""Kuro OS — wallpapers: one library, three modes, live video, and the OS theme follows the colours.

Library (everything here shows up in the Wallpapers app):
    ~/Pictures/wallpapers/bapirlo/              your pictures and videos (the app copies dropped files here)
        dawn/ day/ dusk/ night/                 … files in these sub-folders are tagged with that time of day
    ~/.local/share/backgrounds/bapirlo/originals[/live]   the Kuro originals (dawn-a.jpg, night-live.mp4, …)
    the Kuro day / night pictures
Pictures: .jpg .jpeg .png .webp   Live: .mp4 .webm .mkv .mov .gif (played by Hanabi, paused on battery,
with a maximised / fullscreen window and in the overview; a still frame of it is the "real" GNOME wallpaper,
used by the lock screen, the overview blur and the colour picker).

Modes (~/.config/bapirlo/wallpaper.json):
    fixed     the one you picked
    time      dawn / day / dusk / night from sunrise & sunset; a different tagged one each day
    shuffle   another one every N hours
Live extras (lib/bapirlo_wallmedia.py does the ffmpeg work, in the background after each change):
    battery   "lite" = a 1280x800 / 24 fps copy plays while on battery (pauses only on LOW battery);
              "pause" = the video freezes on battery. `bapirlo-wallpaper watch` (a user service)
              swaps the copies the moment the charger goes in or out.
    lock_live the lock screen plays a 12 s animated AVIF of the video (web-greeter CSS, no root).
    subject   ~/.local/state/bapirlo/wallpaper/subject.json — where the wallpaper's main subject is;
              the desk widgets step out of its way.
    depth     ~/.local/state/bapirlo/wallpaper/depth.json — depth map of the still (lib/bapirlo_depth.py);
              bapirlo-live turns it into the 3D wallpaper.
Theme follows wallpaper: a Theme Studio preset is made from the wallpaper's colours (cached per file) and
applied with the usual fade. Applying a preset yourself in Theme Studio wins until you pick a wallpaper again.
"""
import datetime
import fcntl
import hashlib
import json
import math
import os
import random
import shutil
import subprocess
import sys
import time

from gi.repository import Gio, GLib

HOME = os.path.expanduser("~")
OS_DIR = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
CONF_DIR = os.path.join(GLib.get_user_config_dir(), "bapirlo")
CONF = os.path.join(CONF_DIR, "wallpaper.json")
STATE_DIR = os.path.join(GLib.get_user_state_dir(), "bapirlo", "wallpaper")
STATE = os.path.join(STATE_DIR, "current.json")
LOCK = os.path.join(STATE_DIR, "lock")
CACHE = os.path.join(GLib.get_user_cache_dir(), "bapirlo", "wallpaper")
LIBRARY = os.path.join(HOME, "Pictures", "wallpapers", "bapirlo")
BACKGROUNDS = os.path.join(HOME, ".local", "share", "backgrounds", "bapirlo")
ORIGINALS = os.path.join(BACKGROUNDS, "originals")
KURO = {os.path.join(BACKGROUNDS, "kuro-day-2560x1600.jpg"): "day",
        os.path.join(BACKGROUNDS, "kuro-night-2560x1600.jpg"): "night"}
SLOTS = ("dawn", "day", "dusk", "night")
STUDIO_SLOT = {"dawn": "day", "day": "day", "dusk": "night", "night": "night"}
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp")
VID_EXT = (".mp4", ".webm", ".mkv", ".mov", ".gif")
MODES = ("fixed", "time", "shuffle")
HANABI = "hanabi-extension@jeffshee.github.io"
HANABI_SCHEMA = "io.github.jeffshee.hanabi-extension"
BUSY = "BAPIRLO_WALLPAPER_BUSY"
SUBJECT = os.path.join(STATE_DIR, "subject.json")
DEPTH_STATE = os.path.join(STATE_DIR, "depth.json")     # read by bapirlo-live (3D wallpaper)
WS_STATE = os.path.join(STATE_DIR, "workspace")         # the workspace on screen (1 = first), written by the top bar
DEPTH_KEEP = 40
GREETER_STUDIO = "/usr/share/web-greeter/themes/bapirlo/studio"
BATTERY_MODES = ("lite", "pause")
DEFAULT_CONF = {"mode": "fixed", "current": "", "shuffle_hours": 3, "theme": True, "live": True, "tags": {}, "hidden": [],
                "battery": "lite", "lock_live": True, "workspaces": {}}


def log(*a):
    print("wallpaper:", *a, flush=True)


# ------------------------------------------------------------------ config / state
def _load(path, default):
    try:
        with open(path) as f:
            return {**default, **json.load(f)}
    except (OSError, ValueError):
        return dict(default)


def _save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def conf():
    c = _load(CONF, DEFAULT_CONF)
    if c["mode"] not in MODES:
        c["mode"] = "fixed"
    return c


def save_conf(c):
    _save(CONF, c)


def state():
    return _load(STATE, {"path": "", "still": "", "chosen_at": 0, "applied_at": 0})


class Lock:
    """One change at a time (the app, the timer and Theme Studio can all ask)."""

    def __enter__(self):
        os.makedirs(STATE_DIR, exist_ok=True)
        self.f = open(LOCK, "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        os.environ[BUSY] = "1"         # Theme Studio's own call back into `tick` (a child process) must not wait on us
        return self

    def __exit__(self, *exc):
        os.environ.pop(BUSY, None)
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


# ------------------------------------------------------------------ the library
def is_video(path):
    return path.lower().endswith(VID_EXT)


def _auto_tags(path):
    rel = os.path.relpath(path, LIBRARY)
    if not rel.startswith(".."):
        top = rel.split(os.sep)[0]
        return [top] if top in SLOTS else []
    if path in KURO:
        return [KURO[path]]
    name = os.path.basename(path)
    return [s for s in SLOTS if name.startswith(s + "-")][:1]


def _scan(folder, recursive):
    out = []
    if not os.path.isdir(folder):
        return out
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".")] if recursive else []
        for f in files:
            if not f.startswith(".") and f.lower().endswith(IMG_EXT + VID_EXT):
                out.append(os.path.join(root, f))
    return out


def items(include_hidden=False):
    """[{path, name, live, mine, tags}] — yours first (newest first), then the Kuro ones."""
    c = conf()
    hidden = set(c["hidden"])
    mine = sorted(_scan(LIBRARY, True), key=lambda p: os.path.getmtime(p), reverse=True)
    ours = sorted(_scan(ORIGINALS, True)) + [p for p in KURO if os.path.exists(p)]
    out = []
    for p in mine + ours:
        if p in hidden and not include_hidden:
            continue
        out.append({"path": p, "name": os.path.splitext(os.path.basename(p))[0], "live": is_video(p),
                    "mine": p in mine, "tags": c["tags"].get(p, _auto_tags(p)), "hidden": p in hidden})
    return out


def set_tags(path, tags):
    c = conf()
    tags = [t for t in SLOTS if t in tags]
    if tags == _auto_tags(path):
        c["tags"].pop(path, None)
    else:
        c["tags"][path] = tags
    save_conf(c)


def add(files, slot=None):
    """Copy pictures / videos into the library; returns the new paths (duplicates by content are skipped)."""
    dest = os.path.join(LIBRARY, slot) if slot in SLOTS else LIBRARY
    os.makedirs(dest, exist_ok=True)
    known = {_digest(p) for p in _scan(LIBRARY, True)}
    out = []
    for f in files:
        f = os.path.abspath(os.path.expanduser(f))
        if not os.path.isfile(f) or not f.lower().endswith(IMG_EXT + VID_EXT):
            continue
        if os.path.commonpath([f, LIBRARY]) == LIBRARY:          # already in the library
            out.append(f)
            continue
        dig = _digest(f)
        if dig in known:
            continue
        name = os.path.basename(f)
        target = os.path.join(dest, name)
        stem, ext = os.path.splitext(name)
        n = 2
        while os.path.exists(target):
            target = os.path.join(dest, f"{stem}-{n}{ext}")
            n += 1
        shutil.copy2(f, target)
        known.add(dig)
        out.append(target)
    return out


def remove(path):
    """Yours go to the Bin; Kuro ones are only hidden (the app can show them again)."""
    c = conf()
    if os.path.commonpath([os.path.abspath(path), LIBRARY]) == LIBRARY:
        Gio.File.new_for_path(path).trash(None)
        c["tags"].pop(path, None)
    elif path not in c["hidden"]:
        c["hidden"].append(path)
    save_conf(c)


def unhide(path):
    c = conf()
    c["hidden"] = [p for p in c["hidden"] if p != path]
    save_conf(c)


def _digest(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        h.update(f.read(1 << 20))
    h.update(str(os.path.getsize(path)).encode())
    return h.hexdigest()


def _key(path):
    st = os.stat(path)
    return hashlib.sha1(f"{path}\0{st.st_mtime_ns}\0{st.st_size}".encode()).hexdigest()[:16]


# ------------------------------------------------------------------ stills, thumbnails
def still(path):
    """A picture for GNOME's own wallpaper key: the picture itself, or a frame of the video."""
    if not is_video(path):
        return path
    out = os.path.join(CACHE, "posters", _key(path) + ".jpg")
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        tmp = out + ".part.jpg"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-frames:v", "1",
                        "-q:v", "2", tmp], check=True, timeout=60)
        os.replace(tmp, out)
    return out


def thumb(path, width=400):
    out = os.path.join(CACHE, "thumbs", f"{_key(path)}-{width}.jpg")
    if os.path.exists(out):
        return out
    from PIL import Image
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img = Image.open(still(path)).convert("RGB")
    h = round(width * 10 / 16)
    s = max(width / img.width, h / img.height)
    img = img.resize((max(width, round(img.width * s)), max(h, round(img.height * s))), Image.LANCZOS)
    x, y = (img.width - width) // 2, (img.height - h) // 2
    img.crop((x, y, x + width, y + h)).save(out, quality=88)
    return out


# ------------------------------------------------------------------ sun, slots
def location():
    ext = f"{HOME}/.local/share/gnome-shell/extensions/simple-weather@romanlefler.com/schemas"
    try:
        src = Gio.SettingsSchemaSource.new_from_directory(ext, Gio.SettingsSchemaSource.get_default(), False)
        schema = src.lookup("org.gnome.shell.extensions.simple-weather", False)
        if schema:
            s = Gio.Settings.new_full(schema, None, None)
            locs = [json.loads(x) for x in s.get_strv("locations")]
            if locs:
                loc = locs[min(s.get_int64("main-location-index"), len(locs) - 1)]
                return float(loc["lat"]), float(loc["lon"])
    except (GLib.Error, ValueError, KeyError, TypeError):
        pass
    try:
        with open(os.path.join(CONF_DIR, "location.json")) as f:
            d = json.load(f)
            return float(d["lat"]), float(d["lon"])
    except (OSError, ValueError, KeyError):
        return None


def sun_times(day, lat, lon):
    """NOAA sunrise/sunset (UTC datetimes) — good to about a minute."""
    n = day.timetuple().tm_yday
    out = []
    for rising in (True, False):
        lng_hour = lon / 15
        t = n + ((6 if rising else 18) - lng_hour) / 24
        m = 0.9856 * t - 3.289
        l_ = (m + 1.916 * math.sin(math.radians(m)) + 0.020 * math.sin(math.radians(2 * m)) + 282.634) % 360
        ra = math.degrees(math.atan(0.91764 * math.tan(math.radians(l_)))) % 360
        ra = (ra + (math.floor(l_ / 90) * 90 - math.floor(ra / 90) * 90)) / 15
        sin_dec = 0.39782 * math.sin(math.radians(l_))
        cos_dec = math.cos(math.asin(sin_dec))
        cos_h = (math.cos(math.radians(90.833)) - sin_dec * math.sin(math.radians(lat))) / \
                (cos_dec * math.cos(math.radians(lat)))
        if not -1 <= cos_h <= 1:
            return None                     # polar day / night
        h = (360 - math.degrees(math.acos(cos_h)) if rising else math.degrees(math.acos(cos_h))) / 15
        ut = (h + ra - 0.06571 * t - 6.622 - lng_hour) % 24
        out.append(datetime.datetime.combine(day, datetime.time(0), datetime.timezone.utc) +
                   datetime.timedelta(hours=ut))
    return out


def sun(now=None):
    """(now, sunrise, sunset, slot, slot start times) for the local day."""
    now = now or datetime.datetime.now().astimezone()
    loc = location() or (51.5, -0.12)
    times = sun_times(now.date(), *loc)
    if times:
        rise, sset = (t.astimezone() for t in times)
    else:   # polar edge case — fixed 07:00 / 19:00
        rise = now.replace(hour=7, minute=0, second=0, microsecond=0)
        sset = now.replace(hour=19, minute=0, second=0, microsecond=0)
    m = datetime.timedelta(minutes=1)
    starts = {"dawn": rise - 45 * m, "day": rise + 90 * m, "dusk": sset - 90 * m, "night": sset + 45 * m}
    if starts["dawn"] <= now < starts["day"]:
        slot = "dawn"
    elif starts["day"] <= now < starts["dusk"]:
        slot = "day"
    elif starts["dusk"] <= now < starts["night"]:
        slot = "dusk"
    else:
        slot = "night"
    return now, rise, sset, slot, starts, loc


def slot_pool(slot, its=None):
    its = items() if its is None else its
    pool = [i["path"] for i in its if slot in i["tags"]]
    if not pool:     # an empty slot borrows from its neighbour (dawn → day, dusk → night)
        pool = [i["path"] for i in its if STUDIO_SLOT[slot] in i["tags"]]
    return pool


def target(c=None, now=None):
    """What should be on screen now, by the mode."""
    c = c or conf()
    now, _, _, slot, _, _ = sun(now)
    its = items()
    paths = [i["path"] for i in its]
    if c["mode"] == "time":
        pool = slot_pool(slot, its)
        if pool:
            return random.Random(f"{now.date().toordinal()}-{slot}").choice(pool)
    elif c["mode"] == "shuffle" and paths:
        hours = max(1, int(c.get("shuffle_hours") or 3))
        period = int(now.timestamp() // (hours * 3600))
        order = paths[:]
        random.Random(f"shuffle-{period // len(order)}").shuffle(order)
        return order[period % len(order)]
    if c["current"] and os.path.exists(c["current"]):
        return c["current"]
    return paths[0] if paths else ""


# ------------------------------------------------------------------ a wallpaper per workspace
# conf["workspaces"] = {"2": path}: workspace 2 shows its own wallpaper (and the colours follow it);
# workspaces without one show the normal one (mode fixed/time/shuffle). The top bar writes the
# workspace on screen to WS_STATE and runs `bapirlo-wallpaper workspace N` after a switch settles.
def current_workspace():
    try:
        with open(WS_STATE) as f:
            return max(1, int(f.read().strip()))
    except (OSError, ValueError):
        return 1


def ws_wallpaper(c=None, n=None):
    p = (c or conf()).get("workspaces", {}).get(str(n or current_workspace()))
    return p if p and os.path.exists(p) else None


def set_workspace(n, path):
    """Give workspace n its own wallpaper (path), or back to the normal one (None)."""
    with Lock():
        c = conf()
        ws = dict(c.get("workspaces") or {})
        if path:
            ws[str(n)] = path
        else:
            ws.pop(str(n), None)
        c["workspaces"] = ws
        save_conf(c)
    if n == current_workspace():
        tick(force=bool(path))


def bedtime_wallpaper():
    """bapirlo-bedtime: the night wallpaper it chose, while bedtime is on."""
    st = _load(os.path.join(GLib.get_user_state_dir(), "bapirlo", "bedtime.json"), {})
    p = st.get("wallpaper") if st.get("on") else None
    return p if p and os.path.exists(p) else None


def switch_workspace(n):
    """The top bar: workspace n is on screen now."""
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(WS_STATE, "w") as f:
        f.write(str(n))
    tick()


# ------------------------------------------------------------------ Theme Studio
def _studio():
    sys.path.insert(0, os.path.join(OS_DIR, "studio"))
    import engine
    import studio
    return engine, studio


def studio_override(st, slot):
    """A preset applied by hand in Theme Studio after your last pick brings its own wallpaper grade."""
    try:
        with open(os.path.join(GLib.get_user_state_dir(), "bapirlo", "studio", "active.json")) as f:
            a = json.load(f)
    except (OSError, ValueError):
        return None
    if a.get("applied", 0) <= st.get("chosen_at", 0):
        return None
    try:
        with open(os.path.join(GLib.get_user_data_dir(), "bapirlo", "theme-studio", "presets", a["preset"], "preset.json")) as f:
            if json.load(f).get("auto"):          # made from a wallpaper by theme_for(): not a hand-picked theme
                return None
    except (OSError, ValueError, KeyError):
        pass
    img = a.get(STUDIO_SLOT[slot])
    return img if img and os.path.exists(img) else None


def theme_for(path, fade=True):
    """Make (or reuse) the preset for this wallpaper and apply it."""
    E, S = _studio()
    key = _key(path)
    a = S.active() or {}
    autos = [p for p in S.presets() if p.get("auto")]
    preset = next((p for p in autos if p.get("key") == key), None)
    if preset is None:
        img = still(path)
        palette = E.palette_from_image(img)
        name = "Wallpaper · " + os.path.splitext(os.path.basename(path))[0][:40]
        preset = S.save_preset(name, img, palette)
        preset.update(auto=True, key=key, source=path)
        meta = {k: v for k, v in preset.items() if k != "dir"}
        S.write_atomic(os.path.join(preset["dir"], "preset.json"), json.dumps(meta, indent=1))
        log(f"new colours from {os.path.basename(path)}: accent {palette['roles']['crimson']}")
        for old in [p for p in autos if p["id"] != a.get("preset")][11:]:        # keep the 12 newest
            shutil.rmtree(old["dir"], ignore_errors=True)
    if a.get("preset") == preset["id"]:
        return preset["id"]
    S.apply_preset(preset["id"], fade=fade)
    return preset["id"]


def theme_off():
    """Back to the original Kuro colours, if the wallpaper had set them."""
    E, S = _studio()
    a = S.active() or {}
    try:
        auto = S.get_preset(a.get("preset", "original")).get("auto")
    except KeyError:
        auto = False
    if auto:
        S.apply_preset("original")


# ------------------------------------------------------------------ live (Hanabi)
def _hanabi_settings():
    for base in (os.path.join(GLib.get_user_data_dir(), "gnome-shell", "extensions"),
                 "/usr/share/gnome-shell/extensions"):
        d = os.path.join(base, HANABI, "schemas")
        if os.path.isdir(d):
            src = Gio.SettingsSchemaSource.new_from_directory(d, Gio.SettingsSchemaSource.get_default(), False)
            schema = src.lookup(HANABI_SCHEMA, False)
            if schema:
                return Gio.Settings.new_full(schema, None, None)
    return None


def live_available():
    return _hanabi_settings() is not None


def _set_extension(uuid, on):
    shell = Gio.Settings.new("org.gnome.shell")
    en, dis = list(shell.get_strv("enabled-extensions")), list(shell.get_strv("disabled-extensions"))
    if on and (uuid not in en or uuid in dis):
        shell.set_strv("disabled-extensions", [u for u in dis if u != uuid])
        shell.set_strv("enabled-extensions", en + ([uuid] if uuid not in en else []))
    elif not on and uuid in en:
        shell.set_strv("enabled-extensions", [u for u in en if u != uuid])


def _live(path):
    """Play `path` (a video) or stop playing (None). Returns whether a video is now playing."""
    hs = _hanabi_settings()
    if hs is None:
        return False
    c = conf()
    if path and c["live"]:
        play = _video_for(path, c)
        if hs.get_string("video-path") != play:
            hs.set_string("video-path", play)
        pause = 2 if c.get("battery") == "pause" else 1        # 1 = only on low battery
        if hs.get_int("pause-on-battery") != pause:
            hs.set_int("pause-on-battery", pause)
        _set_extension(HANABI, True)
        return True
    _set_extension(HANABI, False)
    return False


def _system_bus():
    # Gio.DBus.system is GJS-only; PyGObject needs bus_get_sync
    return Gio.bus_get_sync(Gio.BusType.SYSTEM, None)


def on_battery():
    try:
        v = _system_bus().call_sync("org.freedesktop.UPower", "/org/freedesktop/UPower", "org.freedesktop.DBus.Properties",
                                      "Get", GLib.Variant("(ss)", ("org.freedesktop.UPower", "OnBattery")),
                                      None, Gio.DBusCallFlags.NONE, 2000, None)
        return bool(v.unpack()[0])
    except GLib.Error:
        return False


def _video_for(path, c=None):
    """The file Hanabi should play for `path`: the light copy on battery (once it has been made)."""
    import bapirlo_wallmedia as M
    c = c or conf()
    if c.get("battery") == "lite" and on_battery():
        lp = M.lite_path(path)
        if os.path.exists(lp):
            return lp
    return path


def power_sync():
    """Charger in / out: switch between the full video and the battery copy."""
    st = state()
    p = st.get("path", "")
    if not (st.get("live") and p and is_video(p) and os.path.exists(p)):
        return
    hs = _hanabi_settings()
    if hs is None:
        return
    play = _video_for(p)
    if hs.get_string("video-path") != play:
        hs.set_string("video-path", play)
        Gio.Settings.sync()
        log(f"{'battery' if play != p else 'mains'}: playing {os.path.basename(play)}")


def watch():
    """Run forever (bapirlo-wallpaper-power.service): follow the charger."""
    loop = GLib.MainLoop()
    last = [on_battery()]

    def changed(*_a):
        now = on_battery()
        if now != last[0]:
            last[0] = now
            power_sync()
    _system_bus().signal_subscribe("org.freedesktop.UPower", "org.freedesktop.DBus.Properties", "PropertiesChanged",
                                     "/org/freedesktop/UPower", None, Gio.DBusSignalFlags.NONE, changed)
    power_sync()
    log("watching the charger")
    loop.run()


# ------------------------------------------------------------------ extras: battery copy, lock screen, subject
def lock_ready():
    return os.path.isdir(GREETER_STUDIO) and os.access(GREETER_STUDIO, os.W_OK)


LIVE_CSS = "live.css"
IMPORT = '@import url("live.css");'


def ensure_lock_import():
    """studio.css (rewritten by Theme Studio) must pull in live.css — added here and in studio.greeter_apply."""
    css = os.path.join(GREETER_STUDIO, "studio.css")
    try:
        with open(css) as f:
            src = f.read()
    except OSError:
        src = ""
    if IMPORT not in src:
        tmp = css + ".new"
        with open(tmp, "w") as f:
            f.write(IMPORT + "\n" + src)
        os.chmod(tmp, 0o644)
        os.replace(tmp, css)


def set_lock_anim(anim):
    """Put an animated AVIF on the lock screen, or (None) go back to the still picture."""
    if not lock_ready():
        return False
    ensure_lock_import()
    dst = os.path.join(GREETER_STUDIO, "bg-live.avif")
    css = os.path.join(GREETER_STUDIO, LIVE_CSS)
    if anim:
        tmp = dst + ".new"
        shutil.copyfile(anim, tmp)
        os.chmod(tmp, 0o644)
        os.replace(tmp, dst)
        # layered: the animation on top, the still underneath in case it can't play
        body = ('/* bapirlo-wallpaper: the live wallpaper on the lock screen */\n'
                '#stage #bg { background-image: url("bg-live.avif"), url("bg.jpg"), url("../img/bg.jpg"); }\n')
    else:
        body = "/* bapirlo-wallpaper: lock screen shows the still picture */\n"
        if os.path.exists(dst):
            os.remove(dst)
    tmp = css + ".new"
    with open(tmp, "w") as f:
        f.write(body)
    os.chmod(tmp, 0o644)
    os.replace(tmp, css)
    return True


def write_subject(path):
    import bapirlo_wallmedia as M
    w, h = M.screen_size()
    box = M.subject(still(path), w / h)
    _save(SUBJECT, {"path": path, "box": box, "aspect": round(w / h, 4), "at": time.time()})
    return box


def write_depth(path):
    """Depth map for the 3D wallpaper (bapirlo-live): of the picture, or of the video's still frame."""
    import bapirlo_depth as D
    img = still(path)
    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(CACHE, "depth.lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        out = D.depth_for(img)
    if not out:
        log("depth: not set up (python3 lib/bapirlo_depth.py --setup)")
        return None
    _save(DEPTH_STATE, {"still": img, "depth": out, "at": time.time()})
    maps = sorted((os.path.join(D.CACHE, f) for f in os.listdir(D.CACHE)), key=os.path.getmtime, reverse=True)
    for old in maps[DEPTH_KEEP:]:
        os.remove(old)
    return out


def prepare(path):
    """After a change (run detached): subject box, battery copy, lock-screen animation. Slow parts last."""
    import bapirlo_wallmedia as M
    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(CACHE, "prepare.lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try:
            write_subject(path)
        except Exception as e:  # noqa: BLE001 — never block the rest
            log(f"subject: {e}")
        try:
            write_depth(path)
        except Exception as e:  # noqa: BLE001
            log(f"depth: {e}")
        c = conf()
        video = is_video(path) and os.path.exists(path)
        if video and c.get("lock_live"):
            try:
                if state().get("path") == path:
                    set_lock_anim(M.lock_anim(path))
            except Exception as e:  # noqa: BLE001
                log(f"lock screen: {e}")
        elif lock_ready():
            set_lock_anim(None)
        if video and c.get("battery") == "lite":
            try:
                M.lite(path)
                if state().get("path") == path:
                    power_sync()
            except Exception as e:  # noqa: BLE001
                log(f"battery copy: {e}")
        vids = {i["path"] for i in items(include_hidden=True) if i["live"]}
        M.prune(M.LITE_DIR, vids)
        M.prune(M.LOCK_DIR, vids)


def prepare_later(path):
    """prepare() in a detached process, so the app / timer never wait on ffmpeg."""
    if os.environ.get("BAPIRLO_NO_PREPARE"):
        return
    cli = os.path.join(OS_DIR, "bin", "bapirlo-wallpaper")
    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(CACHE, "prepare.log"), "a") as out:
        subprocess.Popen([cli, "prepare", path], start_new_session=True, stdin=subprocess.DEVNULL,
                         stdout=out, stderr=subprocess.STDOUT, env={**os.environ, BUSY: ""})


def set_battery(mode):
    with Lock():
        c = conf()
        c["battery"] = mode if mode in BATTERY_MODES else "lite"
        save_conf(c)
        st = state()
        p = st.get("path", "")
        if p and is_video(p):
            st["live"] = _live(p)
            _save(STATE, st)
    if p and is_video(p):
        prepare_later(p)


def set_lock_live(on):
    with Lock():
        c = conf()
        c["lock_live"] = bool(on)
        save_conf(c)
    p = state().get("path", "")
    if on and p:
        prepare_later(p)
    elif lock_ready():
        set_lock_anim(None)


# ------------------------------------------------------------------ apply
def apply(path, theme=None, fade=True, reason=""):
    """Put `path` on screen (and theme the OS from it, if that's on)."""
    c = conf()
    theme = c["theme"] if theme is None else theme
    img = still(path)
    uri = Gio.File.new_for_path(img).get_uri()
    bg = Gio.Settings.new("org.gnome.desktop.background")
    if bg.get_string("picture-uri") != uri or bg.get_string("picture-uri-dark") != uri:
        bg.set_string("picture-uri", uri)
        bg.set_string("picture-uri-dark", uri)
    if bg.get_string("picture-options") not in ("zoom", "spanned"):
        bg.set_string("picture-options", "zoom")
    playing = _live(path if is_video(path) else None)
    Gio.Settings.sync()
    st = state()
    st.update(path=path, still=img, live=playing, applied_at=time.time())
    _save(STATE, st)
    log(f"{reason + ': ' if reason else ''}{path}" + (" (live)" if playing else ""))
    prepare_later(path)
    if theme:
        try:
            theme_for(path, fade=fade)
        except Exception as e:                                       # never leave the wallpaper half-done
            log(f"theme from wallpaper failed: {e}")


def choose(path, fade=True):
    """You picked this one: Fixed mode, on screen now. On a workspace that has its own
    wallpaper, the pick replaces that workspace's one instead."""
    if ws_wallpaper():
        set_workspace(current_workspace(), path)
        return
    with Lock():
        c = conf()
        c["current"] = path
        c["mode"] = "fixed"
        save_conf(c)
        st = state()
        st["chosen_at"] = time.time()
        _save(STATE, st)
        apply(path, fade=fade, reason="picked")


def set_mode(mode, hours=None):
    with Lock():
        c = conf()
        c["mode"] = mode
        if hours:
            c["shuffle_hours"] = int(hours)
        save_conf(c)
        st = state()
        st["chosen_at"] = time.time()
        _save(STATE, st)
    tick(force=True)


def set_theme(on):
    with Lock():
        c = conf()
        c["theme"] = bool(on)
        save_conf(c)
        if on:
            st = state()
            if st.get("path") and os.path.exists(st["path"]):
                theme_for(st["path"])
        else:
            theme_off()


def set_live(on):
    """Live wallpapers on/off. Off = the video's still frame stays on screen (Hanabi disabled)."""
    with Lock():
        c = conf()
        c["live"] = bool(on)
        save_conf(c)
        st = state()
        p = st.get("path", "")
        st["live"] = _live(p if p and is_video(p) else None)
        _save(STATE, st)
        log(f"live {'on' if on else 'off'}" + (" (playing)" if st["live"] else ""))


def next_one():
    """Skip to the next one in the current pool (time: this slot; otherwise everything)."""
    with Lock():
        c = conf()
        _, _, _, slot, _, _ = sun()
        pool = slot_pool(slot) if c["mode"] == "time" else [i["path"] for i in items()]
        if not pool:
            return
        cur = state().get("path")
        nxt = pool[(pool.index(cur) + 1) % len(pool)] if cur in pool else pool[0]
        c["current"] = nxt
        c["mode"] = "fixed"
        save_conf(c)
        st = state()
        st["chosen_at"] = time.time()
        _save(STATE, st)
        apply(nxt, reason="next")


def night_light(rise, sset):
    color = Gio.Settings.new("org.gnome.settings-daemon.plugins.color")
    frm = round(sset.hour + sset.minute / 60, 2)
    to = round(rise.hour + rise.minute / 60, 2)
    if color.get_boolean("night-light-schedule-automatic"):
        color.set_boolean("night-light-schedule-automatic", False)
    if abs(color.get_double("night-light-schedule-from") - frm) > 0.01:
        color.set_double("night-light-schedule-from", frm)
    if abs(color.get_double("night-light-schedule-to") - to) > 0.01:
        color.set_double("night-light-schedule-to", to)


def tick(no_theme=False, force=False):
    """Timer / login / Theme Studio: keep the screen on what the mode says; Night Light follows the sun."""
    if os.environ.get(BUSY):            # called back from inside a change we are making
        return
    with Lock():
        now, rise, sset, slot, _, _ = sun()
        night_light(rise, sset)
        c, st = conf(), state()
        ws = ws_wallpaper(c)
        bed = bedtime_wallpaper()
        want = bed or studio_override(st, slot) or ws or target(c, now)
        if not want or not os.path.exists(want):
            Gio.Settings.sync()
            return
        live_wrong = (is_video(want) and live_available() and c["live"]) != bool(st.get("live"))
        if force or want != st.get("path") or live_wrong or not os.path.exists(st.get("still", "")):
            manual = want not in (target(c, now), ws, bed)
            apply(want, theme=False if (no_theme or manual) else None, reason=c["mode"] if not manual else "studio")
        else:
            power_sync()        # the charger watcher does this at once; this is the fallback
        Gio.Settings.sync()


def status():
    c, st = conf(), state()
    now, rise, sset, slot, starts, loc = sun()
    its = items()
    lines = [f"mode     {c['mode']}" + (f" (every {c['shuffle_hours']} h)" if c["mode"] == "shuffle" else "")
             + f"   theme follows wallpaper: {'on' if c['theme'] else 'off'}   live: {'on' if c['live'] else 'off'}   live engine: "
             + ("installed" if live_available() else "missing (Hanabi)"),
             f"now      {st.get('path') or '—'}" + ("  [live]" if st.get("live") else ""),
             f"sun      {loc[0]:.3f},{loc[1]:.3f}  sunrise {rise:%H:%M}  sunset {sset:%H:%M}  slot {slot}",
             "slots    " + "  ".join(f"{s} {starts[s]:%H:%M}" for s in SLOTS),
             f"library  {sum(i['mine'] for i in its)} yours + {sum(not i['mine'] for i in its)} Kuro "
             f"({sum(i['live'] for i in its)} live) — add in {LIBRARY}"]
    for s in SLOTS:
        lines.append(f"  {s:5} {len([i for i in its if s in i['tags']])} tagged")
    return "\n".join(lines)
