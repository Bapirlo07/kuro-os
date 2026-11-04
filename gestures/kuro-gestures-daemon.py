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

Round 21 — one camera, two jobs (~/.config/bapirlo/camera.json → {"hands": bool, "guard": bool}):
  * hands  = the air gestures above (default on, so an old setup keeps working)
  * guard  = Shoulder-surf guard: a second face behind you → Guard(true) → the shell blurs the screen and
    hides notifications until it's gone. A face that never moves for 30 s (a poster, a photo) is learnt and
    ignored — never the biggest face, which is you. Faces are looked for 4×/s on alternating whole picture /
    upper-middle crop (where someone looking over your shoulder stands). Only 5 frames/s are decoded when
    hands are off. Nothing is ever saved or sent anywhere.
The daemon owns org.bapirlo.GesturesCam while hands are on and org.bapirlo.KuroGuardCam while guard is on.

Round 28 — both hands. MediaPipe already looked for two hands; now the second one is used too:
  * the hand view draws both skeletons (Hand2(pts, pose, progress) for the second one)
  * two hands in view for 0.2 s = two-hand mode: one-hand swipes, holds and pinch-clicks pause (so the
    second hand can't set them off by accident); the red dot still follows the first hand
  * 🤏🤏 pinch with BOTH hands, then pull them apart / push together .... Dial("spread", d)  (zoom in / out)
  * ✋✋ both palms held still ........................................... two-palms
  Dropping one hand goes straight back to normal one-hand gestures.

Round 25 — Kuro Sense, two more jobs for the same camera (camera.json "head" / "look", both off by default):
  * head = the biggest face's position → org.bapirlo.Sense.Head(x, y, z) up to 30×/s, for the head-tracked 3D
    wallpaper. x/y -1…1 from where you usually sit (a slow average, so it re-centres if you move your chair),
    mirrored (lean right → x > 0); z = how near (1 = usual). Only sent while it changes.
  * look = are you looking at the screen? → Look(facing, present) on change (after 0.6 s steady) + every 2 s,
    and Point(x, y) = where your head points on the screen (0…1) 5×/s, for look-to-focus. Facing = a face
    whose nose sits between its ears (head turned < ~25°).
  Both use the BlazeFace model the guard uses. The daemon owns org.bapirlo.KuroSenseCam while either is on.
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
CAMCONF = os.path.expanduser("~/.config/bapirlo/camera.json")
FACE_MODEL = os.path.expanduser("~/.local/share/bapirlo/models/blaze_face_short_range.tflite")
MIRROR_FLAG = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "kuro-gestures-mirror")
SHELL = DBusAddress("/org/bapirlo/Gestures", bus_name="org.bapirlo.Gestures", interface="org.bapirlo.Gestures")
SENSE = DBusAddress("/org/bapirlo/Sense", bus_name="org.bapirlo.Sense", interface="org.bapirlo.Sense")
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
GUARD_FPS = 5                            # decode rate when only the guard is on
GUARD_EVERY = 0.25                       # s between face checks
GUARD_CLEAR = 1.5                        # s with no second face before the screen comes back
TWO_ENTER = 0.2                          # s both hands must be seen before two-hand mode starts
TWO_LOST = 0.35                          # s the second hand may vanish before two-hand mode ends
TWO_HOLD = 0.7                           # s both palms held still = two-palms
STATIC_AFTER = 30.0                      # s a face may sit perfectly still before it's taken for a picture
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
        self.owned = set()       # org.bapirlo.GesturesCam / KuroGuardCam — see own()
        self.muted = False       # accuracy test running: show the hand, but don't DO anything

    def own(self, name, want):
        """Hold or let go of a bus name (so the shell knows which camera jobs are running)."""
        have = name in self.owned
        if want == have:
            return
        try:
            if want:
                self.conn.send_and_get_reply(message_bus.RequestName(name, 4), timeout=2)
                self.owned.add(name)
            else:
                self.conn.send_and_get_reply(message_bus.ReleaseName(name), timeout=2)
                self.owned.discard(name)
        except Exception as e:
            log(f"name {name}: {e}")

    def call(self, method, sig=None, *args, to=SHELL):
        if self.muted and to is SHELL:
            if method in ("Gesture", "Dial"):
                return
            if method == "Pointer":
                args = (args[0], args[1], False, args[3])     # no clicks / drags during the test
        try:
            msg = new_method_call(to, method, sig, args) if sig else new_method_call(to, method)
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


