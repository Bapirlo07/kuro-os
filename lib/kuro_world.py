"""Kuro OS — Kuro World: a wallpaper that grows with you (round 17).

A painted landscape, re-drawn every 15 minutes while it's your wallpaper:
  · sky, sun, moon and stars follow the real time of day at your location (bapirlo_wallpaper.sun)
  · seasons follow the real calendar (hemisphere from location.json): blossom, green, falling leaves, snow
  · THE TREE grows a little for every focus block you finish (focus.tsv)
  · THE TOWN gains a house every couple of days you and Kuro spend together (pet.json)
  · at night the town lights up more the LESS screen time you've had today (screentime/DATE.json)
  · flowers bloom for each time you've petted Kuro; Kuro's little house sits under the tree
Everything random is seeded, so the world stays the same world between redraws — it only grows.
"""
import datetime
import glob
import json
import math
import os
import random

import cairo

STATE = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "bapirlo")
FOCUS_LOG = os.path.join(STATE, "focus.tsv")
PET = os.path.join(STATE, "pet.json")
SCREENTIME = os.path.join(STATE, "screentime")
WORLD_STATE = os.path.join(STATE, "world.json")
SEED = 1717        # the same hills, houses and branches every time


# ---------------------------------------------------------------- what the world grows from
def _json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def stats(now=None):
    now = now or datetime.datetime.now().astimezone()
    blocks = minutes = 0
    try:
        with open(FOCUS_LOG, encoding="utf-8") as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                if len(p) == 3 and p[2] == "done":
                    blocks += 1
                    minutes += int(p[1]) if p[1].isdigit() else 0
    except OSError:
        pass
    pet = _json(PET, {})
    days = len(pet.get("days", [])) or 1
    st = _json(os.path.join(SCREENTIME, now.strftime("%F") + ".json"), {})
    screen_s = sum(int(a.get("s", 0)) for a in st.get("apps", {}).values())
    return {"blocks": blocks, "focus_minutes": minutes, "days": days, "pets": int(pet.get("pets", 0)),
            "screen_hours": round(screen_s / 3600, 2)}


def growth(blocks):
    """0 (a seed) … 1 (an old giant, ~400 blocks)."""
    return min(1.0, math.log1p(blocks) / math.log1p(400))


def season(now, lat):
    m = now.month if lat >= 0 else (now.month + 5) % 12 + 1
    return {12: "winter", 1: "winter", 2: "winter", 3: "spring", 4: "spring", 5: "spring",
            6: "summer", 7: "summer", 8: "summer"}.get(m, "autumn")


