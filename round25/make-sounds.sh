#!/usr/bin/env bash
# Kuro Sense — makes the four soft spatial UI sounds into the current sound theme (no downloads, pure ffmpeg).
#   kuro-window-open (rising glass blip) · kuro-window-close (falling) · kuro-window-minimize (low drop)
#   kuro-workspace (airy whoosh)
set -euo pipefail
THEME=$(gsettings get org.gnome.desktop.sound theme-name | tr -d "'")
D="$HOME/.local/share/sounds/$THEME/stereo"; mkdir -p "$D"
mk() { ffmpeg -hide_banner -loglevel error -y "$@"; }
mk -f lavfi -i "aevalsrc='0.30*sin(2*PI*(700*t+1400*t*t))*exp(-26*t)+0.10*sin(2*PI*(1400*t+2800*t*t))*exp(-34*t)':s=48000:d=0.16" \
   -af "afade=t=in:d=0.004,aecho=0.6:0.5:28:0.18" -ac 2 -c:a libvorbis -q:a 5 "$D/kuro-window-open.oga"
mk -f lavfi -i "aevalsrc='0.28*sin(2*PI*(980*t-1500*t*t))*exp(-24*t)+0.08*sin(2*PI*(1960*t-3000*t*t))*exp(-30*t)':s=48000:d=0.15" \
   -af "afade=t=in:d=0.004,aecho=0.6:0.5:24:0.15" -ac 2 -c:a libvorbis -q:a 5 "$D/kuro-window-close.oga"
mk -f lavfi -i "aevalsrc='0.34*sin(2*PI*(520*t-700*t*t))*exp(-14*t)':s=48000:d=0.24" \
   -af "afade=t=in:d=0.006,lowpass=f=2400" -ac 2 -c:a libvorbis -q:a 5 "$D/kuro-window-minimize.oga"
mk -f lavfi -i "anoisesrc=color=pink:a=0.5:d=0.34:r=48000" \
   -af "bandpass=f=1900:width_type=o:w=1.4,afade=t=in:curve=qsin:d=0.12,afade=t=out:curve=qsin:st=0.12:d=0.22,volume=0.9" \
   -ac 2 -c:a libvorbis -q:a 5 "$D/kuro-workspace.oga"
ls "$D" | grep kuro-
