#!/usr/bin/env bash
# Kuro Air Gestures — one-time setup (no sudo). Re-run safely at any time.
#   bash gestures/setup.sh            install everything (does NOT turn gestures on)
#   bash gestures/setup.sh uninstall  remove what this script added (keeps your gestures.json)
#
# What it does, all inside your home folder:
#   1. a private Python 3.12 (MediaPipe has no wheels for newer Pythons) via uv
#   2. a venv at ~/.local/share/bapirlo/gesture-venv with pinned mediapipe / opencv / jeepney (~650 MB)
#   3. Google's MediaPipe gesture model (8 MB, checksum-verified)
#   4. the GNOME Shell extension + a systemd user service (left OFF)
# Afterwards: log out and back in once, then `bapirlo-gestures on` (or the ✋ button, top left).
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
DATA="$HOME/.local/share/bapirlo"
VENV="$DATA/gesture-venv"
UVBOOT="$DATA/uv-boot"
export UV_PYTHON_INSTALL_DIR="$DATA/uv-python"
MODEL="$DATA/models/gesture_recognizer.task"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task"
MODEL_SHA="97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482"
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
    rm -rf "$EXT_DST" "$VENV" "$MODEL"
    rm -f "$UNIT_DST"
    [[ -L "$HOME/.local/bin/bapirlo-gestures" ]] && rm -f "$HOME/.local/bin/bapirlo-gestures"
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

# 3. model
if [[ -f "$MODEL" ]] && echo "$MODEL_SHA  $MODEL" | sha256sum -c --status; then
    say "Gesture model already there"
else
    say "Downloading the MediaPipe gesture model"
    mkdir -p "$(dirname "$MODEL")"
    curl -fsSL --retry 3 -o "$MODEL.part" "$MODEL_URL"
    echo "$MODEL_SHA  $MODEL.part" | sha256sum -c --status || { rm -f "$MODEL.part"; echo "model checksum mismatch" >&2; exit 1; }
    mv "$MODEL.part" "$MODEL"
fi

# 4. extension + user service (pointed at wherever this repo lives) — left off
say "Installing the shell extension and the user service"
mkdir -p "$(dirname "$EXT_DST")" "$(dirname "$UNIT_DST")"
rm -rf "$EXT_DST"
cp -r "$EXT_SRC" "$EXT_DST"
sed "s#%h/bapirlo-os/#$REPO/#" "$REPO/round17/systemd/$UNIT" > "$UNIT_DST"
systemctl --user daemon-reload
gnome-extensions enable "$UUID" 2>/dev/null || true   # takes effect after the next login
mkdir -p "$HOME/.local/bin"
[[ -e "$HOME/.local/bin/bapirlo-gestures" && ! -L "$HOME/.local/bin/bapirlo-gestures" ]] || ln -sfn "$REPO/bin/bapirlo-gestures" "$HOME/.local/bin/bapirlo-gestures"

cat <<EOF

Kuro Air Gestures is installed (still OFF).
  1. Log out and back in once, so GNOME loads the extension.
  2. Turn it on:  $REPO/bin/bapirlo-gestures on   (or click the ✋ button, top left)
  3. Cheat sheet: bapirlo-gestures help
Remove it again: bash $REPO/gestures/setup.sh uninstall
EOF