# ---------------------------------------------------------------- colour helpers
def hexc(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def shade(c, k):
    return tuple(max(0.0, min(1.0, x * k)) for x in c)


# sky keyframes: (top, horizon, ambient light 0..1)
SKY = {
    "night": (hexc("#070814"), hexc("#1B1A3A"), 0.22),
    "dawn": (hexc("#2B2E6E"), hexc("#F2A07A"), 0.62),
    "day": (hexc("#3C7FD0"), hexc("#BFE0F5"), 1.0),
    "dusk": (hexc("#2A1F55"), hexc("#F0765A"), 0.58),
}


def sky_at(now, rise, sset):
    """Blend the keyframes by how far we are between sunrise and sunset (smooth hand-overs)."""
    h = datetime.timedelta(hours=1)
    keys = [(rise - 1.2 * h, "night"), (rise, "dawn"), (rise + 1.5 * h, "day"),
            (sset - 1.5 * h, "day"), (sset, "dusk"), (sset + 1.2 * h, "night")]
    if now <= keys[0][0] or now >= keys[-1][0]:
        return SKY["night"]
    for (t0, a), (t1, b) in zip(keys, keys[1:]):
        if t0 <= now <= t1:
            k = (now - t0) / (t1 - t0) if t1 > t0 else 0
            k = k * k * (3 - 2 * k)
            A, B = SKY[a], SKY[b]
            return mix(A[0], B[0], k), mix(A[1], B[1], k), A[2] + (B[2] - A[2]) * k
    return SKY["day"]


SEASON = {   # ground, far hills, leaves (list), accent
    "spring": (hexc("#6FAE58"), hexc("#7C9A86"), ["#F6B7C9", "#F49AB6", "#FFD9E4", "#9CCB6E"]),
    "summer": (hexc("#4F9A45"), hexc("#5F8A70"), ["#3E8A3A", "#58A24A", "#2F7533", "#7DBE5A"]),
    "autumn": (hexc("#8E9A4A"), hexc("#8A7A6A"), ["#E0782E", "#C8452A", "#F0A23A", "#9C3A22"]),
    "winter": (hexc("#E8EEF5"), hexc("#B8C3D3"), ["#F4F8FC", "#DCE6F0"]),
}


# ---------------------------------------------------------------- painting
def ridge(rng, w, base, amp, rough, n=9):
    """Midpoint-displacement skyline → [(x, y)]."""
    pts = [base + rng.uniform(-amp, amp) for _ in range(2)]
    for _ in range(n):
        new = []
        for a, b in zip(pts, pts[1:]):
            new += [a, (a + b) / 2 + rng.uniform(-amp, amp)]
        new.append(pts[-1])
        pts = new
        amp *= rough
    step = w / (len(pts) - 1)
    return [(i * step, y) for i, y in enumerate(pts)]


def fill_ridge(cr, pts, w, h, col):
    cr.move_to(0, h)
    for x, y in pts:
        cr.line_to(x, y)
    cr.line_to(w, h)
    cr.close_path()
    cr.set_source_rgb(*col)
    cr.fill()


def soft_circle(cr, x, y, r, col, a):
    g = cairo.RadialGradient(x, y, 0, x, y, r)
    g.add_color_stop_rgba(0, *col, a)
    g.add_color_stop_rgba(1, *col, 0)
    cr.set_source(g)
    cr.arc(x, y, r, 0, math.tau)
    cr.fill()


def tree(cr, rng, x, y, g, seas, amb, s):
    """Recursive tree; g = growth 0..1. Returns the foliage tips (for falling leaves)."""
    bark = shade(hexc("#3A2A22"), 0.55 + 0.45 * amb)
    leaves = [shade(hexc(c), 0.45 + 0.55 * amb) for c in SEASON[seas][2]]
    tips = []
    if g < 0.04:                                         # a sprout
        cr.set_source_rgb(*bark)
        cr.set_line_width(5 * s)
        cr.move_to(x, y)
        cr.curve_to(x, y - 45 * s, x + 9 * s, y - 60 * s, x + 6 * s, y - 80 * s)
        cr.stroke()
        for sx in (-1, 1):
            cr.save()
            cr.translate(x + 6 * s, y - 78 * s)
            cr.rotate(sx * 0.9)
            cr.scale(24 * s, 10 * s)
            cr.arc(sx * 0.9, 0, 1, 0, math.tau)
            cr.restore()
            cr.set_source_rgb(*shade(hexc("#6DB25A"), 0.45 + 0.55 * amb))
            cr.fill()
        return [(x, y - 78 * s)]
    depth = 3 + int(round(5 * g))
    trunk = (90 + 430 * g) * s
    width = (10 + 46 * g) * s

    def branch(x0, y0, ang, length, wid, d):
        x1 = x0 + math.cos(ang) * length
        y1 = y0 - math.sin(ang) * length
        cr.set_source_rgb(*bark)
        cr.set_line_width(wid)
        cr.set_line_cap(cairo.LINE_CAP_ROUND)
        mx = (x0 + x1) / 2 + rng.uniform(-0.08, 0.08) * length
        my = (y0 + y1) / 2 + rng.uniform(-0.08, 0.08) * length
        cr.move_to(x0, y0)
        cr.curve_to(mx, my, mx, my, x1, y1)
        cr.stroke()
        if d <= 2:
            tips.append((x1, y1))
        if d == 0:
            return
        kids = 2 if d < depth - 1 or rng.random() < 0.5 else 3
        spread = rng.uniform(0.35, 0.6)
        for i in range(kids):
            a = ang + spread * (i - (kids - 1) / 2) * 1.4 + rng.uniform(-0.18, 0.18)
            a = min(math.pi * 0.86, max(math.pi * 0.14, a + (math.pi / 2 - a) * 0.18))   # lean back up
            branch(x1, y1, a, length * rng.uniform(0.66, 0.8), max(1.2 * s, wid * 0.66), d - 1)

    # roots
    cr.set_source_rgb(*bark)
    for sx in (-1, 1):
        cr.move_to(x - sx * width * 0.2, y - width * 0.3)
        cr.curve_to(x + sx * width * 0.6, y, x + sx * width * 1.3, y + 2 * s, x + sx * width * 1.8, y + 4 * s)
        cr.set_line_width(width * 0.35)
        cr.stroke()
    branch(x, y, math.pi / 2 + rng.uniform(-0.05, 0.05), trunk * 0.42, width, depth)

    if seas != "winter":
        r = (16 + 46 * g) * s
        # a soft body of leaves behind the clumps, so the crown reads as one shape
        if len(tips) > 3:
            mx = sum(t[0] for t in tips) / len(tips)
            my = sum(t[1] for t in tips) / len(tips)
            sx = max(abs(t[0] - mx) for t in tips) * 0.85
            sy = max(abs(t[1] - my) for t in tips) * 0.8
            cr.save()
            cr.translate(mx, my)
            cr.scale(max(sx, r), max(sy, r))
            cr.arc(0, 0, 1, 0, math.tau)
            cr.restore()
            cr.set_source_rgba(*shade(leaves[0], 0.75), 0.95)
            cr.fill()
        for (tx, ty) in tips:
            for _ in range(2):
                c = rng.choice(leaves)
                cr.set_source_rgba(*c, 0.92)
                cr.arc(tx + rng.uniform(-r, r) * 0.6, ty + rng.uniform(-r, r) * 0.5, r * rng.uniform(0.55, 0.95), 0, math.tau)
                cr.fill()
    else:                                                 # snow resting on the branches
        for (tx, ty) in tips:
            cr.set_source_rgba(*leaves[0], 0.95)
            cr.arc(tx, ty - 2 * s, (4 + 6 * g) * s, math.pi, 0)
            cr.fill()
    return tips


def house(cr, x, y, w, h, wall, roof, lit, amb, s, rng):
    cr.set_source_rgb(*wall)
    cr.rectangle(x, y - h, w, h)
    cr.fill()
    cr.set_source_rgb(*roof)
    cr.move_to(x - w * 0.12, y - h)
    cr.line_to(x + w / 2, y - h - w * 0.55)
    cr.line_to(x + w * 1.12, y - h)
    cr.close_path()
    cr.fill()
    # windows
    cols = max(1, int(w // (22 * s)))
    rows = max(1, int(h // (26 * s)))
    for r in range(rows):
        for c in range(cols):
            wx = x + (c + 0.5) * w / cols - 5 * s
            wy = y - h + (r + 0.35) * h / rows
            on = rng.random() < lit
            if on and amb < 0.75:
                soft_circle(cr, wx + 5 * s, wy + 6 * s, 26 * s, hexc("#FFC46B"), 0.25 * (1 - amb))
                cr.set_source_rgb(*hexc("#FFD98A"))
            else:
                cr.set_source_rgb(*shade(wall, 0.55))
            cr.rectangle(wx, wy, 10 * s, 12 * s)
            cr.fill()


def render(path, now=None, w=2560, h=1600, info=None):
    import bapirlo_wallpaper as W                         # sun times + location (same as the wallpaper rotation)
    now = now or datetime.datetime.now().astimezone()
    _, rise, sset, slot, _, loc = W.sun(now)
    lat = loc[0] if loc else 51.5
    st = info or stats(now)
    seas = season(now, lat)
    g = growth(st["blocks"])
    top, horizon, amb = sky_at(now, rise, sset)
    s = w / 2560
    rng = random.Random(SEED)

    surf = cairo.ImageSurface(cairo.FORMAT_RGB24, w, h)
    cr = cairo.Context(surf)

    # sky
    grad = cairo.LinearGradient(0, 0, 0, h * 0.68)
    grad.add_color_stop_rgb(0, *top)
    grad.add_color_stop_rgb(1, *horizon)
    cr.set_source(grad)
    cr.paint()

    # stars (fade in as light goes)
    srng = random.Random(SEED + 1)
    star_a = max(0.0, 1 - amb * 1.6)
    for _ in range(420):
        x, y = srng.uniform(0, w), srng.uniform(0, h * 0.55)
        r = srng.choice((0.8, 1, 1.2, 1.6, 2.2)) * s
        tw = 0.4 + 0.6 * srng.random()
        cr.set_source_rgba(1, 1, 0.95, star_a * tw)
        cr.arc(x, y, r, 0, math.tau)
        cr.fill()

    # sun or moon along an arc
    day_len = (sset - rise).total_seconds()
    if rise <= now <= sset:
        k = (now - rise).total_seconds() / day_len
        body, col, rad = "sun", hexc("#FFE6A8") if 0.12 < k < 0.88 else hexc("#FFB27A"), 70 * s
    else:
        nxt = rise + datetime.timedelta(days=1) if now > sset else rise
        prev = sset if now > sset else sset - datetime.timedelta(days=1)
        k = (now - prev).total_seconds() / max(1, (nxt - prev).total_seconds())
        body, col, rad = "moon", hexc("#EEF0FF"), 46 * s
    bx = w * (0.08 + 0.84 * k)
    by = h * 0.6 - math.sin(math.pi * k) * h * 0.47
    soft_circle(cr, bx, by, rad * 5, col, 0.28 if body == "sun" else 0.16)
    cr.set_source_rgb(*col)
    if body == "moon":                                    # crescent = moon minus an offset disc
        cr.save()
        cr.arc(bx, by, rad, 0, math.tau)
        cr.clip()
        cr.set_fill_rule(cairo.FILL_RULE_EVEN_ODD)
        cr.rectangle(bx - rad, by - rad, 2 * rad, 2 * rad)
        cr.arc(bx + rad * 0.45, by - rad * 0.2, rad * 0.9, 0, math.tau)
        cr.fill()
        cr.restore()
    else:
        cr.arc(bx, by, rad, 0, math.tau)
        cr.fill()

    # clouds
    crng = random.Random(SEED + 2 + now.timetuple().tm_yday)
    ccol = mix(horizon, (1, 1, 1), 0.55 * amb + 0.1)
    for _ in range(5):
        cx, cy = crng.uniform(0, w), crng.uniform(h * 0.1, h * 0.36)
        for _ in range(6):
            cr.set_source_rgba(*ccol, 0.18 + 0.25 * amb)
            cr.save()
            cr.translate(cx + crng.uniform(-110, 110) * s, cy + crng.uniform(-14, 14) * s)
            cr.scale(crng.uniform(70, 150) * s, crng.uniform(22, 38) * s)
            cr.arc(0, 0, 1, 0, math.tau)
            cr.restore()
            cr.fill()

    # mountains: three layers, hazier the further away
    ground, far, _ = SEASON[seas]
    for i, (base, amp, depth) in enumerate([(0.50, 120, 0.25), (0.58, 90, 0.5), (0.65, 60, 0.75)]):
        pts = ridge(random.Random(SEED + 10 + i), w, h * base, amp * s, 0.55)
        col = mix(mix(horizon, far, 0.35 + 0.4 * depth), (0.02, 0.02, 0.05), 0.25 * depth)
        fill_ridge(cr, pts, w, h, shade(col, 0.5 + 0.5 * amb))
        if i == 0 and seas in ("winter", "autumn", "spring"):          # snow caps on the far peaks
            for x, y in pts:
                if y < h * base - amp * s * 0.6:
                    cr.set_source_rgba(*shade(hexc("#F4F7FB"), 0.5 + 0.5 * amb), 0.85)
                    cr.move_to(x - 26 * s, y + 22 * s)
                    cr.line_to(x, y)
                    cr.line_to(x + 26 * s, y + 22 * s)
                    cr.close_path()
                    cr.fill()

    # the ground + the tree's hill
    gy = h * 0.74
    gcol = shade(ground, 0.42 + 0.58 * amb)
    pts = ridge(random.Random(SEED + 20), w, gy, 18 * s, 0.5, n=7)
    fill_ridge(cr, pts, w, h, gcol)
    hx, hy = w * 0.3, gy - 40 * s
    cr.set_source_rgb(*shade(gcol, 1.06))
    cr.save()
    cr.translate(hx, gy + 40 * s)
    cr.scale(420 * s, 120 * s)
    cr.arc(0, 0, 1, math.pi, 0)
    cr.restore()
    cr.fill()

    # winding path from the tree to the town
    cr.set_source_rgba(*shade(hexc("#D9C49A") if seas != "winter" else hexc("#C9D2DE"), 0.45 + 0.55 * amb), 0.8)
    cr.set_line_width(22 * s)
    cr.move_to(hx + 40 * s, hy + 30 * s)
    cr.curve_to(w * 0.42, h * 0.86, w * 0.52, h * 0.7, w * 0.64, gy + 10 * s)
    cr.stroke()

    # the town (grows with the days together; lights up when screen time is low)
    trng = random.Random(SEED + 30)
    n_houses = min(30, 2 + st["days"] // 2)
    lit = max(0.15, min(1.0, 1 - st["screen_hours"] / 8))
    walls = [hexc(c) for c in ("#C9B8A6", "#B7A193", "#D6C6B2", "#A9B2BE", "#C7A9A0", "#B9C2A8")]
    roofs = [hexc(c) for c in ("#7A2E2E", "#3E4A6B", "#5B3B2E", "#2F4F4F", "#8A4A3A")]
    slots = []
    for i in range(30):                                   # fixed plots, filled in order → the town only grows
        row = i % 3
        x = w * 0.6 + trng.uniform(0, w * 0.36)
        y = gy + (8 + row * 40) * s + trng.uniform(0, 14) * s
        slots.append((y, x, trng.uniform(46, 80) * s, trng.uniform(44, 96) * s, trng.choice(walls),
                      trng.choice(roofs), trng.random()))
    for y, x, bw, bh, wall, roof, seed in sorted(slots[:n_houses]):
        house(cr, x, y, bw, bh, shade(wall, 0.4 + 0.6 * amb), shade(roof, 0.4 + 0.6 * amb), lit, amb, s,
              random.Random(seed))
        if seas == "winter":
            cr.set_source_rgba(*shade(hexc("#F4F8FC"), 0.5 + 0.5 * amb), 0.95)
            cr.move_to(x - bw * 0.12, y - bh)
            cr.line_to(x + bw / 2, y - bh - bw * 0.55)
            cr.line_to(x + bw * 1.12, y - bh)
            cr.line_to(x + bw / 2, y - bh - bw * 0.42)
            cr.close_path()
            cr.fill()

    # flowers — one patch per time you've petted Kuro (not in winter)
    if seas != "winter":
        frng = random.Random(SEED + 40)
        fcols = [hexc(c) for c in ("#F7D046", "#F28AB2", "#FFFFFF", "#B48AF2", "#F26B5B")]
        for _ in range(min(160, st["pets"] * 2)):
            fx, fy = frng.uniform(0, w), frng.uniform(gy + 30 * s, h - 10 * s)
            cr.set_source_rgb(*shade(frng.choice(fcols), 0.45 + 0.55 * amb))
            cr.arc(fx, fy, frng.uniform(2.5, 4.5) * s, 0, math.tau)
            cr.fill()

    # Kuro's little house under the tree
    kx, ky = hx + 120 * s, hy + 34 * s
    house(cr, kx, ky, 54 * s, 40 * s, shade(hexc("#2A2026"), 0.5 + 0.5 * amb),
          shade(hexc("#E4003D"), 0.5 + 0.5 * amb), 1.0, amb, s, random.Random(7))
    if amb < 0.75:                                         # two red eyes in the window at night
        cr.set_source_rgb(*hexc("#E4003D"))
        for ex in (-4, 4):
            cr.arc(kx + 27 * s + ex * s, ky - 26 * s, 1.6 * s, 0, math.tau)
            cr.fill()

    # THE TREE
    tips = tree(cr, random.Random(SEED + 50), hx, hy + 4 * s, g, seas, amb, s)

    # season weather: petals / falling leaves / snow / fireflies
    prng = random.Random(SEED + 60 + now.hour)
    if seas == "autumn":
        for _ in range(int(20 + 60 * g)):
            tx, ty = prng.choice(tips)
            lx, ly = tx + prng.uniform(-200, 200) * s, ty + prng.uniform(40, 500) * s
            cr.save()
            cr.translate(lx, min(ly, h - 6 * s))
            cr.rotate(prng.uniform(0, math.pi))
            cr.scale(7 * s, 3.5 * s)
            cr.arc(0, 0, 1, 0, math.tau)
            cr.restore()
            cr.set_source_rgb(*shade(hexc(prng.choice(SEASON["autumn"][2])), 0.45 + 0.55 * amb))
            cr.fill()
    elif seas == "spring":
        for _ in range(int(15 + 50 * g)):
            tx, ty = prng.choice(tips)
            cr.set_source_rgba(*hexc("#FFD9E4"), 0.9)
            cr.arc(tx + prng.uniform(-260, 260) * s, ty + prng.uniform(30, 420) * s, 3 * s, 0, math.tau)
            cr.fill()
    elif seas == "winter":
        for _ in range(500):
            cr.set_source_rgba(1, 1, 1, prng.uniform(0.4, 0.9))
            cr.arc(prng.uniform(0, w), prng.uniform(0, h), prng.uniform(1, 3.2) * s, 0, math.tau)
            cr.fill()
    if seas == "summer" and amb < 0.5:
        for _ in range(40):
            soft_circle(cr, prng.uniform(0, w), prng.uniform(gy - 80 * s, h), 10 * s, hexc("#E8FF8A"), 0.7)

    # a soft vignette so the desk widgets and dock sit nicely
    v = cairo.RadialGradient(w / 2, h * 0.45, h * 0.35, w / 2, h * 0.5, h * 0.95)
    v.add_color_stop_rgba(0, 0, 0, 0, 0)
    v.add_color_stop_rgba(1, 0, 0, 0, 0.35)
    cr.set_source(v)
    cr.paint()

    tmp = path + ".tmp.png"
    surf.write_to_png(tmp)
    os.replace(tmp, path)                                 # atomic: GNOME reloads the changed file
    st.update(season=seas, growth=round(g, 3), slot=slot, lit=round(lit, 2), houses=n_houses,
              rendered=now.isoformat(timespec="seconds"))
    os.makedirs(STATE, exist_ok=True)
    with open(WORLD_STATE, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=1)
    return st


def cleanup_tmp(folder):
    for p in glob.glob(os.path.join(folder, "*.tmp.png")):
        try:
            os.remove(p)
        except OSError:
            pass
