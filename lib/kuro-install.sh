# Kuro OS — safe install helpers for round scripts (sourced). The running shell keeps files open / memory-mapped
# (gschemas.compiled above all): overwriting one in place crashed the shell twice. Everything here swaps in a
# finished file with one rename, so the shell only ever sees the old file or the new one, never half of one.
#   kuro_put SRC DST              copy one file in atomically
#   kuro_sync_ext SRC_DIR UUID    copy an extension's files in, one atomic file at a time, + schemas
#   kuro_schemas EXT_DIR          compile schemas next to it, swap the result in
#   kuro_done                     after installing: check every extension + save a known-good snapshot
KURO_EXT_DIR=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions
kuro_put() { mkdir -p "$(dirname "$2")" && cp -p "$1" "$2.kuro-new" && mv -f "$2.kuro-new" "$2"; }
kuro_schemas() {
  local d=$1/schemas tmp
  ls "$d"/*.gschema.xml >/dev/null 2>&1 || return 0
  tmp=$(mktemp -d)
  cp "$d"/*.gschema.xml "$tmp/"
  glib-compile-schemas --strict "$tmp" || { rm -rf "$tmp"; echo "schema error in $d" >&2; return 1; }
  mv -f "$tmp/gschemas.compiled" "$d/gschemas.compiled.kuro-new" && mv -f "$d/gschemas.compiled.kuro-new" "$d/gschemas.compiled"
  rm -rf "$tmp"
}
kuro_sync_ext() {
  local src=$1 uuid=$2 dst=$KURO_EXT_DIR/$2 f rel
  mkdir -p "$dst"
  while IFS= read -r -d '' f; do
    rel=${f#"$src"/}
    [[ "$rel" == schemas/gschemas.compiled ]] && continue
    kuro_put "$f" "$dst/$rel"
  done < <(find "$src" -type f ! -path '*/__pycache__/*' ! -name '*.bak' -print0)
  kuro_schemas "$dst"
}
kuro_done() {
  local K="$HOME/bapirlo-os/bin/kuro"
  echo "== checking every extension"
  "$K" check || echo "!! fix the problems above before logging out (or: kuro rescue)"
  "$K" snapshot >/dev/null 2>&1 || true
}
