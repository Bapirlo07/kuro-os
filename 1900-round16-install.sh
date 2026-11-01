#!/usr/bin/env bash
# Kuro OS round 16 — the parts that need your password. Run as YOURSELF (it asks for sudo itself).
#   bash ~/bapirlo-os/1900-round16-install.sh            # snapshot + Tesseract + faster boot
#   bash ~/bapirlo-os/1900-round16-install.sh restore    # boot image back as before (packages stay)
#
# 0. Timeshift snapshot "Before round 16" FIRST — nothing else runs unless it succeeds
# 1. tesseract + tesseract-data-eng (~35 MB) for Super+Shift+T "grab text" (bapirlo-capture text)
# 2. faster boot: CachyOS's hardware tool (chwd, /etc/mkinitcpio.conf.d/10-chwd.conf) puts the NVIDIA
#    driver + its firmware into the boot image → 243 MB that GRUB has to read on every boot. The
#    screen runs on the Intel GPU (i915 stays in the image), so NVIDIA can load a moment later from
#    the disk like any other driver. 20-kuro-no-nvidia-early.conf takes it out of the image (chwd's
#    own file is left alone, so its updates still apply), then both boot images are rebuilt and checked.
#    If anything about the NVIDIA GPU misbehaves: bash 1900-round16-install.sh restore (or delete
#    /etc/mkinitcpio.conf.d/20-kuro-no-nvidia-early.conf and run sudo mkinitcpio -P).
# Then: bash ~/bapirlo-os/1910-round16.sh (no sudo). Backup: ~/theme-backups/LATEST-ROUND16-INSTALL
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "Run as yourself (not sudo) — it asks for your password."; exit 1; }
LATEST=~/theme-backups/LATEST-ROUND16-INSTALL
CONF=/etc/mkinitcpio.conf.d/20-kuro-no-nvidia-early.conf

sizes() { sudo bash -c 'for f in /boot/initramfs-*.img; do printf "   %-40s %s\n" "$(basename "$f")" "$(du -h "$f" | cut -f1)"; done'; }

rebuild() {
  echo "   rebuilding the boot images (a minute or two)…"
  sudo mkinitcpio -P > /tmp/kuro-mkinitcpio.log 2>&1 || { echo "!! mkinitcpio failed — see /tmp/kuro-mkinitcpio.log"; tail -20 /tmp/kuro-mkinitcpio.log; exit 1; }
  grep -E "==> (ERROR|WARNING)" /tmp/kuro-mkinitcpio.log | grep -v "Possibly missing firmware" | sed 's/^/   /' || true
}

if [ "${1:-}" = restore ]; then
  sudo -v
  if [ -f "$CONF" ]; then
    sudo rm -f "$CONF"
    rebuild
    echo "   boot images back to how chwd makes them:"; sizes
  else
    echo "   nothing to undo ($CONF is not there)"
  fi
  exit 0
fi

sudo -v
echo "== 0/2 Timeshift snapshot \"Before round 16\" (incremental — a few minutes)"
if ! sudo timeshift --list --scripted 2>/dev/null | grep -q "Before round 16"; then
  sudo timeshift --create --scripted --comments "Before round 16" --tags O
  sudo timeshift --list --scripted | grep -q "Before round 16" || { echo "!! snapshot missing — stopping, nothing changed."; exit 1; }
fi
sudo timeshift --list --scripted | grep "Before round 16"

if [ ! -e "$LATEST" ]; then
  BK=~/theme-backups/$(date +%Y%m%d-%H%M%S)-round16-install
  mkdir -p "$BK"
  pacman -Q > "$BK/packages-before.txt"
  cp -a /etc/mkinitcpio.conf.d "$BK/mkinitcpio.conf.d" 2>/dev/null || true
  sizes > "$BK/initramfs-sizes-before.txt"
  ln -sfn "$BK" "$LATEST"; echo "backup -> $BK"
fi

echo "== 1/2 Tesseract (grab text, Super+Shift+T)"
sudo pacman -S --needed --noconfirm tesseract tesseract-data-eng
sudo paccache -rk1 -c /var/cache/pacman/pkg >/dev/null 2>&1 || true

echo "== 2/2 faster boot: NVIDIA out of the boot image"
echo "   before:"; sizes
if [ -f /etc/mkinitcpio.conf.d/10-chwd.conf ] && grep -q nvidia /etc/mkinitcpio.conf.d/10-chwd.conf; then
  sudo tee "$CONF" >/dev/null <<'EOF'
# Kuro OS round 16: keep the NVIDIA driver out of the boot image (10-chwd.conf adds it).
# The display runs on the Intel GPU (i915 stays); nvidia loads from the disk a moment later.
# Undo: delete this file and run  sudo mkinitcpio -P   (or: bash ~/bapirlo-os/1900-round16-install.sh restore)
_kuro=()
for _m in "${MODULES[@]}"; do [[ $_m == nvidia* ]] || _kuro+=("$_m"); done
MODULES=("${_kuro[@]}")
unset _kuro _m
EOF
  rebuild
  echo "   after:"; sizes
  for f in /boot/initramfs-*.img; do
    sudo lsinitcpio "$f" | grep -q 'i915.ko' || { echo "!! $f has no i915 — putting it back"; sudo rm -f "$CONF"; rebuild; exit 1; }
    sudo lsinitcpio "$f" | grep -q 'nvidia.ko' && echo "   note: $f still has nvidia.ko"
  done
  echo "   checked: every image still has the Intel driver (i915)"
else
  echo "   chwd doesn't add NVIDIA here — nothing to do"
fi

echo
echo "Done. Next: bash ~/bapirlo-os/1910-round16.sh   (then log out/in). The faster boot shows at the next restart."
