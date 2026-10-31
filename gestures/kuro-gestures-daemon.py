"""Kuro Air Gestures — the camera half (runs in ~/.local/share/bapirlo/gesture-venv, Python 3.12 + MediaPipe).

Watches the webcam for one hand and tells the shell (org.bapirlo.Gestures, extension bapirlo-gestures) what it
sees. The shell decides what each gesture DOES (~/.config/bapirlo/gestures.json → "actions").

The one rule: hold a pose STILL = do the thing (a ring fills up around the dot), MOVE while holding it = a dial.
  move hand ............................ red dot follows your index finger
  pinch tap (thumb + index) ............ click            pinch + move ... carry the window (fling = throw)
  swipe ✋ left / right / up / down .... gesture names swipe-left/right/up/down
  ✋ palm still · ✊ fist still · 👍 · 👎 · 🤙 still ... palm, fist, thumb-up, thumb-down, shaka
  👍 / 👎 kept held ..................... fires again every 0.25 s (volume steps)
  ✌ two fingers + move up/down ......... Dial("victory", dy)            (scroll)
  ✌ two fingers + flick left / right ... victory-left / victory-right   (previous / next song)
  🤟 rock ............................... still recognised (name "rock") but has no hold action any more

Round 20 — no lag:
  * the camera is read on its own thread, which always keeps only the NEWEST frame. The old loop read frames in
    turn, so when MediaPipe was a little slow it worked on pictures that were already old.
  * a hand in view is processed at the full 30 fps (was 15); with no hand, ~10 fps (and only those frames are
    decoded)
  * the screen-lock check runs on its own thread (it used to block the loop for up to 1 s)
  * brightening runs on the small picture MediaPipe sees, not the full 1280×720 one
  * shorter holds, a shorter vertical-swipe check and a shorter cooldown
  * KURO_GEST_PROFILE=1 logs fps and timings every 5 s
Camera released while the screen is locked.
"""
import collections
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time

import cv2
import mediapipe as mp
import numpy as np
from jeepney import DBusAddress, new_method_call
from jeepney.bus_messages import message_bus
from jeepney.io.blocking import open_dbus_connection
from jeepney.low_level import MessageFlag
from mediapipe.tasks.python import BaseOptions, vision

MODEL = os.path.expanduser("~/.local/share/bapirlo/models/gesture_recognizer.task")
CONF = os.path.expanduser("~/.config/bapirlo/gestures.json")
MIRROR_FLAG = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "kuro-gestures-mirror")
SHELL = DBusAddress("/org/bapirlo/Gestures", bus_name="org.bapirlo.Gestures", interface="org.bapirlo.Gestures")
SAVER = DBusAddress("/org/gnome/ScreenSaver", bus_name="org.gnome.ScreenSaver", interface="org.gnome.ScreenSaver")
PROFILE = os.environ.get("KURO_GEST_PROFILE") == "1"

CAM_W, CAM_H = 1280, 720
INFER_W, INFER_H = 640, 360
ZOOM_BOX = (0.20, 0.10, 0.80, 0.70)      # the middle crop used to find a far-away hand
POSES = {"Open_Palm": "palm", "Closed_Fist": "fist", "Thumb_Up": "thumb-up", "Thumb_Down": "thumb-down",
         "ILoveYou": "rock", "Victory": "victory", "Pointing_Up": "point"}