class Modes:
    """~/.config/bapirlo/camera.json, checked once a second. No file = hands on, guard off."""
    def __init__(self):
        self.hands, self.guard, self.mtime, self.checked = True, False, -1, 0.0
        self.head = self.look = False
        self.refresh(force=True)

    def refresh(self, force=False):
        now = time.monotonic()
        if not force and now - self.checked < 1:
            return
        self.checked = now
        try:
            m = os.stat(CAMCONF).st_mtime
        except OSError:
            m = None
        if m == self.mtime:
            return
        self.mtime = m
        try:
            with open(CAMCONF) as f:
                d = json.load(f)
        except Exception:
            d = {}
        self.hands, self.guard = bool(d.get("hands", True)), bool(d.get("guard", False))
        self.head, self.look = bool(d.get("head", False)), bool(d.get("look", False))
        log(f"modes: hands={self.hands} guard={self.guard} head={self.head} look={self.look}")

    @property
    def any(self):
        return self.hands or self.guard or self.head or self.look


class Guard:
    """Shoulder-surf guard: two or more live faces → on; under two for GUARD_CLEAR s → off."""
    CROPS = ((0, 0, 1, 1), (0.15, 0.0, 0.85, 0.62))

    def __init__(self, shell):
        self.shell = shell
        self.det = None
        self.last = 0.0
        self.turn = 0
        self.hist = collections.deque(maxlen=3)
        self.on = False
        self.clear_since = None
        self.sent_t = 0.0
        self.tracks = []          # [cx, cy, w, first_seen, last_seen] — anchors for "has this face moved?"
        self.recent = collections.deque(maxlen=2)   # face lists from the last whole + crop pass

    def _detector(self):
        if self.det is None:
            opts = vision.FaceDetectorOptions(base_options=BaseOptions(model_asset_path=FACE_MODEL),
                                              min_detection_confidence=0.55)
            self.det = vision.FaceDetector.create_from_options(opts)
        return self.det

    def _faces(self, frame, lut, box):
        h, w = frame.shape[:2]
        x0, y0, x1, y1 = box
        crop = frame[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
        crop = cv2.resize(crop, (INFER_W, int(INFER_W * crop.shape[0] / max(1, crop.shape[1]))),
                          interpolation=cv2.INTER_AREA)
        if lut is not None:
            crop = cv2.LUT(crop, lut)
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
        ch, cw = crop.shape[:2]
        out = []
        for d in self._detector().detect(img).detections:
            b = d.bounding_box
            cx = x0 + (b.origin_x + b.width / 2) / cw * (x1 - x0)
            cy = y0 + (b.origin_y + b.height / 2) / ch * (y1 - y0)
            out.append((cx, cy, b.width / cw * (x1 - x0)))
        return out

    def _live(self, faces, now):
        """Drop faces that have sat perfectly still for STATIC_AFTER s (pictures) — never the biggest one."""
        if not faces:
            return []
        biggest = max(faces, key=lambda f: f[2])
        live = []
        for f in faces:
            tr = next((t for t in self.tracks if abs(f[0] - t[0]) < 0.015 and abs(f[1] - t[1]) < 0.015
                       and abs(f[2] - t[2]) < 0.015), None)
            if tr:
                tr[4] = now
            else:
                tr = [f[0], f[1], f[2], now, now]
                self.tracks.append(tr)
            if f is biggest or now - tr[3] < STATIC_AFTER:
                live.append(f)
        self.tracks = [t for t in self.tracks if now - t[4] < 5]
        return live

    def _send(self, on, now):
        self.on, self.sent_t = on, now
        self.shell.call("Guard", "b", on)

    def reset(self):
        if self.on:
            self._send(False, time.monotonic())
        self.hist.clear()
        self.recent.clear()
        self.clear_since = None

    def step(self, frame, lut, now):
        if now - self.last < GUARD_EVERY:
            return
        self.last = now
        self.turn += 1
        try:
            faces = self._faces(frame, lut, self.CROPS[self.turn % 2])
        except Exception as e:
            log(f"guard: {e}")
            return
        self.recent.append(faces)
        # merge the two passes: the crop finds small far faces, the whole picture finds big near ones
        merged = []
        for f in (x for fs in self.recent for x in fs):
            if not any(abs(f[0] - g[0]) < 0.05 and abs(f[1] - g[1]) < 0.06 for g in merged):
                merged.append(f)
        n = len(self._live(merged, now))
        self.hist.append(n >= 2)
        if not self.on:
            if sum(self.hist) >= 2:
                self.clear_since = None
                self._send(True, now)
        elif n >= 2:
            self.clear_since = None
        else:
            self.clear_since = self.clear_since or now
            if now - self.clear_since > GUARD_CLEAR:
                self.hist.clear()
                self._send(False, now)
        if self.on and now - self.sent_t > 3:      # say it again now and then, in case the shell restarted
            self._send(True, now)


class Face:
    """Kuro Sense: head position (job "head") and "looking at the screen?" (job "look") from the biggest face."""
    HEAD_EVERY = 1 / 30
    LOOK_EVERY = 0.2
    SPAN = 0.22            # face-centre travel (fraction of the picture) that counts as a full lean

    def __init__(self, shell):
        self.shell = shell
        self.det = None
        self.last = 0.0
        self.base = None               # [cx, cy, w] — where you usually sit (slow average)
        self.fx, self.fy = OneEuro(min_cutoff=0.8, beta=3.0), OneEuro(min_cutoff=0.8, beta=3.0)
        self.sent_head = (9.0, 9.0, 9.0)
        self.sent_head_t = 0.0
        self.facing = True
        self.cand, self.cand_since = True, 0.0
        self.sent_look_t = 0.0
        self.last_point = 0.0
        self.yaw_s = 0.0

    def _detector(self):
        if self.det is None:
            opts = vision.FaceDetectorOptions(base_options=BaseOptions(model_asset_path=FACE_MODEL),
                                              min_detection_confidence=0.5)
            self.det = vision.FaceDetector.create_from_options(opts)
        return self.det

    def reset(self):
        """Job switched off / screen locked: tell the shell 'looking' so nothing stays dimmed."""
        if not self.facing:
            self.shell.call("Look", "bb", True, True, to=SENSE)
        self.facing = self.cand = True
        self.fx.reset(), self.fy.reset()

    def step(self, frame, lut, now, head_on, look_on):
        if now - self.last < (self.HEAD_EVERY if head_on else self.LOOK_EVERY):
            return
        self.last = now
        small = cv2.resize(frame, (INFER_W, INFER_H), interpolation=cv2.INTER_AREA)
        if lut is not None:
            small = cv2.LUT(small, lut)
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
        try:
            dets = self._detector().detect(img).detections
        except Exception as e:
            log(f"face: {e}")
            return
        face = max(dets, key=lambda d: d.bounding_box.width, default=None)
        present = face is not None
        yaw = None
        if present:
            b = face.bounding_box
            cx, cy, w = (b.origin_x + b.width / 2) / INFER_W, (b.origin_y + b.height / 2) / INFER_H, b.width / INFER_W
            kp = face.keypoints   # right eye, left eye, nose tip, mouth, right ear, left ear (image coords 0…1)
            if len(kp) >= 6:
                ear_mid = (kp[4].x + kp[5].x) / 2
                ear_d = abs(kp[5].x - kp[4].x) or 1e-3
                yaw = (kp[2].x - ear_mid) / ear_d
                self.yaw_s = 0.7 * self.yaw_s + 0.3 * yaw
            if self.base is None:
                self.base = [cx, cy, w]
            else:                                     # ~20 s to re-centre
                a = 0.0017 if head_on else 0.01
                self.base = [self.base[0] + (cx - self.base[0]) * a, self.base[1] + (cy - self.base[1]) * a,
                             self.base[2] + (w - self.base[2]) * a]
            if head_on:
                hx = self.fx(max(-1.5, min(1.5, -(cx - self.base[0]) / self.SPAN)), now)
                hy = self.fy(max(-1.5, min(1.5, (cy - self.base[1]) / self.SPAN)), now)
                hz = w / max(self.base[2], 1e-3)
                if max(abs(hx - self.sent_head[0]), abs(hy - self.sent_head[1])) > 0.004 or now - self.sent_head_t > 0.4:
                    self.shell.call("Head", "ddd", float(hx), float(hy), float(hz), to=SENSE)
                    self.sent_head, self.sent_head_t = (hx, hy, hz), now
        if not look_on:
            return
        facing_now = present and (yaw is None or abs(self.yaw_s) < (0.30 if self.facing else 0.22))
        if facing_now != self.cand:
            self.cand, self.cand_since = facing_now, now
        changed = self.cand != self.facing and now - self.cand_since > 0.6
        if changed:
            self.facing = self.cand
        if changed or now - self.sent_look_t > 2:
            self.shell.call("Look", "bb", self.facing, present, to=SENSE)
            self.sent_look_t = now
        if present and yaw is not None and now - self.last_point > 0.2 and self.base is not None:
            b = face.bounding_box
            cy = (b.origin_y + b.height / 2) / INFER_H
            px = 0.5 - self.yaw_s * 1.6 - (cx - self.base[0]) * 1.2
            py = 0.5 + (cy - self.base[1]) * 2.0
            self.shell.call("Point", "dd", float(max(0, min(1, px))), float(max(0, min(1, py))), to=SENSE)
            self.last_point = now


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
        self.idle_fps = IDLE_FPS
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
            if not self.tracking and t - last_decode < 1 / self.idle_fps - 0.01:
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


# ---------------------------------------------------------------- round 27: reading the hand in 3-D
# MediaPipe also gives the 21 points in real-world metres around the hand's centre (hand_world_landmarks).
# Joint ANGLES from those don't change when the hand tilts, turns or comes closer — unlike the old 2-D
# distance ratios, which misread a tilted palm as a fist or a sideways pinch as open.
FINGER_CHAINS = ((5, 6, 7, 8), (9, 10, 11, 12), (13, 14, 15, 16), (17, 18, 19, 20))   # index … pinky
DEFAULT_CAL = {"ext": [65, 65, 70, 75], "curl": [115, 115, 115, 110],   # total bend (°): straight < ext, curled > curl
               "thumb_out": 0.85, "thumb_in": 0.70,                    # thumb tip ↔ pinky knuckle / palm length
               "thumb_tuck": 0.30,                                     # thumb tip lying on the curled fingers
               "pinch_on": 0.30, "pinch_off": 0.45}                    # thumb tip ↔ index tip / palm length (3-D)
DEBUG_FLAG = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "kuro-gestures-debug")
DEBUG_LOG = DEBUG_FLAG + ".jsonl"


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _angle(u, v):
    nu = math.sqrt(u[0] ** 2 + u[1] ** 2 + u[2] ** 2) or 1e-9
    nv = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) or 1e-9
    c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def dist3(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)


