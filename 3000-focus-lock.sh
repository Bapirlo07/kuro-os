#!/usr/bin/env bash
# Kuro OS round 30 — Focus Lock. NO sudo; log out after (the Kuro Study extension changed).
#   · PC: while a focus block runs, every app but Lectern is blocked (minimised + "blocked" card, Lectern to the front);
#     breaks are free; the windows come back when the block ends. Toggle: Kuro Study menu → "Block other apps during focus".
#   · iPhone: kuro-phone-focus service (port 1764, LAN only, secret link) + an iOS Shortcuts automation sends you
#     back to the Home Screen when you open a blocked app during a focus block. Steps: kuro-phone-focus setup
#   · Kuro Focus app (apps/focus/kuro-focus): timer, allowed apps, iPhone link + QR — replaces the old "Focus Timer" launcher
#   bash ~/bapirlo-os/3000-focus-lock.sh            install
#   bash ~/bapirlo-os/3000-focus-lock.sh restore    back to round 29 Kuro Study, iPhone service off
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "Run WITHOUT sudo."; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib/kuro-install.sh"
STUDY=bapirlo-study@bapirlo-os
UNIT=kuro-phone-focus.service
BK_ROOT=$HOME/theme-backups
UDIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
APPS=${XDG_DATA_HOME:-$HOME/.local/share}/applications
ICONS=${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps

if [ "${1:-}" = restore ]; then
  BK=$BK_ROOT/LATEST-ROUND30
  [ -d "$BK/$STUDY" ] || { echo "no backup at $BK"; exit 1; }
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UDIR/$UNIT"; systemctl --user daemon-reload
  rm -f "$KURO_EXT_DIR/$STUDY/lockdown.js" "$ICONS/kuro-focus.svg"
  [ -f "$BK/os.bapirlo.Focus.desktop" ] && cp -p "$BK/os.bapirlo.Focus.desktop" "$APPS/"
  update-desktop-database "$APPS" 2>/dev/null || true
  kuro_sync_ext "$BK/$STUDY" "$STUDY"
  kuro_done
  echo "Restored — log out and back in."
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
BK=$BK_ROOT/$STAMP-round30
mkdir -p "$BK"
[ -d "$KURO_EXT_DIR/$STUDY" ] && cp -a "$KURO_EXT_DIR/$STUDY" "$BK/"
[ -f "$APPS/os.bapirlo.Focus.desktop" ] && ! grep -q "^Name=Kuro Focus" "$APPS/os.bapirlo.Focus.desktop" \
  && cp -p "$APPS/os.bapirlo.Focus.desktop" "$BK/"
# keep the first backup (= before round 30) as the restore point on re-runs
[ -e "$BK_ROOT/LATEST-ROUND30" ] || ln -sfn "$BK" "$BK_ROOT/LATEST-ROUND30"
echo "== backup: $BK"

kuro_sync_ext "$HERE/round29/$STUDY" "$STUDY"
echo "== Kuro Study + Focus Lock installed (active after logout)"

chmod +x "$HERE/bin/kuro-phone-focus" "$HERE/apps/focus/kuro-focus"
kuro_put "$HERE/apps/focus/kuro-focus.svg" "$ICONS/kuro-focus.svg"
kuro_put "$HERE/apps/focus/os.bapirlo.Focus.desktop" "$APPS/os.bapirlo.Focus.desktop"
sed -i "s#@REPO@#$HERE#g" "$APPS/os.bapirlo.Focus.desktop"
gtk-update-icon-cache -q -t "${ICONS%/scalable/apps}" 2>/dev/null || true
update-desktop-database "$APPS" 2>/dev/null || true
echo "== Kuro Focus app installed (app grid: Kuro Focus)"
kuro_put "$HERE/round30/$UNIT" "$UDIR/$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"
sleep 1
systemctl --user is-active "$UNIT" >/dev/null && echo "== iPhone answer server running (port 1764)"

kuro_done
echo
echo "Done — log out and back in for the PC lock. iPhone setup: ~/bapirlo-os/bin/kuro-phone-focus setup"
