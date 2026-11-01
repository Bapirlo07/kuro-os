#!/usr/bin/env bash
# Kuro OS round 16 (NO sudo — run 1900-round16-install.sh first for Tesseract + the faster boot):
#   1  search actions: sums (=12*7), units (5 km in mi) and Kuro commands in the overview / ArcMenu search
#   2  per-app volume: Control Centre → Sound page → APPS, a slider per app playing sound
#   3  screen time: desk card SCREEN TIME + Kuro Settings → Screen time (counted only on this computer)
#   4  Kuro Settings → Battery: watts in/out, last 24 h, health, 80 % limit, power mode   (runs from the repo)
#   5  a wallpaper per workspace: right-click a workspace number → Own wallpaper… (the colours follow)
#   6  rounded corners on every app + blur behind terminals and Spotify (only those — nothing else blurs)
#   8  four-finger swipes: up Launchpad · down desktop · left radial launcher · right previous window
#  11  Kuro Doctor also runs once a week (still only notifies when something needs you)
#  12  bedtime 23:00 → 07:00: Quiet + Do Not Disturb + warm screen + night wallpaper (Kuro Settings → Modes)
#  13  Super+Shift+T: grab the text in any area of the screen (Tesseract, from 1900)
#   bash ~/bapirlo-os/1910-round16.sh            install
#   bash ~/bapirlo-os/1910-round16.sh restore    take it all out again
# Needs a log out/in once (new extension code). Backup: ~/theme-backups/LATEST-ROUND16
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "Run WITHOUT sudo."; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib/ext.sh"
LATEST=~/theme-backups/LATEST-ROUND16
SEARCH=bapirlo-search@bapirlo-os
DESK=bapirlo-desk@bapirlo-os
CC=bapirlo-control-centre@bapirlo-os
BAR=bapirlo-bar@bapirlo-os
RWC=rounded-window-corners@fxgn
BMS=blur-my-shell@aunetx
BMS_PATH=/org/gnome/shell/extensions/blur-my-shell/
STUDIO_DATA=~/.local/share/bapirlo/theme-studio
UNITS=~/.config/systemd/user
MK=org.gnome.settings-daemon.plugins.media-keys
OCR_KEY=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/bapirlo-ocr/
desk_gs() { gsettings --schemadir "$EXT_DIR/$DESK/schemas" "$@"; }

