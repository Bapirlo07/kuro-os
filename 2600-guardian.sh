#!/usr/bin/env bash
# Kuro OS round 26 — KURO GUARDIAN (NO sudo, no log out needed):
#   · kuro-guardian.service: after a shell crash GNOME switches every extension off — the Guardian reads the
#     crash's stack trace, switches off only the extension to blame, turns the rest back on and tells you
#     (button: turn it back on). Same extension crashing twice in 24 h → off. Extension that fails to load →
#     notification + "Roll back" to its known-good copy. Known-good snapshot after 10 clean minutes (keeps 3).
#   · kuro check     check every enabled extension's code / metadata / settings schema (run before logging out)
#   · kuro rescue    put back the last known-good extensions + shell settings (also from a TTY: Ctrl+Alt+F3)
#   · kuro status · kuro unblock UUID · kuro snapshot
#   bash ~/bapirlo-os/2600-guardian.sh            install
#   bash ~/bapirlo-os/2600-guardian.sh restore    take it out again (snapshots in ~/.local/state/bapirlo/guardian are kept)
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "Run WITHOUT sudo."; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
UNITS=~/.config/systemd/user
if [ "${1:-}" = restore ]; then
  systemctl --user disable --now kuro-guardian.service 2>/dev/null || true
  rm -f "$UNITS/kuro-guardian.service" ~/.local/bin/kuro
  systemctl --user daemon-reload
  echo "Kuro Guardian removed."
  exit 0
fi
chmod +x "$HERE/bin/kuro-guardian" "$HERE/bin/kuro"
mkdir -p "$UNITS" ~/.local/bin
cp "$HERE/round26/kuro-guardian.service" "$UNITS/kuro-guardian.service.new" && mv -f "$UNITS/kuro-guardian.service.new" "$UNITS/kuro-guardian.service"
# `kuro` on PATH even in a bare TTY login (where ~/bapirlo-os/bin may not be on PATH)
ln -sfn "$HERE/bin/kuro" ~/.local/bin/kuro
systemctl --user daemon-reload
systemctl --user enable --now kuro-guardian.service
echo "== checking your extensions"
"$HERE/bin/kuro" check || true
echo "== first known-good snapshot"
"$HERE/bin/kuro" snapshot
echo "Kuro Guardian is on.   kuro status · kuro check · kuro rescue"