def hand_features(w):
    """From the 3-D points: bend of each finger (°, MCP counted half), thumb reach and pinch, both ÷ palm length."""
    palm = dist3(w[0], w[9]) or 1e-3
    bends = []
    for m, p, d, t in FINGER_CHAINS:
        b = 0.5 * _angle(_sub(w[m], w[0]), _sub(w[p], w[m]))
        b += _angle(_sub(w[p], w[m]), _sub(w[d], w[p]))
        b += _angle(_sub(w[d], w[p]), _sub(w[t], w[d]))
        bends.append(b)
    thumb_bend = _angle(_sub(w[3], w[2]), _sub(w[4], w[3]))
    thumb_reach = dist3(w[4], w[17]) / palm          # across the palm to the pinky knuckle: big only when it's out
    thumb_tuck = min(dist3(w[4], w[j]) for j in (6, 7, 10, 11)) / palm   # resting on curled fingers (fist)
    pinch = dist3(w[4], w[8]) / palm
    return {"bends": bends, "thumb_bend": thumb_bend, "thumb_reach": thumb_reach, "thumb_tuck": thumb_tuck,
            "pinch": pinch}


def geo_fingers(feat, cal):
    """Each finger straight (True), curled (False) or in between (None); thumb the same."""
    out = []
    for b, e, c in zip(feat["bends"], cal["ext"], cal["curl"]):
        out.append(True if b < e else (False if b > c else None))
    r, tuck = feat["thumb_reach"], feat["thumb_tuck"]
    if r > cal["thumb_out"] and tuck > cal["thumb_tuck"] and feat["thumb_bend"] < 60:
        thumb = True
    elif r < cal["thumb_in"] or tuck < cal["thumb_tuck"] * 0.8:
        thumb = False
    else:
        thumb = None
    return thumb, out