HOLD = {"palm": 0.6, "fist": 0.5, "thumb-up": 0.4, "thumb-down": 0.4, "shaka": 0.45}
DIALS = ("victory",)                     # moving up/down while holding these = a dial
FLICKS = ("victory",)                    # moving left/right fast while holding these = <pose>-left/right
REPEAT = {"thumb-up": 0.25, "thumb-down": 0.25}   # keep holding = fire again every n s (volume steps)
COOLDOWN = 0.7
SETTLE = 0.35                            # a hand must be tracked this long before swipes count (raising it ≠ swipe)
VERT_CONFIRM = 0.15                      # vertical swipes wait this long to see the hand is still there
LOST_AFTER = 0.5
IDLE_FPS = 10
running = True


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Conf:
    """~/.config/bapirlo/gestures.json, re-read only when the file changes."""
    def __init__(self):
        self.data, self.mtime, self.checked = {}, None, 0.0
        self.refresh(force=True)

    def refresh(self, force=False):
        now = time.monotonic()
        if not force and now - self.checked < 2:
            return False
        self.checked = now
        try:
            m = os.stat(CONF).st_mtime
        except OSError:
            m = None
        if m == self.mtime and not force:
            return False
        self.mtime = m
        try:
            with open(CONF) as f:
                self.data = json.load(f)
        except Exception:
            self.data = {}
        return True

    def get(self, k, d=None):
        return self.data.get(k, d)


class Shell:
    def __init__(self):
        self.conn = open_dbus_connection(bus="SESSION")
        try:      # so the shell can tell whether the camera half is running (top-bar icon)
            self.conn.send_and_get_reply(message_bus.RequestName("org.bapirlo.GesturesCam", 4), timeout=2)
        except Exception as e:
            log(f"name: {e}")

    def call(self, method, sig=None, *args):
        try:
            msg = new_method_call(SHELL, method, sig, args) if sig else new_method_call(SHELL, method)
            msg.header.flags = MessageFlag.no_reply_expected      # fire and forget, and no replies piling up
            self.conn.send(msg)
        except Exception as e:
            log(f"shell call {method}: {e}")


class LockWatch(threading.Thread):
    """Asks the screensaver every 2 s on its own connection, so the camera loop never waits on D-Bus."""
    def __init__(self):
        super().__init__(daemon=True)
        self.locked = False

    def run(self):
        conn = None
        while running:
            try:
                conn = conn or open_dbus_connection(bus="SESSION")
                reply = conn.send_and_get_reply(new_method_call(SAVER, "GetActive"), timeout=1)
                self.locked = bool(reply.body[0])
            except Exception:
                self.locked = False
                try:
                    conn and conn.close()
                except Exception:
                    pass
                conn = None
            time.sleep(2)


def v4l2_get(ctrl):
    try:
        out = subprocess.run(["v4l2-ctl", "-d", "/dev/video0", "-C", ctrl], capture_output=True, text=True,
                             timeout=2).stdout
        return out.split(":")[-1].strip() or None
    except Exception:
        return None


def v4l2_set(ctrl, val):
    try:
        subprocess.run(["v4l2-ctl", "-d", "/dev/video0", "-c", f"{ctrl}={val}"], capture_output=True, timeout=2)
    except Exception:
        pass


