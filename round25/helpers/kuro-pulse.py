"""Kuro Pulse — the beat of whatever is playing, for Kuro Sense (music-reactive glow).

Runs as kuro-pulse.service ONLY while an MPRIS player is Playing (Kuro Sense starts and stops it).
Listens to the default OUTPUT's monitor (what the speakers play — never the microphone) with parec at 22 kHz mono,
and ~30×/s sends org.bapirlo.Sense.Levels(level, bass, onset):
  level  overall loudness 0…1 (auto-gain: follows how loud this track is, so quiet songs pulse too)
  bass   kick-drum band (40–160 Hz) 0…1, same auto-gain
  onset  True on a beat (bass jumps well above its last second)
Silence for 1.5 s → it stops sending (the shell fades the glow out) but keeps listening.
The stream calls itself application.id=org.PulseAudio.pavucontrol: GNOME's "microphone in use" indicator
skips that id because a level meter is not a recording — this is a level meter too. Nothing is stored or sent.
"""
import collections
import signal
import subprocess
import sys
import time

import numpy as np
from jeepney import DBusAddress, new_method_call
from jeepney.io.blocking import open_dbus_connection
from jeepney.low_level import MessageFlag

RATE = 22050
HOP = 735                 # 30 per second
WIN = 2048
SENSE = DBusAddress("/org/bapirlo/Sense", bus_name="org.bapirlo.Sense", interface="org.bapirlo.Sense")

running = True


def stop(*_):
    global running
    running = False


def main():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    conn = open_dbus_connection(bus="SESSION")
    rec = subprocess.Popen(
        ["parec", "--device=@DEFAULT_MONITOR@", "--format=s16le", f"--rate={RATE}", "--channels=1",
         "--latency-msec=30", "--client-name=kuro-pulse", "--stream-name=kuro-pulse level meter",
         "--property=application.id=org.PulseAudio.pavucontrol", "--property=application.name=kuro-pulse",
         "--property=media.role=music"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
    buf = np.zeros(WIN, np.float32)
    window = np.hanning(WIN).astype(np.float32)
    freqs = np.fft.rfftfreq(WIN, 1 / RATE)
    bass_band = (freqs >= 40) & (freqs <= 160)
    gain_level, gain_bass = 1e-3, 1e-3          # running peaks (auto-gain)
    hist = collections.deque(maxlen=30)           # last second of bass
    last_onset = 0.0
    quiet_since = None
    need = HOP * 2
    pending = b""
    while running:
        chunk = rec.stdout.read(need - len(pending))
        if not chunk:
            break
        pending += chunk
        if len(pending) < need:
            continue
        x = np.frombuffer(pending, np.int16).astype(np.float32) / 32768.0
        pending = b""
        buf = np.concatenate([buf[HOP:], x])
        rms = float(np.sqrt(np.mean(x * x)))
        now = time.monotonic()
        if rms < 2e-4:
            quiet_since = quiet_since or now
            if now - quiet_since > 1.5:
                continue
        else:
            quiet_since = None
        spec = np.abs(np.fft.rfft(buf * window))
        bass = float(np.sqrt(np.mean(spec[bass_band] ** 2)))
        # auto-gain: peaks fall slowly (≈ 4 s to halve), jump up at once
        gain_level = max(rms, gain_level * 0.995, 1e-3)
        gain_bass = max(bass, gain_bass * 0.995, 1e-3)
        lv = min(1.0, rms / gain_level)
        bs = min(1.0, bass / gain_bass)
        onset = False
        if len(hist) >= 10:
            mean = float(np.mean(hist))
            sd = float(np.std(hist))
            if bs > mean + 1.4 * sd and bs > 0.45 and now - last_onset > 0.18:
                onset, last_onset = True, now
        hist.append(bs)
        shaped = max(0.0, (bs - 0.25) / 0.75) ** 1.5     # only the kick, not the bass line's floor
        try:
            msg = new_method_call(SENSE, "Levels", "ddb", (lv, shaped, onset))
            msg.header.flags = MessageFlag.no_reply_expected
            conn.send(msg)
        except Exception as e:
            print(f"kuro-pulse: {e}", file=sys.stderr, flush=True)
            time.sleep(1)
            try:
                conn = open_dbus_connection(bus="SESSION")
            except Exception:
                pass
    rec.terminate()


if __name__ == "__main__":
    main()
