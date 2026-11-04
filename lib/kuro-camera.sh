# Kuro camera — shared by bapirlo-gestures and bapirlo-guard (sourced, not run).
# One daemon (bapirlo-gestures.service) owns the webcam; ~/.config/bapirlo/camera.json says which jobs it does:
#   {"hands": true|false, "guard": true|false}     (no file = hands on, guard off)
KURO_CAM_UNIT=bapirlo-gestures.service
KURO_CAM_CONF="$HOME/.config/bapirlo/camera.json"

cam_get() {   # cam_get hands|guard  → prints true/false
    python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
print("true" if d.get(sys.argv[2], sys.argv[2]=="hands") else "false")' "$KURO_CAM_CONF" "$1"
}

cam_set() {   # cam_set hands|guard|head|look true|false, then start / stop the daemon to match
    mkdir -p "$(dirname "$KURO_CAM_CONF")"
    # first time (no file yet): hands are "on" only if the daemon is already running for them
    local hands_now=false
    systemctl --user is-active -q "$KURO_CAM_UNIT" && hands_now=true
    python3 -c 'import json,os,sys
p=sys.argv[1]
try: d=json.load(open(p))
except Exception: d={}
d.setdefault("hands", sys.argv[4]=="true"); d.setdefault("guard", False); d.setdefault("head", False); d.setdefault("look", False)
d[sys.argv[2]] = sys.argv[3]=="true"
t=p+".tmp"; json.dump(d, open(t,"w"), indent=1); os.replace(t,p)' "$KURO_CAM_CONF" "$1" "$2" "$hands_now"
    if [[ "$(cam_get hands)" == true || "$(cam_get guard)" == true || "$(cam_get head)" == true || "$(cam_get look)" == true ]]; then
        systemctl --user enable --now "$KURO_CAM_UNIT" >/dev/null 2>&1
    else
        systemctl --user disable --now "$KURO_CAM_UNIT" >/dev/null 2>&1
    fi
}

cam_on() {    # cam_on hands|guard → true only if the daemon runs AND that job is on
    systemctl --user is-active -q "$KURO_CAM_UNIT" && [[ "$(cam_get "$1")" == true ]]
}

cam_note() { gdbus call --session -d org.freedesktop.Notifications -o /org/freedesktop/Notifications \
    -m org.freedesktop.Notifications.Notify "Kuro" 0 "$1" "$2" "$3" '[]' '{}' 3000 >/dev/null 2>&1; }
