"""Kuro Voice — offline speech for "Hey Kuro" (Kuro Sense voice.js does the commands).

Runs as kuro-voice.service (~/.local/share/bapirlo/voice-venv, faster-whisper base.en, int8 on the CPU).
Kuro Sense starts it on first use; with the wake word off it exits after 20 idle minutes.
Control: one line per connection on $XDG_RUNTIME_DIR/kuro-voice.sock
  listen   open the mic, wait for speech, stop after a pause (or 8 s), transcribe → VoiceState("heard", text)
  stop     finish listening now
  wake 1   keep the mic open and wait for "Hey Kuro …" (anything after it is the command; nothing after it →
           listen for the command)          wake 0  stop that
Reports go to org.bapirlo.Sense.VoiceState(state, text): listening · thinking · heard · nothing · error.
The microphone is open ONLY while listening or while the wake word is on (GNOME's red mic dot shows it).
Audio is never saved or sent anywhere.
"""
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time

import numpy as np
from faster_whisper import WhisperModel
from jeepney import DBusAddress, new_method_call
from jeepney.io.blocking import open_dbus_connection
from jeepney.low_level import MessageFlag

RATE = 16000
FRAME = 480                      # 30 ms
SOCK = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "kuro-voice.sock")
MODEL_DIR = os.path.expanduser("~/.local/share/bapirlo/models/whisper")
SENSE = DBusAddress("/org/bapirlo/Sense", bus_name="org.bapirlo.Sense", interface="org.bapirlo.Sense")
PROMPT = "Hey Kuro, open Spotify. Next song. Volume up. Dark mode. Lock the screen. Workspace two."
WAKE = re.compile(r"^\W*(hey|hi|okay|ok|a|hay|he)?[\s,]*(kuro|curo|cuero|kiro|kirro|guro|coro|kuru|curro|cairo|kudo|kudos|crow|carol)\b",
                  re.I)
IDLE_EXIT = 20 * 60

running = True


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Shell:
    def __init__(self):
        self.conn = None

    def say(self, state, text=""):
        for _ in range(2):
            try:
                self.conn = self.conn or open_dbus_connection(bus="SESSION")
                msg = new_method_call(SENSE, "VoiceState", "ss", (state, text))
                msg.header.flags = MessageFlag.no_reply_expected
                self.conn.send(msg)
                return
            except Exception as e:
                log(f"shell: {e}")
                self.conn = None


