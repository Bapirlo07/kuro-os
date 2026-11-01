#!/usr/bin/env bash
# Kuro OS round 22 — KURO COSMOS (NO sudo):
#   · Kuro Cosmos extension: black-hole close, echo windows, supernova notifications, wormhole workspace
#     switch, time dilation (Super+Shift+Z), breathing desktop, gravity wells (Super+Alt+P), shatter lock,
#     aurora night-sky wallpaper (off until you switch it on), constellation launcher (Super+Shift+Space),
#     Living OS (dock glow / dust, a garden on the wallpaper)
#   · bin/bapirlo-living + a daily user timer: moss on folders untouched for a month (icons only)
#   · Kuro Physics: a hard throw into a screen corner feeds the black hole
#   · Kuro Search: aurora / constellation / tidy / garden / breathe / black hole commands
#   · What's New → round 22 (opens once after the next log in)
#   bash ~/bapirlo-os/2200-round22.sh            install
#   bash ~/bapirlo-os/2200-round22.sh restore    take it all out again (moss icons removed too)
# Needs a log out/in once (new shell code). Backup: ~/theme-backups/LATEST-ROUND22
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "Run WITHOUT sudo."; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib/ext.sh"
LATEST=~/theme-backups/LATEST-ROUND22
COSMOS=bapirlo-cosmos@bapirlo-os
PHYS=bapirlo-physics@bapirlo-os
SEARCH=bapirlo-search@bapirlo-os
UNITS=~/.config/systemd/user

ext_remove() {   # take UUID out of enabled-extensions
  python3 - "$1" <<'PY'
import ast, subprocess, sys
v = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"], capture_output=True, text=True).stdout.strip()
en = [] if v.startswith("@as") else ast.literal_eval(v)
subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str([e for e in en if e != sys.argv[1]])], check=True)
PY
}

if [ "${1:-}" = restore ]; then
  [ -e "$LATEST" ] || { echo "No round-22 backup at $LATEST"; exit 1; }
  B=$(readlink -f "$LATEST")
  echo "Restoring from $B"
  systemctl --user disable --now bapirlo-living.timer 2>/dev/null || true
  rm -f "$UNITS/bapirlo-living.service" "$UNITS/bapirlo-living.timer"
  systemctl --user daemon-reload
  "$HERE/bin/bapirlo-living" clear || true
  ext_remove $COSMOS
  rm -rf "${EXT_DIR:?}/$COSMOS"
  dconf reset -f /org/gnome/shell/extensions/bapirlo-cosmos/
  for e in $PHYS $SEARCH; do
    [ -f "$B/$e/extension.js" ] && cp "$B/$e/extension.js" "$EXT_DIR/$e/extension.js"
  done
  [ -f "$B/whats-new-seen" ] && cp "$B/whats-new-seen" ~/.local/state/bapirlo/whats-new-seen
  echo "Done — log out/in to unload Kuro Cosmos. (The repo files stay; git shows them.)"
  exit 0
fi

# ---------------------------------------------------------------- backup (first run only)
if [ ! -e "$LATEST" ]; then
  BK=~/theme-backups/$(date +%Y%m%d-%H%M%S)-round22
  mkdir -p "$BK"
  gsettings get org.gnome.shell enabled-extensions > "$BK/enabled-extensions.txt"
  for e in $PHYS $SEARCH; do
    mkdir -p "$BK/$e"
    cp "$EXT_DIR/$e/extension.js" "$BK/$e/" 2>/dev/null || true
  done
  cp ~/.local/state/bapirlo/whats-new-seen "$BK/" 2>/dev/null || true
  ln -sfn "$BK" "$LATEST"; echo "backup -> $BK"
fi

echo "== Kuro Cosmos"
glib-compile-schemas "$HERE/round22/$COSMOS/schemas"         # repo copy (test shell) too
rm -rf "${EXT_DIR:?}/$COSMOS"; cp -rL "$HERE/round22/$COSMOS" "$EXT_DIR/"
glib-compile-schemas "$EXT_DIR/$COSMOS/schemas"
ext_enable $COSMOS

echo "== Kuro Physics (corner throw → black hole) + Kuro Search (cosmos commands)"
cp "$HERE/round17/$PHYS/extension.js" "$EXT_DIR/$PHYS/extension.js"
cp "$HERE/round16/$SEARCH/extension.js" "$EXT_DIR/$SEARCH/extension.js"

echo "== Living OS moss timer"
mkdir -p "$UNITS"
cp "$HERE/round22/systemd/bapirlo-living.service" "$HERE/round22/systemd/bapirlo-living.timer" "$UNITS/"
systemctl --user daemon-reload
systemctl --user enable --now bapirlo-living.timer
"$HERE/bin/bapirlo-living" scan || true

echo "== What's New → round 22 (opens once at the next log in)"
python3 -m py_compile "$HERE/whats-new/bapirlo-whats-new" 2>/dev/null || true

echo
echo "Installed. Log out and back in once, then:"
echo "   fling a window into a corner · Super+Shift+Z (hold) · Super+Alt+P · Super+Shift+Space · lock the screen"
echo "   bapirlo-cosmos            what's on / off      bapirlo-cosmos aurora on   the night sky"
echo "Undo: bash ~/bapirlo-os/2200-round22.sh restore"
