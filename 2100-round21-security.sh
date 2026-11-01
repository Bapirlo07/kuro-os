#!/usr/bin/env bash
# Kuro OS round 21 — security pass (the parts that need root).
#   sudo bash ~/bapirlo-os/2100-round21-security.sh            install
#   sudo bash ~/bapirlo-os/2100-round21-security.sh restore    undo all of it (packages are kept, just switched off)
#
#  1. DNS leaks   -> systemd-resolved: every lookup goes to Cloudflare + Quad9 over DNS-over-TLS (opportunistic:
#                    falls back to plain DNS on networks that block it, e.g. hotel / café login pages);
#                    *.lan names still go to your router; LLMNR off (it answers name lookups to anyone on the
#                    Wi-Fi); resolved's mDNS off (Avahi keeps doing mDNS for AirPlay / printers).
#                    Checked right after: if lookups stop working, this step undoes itself.
#  2. MAC privacy -> Wi-Fi scans use random MACs; every network sees its OWN made-up MAC, so cafés/airports
#                    can't track the laptop between them. Your home Wi-Fi (the one connected now, or HOME_WIFI=
#                    "name") keeps the real MAC so the router's reservations keep working. Applies on reconnect.
#  3. USBGuard    -> USB devices plugged in from now on are BLOCKED until you allow them (a popup asks:
#                    Allow once / Always allow — kuro-usb-guard user service). Everything plugged in right now
#                    (camera, Bluetooth, RGB controller) stays allowed. The keyboard and touchpad are not USB,
#                    so you can never lock yourself out.
#  4. AppArmor    -> installed + switched on in the kernel command line (GRUB rebuilt to a temp file and
#                    checked before it replaces the real one). Active after the next reboot.
#  5. arch-audit  -> lists installed packages with known security holes; Kuro Doctor shows the count.
# Never touches partitions, the EFI partition, grub-install, the firewall or user files.
# Backup + log: ~/theme-backups/LATEST-SECURITY (this run) — `restore` uses ORIGINAL-SECURITY: the
# backup from the FIRST run, taken before anything was changed, so running this again never spoils the undo.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
U=${SUDO_USER:?run via sudo}; U_HOME=$(getent passwd "$U" | cut -d: -f6); U_ID=$(id -u "$U")
LATEST=$U_HOME/theme-backups/LATEST-SECURITY
ORIG=$U_HOME/theme-backups/ORIGINAL-SECURITY
RESOLVED_D=/etc/systemd/resolved.conf.d/50-kuro-privacy.conf
NM_D=/etc/NetworkManager/conf.d/50-kuro-privacy.conf
POLKIT=/etc/polkit-1/rules.d/70-kuro-usbguard.rules
UG_CONF=/etc/usbguard/usbguard-daemon.conf
UG_RULES=/etc/usbguard/rules.conf
LSM="landlock,lockdown,yama,integrity,apparmor,bpf"
CFG=/boot/grub/grub.cfg; NEW=/boot/grub/grub.cfg.kuro-new
say() { printf '\e[1;31m==>\e[0m %s\n' "$*"; }
as_user() { runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/$U_ID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$U_ID/bus "$@"; }

dns_works() {   # true if a fresh lookup works (twice, different names)
    resolvectl flush-caches 2>/dev/null || true
    timeout 8 resolvectl query -t A archlinux.org >/dev/null 2>&1 && timeout 8 getent ahostsv4 wikipedia.org >/dev/null 2>&1
}

grub_rebuild() {  # grub_rebuild BACKUP_DIR — temp file, checked, then swapped in
    grub-mkconfig -o "$NEW" > "$1/grub-mkconfig.log" 2>&1 || { rm -f "$NEW"; return 1; }
    ok() { grep -qE "$1" "$NEW" || { echo "   grub check failed: $1"; return 1; }; }
    if grub-script-check "$NEW" && ok "menuentry 'Kuro OS'" && ok "linux\s+/(boot/)?vmlinuz-linux-cachyos" \
       && ok "initrd\s+.*initramfs-linux-cachyos" && ok "set theme=" && { [ -z "${2:-}" ] || ok "$2"; } ; then
        grep -q "menuentry 'Windows" "$CFG" && ! grep -q "menuentry 'Windows" "$NEW" && { echo "   grub check failed: Windows entry gone"; rm -f "$NEW"; return 1; }
        mv "$NEW" "$CFG"
    else
        rm -f "$NEW"; return 1
    fi
}