class Camera(threading.Thread):
    """Reads the webcam non-stop and keeps only the newest frame. MJPG decoding (the expensive part) only happens
    for frames the main loop will actually use: every frame while tracking, IDLE_FPS while looking."""
    def __init__(self):
        super().__init__(daemon=True)
        self.cond = threading.Condition()
        self.frame = None
        self.t = 0.0
        self.seq = 0
        self.tracking = False
        self.want_open = False
        self.state = "closed"            # closed | open | failed
        self.grab_n = 0
        self.dyn_fps = None

    def _open(self):
        # in dim light this webcam slows itself down to ~13 fps to expose longer — that alone is ~45 ms of lag
        # per frame and blurs fast moves. Keep it at a steady 30 fps (the picture is brightened in software).
        # Has to be set before the stream starts.
        self.dyn_fps = v4l2_get("exposure_dynamic_framerate")
        if self.dyn_fps == "1":
            v4l2_set("exposure_dynamic_framerate", "0")
        cap = cv2.VideoCapture(0, cv2.CAP_V4L2)
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAM_W)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAM_H)
        cap.set(cv2.CAP_PROP_FPS, 30)
        # (no BUFFERSIZE=1: with a single buffer the driver can't fill the next frame while we read one, which
        # halved the frame rate. The reader thread drains the queue anyway, so nothing goes stale.)
        if not cap.isOpened():
            self._restore()
            return None
        log(f"camera {int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))}")
        return cap

    def _close(self, cap):
        cap.release()
        self._restore()

    def _restore(self):
        if self.dyn_fps == "1":                     # give other apps the camera the way we found it
            v4l2_set("exposure_dynamic_framerate", "1")
        self.dyn_fps = None

    def run(self):
        cap = None
        last_decode = 0.0
        while running:
            if not self.want_open:
                if cap:
                    self._close(cap)
                    cap = None
                    self.state = "closed"
                time.sleep(0.2)
                continue
            if cap is None:
                cap = self._open()
                if cap is None:
                    self.state = "failed"
                    time.sleep(5)
                    continue
                self.state = "open"
            if not cap.grab():
                self._close(cap)
                cap = None
                self.state = "failed"
                time.sleep(1)
                continue
            t = time.monotonic()
            self.grab_n += 1
            if not self.tracking and t - last_decode < 1 / IDLE_FPS - 0.01:
                continue
            ok, frame = cap.retrieve()
            if not ok:
                continue
            last_decode = t
            with self.cond:
                self.frame, self.t = frame, t
                self.seq += 1
                self.cond.notify()
        if cap:
            self._close(cap)

    def latest(self, after_seq, timeout=0.5):
        with self.cond:
            if self.seq == after_seq:
                self.cond.wait(timeout)
            if self.seq == after_seq:
                return None, 0.0, after_seq
            return self.frame, self.t, self.seq


class OneEuro:
    """Jitter filter: heavy smoothing when the hand is still, almost none when it moves fast."""
    def __init__(self, min_cutoff=1.4, beta=8.0, d_cutoff=1.2):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.x = self.dx = self.t = None

    @staticmethod
    def _a(cutoff, dt):
        r = 2 * math.pi * cutoff * dt
        return r / (r + 1)

    def __call__(self, x, t):
        if self.x is None:
            self.x, self.dx, self.t = x, 0.0, t
            return x
        dt = max(1e-3, t - self.t)
        dx = (x - self.x) / dt
        self.dx += self._a(self.d_cutoff, dt) * (dx - self.dx)
        self.x += self._a(self.min_cutoff + self.beta * abs(self.dx), dt) * (x - self.x)
        self.t = t
        return self.x

    def reset(self):
        self.x = None


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def fingers(p):
    """Which fingers are straight: (thumb, index, middle, ring, pinky), from the 21 points."""
    w = p[0]
    ext = [dist(w, p[t]) > dist(w, p[j]) * 1.12 for t, j in ((8, 6), (12, 10), (16, 14), (20, 18))]
    thumb = dist(p[4], p[17]) > dist(p[3], p[17]) * 1.08 and dist(p[4], p[5]) > dist(p[0], p[9]) * 0.45
    return (thumb, *ext)


def is_shaka(p, f):
    """🤙 thumb + pinky out, the other three curled. Checked from the points because MediaPipe's model has no
    shaka class (it tends to call it ILoveYou, Thumb_Up or None)."""
    thumb, i, m, r, k = f
    if not (thumb and k) or i or m or r:
        return False
    # curled fingers really curled (tip near the palm), pinky clearly out
    palm = dist(p[0], p[9])
    curled = all(dist(p[t], p[0]) < palm * 1.25 for t in (8, 12, 16))
    pinky_out = dist(p[20], p[0]) > palm * 1.15
    return curled and pinky_out


def finger_pose(f):
    """Fallback when the model says 'None'."""
    thumb, i, m, r, k = f
    if i and m and r and k:
        return "palm"
    if not any((i, m, r, k)) and not thumb:
        return "fist"
    if i and m and not r and not k:
        return "victory"
    if i and k and not m and not r:
        return "rock"
    if i and not m and not r and not k:
        return "point"
    return None


