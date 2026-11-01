#!/usr/bin/env bash
# Kuro OS — put the new name on the parts that need root (the art was rebuilt without sudo first:
# tools/build-grub-v2.py, build-plymouth-v2.py, Theme Studio's splash originals + boot-stage).
#   sudo bash ~/bapirlo-os/1700-rebrand.sh            install
#   sudo bash ~/bapirlo-os/1700-rebrand.sh restore    put it all back
#
#  1. GRUB theme  -> /boot/grub/themes/bapirlo-kuro  (K logo + KURO wordmark, new "kuro" icon class)
#  2. GRUB menu   -> GRUB_DISTRIBUTOR="Kuro OS"; grub-mkconfig to a TEMP file, checked (Kuro OS +
#                    Windows + theme) before it replaces grub.cfg
#  3. Login       -> web-greeter theme: KURO / OS wordmark, K logo, titles (bg, avatar, fonts and
#                    Theme Studio's studio/ folder + its stylesheet link are kept)
#  4. Boot splash -> through Theme Studio's own helper, so your current Studio colours stay:
#                    it checks the staged files, backs up, mkinitcpio -P, verifies, rolls back on failure
# Never touches partitions, fstab, the EFI partition or grub-install.
# Backup: ~/theme-backups/LATEST-REBRAND (+ LATEST-STUDIO-BOOT for the splash)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
U=${SUDO_USER:?run via sudo}; U_HOME=$(getent passwd "$U" | cut -d: -f6)
B="$U_HOME/bapirlo-os/build/grub-v2/bapirlo"
G_SRC="$U_HOME/bapirlo-os/greeter/bapirlo"
GTHEME=/boot/grub/themes/bapirlo-kuro
GREETER=/usr/share/web-greeter/themes/bapirlo
CFG=/boot/grub/grub.cfg; NEW=/boot/grub/grub.cfg.kuro-new
HELPER=/usr/local/lib/bapirlo/bapirlo-studio-boot
STAGE=$U_HOME/.local/state/bapirlo/studio/boot-stage
LATEST=$U_HOME/theme-backups/LATEST-REBRAND
GREETER_FILES="index.html secondary.html css/style.css js/common.js js/main.js js/mock.js img/logo.svg"

if [ "${1:-}" = restore ]; then
  BK=$(readlink -f "$LATEST")
  [ -f "$BK/etc/default/grub" ] || { echo "No rebrand backup at $LATEST"; exit 1; }
  echo "Restoring from $BK"
  cp -a "$BK/etc/default/grub" /etc/default/grub
  cp -a "$BK/boot/grub/grub.cfg" "$CFG"
  rm -rf "$GTHEME"; cp -a "$BK/grub-theme" "$GTHEME"
  for f in $GREETER_FILES; do cp -a "$BK/greeter/$f" "$GREETER/$f"; done
  SB=$(cat "$U_HOME/theme-backups/LATEST-STUDIO-BOOT")
  if [ -d "$SB/plymouth-theme" ] && [ -d "$SB/boot" ]; then
    rm -rf /usr/share/plymouth/themes/bapirlo-kuro
    cp -a "$SB/plymouth-theme" /usr/share/plymouth/themes/bapirlo-kuro
    chown -R root:root /usr/share/plymouth/themes/bapirlo-kuro
    cp -a "$SB"/boot/initramfs-*.img /boot/
    echo "Boot splash + boot images restored from $SB"
  else
    echo "!! splash backup not found ($SB) — splash left as it is"
  fi
  sync; echo "Restored."; exit 0
fi

# ------------------------------------------------------------------ checks
[ -f "$B/theme.txt" ] && [ -f "$B/icons/kuro.png" ] || { echo "Missing GRUB build — run tools/build-grub-v2.py"; exit 1; }
[ -f "$G_SRC/index.html" ] || { echo "Missing $G_SRC"; exit 1; }
[ -x "$HELPER" ] || { echo "Theme Studio boot helper missing: sudo bash ~/bapirlo-os/studio/install.sh root"; exit 1; }
[ -f "$STAGE/lockup.png" ] || { echo "No staged splash in $STAGE"; exit 1; }

# ------------------------------------------------------------------ 0. backup
BK=$U_HOME/theme-backups/$(date +%Y%m%d-%H%M%S)-rebrand
echo "== 0. Backup -> $BK"
mkdir -p "$BK/etc/default" "$BK/boot/grub" "$BK/greeter/css" "$BK/greeter/js" "$BK/greeter/img"
cp -a /etc/default/grub "$BK/etc/default/grub"
cp -a "$CFG" "$BK/boot/grub/grub.cfg"
cp -a "$GTHEME" "$BK/grub-theme"
for f in $GREETER_FILES; do cp -a "$GREETER/$f" "$BK/greeter/$f"; done
chown -R "$U:" "$BK"; ln -sfn "$BK" "$LATEST"; chown -h "$U:" "$LATEST"

# ------------------------------------------------------------------ 1. GRUB theme
echo "== 1. GRUB theme"
cp -a "$B/." "$GTHEME/"; chown -R root:root "$GTHEME"

# ------------------------------------------------------------------ 2. GRUB menu names
echo "== 2. GRUB menu: Kuro OS"
sed -i 's/^GRUB_DISTRIBUTOR=.*/GRUB_DISTRIBUTOR="Kuro OS"/' /etc/default/grub
grub-mkconfig -o "$NEW" > "$BK/grub-mkconfig.log" 2>&1 || { cp -a "$BK/etc/default/grub" /etc/default/grub; tail "$BK/grub-mkconfig.log"; echo "!! grub-mkconfig failed — nothing changed"; exit 1; }
ok() { grep -qE "$1" "$NEW" || { echo "   FAIL: $1"; return 1; }; }
if grub-script-check "$NEW" && ok "menuentry 'Kuro OS'" && ok "linux\s+/(boot/)?vmlinuz-linux-cachyos" \
   && ok "initrd\s+.*initramfs-linux-cachyos" && ok "menuentry 'Windows'" && ok "set theme=.*bapirlo-kuro/theme.txt"; then
  mv "$NEW" "$CFG"
  grep -E '^\s*(menuentry|submenu)' "$CFG" | sed -E "s/^\s*(menuentry|submenu) '([^']*)'.*/   \2/"
else
  rm -f "$NEW"; cp -a "$BK/etc/default/grub" /etc/default/grub
  echo "!! new menu failed the check (Kuro OS / Windows / theme) — old grub.cfg kept"; exit 1
fi

# ------------------------------------------------------------------ 3. login screen
echo "== 3. Login screen"
for f in $GREETER_FILES; do install -o root -g root -m 644 "$G_SRC/$f" "$GREETER/$f"; done
if [ -d "$GREETER/studio" ]; then   # Theme Studio's stylesheet loads after the theme's own
  sed -i 's|<link rel="stylesheet" href="css/style.css">|&\n  <link rel="stylesheet" href="studio/studio.css">|' "$GREETER/index.html"
  grep -q 'href="studio/studio.css"' "$GREETER/index.html" || echo "!! couldn't re-add Theme Studio's stylesheet link"
fi
grep -o '<div class="wordmark">[^/]*' "$GREETER/index.html" | sed 's/^/   /'

# ------------------------------------------------------------------ 4. boot splash
echo "== 4. Boot splash (Theme Studio helper)"
SUDO_UID=$(id -u "$U") "$HELPER" apply "$STAGE"

sync
echo
echo "Done. You'll see the new name at the next restart. Undo: sudo bash ~/bapirlo-os/1700-rebrand.sh restore"
