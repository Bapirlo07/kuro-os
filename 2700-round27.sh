#!/usr/bin/env bash
# Kuro OS round 27 (NO sudo, no log out needed):
#   · Air gestures read the hand in 3-D (joint angles + 3-D pinch), model + geometry vote, full-resolution
#     tracking, two-hand aware, click lock, dark-room contrast; `bapirlo-gestures test` = accuracy test +
#     personal calibration (camera daemon restarted if it's running)
#   · Update safety check before every update (bapirlo-update → kuro-preflight; holds GNOME back if a big
#     GNOME upgrade would switch extensions off) + an after-update check (DKMS modules, extensions)
#   · kuro backup / kuro restore-all — whole-setup backup every night (kuro-backup.timer, keeps 2)
#   · kuro-power.service — tells you which app keeps the NVIDIA GPU awake / burns CPU on battery
#   · lib/kuro-install.sh — atomic install helpers for future rounds
#   bash ~/bapirlo-os/2700-round27.sh            install
#   bash ~/bapirlo-os/2700-round27.sh restore    take the services out (backups / calibration are kept)
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "Run WITHOUT sudo."; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib/kuro-install.sh"
UNITS=~/.config/systemd/user
if [ "${1:-}" = restore ]; then
  systemctl --user disable --now kuro-power.service kuro-backup.timer 2>/dev/null || true
  rm -f "$UNITS"/kuro-power.service "$UNITS"/kuro-backup.service "$UNITS"/kuro-backup.timer
  systemctl --user daemon-reload
  echo "Round 27 services removed. Gesture code: restore from ~/theme-backups/*-gestures-accuracy if wanted."
  exit 0
fi
chmod +x "$HERE"/bin/kuro "$HERE"/bin/kuro-power "$HERE"/bin/kuro-backup "$HERE"/bin/kuro-preflight
for u in kuro-power.service kuro-backup.service kuro-backup.timer; do kuro_put "$HERE/round27/$u" "$UNITS/$u"; done
systemctl --user daemon-reload
systemctl --user enable --now kuro-power.service kuro-backup.timer
systemctl --user is-active -q bapirlo-gestures.service && systemctl --user restart bapirlo-gestures.service || true
kuro_done
echo "Round 27 on.  bapirlo-gestures test · kuro preflight · kuro backup · kuro power"
