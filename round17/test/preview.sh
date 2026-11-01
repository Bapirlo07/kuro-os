#!/usr/bin/env bash
# Throwaway headless GNOME Shell for round 17. Never touches the real session.
#   EXTS_EXTRA="uuid ..." SRC_DIRS="dir ..." bash preview.sh   then  T=$T bash ~/bapirlo-os/media-widget/test/drive.sh ...
# SRC_DIRS: extension source dirs (symlinked over the installed ones), e.g. ~/bapirlo-os/round16/bapirlo-search@bapirlo-os
set -euo pipefail
OS=$HOME/bapirlo-os
T=${T:-/tmp/claude-1000/kuro-r17-test}
rm -rf "$T"; mkdir -p "$T"/{config,data/gnome-shell/extensions,data/themes,cache,state}
EXTD=$T/data/gnome-shell/extensions
ln -s "$OS/media-widget/test/testhelper@bapirlo-os" "$EXTD/"
UUIDS=("user-theme@gnome-shell-extensions.gcampax.github.com" "testhelper@bapirlo-os")
for d in ${SRC_DIRS:-}; do ln -s "$d" "$EXTD/"; UUIDS+=("$(basename "$d")"); done
for e in ${EXTS_EXTRA:-}; do [ -e "$EXTD/$e" ] || ln -s ~/.local/share/gnome-shell/extensions/$e "$EXTD/" 2>/dev/null || ln -s /usr/share/gnome-shell/extensions/$e "$EXTD/"; UUIDS+=("$e"); done
THEME=$(gsettings get org.gnome.shell.extensions.user-theme name | tr -d "'")
cp -rL ~/.local/share/themes/"$THEME" "$T/data/themes/Kuro-Preview" 2>/dev/null || cp -rL ~/.themes/"$THEME" "$T/data/themes/Kuro-Preview"
ln -s ~/.local/share/fonts "$T/data/fonts"; [ -d ~/.local/share/icons ] && ln -s ~/.local/share/icons "$T/data/icons"
dconf dump /org/gnome/shell/extensions/ > "$T/ext.dconf"; dconf dump /org/gnome/desktop/interface/ > "$T/iface.dconf"
BG=$(gsettings get org.gnome.desktop.background picture-uri-dark)
EXTS=$(printf '"%s", ' "${UUIDS[@]}"); EXTS="[${EXTS%, }]"
export XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_CACHE_HOME=$T/cache XDG_STATE_HOME=$T/state
export PULSE_SERVER=unix:/nonexistent GSETTINGS_BACKEND=dconf
exec dbus-run-session -- bash -c '
  set -e
  dconf load /org/gnome/shell/extensions/ < '"$T"'/ext.dconf
  dconf load /org/gnome/desktop/interface/ < '"$T"'/iface.dconf
  g() { gsettings set "$@"; }
  g org.gnome.shell enabled-extensions '"'$EXTS'"'
  g org.gnome.shell disable-user-extensions false
  g org.gnome.shell welcome-dialog-last-shown-version "999"
  g org.gnome.shell.extensions.user-theme name "Kuro-Preview"
  g org.gnome.mutter dynamic-workspaces false
  g org.gnome.desktop.wm.preferences num-workspaces 4
  g org.gnome.desktop.background picture-uri '"$BG"'
  g org.gnome.desktop.background picture-uri-dark '"$BG"'
  echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" > '"$T"'/env
  echo "export XDG_CONFIG_HOME='"$T"'/config XDG_DATA_HOME='"$T"'/data XDG_CACHE_HOME='"$T"'/cache WAYLAND_DISPLAY=kuro-r17-test" >> '"$T"'/env
  exec gnome-shell --headless --wayland --no-x11 --wayland-display kuro-r17-test \
       --virtual-monitor 1920x1200 --force-animations 2>&1 | tee '"$T"'/shell.log
'
