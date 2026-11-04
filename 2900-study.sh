#!/usr/bin/env bash
# Kuro OS round 29 — Kuro Study replaces Kuro Creature (the cat) and Kuro Optics (the neon HUD). NO sudo; log out after.
#   · Kuro Study: Lectern in the top bar (next class, cards due, deadlines, today's plan, focus on a module)
#     and Super+Shift+X = selected text → Lectern flashcard (the key Optics used)
#   · Kuro Creature + Kuro Optics: switched off and taken out; a copy goes to ~/theme-backups/LATEST-ROUND29
#   · Kuro Search / Flow / Lens: their creature hooks removed
#   bash ~/bapirlo-os/2900-study.sh            install
#   bash ~/bapirlo-os/2900-study.sh restore    Kuro Study out, creature + Optics back
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "Run WITHOUT sudo."; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib/kuro-install.sh"
STUDY=bapirlo-study@bapirlo-os
OLD=(bapirlo-pet@bapirlo-os bapirlo-optics@bapirlo-os)
BK_ROOT=$HOME/theme-backups

enabled() {   # enabled ADD|REMOVE UUID...
  python3 - "$@" <<'PY'
import ast, subprocess, sys
mode, uuids = sys.argv[1], sys.argv[2:]
cur = ast.literal_eval(subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True).replace('@as ', ''))
new = [u for u in cur if u not in uuids] + (uuids if mode == 'ADD' else [])
new = list(dict.fromkeys(new))
if new != cur:
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(new)])
PY
}

if [ "${1:-}" = restore ]; then
  BK=$BK_ROOT/LATEST-ROUND29
  [ -d "$BK" ] || { echo "no backup at $BK"; exit 1; }
  gnome-extensions disable "$STUDY" 2>/dev/null || true
  enabled REMOVE "$STUDY"
  rm -rf "${KURO_EXT_DIR:?}/$STUDY"
  for u in "${OLD[@]}"; do
    [ -d "$BK/$u" ] && kuro_sync_ext "$BK/$u" "$u"
  done
  for u in bapirlo-search@bapirlo-os bapirlo-flow@bapirlo-os bapirlo-lens@bapirlo-os; do
    [ -d "$BK/before/$u" ] && kuro_sync_ext "$BK/before/$u" "$u"
  done
  [ -f "$BK/bapirlo-pet" ] && cp -p "$BK/bapirlo-pet" "$HERE/bin/bapirlo-pet"
  enabled ADD "${OLD[@]}"
  kuro_done
  echo "Restored: Kuro Creature + Kuro Optics back, Kuro Study removed — log out and back in."
  exit 0
fi

# 1. back up what goes away (installed copies = exactly what is running now)
STAMP=$(date +%Y%m%d-%H%M%S)
BK=$BK_ROOT/$STAMP-round29
mkdir -p "$BK/before"
for u in "${OLD[@]}"; do
  [ -d "$KURO_EXT_DIR/$u" ] && cp -a "$KURO_EXT_DIR/$u" "$BK/"
done
for u in bapirlo-search@bapirlo-os bapirlo-flow@bapirlo-os bapirlo-lens@bapirlo-os; do
  [ -d "$KURO_EXT_DIR/$u" ] && cp -a "$KURO_EXT_DIR/$u" "$BK/before/"
done
[ -f "$HERE/bin/bapirlo-pet" ] && cp -p "$HERE/bin/bapirlo-pet" "$BK/"
ln -sfn "$BK" "$BK_ROOT/LATEST-ROUND29"
echo "== backup: $BK"

# 2. creature + Optics out. Disable first (the running shell tears them down cleanly), then drop the files.
for u in "${OLD[@]}"; do
  gnome-extensions disable "$u" 2>/dev/null || true
done
enabled REMOVE "${OLD[@]}"
for u in "${OLD[@]}"; do
  rm -rf "${KURO_EXT_DIR:?}/$u"
done
rm -f "$HERE/bin/bapirlo-pet"
echo "== Kuro Creature + Kuro Optics removed"

# 3. creature hooks out of Search (menu entry), Flow (meeting mode), Lens (focus tunnel report)
kuro_put "$HERE/round16/bapirlo-search@bapirlo-os/extension.js" "$KURO_EXT_DIR/bapirlo-search@bapirlo-os/extension.js"
kuro_put "$HERE/round23/bapirlo-flow@bapirlo-os/meeting.js" "$KURO_EXT_DIR/bapirlo-flow@bapirlo-os/meeting.js"
kuro_put "$HERE/round21/bapirlo-lens@bapirlo-os/tunnel.js" "$KURO_EXT_DIR/bapirlo-lens@bapirlo-os/tunnel.js"

# 4. Kuro Study in
chmod +x "$HERE/bin/kuro-study"
kuro_sync_ext "$HERE/round29/$STUDY" "$STUDY"
enabled ADD "$STUDY"
echo "== Kuro Study installed"
"$HERE/bin/kuro-study" summary || true

kuro_done
echo "Done — log out and back in. Then: the book icon in the top bar, and Super+Shift+X on selected text."
