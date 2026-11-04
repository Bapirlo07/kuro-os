#!/usr/bin/env bash
# Kuro OS — iPhones / iPads plugged into USB get POWER ONLY (no data), with any cable.
#   sudo bash ~/bapirlo-os/2800-iphone-charge-only.sh            install
#   sudo bash ~/bapirlo-os/2800-iphone-charge-only.sh restore    undo (normal iPhone data access again)
#   sudo bash ~/bapirlo-os/2800-iphone-charge-only.sh status     show what's in place
#
# How it works:
#  1. USBGuard allows Apple iPhone/iPad/iPod product IDs (05ac:1290-12af) without the popup, so the phone
#     is properly *configured* by the kernel and may draw normal charging current. A blocked/unconfigured
#     device is only allowed 100 mA, which is why iPhones show "Not Charging" behind USBGuard.
#     The rule refuses anything with keyboard/mouse (HID), storage, network-adapter or Bluetooth
#     interfaces, so a fake "iPhone" stick can't use it to get in. Those still get the normal popup.
#  2. A udev rule de-authorises every *interface* on those devices the moment it appears. The device stays
#     powered and configured, but no driver can bind: no photos (PTP/gvfs), no usbmuxd/libimobiledevice,
#     no USB tethering. The phone never even asks "Trust this computer?".
#  3. usbmuxd's own udev rule is overridden. It normally switches the phone to "configuration 0"
#     (unconfigured = 100 mA) and then starts usbmuxd. We don't want either.
# Charging speed: a USB-C iPhone on a USB-C port charges as usual (the port advertises current itself).
# A Lightning iPhone on a laptop port gets the normal computer-port rate (~500 mA, slow), same as before.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
U=${SUDO_USER:?run via sudo}; U_HOME=$(getent passwd "$U" | cut -d: -f6)

UDEV_POWER=/etc/udev/rules.d/49-kuro-iphone-power-only.rules
UDEV_MUX=/etc/udev/rules.d/39-usbmuxd.rules          # same name as /usr/lib/udev/rules.d/39-usbmuxd.rules = overrides it
UG_RULES=/etc/usbguard/rules.conf
LABEL=kuro-iphone-power-only
BK=$U_HOME/theme-backups/IPHONE-CHARGE-ONLY-$(date +%Y%m%d-%H%M%S)
say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

ug_rule_ids() { usbguard list-rules 2>/dev/null | awk -F: -v l="label \"$LABEL\"" 'index($0,l){print $1}'; }

reload_udev() { udevadm control --reload; }

if [ "${1:-}" = "status" ]; then
    for f in "$UDEV_POWER" "$UDEV_MUX"; do [ -f "$f" ] && echo "present: $f" || echo "missing: $f"; done
    ids=$(ug_rule_ids); [ -n "$ids" ] && echo "USBGuard rule(s): $ids" || echo "USBGuard rule: missing"
    for d in /sys/bus/usb/devices/*; do
        [ -f "$d/idVendor" ] && [ "$(cat "$d/idVendor")" = 05ac ] || continue
        echo "Apple device $(basename "$d"): $(cat "$d/product" 2>/dev/null) cfg=$(cat "$d/bConfigurationValue") maxpower=$(cat "$d/bMaxPower" 2>/dev/null)"
        for i in "$d"/*:*; do [ -f "$i/authorized" ] && echo "   interface $(basename "$i") authorized=$(cat "$i/authorized") driver=$(basename "$(readlink "$i/driver" 2>/dev/null || echo none)")"; done
    done
    exit 0
fi

if [ "${1:-}" = "restore" ]; then
    say "Removing iPhone power-only mode"
    rm -f "$UDEV_POWER" "$UDEV_MUX"
    for id in $(ug_rule_ids); do usbguard remove-rule "$id"; done
    sed -i "/label \"$LABEL\"/d" "$UG_RULES"
    reload_udev
    say "Done. Unplug and replug the phone. It will get the normal USBGuard popup again."
    exit 0
fi

mkdir -p "$BK"; chown "$U:" "$BK" "$(dirname "$BK")"
cp -a "$UG_RULES" "$BK/rules.conf"
[ -f "$UDEV_MUX" ] && cp -a "$UDEV_MUX" "$BK/39-usbmuxd.rules.etc"
say "Backup: $BK"

# ---------------------------------------------------------------- 1. udev: power only
say "udev: de-authorise every interface on iPhones/iPads"
cat > "$UDEV_POWER" <<'EOF'
# Kuro OS — iPhone/iPad power only (2800-iphone-charge-only.sh).
# The device stays configured (so it may draw charging current) but every interface is de-authorised,
# so no driver or program (usbmuxd, gvfs/PTP, ipheth) can exchange data with it.
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_interface", ATTRS{idVendor}=="05ac", ATTRS{idProduct}=="12[9a][0-9a-f]", ATTR{authorized}="0"
EOF

cat > "$UDEV_MUX" <<'EOF'
# Kuro OS — overrides /usr/lib/udev/rules.d/39-usbmuxd.rules while iPhone power-only mode is on.
# The stock rule sets bConfigurationValue=0 (unconfigured = 100 mA, so the phone barely charges) and starts
# usbmuxd. Neither is wanted for power-only. Delete this file (or run the script with `restore`) to undo.
EOF
reload_udev

# ---------------------------------------------------------------- 2. USBGuard: let the phone be configured
say "USBGuard: allow iPhone/iPad product IDs (never with keyboard / storage / network / Bluetooth interfaces)"
if [ -z "$(ug_rule_ids)" ]; then
    ids=$(for p in $(seq $((0x1290)) $((0x12af))); do printf '05ac:%04x ' "$p"; done)
    rule="allow id one-of { ${ids% } } with-interface none-of { 03:*:* 08:*:* 02:*:* 0a:*:* e0:*:* } label \"$LABEL\""
    usbguard append-rule "$rule" >/dev/null
    # append-rule is live; make sure it's also in the rules file so it survives a reboot
    grep -q "label \"$LABEL\"" "$UG_RULES" || echo "$rule" >> "$UG_RULES"
else
    echo "   already there"
fi

usbguard list-rules | grep -q "label \"$LABEL\"" || { echo "!! USBGuard didn't accept the rule; nothing else changed in USBGuard."; exit 1; }

say "Done. Plug the iPhone in: it should show the charging bolt, with no 'Trust this computer?' prompt."
say "Check with:  sudo bash $0 status"
