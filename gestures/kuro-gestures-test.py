"""Kuro Air Gestures — accuracy test + personal calibration  (bapirlo-gestures test [--no-save])

Walks you through every pose (a notification + this terminal say which one), records what the camera daemon
reads for 3 s each, and prints how often it was right. Then it learns YOUR hand: where your fingers count as
straight / curled, how far out your thumb goes, how close your pinch gets — and saves that to
~/.config/bapirlo/gestures.json → "calibration" (old file kept as gestures.json.bak). It re-scores the same
recording with the new numbers so you can see the gain straight away.
Gestures do nothing while the test runs (no clicks, no volume, no workspace switches).
Runs in the gesture venv (it reuses the daemon's own geometry code).
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RUN = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
FLAG = os.path.join(RUN, "kuro-gestures-debug")
LOG = FLAG + ".jsonl"
CONF = os.path.expanduser("~/.config/bapirlo/gestures.json")
READY, RECORD = 3.0, 3.5
TAIL = 7.0          # keep recording after the last pose, in case the cues reached you late (see align())

STEPS = [("palm", "✋", "open hand, fingers spread"),
         ("fist", "✊", "closed fist, thumb tucked over the fingers"),
         ("thumb-up", "👍", "thumbs up"),
         ("thumb-down", "👎", "thumbs down"),
         ("victory", "✌", "two fingers (peace sign)"),
         ("point", "☝", "just the index finger up"),
         ("shaka", "🤙", "thumb + little finger out"),
         ("rock", "🤟", "index + little finger out (thumb either way)"),
         ("pinch", "🤏", "pinch thumb and index together and hold"),
         ("palm2", "✋", "open hand again — now turn it slowly side to side")]


def daemon_module():
    loader = importlib.machinery.SourceFileLoader("kd", os.path.join(HERE, "kuro-gestures-daemon.py"))
    spec = importlib.util.spec_from_loader("kd", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def notify(title, body):
    subprocess.run(["notify-send", "-a", "Kuro Air Gestures", "-i", "input-touchpad-symbolic", "-t", "2500",
                    "-h", "string:x-canonical-private-synchronous:kuro-gest-test", title, body],
                   capture_output=True)


def touch():
    with open(FLAG, "a"):
        pass
    os.utime(FLAG)


def wait(sec):
    end = time.monotonic() + sec
    while time.monotonic() < end:
        touch()
        time.sleep(0.25)


def read_log():
    rows = []
    try:
        with open(LOG) as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    return rows


def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    return xs[min(len(xs) - 1, max(0, int(round(q * (len(xs) - 1)))))]


def score(rows, pose):
    if not rows:
        return 0.0
    if pose == "pinch":
        return sum(r["pinch"] for r in rows) / len(rows)
    want = "palm" if pose == "palm2" else pose
    return sum(r["stable"] == want for r in rows) / len(rows)


def rescore(kd, rows, cal, pose):
    """Replay the recording with a calibration: same votes the daemon would cast."""
    v = kd.PoseVote()
    hits = 0
    pin = False
    for r in rows:
        f = r.get("feat")
        if not f:
            continue
        geo = kd.geo_pose(f, cal, r["p2d"]) if r.get("p2d") else r["geo"]
        st = v.add(r["t"], r["model"], r["score"], geo)
        pin = f["pinch"] < cal["pinch_on"] if not pin else f["pinch"] < cal["pinch_off"]
        if pose == "pinch":
            hits += pin
        else:
            hits += st == ("palm" if pose == "palm2" else pose)
    return hits / max(1, len(rows))


def align(rows, steps):
    """Cues can reach you late (a notification shown seconds after it was sent): find the delay that makes the
    recording agree best with the poses asked for, between 0 and 7 s, and cut the windows there."""
    best = (-1.0, 0.0)
    for i in range(0, 29):
        d = i * 0.25
        hits = n = 0
        for key, t0, t1 in steps:
            want = "palm" if key == "palm2" else key
            for r in rows:
                if t0 + d <= r["t"] <= t1 + d:
                    n += 1
                    hits += (r["pinch"] if key == "pinch" else (r["stable"] == want or r["geo"] == want
                                                                or r["model"] == want))
        if n and hits / n > best[0] + 0.02:
            best = (hits / n, d)
    return best[1]


def calibrate(kd, rec):
    cal = dict(kd.DEFAULT_CAL)
    notes = []
    feats = {k: [r["feat"] for r in rows if r.get("feat")] for k, rows in rec.items()}
    straight = feats.get("palm", []) + feats.get("palm2", [])
    curled = feats.get("fist", []) + feats.get("thumb-up", []) + feats.get("thumb-down", [])
    if len(straight) > 20 and len(curled) > 20:
        ext, curl = [], []
        for i in range(4):
            s90 = pct([f["bends"][i] for f in straight], 0.9)
            c10 = pct([f["bends"][i] for f in curled], 0.1)
            gap = c10 - s90
            if gap < 20:
                notes.append(f"finger {i + 1}: straight and curled overlap ({s90:.0f}° vs {c10:.0f}°) — kept default")
                ext.append(cal["ext"][i]), curl.append(cal["curl"][i])
            else:
                ext.append(round(s90 + gap * 0.35, 1)), curl.append(round(c10 - gap * 0.35, 1))
        cal["ext"], cal["curl"] = ext, curl
    out = feats.get("thumb-up", []) + feats.get("thumb-down", []) + feats.get("shaka", [])
    tin = feats.get("fist", [])
    if len(out) > 20 and len(tin) > 10:
        o10 = pct([f["thumb_reach"] for f in out], 0.1)
        i90 = pct([f["thumb_reach"] for f in tin], 0.9)
        if o10 - i90 > 0.08:
            cal["thumb_out"] = round(o10 - (o10 - i90) * 0.3, 3)
            cal["thumb_in"] = round(i90 + (o10 - i90) * 0.3, 3)
        else:
            notes.append(f"thumb out/in too close ({o10:.2f} vs {i90:.2f}) — kept default")
        t_out = pct([f["thumb_tuck"] for f in out], 0.1)
        t_in = pct([f["thumb_tuck"] for f in tin], 0.9)
        if t_out - t_in > 0.05:
            cal["thumb_tuck"] = round((t_out + t_in) / 2, 3)
    pin = feats.get("pinch", [])
    if len(pin) > 20 and len(straight) > 20:
        p90 = pct([f["pinch"] for f in pin], 0.9)
        o10 = pct([f["pinch"] for f in straight], 0.1)
        if o10 - p90 > 0.1:
            cal["pinch_on"] = round(p90 + (o10 - p90) * 0.3, 3)
            cal["pinch_off"] = round(p90 + (o10 - p90) * 0.6, 3)
        else:
            notes.append(f"pinch vs open too close ({p90:.2f} vs {o10:.2f}) — kept default")
    return cal, notes


def main():
    save = "--no-save" not in sys.argv
    kd = daemon_module()
    try:
        os.remove(LOG)
    except OSError:
        pass
    touch()
    print("Kuro Air Gestures — accuracy test. Sit where you normally sit, one hand up in front of the camera.")
    print("Gestures are paused during the test.\n")
    notify("Accuracy test", "Follow the poses shown here — 3 seconds each")
    wait(3)
    steps = []
    try:
        for key, icon, text in STEPS:
            notify(f"{icon}  next: {text}", "get ready…")
            wait(READY)
            notify(f"{icon}  HOLD IT", text)
            t0 = time.monotonic()
            wait(RECORD)
            steps.append((key, t0, time.monotonic()))
        notify("Last one done", "keep still a moment…")
        wait(TAIL)
    finally:
        try:
            os.remove(FLAG)
        except OSError:
            pass
    allrows = read_log()
    d = align(allrows, steps)
    if d > 0.3:
        print(f"  (your poses came {d:.1f} s after the cues — lined the recording up to match)")
    rec = {key: [r for r in allrows if t0 + d <= r["t"] <= t1 + d] for key, t0, t1 in steps}
    for key, icon, text in STEPS:
        rows = rec[key]
        print(f"  {icon}  {key:<10} {100 * score(rows, key):3.0f}% right  ({len(rows) / RECORD:.0f} frames/s with a hand)")
    notify("Accuracy test done", "Results are in the terminal")
    total = [score(rows, k) for k, rows in rec.items() if rows]
    print(f"\n  overall: {100 * sum(total) / max(1, len(total)):.0f}% with the current settings")
    missing = [k for k, rows in rec.items() if len(rows) < 20]
    if missing:
        print(f"  (hardly saw your hand for: {', '.join(missing)} — light / distance?)")

    try:
        with open(CONF) as f:
            conf = json.load(f)
    except (OSError, ValueError):
        conf = {}
    old = kd.load_cal(conf)
    new, notes = calibrate(kd, rec)
    before = [rescore(kd, rows, old, k) for k, rows in rec.items() if rows]
    after = [rescore(kd, rows, new, k) for k, rows in rec.items() if rows]
    b = 100 * sum(before) / max(1, len(before))
    a = 100 * sum(after) / max(1, len(after))
    print(f"  calibrated to your hand: {a:.0f}% on the same recording (was {b:.0f}%)")
    for k, rows in rec.items():
        if rows:
            print(f"     {k:<10} {100 * rescore(kd, rows, old, k):3.0f}% → {100 * rescore(kd, rows, new, k):3.0f}%")
    for n in notes:
        print("  note:", n)
    if save and a >= b and any(rec.values()):
        if os.path.exists(CONF):
            shutil.copy(CONF, CONF + ".bak")
        conf["calibration"] = new
        tmp = CONF + ".tmp"
        with open(tmp, "w") as f:
            json.dump(conf, f, indent=2)
        os.replace(tmp, CONF)
        print("  saved → gestures.json \"calibration\" (live now; undo: bapirlo-gestures calibrate reset)")
    elif save:
        print("  not saved (it wasn't better)")
    with open(os.path.join(RUN, "kuro-gestures-test-result.json"), "w") as f:
        json.dump({"rec": {k: rows for k, rows in rec.items()}, "old": old, "new": new}, f)


if __name__ == "__main__":
    main()
