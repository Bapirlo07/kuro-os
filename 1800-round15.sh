#!/usr/bin/env bash
# Kuro OS round 15 (NO sudo):
#   · Kuro Ruler: Super+Shift+M — crosshair + pointer position, drag a box to measure it (size copied)
#   · Kuro Settings: every Kuro extension on/off + its settings, modes & tools, recent colours, and an
#     Undo list of every backup with its restore command  (app grid: "Kuro Settings")
#   bash ~/bapirlo-os/1800-round15.sh            install
#   bash ~/bapirlo-os/1800-round15.sh restore    take it out again
# The ruler needs a log out/in once (new extension code). Backup: ~/theme-backups/LATEST-ROUND15
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "Run WITHOUT sudo."; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib/ext.sh"
LATEST=~/theme-backups/LATEST-ROUND15
RULER=bapirlo-ruler@bapirlo-os
DESKTOP=~/.local/share/applications/os.bapirlo.Settings.desktop
ICON=~/.local/share/icons/Bapirlo/scalable/apps/bapirlo-settings.svg

ext_remove() {   # take UUID out of enabled-extensions
  python3 - "$1" <<'PY'
import ast, subprocess, sys
v = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"], capture_output=True, text=True).stdout.strip()
en = [] if v.startswith("@as") else ast.literal_eval(v)
subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str([e for e in en if e != sys.argv[1]])], check=True)
PY
}

if [ "${1:-}" = restore ]; then
  ext_remove $RULER
  rm -rf "${EXT_DIR:?}/$RULER" "$DESKTOP" "$ICON"
  dconf reset -f /org/gnome/shell/extensions/bapirlo-ruler/
  update-desktop-database ~/.local/share/applications 2>/dev/null || true
  echo "Removed the ruler and Kuro Settings (log out/in to unload the ruler)."
  exit 0
fi

# backup: nothing existed before, so it records that (and the enabled list)
if [ ! -e "$LATEST" ]; then
  BK=~/theme-backups/$(date +%Y%m%d-%H%M%S)-round15
  mkdir -p "$BK"
  gsettings get org.gnome.shell enabled-extensions > "$BK/enabled-extensions.txt"
  ln -sfn "$BK" "$LATEST"; echo "backup -> $BK"
fi

echo "== Kuro Ruler"
rm -rf "${EXT_DIR:?}/$RULER"; cp -rL "$HERE/round15/$RULER" "$EXT_DIR/"
glib-compile-schemas "$EXT_DIR/$RULER/schemas"
glib-compile-schemas "$HERE/round15/$RULER/schemas"     # the repo copy (test shell) too
ext_enable $RULER
echo "   Super+Shift+M after the next log in"

echo "== Kuro Settings"
chmod +x "$HERE/settings-app/bapirlo-settings"
install -Dm644 "$HERE/settings-app/bapirlo-settings.svg" "$ICON"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Kuro Settings
GenericName=Kuro OS settings
Comment=Every Kuro extension and its settings, modes, tools and an undo list of every change
Exec=$HERE/settings-app/bapirlo-settings
Icon=bapirlo-settings
Terminal=false
Categories=Settings;System;
Keywords=settings;extensions;undo;restore;backup;modes;kuro;bapirlo;
StartupWMClass=os.bapirlo.Settings
Actions=undo;

[Desktop Action undo]
Name=Undo a change
Exec=$HERE/settings-app/bapirlo-settings --page=undo
EOF
update-desktop-database ~/.local/share/applications 2>/dev/null || true
gtk-update-icon-cache -q ~/.local/share/icons/Bapirlo 2>/dev/null || true
echo "   app grid → Kuro Settings"
echo
echo "Done. Log out/in once for the ruler. Undo: bash ~/bapirlo-os/1800-round15.sh restore"
