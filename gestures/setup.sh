#!/usr/bin/env bash
# Kuro Air Gestures — one-time setup (no sudo). Re-run safely at any time.
#   bash gestures/setup.sh            install everything (does NOT turn gestures on)
#   bash gestures/setup.sh uninstall  remove what this script added (keeps your gestures.json)
#
# What it does, all inside your home folder:
#   1. a private Python 3.12 (MediaPipe has no wheels for newer Pythons) via uv
#   2. a venv at ~/.local/share/bapirlo/gesture-venv with pinned mediapipe / opencv / jeepney (~650 MB)
#   3. Google's MediaPipe gesture model (8 MB) + face model for the shoulder-surf guard (0.2 MB), checksum-verified
#   4. the GNOME Shell extension + a systemd user service (left OFF)
# Afterwards: log out and back in once, then `bapirlo-gestures on` (or the ✋ button, top left)
# and/or `bapirlo-guard on` (shoulder-surf guard — same camera daemon).
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
DATA="$HOME/.local/share/bapirlo"
VENV="$DATA/gesture-venv"
UVBOOT="$DATA/uv-boot"
export UV_PYTHON_INSTALL_DIR="$DATA/uv-python"
MODEL="$DATA/models/gesture_recognizer.task"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
MODEL_SHA="97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482"
FACE="$DATA/models/blaze_face_short_range.tflite"
FACE_URL="https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
FACE_SHA="b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f"
UUID="bapirlo-gestures@bapirlo-os"
EXT_SRC="$REPO/round17/$UUID"
EXT_DST="$HOME/.local/share/gnome-shell/extensions/$UUID"
UNIT="bapirlo-gestures.service"
UNIT_DST="$HOME/.config/systemd/user/$UNIT"
PKGS=(mediapipe==1.2.0 opencv-python-headless==5.0.0.93 jeepney==0.9.0)

say() { printf '\e[1;31m==>\e[0m %s\n' "$*"; }

if [[ "${1:-}" == "uninstall" ]]; then
    say "Turning gestures off and removing them"
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$EXT_DST" "$VENV" "$MODEL" "$FACE"
    rm -f "$UNIT_DST"
    for b in bapirlo-gestures bapirlo-guard; do
        [[ -L "$HOME/.local/bin/$b" ]] && rm -f "$HOME/.local/bin/$b"
    done
    systemctl --user daemon-reload
    say "Done. Kept: ~/.config/bapirlo/gestures.json and the shared uv / Python in $DATA (other Kuro tools use them)."
    exit 0
fi

for c in curl sha256sum python3 systemctl; do
    command -v "$c" >/dev/null || { echo "missing: $c" >&2; exit 1; }
done
ls /dev/video* >/dev/null 2>&1 || echo "note: no webcam found right now (/dev/video*) — setup continues anyway"

# 1. uv: use the system one if installed, else a private copy (no sudo)
if command -v uv >/dev/null; then
    UV=uv
else
    UV="$UVBOOT/bin/uv"
    if [[ ! -x "$UV" ]]; then
        say "Getting uv (private copy in $UVBOOT)"
        python3 -m venv "$UVBOOT"
        "$UVBOOT/bin/pip" install -q uv
    fi
fi

# 2. Python 3.12 + venv + packages
say "Python 3.12 + venv ($VENV)"
"$UV" python install 3.12
[[ -x "$VENV/bin/python" ]] || "$UV" venv --python 3.12 "$VENV"
say "Installing ${PKGS[*]} (large download the first time)"
"$UV" pip install -q --python "$VENV/bin/python" "${PKGS[@]}"
"$VENV/bin/python" -I -c "import cv2, mediapipe, jeepney" || { echo "package check failed" >&2; exit 1; }

# 3. models
fetch() {   # fetch NAME PATH URL SHA256
    if [[ -f "$2" ]] && echo "$4  $2" | sha256sum -c --status; then
        say "$1 already there"; return
    fi
    say "Downloading the $1"
    mkdir -p "$(dirname "$2")"
    curl -fsSL --retry 3 -o "$2.part" "$3"
    echo "$4  $2.part" | sha256sum -c --status || { rm -f "$2.part"; echo "$1 checksum mismatch" >&2; exit 1; }
    mv "$2.part" "$2"
}
fetch "MediaPipe gesture model" "$MODEL" "$MODEL_URL" "$MODEL_SHA"
fetch "MediaPipe face model" "$FACE" "$FACE_URL" "$FACE_SHA"

# 4. extension + user service (pointed at wherever this repo lives) — left off
say "Installing the shell extension and the user service"
mkdir -p "$(dirname "$EXT_DST")" "$(dirname "$UNIT_DST")"
rm -rf "$EXT_DST"
cp -r "$EXT_SRC" "$EXT_DST"
sed "s#%h/bapirlo-os/#$REPO/#" "$REPO/round17/systemd/$UNIT" > "$UNIT_DST"
systemctl --user daemon-reload
gnome-extensions enable "$UUID" 2>/dev/null || true   # takes effect after the next login
mkdir -p "$HOME/.local/bin"
for b in bapirlo-gestures bapirlo-guard; do
    [[ -e "$HOME/.local/bin/$b" && ! -L "$HOME/.local/bin/$b" ]] || ln -sfn "$REPO/bin/$b" "$HOME/.local/bin/$b"
done

cat <<EOF

Kuro Air Gestures is installed (still OFF).
  1. Log out and back in once, so GNOME loads the extension.
  2. Turn it on:  $REPO/bin/bapirlo-gestures on   (or click the ✋ button, top left)
  3. Cheat sheet: bapirlo-gestures help
  Shoulder-surf guard (optional, same camera): bapirlo-guard on
Remove it again: bash $REPO/gestures/setup.sh uninstall
EOF