def geo_pose(feat, cal, p2d):
    """The pose the joint angles say (or None)."""
    thumb, (i, m, r, k) = geo_fingers(feat, cal)
    four = (i, m, r, k)
    if all(x is True for x in four):
        return "palm"
    if all(x is False for x in four):
        if thumb is True:
            # up or down is about gravity, so this part uses the picture: thumb tip above / below its base
            vx, vy = p2d[4][0] - p2d[2][0], p2d[4][1] - p2d[2][1]
            if math.hypot(vx, vy) < 0.25 * (dist(p2d[0], p2d[9]) or 1e-3):
                return None                   # thumb pointing at the camera: can't tell up from down
            tilt = math.degrees(math.atan2(abs(vx), -vy))   # 0 = straight up, 180 = straight down
            if tilt < 50:
                return "thumb-up"
            if tilt > 130:
                return "thumb-down"
            return None                       # thumb sideways
        return "fist" if thumb is False else None
    if i is True and m is True and r is False and k is False:
        return "victory"
    if i is True and k is True and m is False and r is False:
        return "rock"          # thumb in or out: the model's "ILoveYou" (🤟) is rock too — air-draw uses it
    if thumb is True and k is True and i is False and m is False and r is False:
        return "shaka"
    if i is True and m is False and r is False and k is False:
        return "point"
    return None


