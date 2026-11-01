#!/usr/bin/env bash
# Kuro OS round 23 — KURO FLOW (NO sudo):
#   · Kuro Flow extension: window hints (Super+;), command palette (Super+Shift+P), text expander (;key + space),
#     one-key arrange (Super+A), screen watch (Super+Shift+W), meeting mode, text → task (Super+Shift+D),
#     deep search in the overview, Autopilot (suggest-only)
#   · bin/bapirlo-deepsearch + a 30-min idle user timer (local SQLite index of words inside your files)
#   · bin/kuro-files: Files → right-click → Scripts → Kuro rename / convert / resize / zip / merge PDFs / clean photos
#   · bin/bapirlo-autopilot, bin/bapirlo-snippets, bin/bapirlo-flow; Kuro Settings → Snippets page
#   · bapirlo-todo --due + the desk To-do card shows due days (Kuro Desk updated)
#   · Kuro Search exposes its commands to the palette
#   · What's New → rounds 22 + 23 (opens once after the next log in)
#   bash ~/bapirlo-os/2300-round23.sh            install
#   bash ~/bapirlo-os/2300-round23.sh restore    take it all out again
# Needs a log out/in once (new shell code). Backup: ~/theme-backups/LATEST-ROUND23
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "Run WITHOUT sudo."; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib/ext.sh"
LATEST=~/theme-backups/LATEST-ROUND23
FLOW=bapirlo-flow@bapirlo-os
SEARCH=bapirlo-search@bapirlo-os
DESK=bapirlo-desk@bapirlo-os
UNITS=~/.config/systemd/user

ext_remove() {
  python3 - "$1" <<'PY'
import ast, subprocess, sys
v = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"], capture_output=True, text=True).stdout.strip()
en = [] if v.startswith("@as") else ast.literal_eval(v)
subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str([e for e in en if e != sys.argv[1]])], check=True)
PY
}

if [ "${1:-}" = restore ]; then
  [ -e "$LATEST" ] || { echo "No round-23 backup at $LATEST"; exit 1; }
  B=$(readlink -f "$LATEST")
  echo "Restoring from $B"
  systemctl --user disable --now bapirlo-deepsearch.timer 2>/dev/null || true
  rm -f "$UNITS/bapirlo-deepsearch.service" "$UNITS/bapirlo-deepsearch.timer"
  systemctl --user daemon-reload
  "$HERE/bin/kuro-files" uninstall || true
  ext_remove $FLOW
  rm -rf "${EXT_DIR:?}/$FLOW"
  dconf reset -f /org/gnome/shell/extensions/bapirlo-flow/
  [ -f "$B/$SEARCH/extension.js" ] && cp "$B/$SEARCH/extension.js" "$EXT_DIR/$SEARCH/extension.js"
  for f in cards.js stylesheet.css; do
    [ -f "$B/$DESK/$f" ] && cp "$B/$DESK/$f" "$EXT_DIR/$DESK/$f"
  done
  echo "Done — log out/in to unload Kuro Flow. Your snippets (~/.config/bapirlo/snippets.json), the search index"
  echo "(bapirlo-deepsearch forget) and Autopilot's notes (bapirlo-autopilot reset) are kept until you remove them."
  exit 0
fi

if [ ! -e "$LATEST" ]; then
  BK=~/theme-backups/$(date +%Y%m%d-%H%M%S)-round23
  mkdir -p "$BK/$SEARCH" "$BK/$DESK"
  gsettings get org.gnome.shell enabled-extensions > "$BK/enabled-extensions.txt"
  cp "$EXT_DIR/$SEARCH/extension.js" "$BK/$SEARCH/" 2>/dev/null || true
  cp "$EXT_DIR/$DESK/cards.js" "$EXT_DIR/$DESK/stylesheet.css" "$BK/$DESK/" 2>/dev/null || true
  ln -sfn "$BK" "$LATEST"; echo "backup -> $BK"
fi

echo "== Kuro Flow"
glib-compile-schemas "$HERE/round23/$FLOW/schemas"
rm -rf "${EXT_DIR:?}/$FLOW"; cp -rL "$HERE/round23/$FLOW" "$EXT_DIR/"
glib-compile-schemas "$EXT_DIR/$FLOW/schemas"
ext_enable $FLOW

echo "== Kuro Search (commands for the palette) + Kuro Desk (to-do due days)"
cp "$HERE/round16/$SEARCH/extension.js" "$EXT_DIR/$SEARCH/extension.js"
cp "$HERE/desk/$DESK/cards.js" "$HERE/desk/$DESK/stylesheet.css" "$EXT_DIR/$DESK/"

echo "== Files power tools"
"$HERE/bin/kuro-files" install

echo "== Deep search index timer"
mkdir -p "$UNITS"
cp "$HERE/round23/systemd/bapirlo-deepsearch.service" "$HERE/round23/systemd/bapirlo-deepsearch.timer" "$UNITS/"
systemctl --user daemon-reload
systemctl --user enable --now bapirlo-deepsearch.timer

echo "== Snippets file (examples, only if you have none)"
SN=~/.config/bapirlo/snippets.json
if [ ! -f "$SN" ]; then
  mkdir -p "$(dirname "$SN")"
  MAIL=$(git -C "$HERE" config user.email 2>/dev/null || true)
  python3 - "$SN" "$MAIL" <<'PY'
import json, sys
d = {";ty": "Thank you!"}
if sys.argv[2]:
    d[";mail"] = sys.argv[2]
json.dump(d, open(sys.argv[1], "w"), indent=1)
PY
fi

echo
echo "Installed. Log out and back in once, then:"
echo "   Super+;  hints · Super+Shift+P palette · Super+A arrange · Super+Shift+W watch · Super+Shift+D text → task"
echo "   type ;mail then a space in any text box · right-click files → Scripts → Kuro …"
echo "Undo: bash ~/bapirlo-os/2300-round23.sh restore"