# ======================================================================================== restore
if [ "${1:-}" = restore ]; then
    BK=$(readlink -f "$ORIG" 2>/dev/null); [ -d "$BK" ] || BK=$(readlink -f "$LATEST")
    [ -d "$BK" ] || { echo "No backup at $ORIG or $LATEST"; exit 1; }
    say "Restoring from $BK"
    rm -f "$RESOLVED_D"; systemctl restart systemd-resolved
    rm -f "$NM_D"
    if [ -f "$BK/home-wifi" ]; then
        IFS=$'\t' read -r name mac < "$BK/home-wifi"
        nmcli con modify "$name" 802-11-wireless.cloned-mac-address "${mac:-}" 2>/dev/null || true
    fi
    nmcli general reload conf 2>/dev/null || true
    systemctl disable --now usbguard-dbus.service usbguard.service 2>/dev/null || true
    rm -f "$POLKIT"
    [ -f "$BK/usbguard-daemon.conf" ] && cp -a "$BK/usbguard-daemon.conf" "$UG_CONF"
    systemctl disable apparmor.service 2>/dev/null || true
    if [ -f "$BK/etc-default-grub" ] && ! cmp -s "$BK/etc-default-grub" /etc/default/grub; then
        cp -a /etc/default/grub "$BK/etc-default-grub.before-restore"
        cp -a "$BK/etc-default-grub" /etc/default/grub
        grub_rebuild "$BK" "" || { echo "!! grub rebuild failed — /etc/default/grub restored but grub.cfg unchanged"; }
    fi
    as_user systemctl --user stop kuro-usb-guard.service 2>/dev/null || true
    rm -f "$ORIG"   # next install takes a fresh original
    say "Restored. (usbguard / apparmor / arch-audit packages are still installed, just off.) Reboot to drop AppArmor."
    exit 0
fi

# ======================================================================================== install
TS=$(date +%Y%m%d-%H%M%S)
BK=$U_HOME/theme-backups/$TS-security; mkdir -p "$BK"
exec > >(tee -a "$BK/install.log") 2>&1
cp -a /etc/default/grub "$BK/etc-default-grub"
[ -f "$UG_CONF" ] && cp -a "$UG_CONF" "$BK/usbguard-daemon.conf"
resolvectl status > "$BK/resolvectl-before.txt" 2>&1 || true
chown -R "$U:" "$BK"; ln -sfn "$BK" "$LATEST"; chown -h "$U:" "$LATEST"
[ -e "$ORIG" ] || { ln -sfn "$BK" "$ORIG"; chown -h "$U:" "$ORIG"; }   # first run only
say "Backup: $BK"

dns_works || { echo "!! DNS isn't working even before any change — connect to a network first."; exit 1; }

# ---------------------------------------------------------------------------------- 5 (first: packages)
say "Packages: usbguard apparmor arch-audit"
if ! pacman -S --needed --noconfirm usbguard apparmor arch-audit; then
    echo "!! pacman couldn't install them (stale package lists?). Run  sudo pacman -Syu  first, then this again."
    exit 1
fi

# ---------------------------------------------------------------------------------- 1. DNS
say "1. DNS: DNS-over-TLS (Cloudflare + Quad9), LLMNR off"
mkdir -p "$(dirname "$RESOLVED_D")"
cat > "$RESOLVED_D" <<'EOF'
# Kuro OS round 21 (2100-round21-security.sh) — undo: sudo bash ~/bapirlo-os/2100-round21-security.sh restore
[Resolve]
DNS=1.1.1.1#cloudflare-dns.com 9.9.9.9#dns.quad9.net 2606:4700:4700::1111#cloudflare-dns.com 2620:fe::fe#dns.quad9.net
# all names go to the servers above (your router still answers its own *.lan names — a more specific route)
Domains=~.
# encrypted when the network allows it; plain DNS otherwise (captive portals keep working)
DNSOverTLS=opportunistic
LLMNR=no
# Avahi already does mDNS (AirPlay, printers); two responders = double answers
MulticastDNS=no
EOF
systemctl restart systemd-resolved
sleep 2
if dns_works; then
    echo "   lookups OK"; resolvectl status | sed -n '1,6p' | sed 's/^/   /'
else
    echo "!! lookups failed with the new DNS — undoing step 1"
    rm -f "$RESOLVED_D"; systemctl restart systemd-resolved; sleep 2
    dns_works && echo "   back to the old DNS, working" || echo "!! still failing — check your connection"
fi