class PoseVote:
    """Model + joint angles vote every frame; votes fade (half-life 0.12 s). A pose has to clearly win to become
    the pose, and the current one is kept until another clearly beats it — no flicker between frames."""
    HALF = 0.12

    def __init__(self):
        self.w = collections.defaultdict(float)
        self.t = None
        self.stable = None

    def clear(self):
        self.w.clear()
        self.t = None
        self.stable = None

    def add(self, t, model_pose, model_score, geo):
        if self.t is not None:
            k = 0.5 ** (max(0.0, t - self.t) / self.HALF)
            for p in list(self.w):
                self.w[p] *= k
        self.t = t
        if model_pose and model_score >= 0.4:
            self.w[model_pose] += model_score
        if geo:
            self.w[geo] += 1.2 if geo == "shaka" else 0.9      # the model has no shaka class
            if geo == model_pose:
                self.w[geo] += 0.3
        if not geo and not (model_pose and model_score >= 0.4):
            self.w["-"] += 1.0
        ranked = sorted(self.w.items(), key=lambda kv: kv[1], reverse=True)
        best, bw = ranked[0]
        second = ranked[1][1] if len(ranked) > 1 else 0.0
        cur = self.w.get(self.stable or "-", 0.0)
        if best != (self.stable or "-"):
            if bw >= 2.0 and bw > 1.6 * max(second, 0.01) and bw > 1.6 * cur:
                self.stable = None if best == "-" else best
        elif bw < 0.8:
            self.stable = None
        return self.stable


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


CLAHE = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))


def enhance(img, lut, dark):
    """Brighten a dim picture (gamma) and, in real darkness, pull the hand's edges out (local contrast)."""
    if lut is not None:
        img = cv2.LUT(img, lut)
    if dark:
        ycc = cv2.cvtColor(img, cv2.COLOR_BGR2YCrCb)
        ycc[:, :, 0] = CLAHE.apply(ycc[:, :, 0])
        img = cv2.cvtColor(ycc, cv2.COLOR_YCrCb2BGR)
    return img


