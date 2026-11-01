#!/usr/bin/env python3
"""Kuro Knock — knock on your desk / laptop and the microphone does the rest.

  knock knock ............ play / pause music
  knock knock knock ...... lock the screen
  your own patterns ...... ~/.config/bapirlo/knock.json, e.g. "x-xx" = knock, pause, knock knock

Pattern letters: x = a knock, - = a pause (0.35–0.9 s) between knocks. Knocks closer than 0.35 s are one group.
Ignored while you're typing or moving the mouse (keystrokes sound like knocks) and while the screen is locked.

  python3 kuro-knock.py            run (bapirlo-knock on starts it as a service)
  python3 kuro-knock.py --test     print every knock it hears with its loudness — for tuning "sensitivity"
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import time

import numpy as np

RATE = 16000
HOP = 80                         # 5 ms
CONF = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "bapirlo", "knock.json")
BIN = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "bin")
DEFAULT = {
    "sensitivity": 1.0,          # higher = hears softer knocks (and more false ones)
    "quiet_after_input_ms": 1200,
    "patterns": {
        "xx": "media",
        "xxx": "lock",
        "x-xx": [os.path.join(BIN, "bapirlo-wallpaper"), "next"],
        "xx-xx": [os.path.join(BIN, "bapirlo-mode"), "dnd", "toggle"],
    },
}
SHORT, LONG, END = 0.35, 0.9, 0.95      # seconds
NAMES = {"media": "Play / pause", "lock": "Lock"}
TEST = "--test" in sys.argv


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def conf():
    try:
        with open(CONF, encoding="utf-8") as f:
            c = json.load(f)
        return {**DEFAULT, **c, "patterns": {**DEFAULT["patterns"], **c.get("patterns", {})}}
    except (OSError, ValueError):
        return DEFAULT


def gdbus(*args, timeout=2):
    try:
        return subprocess.run(["gdbus", "call", "--session", *args], capture_output=True, text=True,
                              timeout=timeout).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def idle_ms():
    out = gdbus("-d", "org.gnome.Mutter.IdleMonitor", "-o", "/org/gnome/Mutter/IdleMonitor/Core",
                "-m", "org.gnome.Mutter.IdleMonitor.GetIdletime")
    try:
        return int(out.split()[1].rstrip(",)"))
    except (IndexError, ValueError):
        return 10 ** 9


def locked():
    return "true" in gdbus("-d", "org.gnome.ScreenSaver", "-o", "/org/gnome/ScreenSaver",
                           "-m", "org.gnome.ScreenSaver.GetActive")


def say(text):
    """Toast through Kuro Air Gestures' overlay (falls back to a notification)."""
    out = gdbus("-d", "org.bapirlo.Gestures", "-o", "/org/bapirlo/Gestures", "-m", "org.bapirlo.Gestures.Say", text)
    if not out:
        gdbus("-d", "org.freedesktop.Notifications", "-o", "/org/freedesktop/Notifications", "-m",
              "org.freedesktop.Notifications.Notify", "Kuro", "0", "audio-input-microphone-symbolic", "Knock",
              text, "[]", "{}", "1500")


def run(action, pattern):
    label = NAMES.get(action) if isinstance(action, str) else None
    say(f"✊ {pattern.replace('x', '●').replace('-', ' ')}  {label or ' '.join(os.path.basename(a) for a in action[:2])}")
    if action == "media":
        subprocess.Popen(["playerctl", "play-pause"], stderr=subprocess.DEVNULL)
    elif action == "lock":
        subprocess.Popen(["loginctl", "lock-session"])
    elif isinstance(action, list):
        subprocess.Popen(action, stderr=subprocess.DEVNULL)
    elif isinstance(action, str):
        subprocess.Popen(["sh", "-c", action], stderr=subprocess.DEVNULL)


def pattern_of(times):
    p = "x"
    for a, b in zip(times, times[1:]):
        p += ("-x" if b - a > SHORT else "x")
    return p


def main():
    if not shutil.which("pw-record"):
        log("pw-record missing")
        return 1
    rec = subprocess.Popen(["pw-record", "--rate", str(RATE), "--channels", "1", "--format", "s16",
                            "--media-role", "Communication", "-P", "{ node.name = kuro-knock }", "-"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    signal.signal(signal.SIGTERM, lambda *_: (rec.terminate(), sys.exit(0)))
    c = conf()
    c_at = time.time()
    floor = 1e-4                                  # adaptive background energy
    prev = 0.0
    hold = 0                                      # frames left in the current transient
    peak = 0.0
    knocks = []
    last_lock = 0
    is_locked = False
    hp_prev_x = 0.0
    log("listening" + (" (test mode — knock away)" if TEST else ""))

    while True:
        raw = rec.stdout.read(HOP * 2)
        if not raw or len(raw) < HOP * 2:
            log("audio stream ended")
            return 1
        now = time.time()
        if now - c_at > 5:
            c, c_at = conf(), now
        if now - last_lock > 3 and not TEST:
            last_lock, is_locked = now, locked()
        if is_locked:
            knocks.clear()
            continue

        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768
        # first difference = a cheap high-pass: hum and the body of voices drop, a knock's click stays
        y = np.diff(x, prepend=hp_prev_x)
        hp_prev_x = float(x[-1])
        e = float(np.mean(y * y))

        sens = float(c.get("sensitivity", 1.0))
        onset = e > floor * (14 / sens) and e > 4e-4 / sens and e > prev * 4
        if hold > 0:
            hold -= 1
            peak = max(peak, e)
            if hold == 0:
                # a knock dies away fast: 60 ms after the hit it must be far quieter than the peak
                if e < peak * 0.12:
                    t_hit = now - 0.065
                    if TEST:
                        log(f"knock  loudness {10 * np.log10(peak / floor):5.1f} dB over background")
                    knocks.append(t_hit)
                elif TEST:
                    log(f"(not a knock — sound kept going {10 * np.log10(peak / floor):4.1f} dB)")
        elif onset:
            hold = 12                                    # look at the next 60 ms
            peak = e
        else:
            floor = floor * 0.995 + e * 0.005 if e < floor * 6 else floor * 0.9995 + e * 0.0005
            floor = max(floor, 1e-6)
        prev = e

        # pattern finished?
        if knocks and now - knocks[-1] > END and hold == 0:
            gaps_ok = all(b - a < LONG for a, b in zip(knocks, knocks[1:]))
            p = pattern_of(knocks)
            knocks = []
            if not gaps_ok or len(p.replace("-", "")) < 2:
                continue
            if TEST:
                log(f"pattern {p!r} → {c['patterns'].get(p, 'nothing set')}")
                continue
            if idle_ms() < int(c.get("quiet_after_input_ms", 1200)) + END * 1000:
                continue                                 # you were typing / mousing — ignore
            act = c["patterns"].get(p)
            if act:
                run(act, p)


if __name__ == "__main__":
    sys.exit(main())