# ---------------------------------------------------------------------------------- 2. MAC privacy
say "2. Wi-Fi MAC privacy"
cat > "$NM_D" <<'EOF'
# Kuro OS round 21 — a different made-up MAC on every network (stable per network), random MACs while scanning.
[device]
wifi.scan-rand-mac-address=yes

[connection]
wifi.cloned-mac-address=stable
ethernet.cloned-mac-address=stable
connection.llmnr=0
EOF
HOME_WIFI=${HOME_WIFI:-$(nmcli -t -f NAME,TYPE con show --active | awk -F: '$2=="802-11-wireless"{print $1; exit}')}
if [ -n "$HOME_WIFI" ]; then
    printf '%s\t%s\n' "$HOME_WIFI" "$(nmcli -g 802-11-wireless.cloned-mac-address con show "$HOME_WIFI" 2>/dev/null)" > "$BK/home-wifi"
    nmcli con modify "$HOME_WIFI" 802-11-wireless.cloned-mac-address permanent
    echo "   home Wi-Fi \"$HOME_WIFI\" keeps the real MAC"
fi
nmcli general reload conf
echo "   other networks get their own MAC the next time you join them (nothing reconnects now)"

# ---------------------------------------------------------------------------------- 3. USBGuard
say "3. USBGuard (new USB devices need your OK)"
# allow everything that is plugged in right now — by id + port, no firmware hashes (they change on updates)
usbguard generate-policy -X > "$BK/rules.conf.new"
echo "   allowed now:"; sed -E 's/.*name "([^"]*)".*/     \1/' "$BK/rules.conf.new"
install -m 600 -o root -g root "$BK/rules.conf.new" "$UG_RULES"
set_conf() { grep -q "^$1=" "$UG_CONF" && sed -i "s|^$1=.*|$1=$2|" "$UG_CONF" || echo "$1=$2" >> "$UG_CONF"; }
set_conf RuleFile "$UG_RULES"
set_conf ImplicitPolicyTarget block
set_conf PresentDevicePolicy apply-policy
set_conf PresentControllerPolicy keep
set_conf InsertedDevicePolicy apply-policy
set_conf IPCAllowedGroups wheel
cat > "$POLKIT" <<'EOF'
// Kuro OS round 21: people in "wheel" at the computer may answer USBGuard's "allow this device?" without a password
polkit.addRule(function (action, subject) {
    if (action.id.indexOf("org.usbguard.") === 0 && subject.local && subject.active && subject.isInGroup("wheel"))
        return polkit.Result.YES;
});
EOF
systemctl enable --now usbguard.service usbguard-dbus.service
sleep 2
if usbguard list-devices 2>/dev/null | grep -q ' block '; then
    echo "!! something already plugged in got blocked — switching USBGuard off again:"
    usbguard list-devices | grep ' block ' | sed 's/^/     /'
    usbguard list-devices | awk -F: '/ block /{print $1}' | while read -r id; do usbguard allow-device "$id" || true; done
    systemctl disable --now usbguard-dbus.service usbguard.service
else
    echo "   USBGuard on: $(usbguard list-devices | wc -l) devices allowed"
    as_user systemctl --user daemon-reload || true
    as_user systemctl --user enable --now kuro-usb-guard.service || echo "   (the popup service starts at your next login)"
fi

# ---------------------------------------------------------------------------------- 4. AppArmor
say "4. AppArmor"
systemctl enable apparmor.service
if grep -q 'apparmor' /proc/cmdline || grep -q "lsm=[^\"]*apparmor" /etc/default/grub; then
    echo "   already in the kernel command line"
else
    sed -i -E "s|^(GRUB_CMDLINE_LINUX_DEFAULT=\"[^\"]*)\"|\1 lsm=$LSM\"|" /etc/default/grub
    if grub_rebuild "$BK" "lsm=$LSM"; then
        echo "   GRUB updated (checked: Kuro OS, kernel, initramfs, theme$(grep -q "menuentry 'Windows" "$CFG" && echo ', Windows'))"
    else
        cp -a "$BK/etc-default-grub" /etc/default/grub
        echo "!! the rebuilt GRUB menu failed its checks — kept the old one; AppArmor not switched on"
    fi
fi

# ---------------------------------------------------------------------------------- 5. arch-audit
say "5. Packages with known security holes"
n=$(arch-audit -q 2>/dev/null | wc -l || echo 0); f=$(arch-audit -uq 2>/dev/null | wc -l || echo 0)
echo "   $n affected, $f fixed by an update (sudo pacman -Syu)"

say "Done. Reboot once for AppArmor. Undo everything: sudo bash $0 restore"
