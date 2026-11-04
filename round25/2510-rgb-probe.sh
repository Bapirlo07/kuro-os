#!/usr/bin/env bash
# Kuro OS round 25 — READ-ONLY look at the keyboard light chip (MSI MysticLight MS-1603, USB 1462:1603).
# OpenRGB doesn't support this chip yet. This only ASKS the chip for its current settings (HID "get feature"
# reports 1–8) and prints them — it never sends a command, so the keyboard lighting can't change.
#   sudo bash ~/bapirlo-os/round25/2510-rgb-probe.sh        then paste the output to Claude
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo (the chip's device file is root-only)."; exit 1; }
DEV=""
for h in /sys/class/hidraw/hidraw*; do
  grep -q 'HID_ID=0003:00001462:00001603' "$h/device/uevent" 2>/dev/null && DEV=/dev/$(basename "$h")
done
[ -n "$DEV" ] || { echo "MysticLight MS-1603 not found"; exit 1; }
echo "== device $DEV"; grep -E 'HID_NAME|HID_ID' "/sys/class/hidraw/$(basename "$DEV")/device/uevent"
echo "== keyboard backlight files"; ls /sys/class/leds/ | grep -iE 'kbd|keyboard|rgb' || echo "(none)"
ls /sys/devices/platform/msi-ec/ 2>/dev/null | grep -iE 'kbd|led|rgb' || true
python3 - "$DEV" <<'PY'
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
def get_feature(rid, size=64):
    buf = bytearray(size); buf[0] = rid
    req = (3 << 30) | (size << 16) | (ord("H") << 8) | 0x07      # HIDIOCGFEATURE(size)
    try:
        n = fcntl.ioctl(fd, req, buf, True)
        return bytes(buf[:n if isinstance(n, int) and n > 0 else size])
    except OSError as e:
        return f"error: {e.strerror}"
for rid in range(1, 9):
    r = get_feature(rid)
    print(f"report {rid}:", r if isinstance(r, str) else r.hex(" "))
os.close(fd)
PY
echo "== done (nothing was changed)"
