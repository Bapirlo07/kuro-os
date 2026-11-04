#!/usr/bin/env bash
# Kuro OS round 25 — KURO SENSE (NO sudo):
#   · Kuro Sense extension: head-tracked 3D wallpaper, look-aware (pause videos + dim when you look away),
#     Liquid Glass bar / dock / island, music-reactive glow, spatial UI sounds, "Hey Kuro" voice (Super+K)
#   · camera daemon (gestures/kuro-gestures-daemon.py) learns two more jobs: head + look (both OFF until you
#     switch them on: bapirlo-sense head on · bapirlo-sense look on)
#   · kuro-pulse.service (music beat, runs only while something plays) + kuro-voice.service (offline speech,
#     started on first Super+K) — ~/.local/share/bapirlo/voice-venv must exist (faster-whisper base.en)
#   · Kuro Live Wallpaper (head → parallax), Kuro Cosmos aurora (beat + album colour), Kuro Sounds (spatial
#     notification sound) get small hooks
#   · four soft UI sounds in the sound theme · What's New → round 25 (opens once after the next log in)
#   bash ~/bapirlo-os/2500-round25.sh            install
#   bash ~/bapirlo-os/2500-round25.sh restore    take it all out again
# Needs a log out/in once (new shell code). Backup: ~/theme-backups/LATEST-ROUND25
# Keyboard RGB (#6) is separate: sudo bash ~/bapirlo-os/round25/2510-rgb-probe.sh (read-only test first).
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "Run WITHOUT sudo."; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib/ext.sh"
LATEST=~/theme-backups/LATEST-ROUND25
SENSE=bapirlo-sense@bapirlo-os
LIVE=bapirlo-live@bapirlo-os
COSMOS=bapirlo-cosmos@bapirlo-os
SOUNDS=bapirlo-sounds@bapirlo-os
UNITS=~/.config/systemd/user
THEME=$(gsettings get org.gnome.desktop.sound theme-name | tr -d "'")
SND=~/.local/share/sounds/$THEME/stereo

ext_remove() {
  python3 - "$1" <<'PY'
import ast, subprocess, sys
v = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"], capture_output=True, text=True).stdout.strip()
en = [] if v.startswith("@as") else ast.literal_eval(v)
subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str([e for e in en if e != sys.argv[1]])], check=True)
PY
}

# copy one file into an installed extension without ever leaving a half-written file behind
put() { cp "$1" "$2.kuro-new" && mv -f "$2.kuro-new" "$2"; }

# compile an extension's schemas next to it, then swap the result in (a running shell may be reading it)
schemas() {
  local d=$1/schemas tmp
  tmp=$(mktemp -d)
  cp "$d"/*.gschema.xml "$tmp/"
  glib-compile-schemas --strict "$tmp"
  mv -f "$tmp/gschemas.compiled" "$d/gschemas.compiled"
  rm -rf "$tmp"
}

if [ "${1:-}" = restore ]; then
  [ -e "$LATEST" ] || { echo "No round-25 backup at $LATEST"; exit 1; }
  B=$(readlink -f "$LATEST")
  echo "Restoring from $B"
  systemctl --user stop kuro-pulse.service kuro-voice.service 2>/dev/null || true
  rm -f "$UNITS/kuro-pulse.service" "$UNITS/kuro-voice.service"
  systemctl --user daemon-reload
  # camera jobs off (keeps hands / guard as they are)
  . "$HERE/lib/kuro-camera.sh"
  [ -f "$KURO_CAM_CONF" ] && { cam_set head false; cam_set look false; }
  ext_remove $SENSE
  rm -rf "${EXT_DIR:?}/$SENSE"
  dconf reset -f /org/gnome/shell/extensions/bapirlo-sense/
  put "$B/$LIVE/extension.js" "$EXT_DIR/$LIVE/extension.js"
  put "$B/$COSMOS/aurora.js" "$EXT_DIR/$COSMOS/aurora.js"
  put "$B/$SOUNDS/extension.js" "$EXT_DIR/$SOUNDS/extension.js"
  rm -f "$SND"/kuro-window-open.oga "$SND"/kuro-window-close.oga "$SND"/kuro-window-minimize.oga "$SND"/kuro-workspace.oga
  echo "Done — log out/in to unload Kuro Sense. The source changes in ~/bapirlo-os (camera daemon head/look jobs,"
  echo "hooks) stay in git but do nothing without Kuro Sense. The speech model stays in ~/.local/share/bapirlo/voice-venv."
  exit 0
fi

[ -x ~/.local/share/bapirlo/voice-venv/bin/python ] || echo "NOTE: voice-venv missing — voice commands won't work until it's created."

if [ ! -e "$LATEST" ]; then
  BK=~/theme-backups/$(date +%Y%m%d-%H%M%S)-round25
  mkdir -p "$BK/$LIVE" "$BK/$COSMOS" "$BK/$SOUNDS"
  gsettings get org.gnome.shell enabled-extensions > "$BK/enabled-extensions.txt"
  cp "$EXT_DIR/$LIVE/extension.js" "$BK/$LIVE/"
  cp "$EXT_DIR/$COSMOS/aurora.js" "$BK/$COSMOS/"
  cp "$EXT_DIR/$SOUNDS/extension.js" "$BK/$SOUNDS/"
  cp ~/.config/bapirlo/camera.json "$BK/" 2>/dev/null || true
  ln -sfn "$BK" "$LATEST"; echo "backup -> $BK"
fi

echo "== Kuro Sense"
schemas "$HERE/round25/$SENSE"
rm -rf "${EXT_DIR:?}/$SENSE.kuro-new"
cp -rL "$HERE/round25/$SENSE" "$EXT_DIR/$SENSE.kuro-new"
rm -rf "${EXT_DIR:?}/$SENSE"; mv "$EXT_DIR/$SENSE.kuro-new" "$EXT_DIR/$SENSE"
ext_enable $SENSE

echo "== hooks: Live Wallpaper (head) · Cosmos aurora (beat) · Sounds (spatial)"
put "$HERE/live/$LIVE/extension.js" "$EXT_DIR/$LIVE/extension.js"
put "$HERE/round22/$COSMOS/aurora.js" "$EXT_DIR/$COSMOS/aurora.js"
put "$HERE/sounds/$SOUNDS/extension.js" "$EXT_DIR/$SOUNDS/extension.js"
put "$HERE/sounds/$SOUNDS/metadata.json" "$EXT_DIR/$SOUNDS/metadata.json"

echo "== music + voice helpers"
mkdir -p "$UNITS"
cp "$HERE/round25/systemd/kuro-pulse.service" "$HERE/round25/systemd/kuro-voice.service" "$UNITS/"
systemctl --user daemon-reload

echo "== UI sounds"
bash "$HERE/round25/make-sounds.sh"

echo "== camera daemon (new head / look jobs; restarted only if it's running)"
systemctl --user try-restart bapirlo-gestures.service 2>/dev/null || true

rm -f ~/.local/state/bapirlo/whats-new-seen   # What's New opens once after the next log in

echo
echo "Installed. Log out and back in once, then:"
echo "   Liquid Glass + music glow + spatial sounds are on · Super+K = talk to Kuro"
echo "   bapirlo-sense head on   (3D wallpaper follows your head)   ·   bapirlo-sense look on   (look away = pause + dim)"
echo "   bapirlo-sense status · What's New has a switch for each"
echo "Undo: bash ~/bapirlo-os/2500-round25.sh restore"