class Mic:
    """parec on the default microphone, only while needed."""
    def __init__(self):
        self.p = None

    def open(self):
        if self.p is None:
            self.p = subprocess.Popen(
                ["parec", "--device=@DEFAULT_SOURCE@", "--format=s16le", f"--rate={RATE}", "--channels=1",
                 "--latency-msec=30", "--client-name=kuro-voice", "--stream-name=Kuro voice command",
                 "--property=application.name=kuro-voice"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)

    def close(self):
        if self.p is not None:
            self.p.terminate()
            try:
                self.p.wait(1)
            except Exception:
                self.p.kill()
            self.p = None

    def frame(self):
        need, data = FRAME * 2, b""
        while len(data) < need:
            chunk = self.p.stdout.read(need - len(data))
            if not chunk:
                raise IOError("microphone closed")
            data += chunk
        return np.frombuffer(data, np.int16).astype(np.float32) / 32768.0


class Voice:
    def __init__(self):
        self.shell = Shell()
        self.mic = Mic()
        self.model = None
        self.wake = False
        self.listen_req = threading.Event()
        self.stop_req = threading.Event()
        self.wake_changed = threading.Event()
        self.last_use = time.monotonic()
        self.floor = 0.004

    def load(self):
        t = time.monotonic()
        self.model = WhisperModel("base.en", device="cpu", compute_type="int8", cpu_threads=4,
                                  download_root=MODEL_DIR)
        log(f"model loaded in {time.monotonic() - t:.1f} s")

    def transcribe(self, audio):
        segs, _ = self.model.transcribe(audio, language="en", beam_size=1, initial_prompt=PROMPT,
                                        vad_filter=False, condition_on_previous_text=False, without_timestamps=True)
        return " ".join(s.text.strip() for s in segs).strip()

    def _thr(self):
        return max(self.floor * 3.2, 0.010)

    def utterance(self, max_s, no_speech_s, end_silence_s, interruptible=True):
        """Record until a pause after speech. Returns audio or None (nothing said)."""
        frames, speech, silent, started = [], 0, 0, False
        pre = []                                   # keep 300 ms before speech starts
        t0 = time.monotonic()
        while running:
            f = self.mic.frame()
            rms = float(np.sqrt(np.mean(f * f)))
            if not started:
                self.floor = 0.97 * self.floor + 0.03 * min(rms, 0.05)
                pre.append(f)
                pre = pre[-10:]
                if rms > self._thr():
                    speech += 1
                    if speech >= 4:                # 120 ms of speech
                        started = True
                        frames = pre[:]
                else:
                    speech = 0
                if time.monotonic() - t0 > no_speech_s or (interruptible and self.stop_req.is_set()):
                    return None
                if not interruptible and (self.listen_req.is_set() or self.wake_changed.is_set()):
                    return None
                continue
            frames.append(f)
            silent = silent + 1 if rms < self._thr() * 0.8 else 0
            dur = len(frames) * FRAME / RATE
            if silent * FRAME / RATE > end_silence_s or dur > max_s or (interruptible and self.stop_req.is_set()):
                break
        return np.concatenate(frames) if frames else None

    def do_listen(self):
        self.listen_req.clear()
        self.stop_req.clear()
        self.last_use = time.monotonic()
        try:
            self.mic.open()
            self.shell.say("listening")
            audio = self.utterance(max_s=8, no_speech_s=5, end_silence_s=0.9)
            if not self.wake:
                self.mic.close()
            if audio is None or len(audio) < RATE * 0.3:
                self.shell.say("nothing")
                return
            self.shell.say("thinking")
            text = self.transcribe(audio)
            log(f"heard: {text!r}")
            self.shell.say("heard" if text else "nothing", text)
        except Exception as e:
            log(f"listen: {e}")
            self.mic.close()
            self.shell.say("error", str(e))

    def wake_step(self):
        self.mic.open()
        audio = self.utterance(max_s=6, no_speech_s=3600, end_silence_s=0.6, interruptible=False)
        if audio is None or len(audio) < RATE * 0.35:
            return
        text = self.transcribe(audio)
        m = WAKE.match(text)
        if not m:
            return
        self.last_use = time.monotonic()
        rest = text[m.end():].strip(" ,.!?")
        log(f"wake: {text!r}")
        if len(rest) >= 2:
            self.shell.say("heard", text)
        else:
            self.listen_req.set()

    def control(self):
        try:
            os.unlink(SOCK)
        except OSError:
            pass
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(SOCK)
        os.chmod(SOCK, 0o600)
        srv.listen(4)
        srv.settimeout(1)
        while running:
            try:
                c, _ = srv.accept()
            except socket.timeout:
                continue
            with c:
                c.settimeout(1)
                try:
                    line = c.recv(256).decode().strip()
                except Exception:
                    continue
            log(f"control: {line}")
            if line == "listen":
                self.listen_req.set()
            elif line == "stop":
                self.stop_req.set()
            elif line.startswith("wake"):
                self.wake = line.endswith("1")
                self.wake_changed.set()
        srv.close()
        try:
            os.unlink(SOCK)
        except OSError:
            pass

    def run(self):
        threading.Thread(target=self.control, daemon=True).start()
        self.load()
        while running:
            if self.listen_req.is_set():
                self.do_listen()
            elif self.wake:
                self.wake_changed.clear()
                try:
                    self.wake_step()
                except Exception as e:
                    log(f"wake: {e}")
                    self.mic.close()
                    time.sleep(2)
            else:
                self.mic.close()
                self.wake_changed.clear()
                self.listen_req.wait(1)
                if not self.wake and time.monotonic() - self.last_use > IDLE_EXIT:
                    log("idle — exiting")
                    break
        self.mic.close()


def main():
    def stop(*_):
        global running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    Voice().run()


if __name__ == "__main__":
    main()