backup() {
  if [ -e "$LATEST" ]; then echo "backup kept: $(readlink -f "$LATEST")"; return; fi
  local BK=~/theme-backups/$(date +%Y%m%d-%H%M%S)-round16
  mkdir -p "$BK/looks"
  cp -a "$EXT_DIR/$DESK" "$EXT_DIR/$CC" "$EXT_DIR/$BAR" "$BK/"
  gsettings get org.gnome.shell enabled-extensions > "$BK/enabled-extensions.txt"
  dconf dump /org/gnome/shell/extensions/bapirlo-desk/ > "$BK/desk.dconf"
  dconf dump $BMS_PATH > "$BK/blur-my-shell.dconf"
  gsettings get $MK custom-keybindings > "$BK/custom-keybindings.txt"
  find "$STUDIO_DATA" -name 'look.json' -o -name 'original-look*.json' 2>/dev/null | while read -r f; do
    mkdir -p "$BK/looks/$(dirname "${f#"$STUDIO_DATA"/}")"; cp -a "$f" "$BK/looks/${f#"$STUDIO_DATA"/}"
  done
  ln -sfn "$BK" "$LATEST"; echo "backup -> $BK"
}

if [ "${1:-}" = restore ]; then
  BK=$(readlink -f "$LATEST"); [ -d "$BK" ] || { echo "no backup at $LATEST"; exit 1; }
  ext_unenable $SEARCH
  rm -rf "${EXT_DIR:?}/$SEARCH"
  for e in $DESK $CC $BAR; do rm -rf "${EXT_DIR:?}/$e"; cp -a "$BK/$e" "$EXT_DIR/"; done
  [ -d "$BK/looks" ] && cp -a "$BK/looks/." "$STUDIO_DATA/"
  dconf reset -f $BMS_PATH; dconf load $BMS_PATH < "$BK/blur-my-shell.dconf"
  gsettings set org.gnome.shell enabled-extensions "$(cat "$BK/enabled-extensions.txt")"
  gsettings set $MK custom-keybindings "$(cat "$BK/custom-keybindings.txt")"
  dconf reset -f $OCR_KEY
  "$HERE/bin/bapirlo-bedtime" off >/dev/null 2>&1 || true
  systemctl --user disable --now bapirlo-bedtime.timer 2>/dev/null || true
  rm -rf "$UNITS/bapirlo-bedtime.service" "$UNITS/bapirlo-bedtime.timer" "$UNITS/bapirlo-bedtime.timer.d" \
         "$UNITS/bapirlo-doctor.timer.d/weekly.conf"
  systemctl --user daemon-reload
  echo "Round 16 taken out (log out/in to unload the extension code). Screen-time files stay in"
  echo "~/.local/state/bapirlo/screentime — delete that folder if you don't want them."
  exit 0
fi

backup

echo "== 1 search actions"
rm -rf "${EXT_DIR:?}/$SEARCH"; cp -rL "$HERE/round16/$SEARCH" "$EXT_DIR/"
ext_enable $SEARCH

echo "== 2 / 3 / 5 / 8  Control Centre, Desk (screen time, gestures), Bar (workspace wallpaper)"
for pair in "control-centre/$CC" "desk/$DESK" "bar/$BAR"; do
  e=$(basename "$pair")
  rm -rf "${EXT_DIR:?}/$e"; cp -rL "$HERE/$pair" "$EXT_DIR/"
  [ -d "$EXT_DIR/$e/schemas" ] && glib-compile-schemas "$EXT_DIR/$e/schemas"
done
glib-compile-schemas "$HERE/desk/$DESK/schemas"      # the repo copy (test shell) too
add='screentime'
desk_gs set org.gnome.shell.extensions.bapirlo-desk widgets-cards "$(python3 -I -c '
import ast, sys
cur = ast.literal_eval(sys.argv[1].replace("@as ", ""))
print(repr(cur + [c for c in sys.argv[2].split() if c not in cur]))' \
  "$(desk_gs get org.gnome.shell.extensions.bapirlo-desk widgets-cards)" "$add")"
echo "   desk cards now: $(desk_gs get org.gnome.shell.extensions.bapirlo-desk widgets-cards)"
# each wallpaper's saved look brings its own card list back — give them the new card too
find "$STUDIO_DATA" -name 'look.json' -o -name 'original-look*.json' 2>/dev/null | while read -r f; do
  python3 -I - "$f" "$add" <<'PY'
import ast, json, sys
path, new = sys.argv[1], sys.argv[2].split()
d = json.load(open(path))
k = d.get("keys", {})
if "bapirlo-desk/widgets-cards" in k:
    cur = ast.literal_eval(k["bapirlo-desk/widgets-cards"].replace("@as ", ""))
    cur += [c for c in new if c not in cur]
    k["bapirlo-desk/widgets-cards"] = repr(cur)
    json.dump(d, open(path, "w"), indent=1)
PY
done

echo "== 6 rounded corners + blur behind terminals / Spotify only"
if [ -d "$EXT_DIR/$RWC" ] && [ -d "$EXT_DIR/$BMS" ]; then
  for k in overview appfolder lockscreen panel dash-to-dock window-list coverflow-alt-tab screenshot; do
    dconf write "$BMS_PATH$k/blur" false
  done
  dconf write "${BMS_PATH}applications/blur" true
  dconf write "${BMS_PATH}applications/enable-all" false
  dconf write "${BMS_PATH}applications/whitelist" "['Alacritty', 'Spotify', 'spotify', 'kitty', 'com.mitchellh.ghostty']"
  dconf write "${BMS_PATH}applications/opacity" 245
  dconf write "${BMS_PATH}applications/dynamic-opacity" false
  ext_enable $RWC $BMS
  echo "   on (off again: gnome-extensions disable $RWC $BMS)"
else
  echo "   !! Rounded Window Corners / Blur my Shell not installed — skipped"
fi

echo "== 11 / 12  weekly doctor + bedtime"
mkdir -p "$UNITS/bapirlo-doctor.timer.d"
cp "$HERE/round16/systemd/bapirlo-doctor-weekly.conf" "$UNITS/bapirlo-doctor.timer.d/weekly.conf"
cp "$HERE/round16/systemd/bapirlo-bedtime.service" "$HERE/round16/systemd/bapirlo-bedtime.timer" "$UNITS/"
systemctl --user daemon-reload
systemctl --user enable --now bapirlo-bedtime.timer
systemctl --user restart bapirlo-doctor.timer
echo "   $("$HERE/bin/bapirlo-bedtime" | head -1)"
echo "   change it: Kuro Settings → Modes & tools → Bedtime, or bapirlo-bedtime set 23:30 07:30"

echo "== 13 Super+Shift+T grab text"
python3 -I - "$OCR_KEY" "$HERE/bin/bapirlo-capture text" <<'PY'
import ast, subprocess, sys
p, cmd = sys.argv[1], sys.argv[2]
k = "org.gnome.settings-daemon.plugins.media-keys"
cur = subprocess.run(["gsettings", "get", k, "custom-keybindings"], capture_output=True, text=True).stdout.strip()
cur = [] if cur.startswith("@as") else ast.literal_eval(cur)
if p not in cur:
    cur.append(p)
subprocess.run(["gsettings", "set", k, "custom-keybindings", str(cur)], check=True)
s = f"{k}.custom-keybinding:{p}"
for key, val in (("name", "Kuro: grab text from the screen"), ("command", cmd), ("binding", "<Shift><Super>t")):
    subprocess.run(["gsettings", "set", s, key, val], check=True)
PY
command -v tesseract >/dev/null || echo "   (needs Tesseract: bash ~/bapirlo-os/1900-round16-install.sh)"

echo
echo "Done. Log out and back in once (new extension code)."
echo "Undo: bash ~/bapirlo-os/1910-round16.sh restore"