class View:
    """One MediaPipe tracker over one part of the camera picture (whole, or the zoomed middle)."""
    def __init__(self, box, sens):
        c = 0.35 if sens == "high" else 0.45
        opts = vision.GestureRecognizerOptions(base_options=BaseOptions(model_asset_path=MODEL),
                                               running_mode=vision.RunningMode.VIDEO, num_hands=1,
                                               min_hand_detection_confidence=c, min_hand_presence_confidence=c,
                                               min_tracking_confidence=c)
        self.rec = vision.GestureRecognizer.create_from_options(opts)
        self.box = box
        self.ts = 0

    def run(self, frame, t, lut):
        h, w = frame.shape[:2]
        x0, y0, x1, y1 = self.box
        crop = frame[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
        crop = cv2.resize(crop, (INFER_W, INFER_H), interpolation=cv2.INTER_AREA)
        if lut is not None:
            crop = cv2.LUT(crop, lut)
        self.ts = max(self.ts + 1, int(t * 1000))
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
        res = self.rec.recognize_for_video(img, self.ts)
        if not res.hand_landmarks:
            return None
        # back to whole-picture coordinates, mirrored so it matches what you see (left is left)
        pts = [(1 - (x0 + l.x * (x1 - x0)), y0 + l.y * (y1 - y0)) for l in res.hand_landmarks[0]]
        g, s = "None", 0.0
        if res.gestures and res.gestures[0]:
            g, s = res.gestures[0][0].category_name, res.gestures[0][0].score
        return pts, g, s


def main():
    global running

    def stop(*_):
        global running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    sys.setswitchinterval(0.001)   # let the camera thread grab its frame promptly while MediaPipe is busy
    conf = Conf()
    sens = conf.get("sensitivity", "normal")
    views = [View((0, 0, 1, 1), sens), View(ZOOM_BOX, sens)]
    shell = Shell()
    lock = LockWatch()
    lock.start()
    cam = Camera()
    cam.start()

    seq = 0
    paused = False
    hand_seen = 0.0
    hand_since = 0.0
    view_i = 0                     # which view found the hand (0 = whole, 1 = zoom)
    scan = 0
    pinching = False
    fx, fy = OneEuro(), OneEuro()
    wrist = collections.deque()    # (t, x, y)
    votes = collections.deque(maxlen=5)
    hold = {"pose": None, "since": 0.0, "x": 0, "y": 0, "ax": 0, "ay": 0, "fired": False, "dial": False, "ly": 0}
    pending = None                 # (name, fire_at) — vertical swipes wait to see the hand is still there
    cooldown_until = 0.0
    status = ""
    status_t = 0.0
    lut_cache = {}
    mirror_on, mirror_t = False, 0.0
    prof = {"n": 0, "infer": 0.0, "age": 0.0, "t": time.monotonic(), "grabs": 0}

    def set_status(state, hint=""):
        nonlocal status, status_t
        key = state + "|" + hint
        now_ = time.monotonic()
        if key != status or now_ - status_t > 2:
            shell.call("Status", "ss", state, hint)
            status, status_t = key, now_

    def reset_hand():
        nonlocal pinching, pending
        pinching = False
        pending = None
        fx.reset(), fy.reset()
        wrist.clear()
        votes.clear()
        hold.update(pose=None, dial=False)
        cam.tracking = False

    while running:
        if conf.refresh() and conf.get("sensitivity", "normal") != sens:
            sens = conf.get("sensitivity", "normal")
            views = [View((0, 0, 1, 1), sens), View(ZOOM_BOX, sens)]

        if lock.locked:
            if not paused:
                paused = True
                cam.want_open = False
                shell.call("Lost")
                reset_hand()
                set_status("paused", "Screen locked — camera off")
            time.sleep(0.5)
            continue
        if paused or not cam.want_open:
            paused = False
            cam.want_open = True
        if cam.state == "failed":
            set_status("nocam", "Can't open the camera (is another app using it?)")

        frame, ft, seq = cam.latest(seq)
        if frame is None:
            continue
        now = time.monotonic()
        idle = now - hand_seen > LOST_AFTER

        # light: brighten a dark picture (on the small copy MediaPipe sees)
        small = cv2.resize(frame, (80, 45), interpolation=cv2.INTER_NEAREST)
        luma = float(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).mean())
        dark = luma < 38
        lut = None
        if luma < 90:
            g = round(max(0.45, min(1.0, (luma / 90) ** 0.8)), 2)
            if g not in lut_cache:
                lut_cache[g] = np.array([((i / 255) ** g) * 255 for i in range(256)], np.uint8)
            lut = lut_cache[g]

        if now - mirror_t > 1:
            mirror_on, mirror_t = os.path.exists(MIRROR_FLAG), now
        if mirror_on and seq % 3 == 0:
            th = cv2.resize(frame, (192, 108), interpolation=cv2.INTER_AREA)
            if lut is not None:
                th = cv2.LUT(th, lut)
            th = cv2.cvtColor(cv2.flip(th, 1), cv2.COLOR_BGR2RGB)
            shell.call("Mirror", "ay", th.tobytes())

        if idle:                                   # still looking: alternate whole picture / zoomed middle
            scan += 1
            vi = scan % 2 if conf.get("zoom", True) else 0
        else:
            vi = view_i
        t0 = time.monotonic()
        res = views[vi].run(frame, ft, lut)
        if PROFILE:
            prof["n"] += 1
            prof["infer"] += time.monotonic() - t0
            prof["age"] += time.monotonic() - ft
            if time.monotonic() - prof["t"] > 5:
                el = time.monotonic() - prof["t"]
                n = max(1, prof["n"])
                log(f"[profile] {prof['n'] / el:.1f} fps processed, camera {(cam.grab_n - prof['grabs']) / el:.1f} fps, "
                    f"mediapipe {1000 * prof['infer'] / n:.1f} ms, frame age at send {1000 * prof['age'] / n:.1f} ms, "
                    f"{'tracking' if cam.tracking else 'idle'}")
                prof.update(n=0, infer=0.0, age=0.0, t=time.monotonic(), grabs=cam.grab_n)

        if res is None:
            if not idle and now - hand_seen > LOST_AFTER * 0.7:
                shell.call("Lost")
                reset_hand()
            if idle:
                set_status("dark" if dark else "looking",
                           "It's dark — turn a light on" if dark else "Raise a hand in front of the camera")
            continue

        pts, gname, gscore = res
        if idle:
            hand_since = now
            view_i = vi
        hand_seen = now
        cam.tracking = True
        size = dist(pts[0], pts[9])                # wrist → middle knuckle: how big (close) the hand is

        # pose: model first, finger counting as a fallback, shaka from the points; then a 5-frame vote
        f = fingers(pts)
        if is_shaka(pts, f):
            pose = "shaka"
        else:
            pose = POSES.get(gname) if gscore > 0.5 else None
            if pose is None:
                pose = finger_pose(f)
        votes.append(pose)
        top, n = collections.Counter(votes).most_common(1)[0]
        stable = top if n >= 3 else None

        # pinch, with hysteresis, never while making a fist / thumbs / shaka pose
        pd = dist(pts[4], pts[8]) / size
        if stable in ("fist", "thumb-up", "thumb-down", "shaka"):
            pinching = False
        else:
            pinching = pd < 0.30 if not pinching else pd < 0.48

        # pointer: index tip (or the pinch point). The box that maps to the whole screen shrinks when
        # you're further away, so you never have to reach far.
        px = (pts[4][0] + pts[8][0]) / 2 if pinching else pts[8][0]
        py = (pts[4][1] + pts[8][1]) / 2 if pinching else pts[8][1]
        bw = min(0.66, max(0.30, size * 4.2))
        bh = bw * 1.05
        cx, cy = 0.5, 0.44
        tx = min(1, max(0, (px - (cx - bw / 2)) / bw))
        ty = min(1, max(0, (py - (cy - bh / 2)) / bh))
        sx, sy = fx(tx, ft), fy(ty, ft)
        shell.call("Pointer", "ddbs", float(sx), float(sy), bool(pinching), stable or "")

        # hints
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        hint = ""
        if min(xs) < 0.02 or max(xs) > 0.98 or min(ys) < 0.02 or max(ys) > 0.98:
            hint = "Hand at the edge — move it to the middle"
        elif size < 0.055:
            hint = "Come a little closer"
        elif dark:
            hint = "It's dark — a light helps"
        set_status("tracking", hint)

        # swipes (open hand, fast, after the hand has settled); ✌ flicks use the same wrist trail
        wx, wy = pts[0]
        wrist.append((ft, wx, wy))
        while wrist and ft - wrist[0][0] > 0.35:
            wrist.popleft()
        progress = 0.0
        if pending and now >= pending[1]:
            shell.call("Gesture", "s", pending[0])
            pending = None
        fired = False
        if (not pinching and now > cooldown_until and now - hand_since > SETTLE and len(wrist) >= 3
                and not hold["dial"]):
            dx = wrist[-1][1] - wrist[0][1]
            dy = wrist[-1][2] - wrist[0][2]
            thr = min(0.30, max(0.11, size * 1.9))
            name = None
            if stable in ("palm", "point", None):
                if abs(dx) > thr and abs(dy) < abs(dx) * 0.55:
                    name = "swipe-left" if dx < 0 else "swipe-right"
                elif abs(dy) > thr * 0.9 and abs(dx) < abs(dy) * 0.55 and stable == "palm":
                    name = "swipe-up" if dy < 0 else "swipe-down"
            elif stable in FLICKS and abs(dx) > thr * 0.8 and abs(dy) < abs(dx) * 0.5:
                name = f"{stable}-left" if dx < 0 else f"{stable}-right"
            if name:
                if name in ("swipe-up", "swipe-down"):
                    pending = (name, now + VERT_CONFIRM)     # dropping your hand out of view ≠ swipe down
                else:
                    shell.call("Gesture", "s", name)
                cooldown_until = now + COOLDOWN
                wrist.clear()
                hold.update(pose=None)
                fired = True

        # holds and dials
        if not fired and (stable in HOLD or stable in DIALS) and not pinching:
            if hold["pose"] != stable:
                hold.update(pose=stable, since=now, x=wx, y=wy, ax=wx, ay=wy, fired=False, dial=False, ly=wy)
            moved = math.hypot(wx - hold["x"], wy - hold["y"]) / size
            if hold["dial"]:
                shell.call("Dial", "sd", stable, float((hold["ly"] - wy) / size))   # + = hand went up
                hold["ly"] = wy
            elif (stable in DIALS and abs(wy - hold["ay"]) / size > 0.55
                  and abs(wy - hold["ay"]) > abs(wx - hold["ax"]) and not hold["fired"]):
                hold.update(dial=True, ly=wy)
                shell.call("Dial", "sd", stable, 0.0)
            elif stable not in HOLD:
                pass                                                # dial-only pose (✌), waiting to move
            elif hold["fired"] and stable in REPEAT:
                if now - hold["since"] >= REPEAT[stable]:
                    shell.call("Gesture", "s", stable)
                    hold["since"] = now
                    cooldown_until = now + COOLDOWN
            elif moved > (0.45 if stable == "palm" else 0.35):
                hold.update(since=now, x=wx, y=wy)                 # moving → not a hold, start again
            elif not hold["fired"] and now > cooldown_until:
                progress = min(1.0, (now - hold["since"]) / HOLD[stable])
                if progress >= 1:
                    shell.call("Gesture", "s", stable)
                    hold.update(fired=True, since=now)
                    cooldown_until = now + COOLDOWN
                    progress = 0.0
        elif not fired and stable not in HOLD and stable not in DIALS:
            hold.update(pose=None, dial=False)

        flat = [float(c) for p in pts for c in p]
        mode = "dial" if hold["dial"] else ("pinch" if pinching else "")
        shell.call("Hand", "adsdss", flat, stable or "", float(progress), mode, hint)

    cam.want_open = False
    cam.join(timeout=2)
    shell.call("Lost")
    shell.call("Status", "ss", "off", "")


if __name__ == "__main__":
    main()