class View:
    """One MediaPipe tracker over one part of the camera picture (whole, or the zoomed middle).
    Looks for up to two hands so a second hand coming into view can't steal the one being followed."""
    def __init__(self, box, sens):
        c = 0.35 if sens == "high" else 0.45
        opts = vision.GestureRecognizerOptions(base_options=BaseOptions(model_asset_path=MODEL),
                                               running_mode=vision.RunningMode.VIDEO, num_hands=2,
                                               min_hand_detection_confidence=c, min_hand_presence_confidence=c,
                                               min_tracking_confidence=c)
        self.rec = vision.GestureRecognizer.create_from_options(opts)
        self.box = box
        self.ts = 0

    def run(self, frame, t, lut, dark=False, full=False):
        """full = feed the crop at camera resolution (sharper hand points while tracking); otherwise the small
        INFER_W×INFER_H copy (faster while only searching). Returns [(pts2d, world3d, gesture, score)]."""
        h, w = frame.shape[:2]
        x0, y0, x1, y1 = self.box
        crop = frame[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
        if not full:
            crop = cv2.resize(crop, (INFER_W, INFER_H), interpolation=cv2.INTER_AREA)
        crop = enhance(crop, lut, dark)
        self.ts = max(self.ts + 1, int(t * 1000))
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
        res = self.rec.recognize_for_video(img, self.ts)
        if not res.hand_landmarks:
            return []
        hands = []
        for i, lm in enumerate(res.hand_landmarks):
            # back to whole-picture coordinates, mirrored so it matches what you see (left is left)
            pts = [(1 - (x0 + l.x * (x1 - x0)), y0 + l.y * (y1 - y0)) for l in lm]
            world = None
            if res.hand_world_landmarks and i < len(res.hand_world_landmarks):
                world = [(l.x, l.y, l.z) for l in res.hand_world_landmarks[i]]
            g, s = "None", 0.0
            if res.gestures and i < len(res.gestures) and res.gestures[i]:
                g, s = res.gestures[i][0].category_name, res.gestures[i][0].score
            hands.append((pts, world, g, s))
        return hands


def pick_hand(hands, prev_wrist):
    """The hand we were following (nearest wrist), or the biggest = nearest the camera."""
    if not hands:
        return None
    if prev_wrist is not None:
        near = min(hands, key=lambda h: dist(h[0][0], prev_wrist))
        if dist(near[0][0], prev_wrist) < 0.25:
            return near
    return max(hands, key=lambda h: dist(h[0][0], h[0][9]))


def pick_second(hands, first):
    """The other hand (biggest of the rest). MediaPipe sometimes reports one hand twice, so anything sitting
    on top of the first hand doesn't count."""
    others = [h for h in hands if h is not first
              and dist(h[0][0], first[0][0]) > 0.08 and dist(h[0][9], first[0][9]) > 0.08]
    return max(others, key=lambda h: dist(h[0][0], h[0][9])) if others else None


def hand_pose(pts, world, gname, gscore, cal, vote, ft):
    """Model + 3-D joint angles vote on the pose (2-D finger counting only without 3-D points).
    Returns (stable pose, 3-D features or None, model pose, geometric pose)."""
    model_pose = POSES.get(gname)
    if world:
        feat = hand_features(world)
        geo = geo_pose(feat, cal, pts)
    else:
        feat = None
        f = fingers(pts)
        geo = "shaka" if is_shaka(pts, f) else finger_pose(f)
    return vote.add(ft, model_pose, gscore, geo), feat, model_pose, geo


def pinch_dist(pts, feat):
    return feat["pinch"] if feat else dist(pts[4], pts[8]) / (dist(pts[0], pts[9]) or 1e-3) * 0.75


def load_cal(conf):
    cal = dict(DEFAULT_CAL)
    for k, v in (conf.get("calibration") or {}).items():
        if k in cal and type(v) is type(cal[k]) and (not isinstance(v, list) or len(v) == 4):
            cal[k] = v
    return cal


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
    modes = Modes()
    guard = Guard(shell)
    face = Face(shell)
    hands_on = None                # last applied hands mode (None = not yet)
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
    vote = PoseVote()
    vote2 = PoseVote()             # the second hand's pose
    # two-hand mode: first = when the 2nd hand appeared, seen = last time it was seen, p1/p2 = pinch states,
    # spread = distance between the two pinch points last frame, hold = when ✋✋ started
    two = {"first": None, "seen": 0.0, "p1": False, "p2": False, "spread": None, "hold": None, "fired": False,
           "anchor": None, "drawn": False}
    cal = load_cal(conf)
    prev_wrist = None
    ptr_hist = collections.deque()  # (t, tx, ty) raw pointer targets, for the click lock
    pinch_off = (0.0, 0.0)          # pointer offset held during a pinch, so pinching never moves the dot
    release_until = 0.0
    release_pos = (0.5, 0.5)
    debug_on, debug_t, debug_f = False, 0.0, None
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
        nonlocal pinching, pending, prev_wrist
        prev_wrist = None
        pinching = False
        pending = None
        fx.reset(), fy.reset()
        wrist.clear()
        vote.clear()
        ptr_hist.clear()
        hold.update(pose=None, dial=False)
        cam.tracking = False
        vote2.clear()
        two.update(first=None, p1=False, p2=False, spread=None, hold=None, fired=False, anchor=None, drawn=False)

    while running:
        modes.refresh()
        shell.own("org.bapirlo.GesturesCam", modes.hands)
        shell.own("org.bapirlo.KuroGuardCam", modes.guard)
        shell.own("org.bapirlo.KuroSenseCam", modes.head or modes.look)
        if not modes.guard:
            guard.reset()
        if not modes.look:
            face.reset()
        if hands_on != modes.hands:
            if hands_on:                                  # hands just switched off
                shell.call("Lost")
                reset_hand()
                shell.call("Status", "ss", "off", "")
            hands_on = modes.hands
        cam.idle_fps = 30 if modes.head else (IDLE_FPS if modes.hands else GUARD_FPS)
        if not modes.any:                                 # nothing to do (bapirlo-* stops the service soon)
            cam.want_open = False
            time.sleep(0.5)
            continue

        if conf.refresh():
            cal = load_cal(conf)
            if conf.get("sensitivity", "normal") != sens:
                sens = conf.get("sensitivity", "normal")
                views = [View((0, 0, 1, 1), sens), View(ZOOM_BOX, sens)]

        if lock.locked:
            if not paused:
                paused = True
                cam.want_open = False
                shell.call("Lost")
                reset_hand()
                guard.reset()
                face.reset()
                set_status("paused", "Screen locked — camera off")
            time.sleep(0.5)
            continue
        if paused or not cam.want_open:
            paused = False
            cam.want_open = True
        if cam.state == "failed" and modes.hands:
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
        dim = luma < 55                            # local-contrast boost below this
        lut = None
        if luma < 90:
            g = round(max(0.45, min(1.0, (luma / 90) ** 0.8)), 2)
            if g not in lut_cache:
                lut_cache[g] = np.array([((i / 255) ** g) * 255 for i in range(256)], np.uint8)
            lut = lut_cache[g]

        if modes.guard:
            guard.step(frame, lut, now)
        if modes.head or modes.look:
            face.step(frame, lut, now, modes.head, modes.look)
        if not modes.hands:
            continue

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
        # searching: the small fast picture; tracking: full camera resolution = sharper, steadier hand points
        hands = views[vi].run(frame, ft, lut, dim, full=not idle)
        res = pick_hand(hands, prev_wrist)
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

        pts, world, gname, gscore = res
        prev_wrist = pts[0]
        if idle:
            hand_since = now
            view_i = vi
        hand_seen = now
        cam.tracking = True
        size = dist(pts[0], pts[9])                # wrist → middle knuckle: how big (close) the hand is

        # second hand → two-hand mode after TWO_ENTER s; ends TWO_LOST s after the second hand goes
        sec = pick_second(hands, res)
        if sec is not None:
            two["seen"] = now
            if two["first"] is None:
                two["first"] = now
        elif two["first"] is not None and now - two["seen"] > TWO_LOST:
            vote2.clear()
            two.update(first=None, p1=False, p2=False, spread=None, hold=None, fired=False, anchor=None)
            if two["drawn"]:
                shell.call("Hand2", "adsd", [], "", 0.0)
                two["drawn"] = False
            wrist.clear()                          # the hand that stays mustn't count as a swipe
            hand_since = now
        two_on = two["first"] is not None and now - two["first"] >= TWO_ENTER

        # pose: the model and the 3-D joint angles both vote (PoseVote); old 2-D finger counting only if
        # MediaPipe gave no 3-D points
        stable, feat, model_pose, geo = hand_pose(pts, world, gname, gscore, cal, vote, ft)

        # pinch (3-D thumb↔index distance, so it works with the hand turned), with hysteresis, never while
        # making a fist / thumbs / shaka pose
        was_pinching = pinching
        pd = pinch_dist(pts, feat)
        if stable in ("fist", "thumb-up", "thumb-down", "shaka") or two_on:
            pinching = False                       # two hands: pinches zoom instead of clicking
        else:
            pinching = pd < cal["pinch_on"] if not pinching else pd < cal["pinch_off"]

        # pointer: index tip (or the pinch point). The box that maps to the whole screen shrinks when
        # you're further away, so you never have to reach far.
        px = (pts[4][0] + pts[8][0]) / 2 if pinching else pts[8][0]
        py = (pts[4][1] + pts[8][1]) / 2 if pinching else pts[8][1]
        bw = min(0.66, max(0.30, size * 4.2))
        bh = bw * 1.05
        cx, cy = 0.5, 0.44
        tx = min(1, max(0, (px - (cx - bw / 2)) / bw))
        ty = min(1, max(0, (py - (cy - bh / 2)) / bh))
        # click lock: closing a pinch drags the index tip a little, and the dot switches to the pinch point.
        # Both would make a click land off target — so at the moment the pinch closes, the dot goes back to
        # where it was ~0.12 s earlier (before the fingers moved) and the pinch keeps that offset while you
        # carry. Opening the pinch holds the dot still for 0.15 s for the same reason.
        ptr_hist.append((ft, tx, ty))
        while ptr_hist and ft - ptr_hist[0][0] > 0.4:
            ptr_hist.popleft()
        if pinching and not was_pinching:
            before = next((h for h in reversed(ptr_hist) if ft - h[0] >= 0.12), ptr_hist[0])
            pinch_off = (before[1] - tx, before[2] - ty)
        elif not pinching and was_pinching:
            release_until = ft + 0.15
            release_pos = (min(1, max(0, tx + pinch_off[0])), min(1, max(0, ty + pinch_off[1])))
            pinch_off = (0.0, 0.0)
        if pinching:
            tx, ty = min(1, max(0, tx + pinch_off[0])), min(1, max(0, ty + pinch_off[1]))
        elif ft < release_until:
            tx, ty = release_pos
        if pinching != was_pinching:                       # jump straight there, no smoothing lag
            fx.reset(), fy.reset()
        sx, sy = fx(tx, ft), fy(ty, ft)
        shell.call("Pointer", "ddbs", float(sx), float(sy), bool(pinching), stable or "")

        # accuracy test / calibration (bapirlo-gestures test): one line per frame while the flag file exists
        if now - debug_t > 1:
            debug_t = now
            try:   # the test keeps touching the flag; a stale one (test crashed) never leaves gestures muted
                want = time.time() - os.stat(DEBUG_FLAG).st_mtime < 20
            except OSError:
                want = False
            if want and not debug_on:
                debug_f = open(DEBUG_LOG, "a", buffering=1)
            elif not want and debug_on and debug_f:
                debug_f.close()
                debug_f = None
            debug_on = want
            shell.muted = want
        if debug_on and debug_f:
            debug_f.write(json.dumps({"t": round(ft, 3), "model": model_pose, "score": round(gscore, 2),
                                      "geo": geo, "stable": stable, "pinch": bool(pinching), "hands": len(hands), "two": bool(two_on),
                                      "p2d": [[round(x, 4), round(y, 4)] for x, y in pts],
                                      "feat": {k: (round(v, 3) if isinstance(v, float) else [round(x, 1) for x in v])
                                               for k, v in feat.items()} if feat else None}) + "\n")

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

        # two hands: draw the second one, and do two-hand gestures instead of the one-hand ones
        if two_on:
            flat = [float(c) for p in pts for c in p]
            progress, mode = 0.0, "two"
            if sec is not None:
                pts2, world2, g2, s2 = sec
                stable2, feat2, _, _ = hand_pose(pts2, world2, g2, s2, cal, vote2, ft)
                size2 = dist(pts2[0], pts2[9]) or 1e-3
                pd2 = pinch_dist(pts2, feat2)
                two["p1"] = pd < (cal["pinch_off"] if two["p1"] else cal["pinch_on"]) and stable != "fist"
                two["p2"] = pd2 < (cal["pinch_off"] if two["p2"] else cal["pinch_on"]) and stable2 != "fist"

                # 🤏🤏 pinch both, pull apart / push together = zoom dial
                if two["p1"] and two["p2"]:
                    c1 = ((pts[4][0] + pts[8][0]) / 2, (pts[4][1] + pts[8][1]) / 2)
                    c2 = ((pts2[4][0] + pts2[8][0]) / 2, (pts2[4][1] + pts2[8][1]) / 2)
                    d = dist(c1, c2)
                    if two["spread"] is None:
                        two["spread"] = d
                        shell.call("Dial", "sd", "spread", 0.0)
                    else:
                        delta = (d - two["spread"]) / ((size + size2) / 2)   # + = hands moved apart
                        if abs(delta) > 0.015:
                            shell.call("Dial", "sd", "spread", float(delta))
                            two["spread"] = d
                    mode = "dial"
                    two["hold"] = None
                else:
                    two["spread"] = None

                # ✋✋ both palms still = two-palms
                if mode != "dial" and stable == "palm" and stable2 == "palm":
                    anchor = (pts[0][0], pts[0][1], pts2[0][0], pts2[0][1])
                    if two["hold"] is None:
                        two.update(hold=now, anchor=anchor)
                    moved = max(math.hypot(anchor[0] - two["anchor"][0], anchor[1] - two["anchor"][1]),
                                math.hypot(anchor[2] - two["anchor"][2], anchor[3] - two["anchor"][3]))
                    if moved / ((size + size2) / 2) > 0.45:
                        two.update(hold=now, anchor=anchor)            # moving → start again
                    elif not two["fired"] and now > cooldown_until:
                        progress = min(1.0, (now - two["hold"]) / TWO_HOLD)
                        if progress >= 1:
                            shell.call("Gesture", "s", "two-palms")
                            two["fired"] = True
                            cooldown_until = now + COOLDOWN
                            progress = 0.0
                elif mode != "dial":
                    two.update(hold=None, fired=False)

                shell.call("Hand2", "adsd", [float(c) for p in pts2 for c in p], stable2 or "", float(progress))
                two["drawn"] = True
            # one-hand gestures start fresh when the second hand goes
            hold.update(pose=None, dial=False)
            pending = None
            shell.call("Hand", "adsdss", flat, stable or "", float(progress), mode, hint)
            continue

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
    guard.reset()
    face.reset()
    shell.call("Lost")
    shell.call("Status", "ss", "off", "")


if __name__ == "__main__":
    main()
