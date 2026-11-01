# Kuro OS — the manual

Everything on this laptop, in plain English: what it is, how to open it, how it works and how to switch it off.
Open this any time from the Start menu → **Kuro OS Guide** (Ctrl+F searches it).
The one-page **Emergency** sheet is a tab in the same window, and a PDF of it is in `~/bapirlo-os/EMERGENCY.pdf` for your phone.

> **The three things that save you most often**
>
> 1. **Kuro Doctor** (Start menu) tells you what is wrong. It changes nothing.
> 2. A **Timeshift snapshot** is taken before every system update, so a bad update can be rolled back.
> 3. If the desktop freezes, press [[Ctrl+Alt+F3]]. See [Troubleshooting](#e-troubleshooting).

Words used below: **Super** is the Windows key. The **Start menu** is ArcMenu (tap Super). The **Control Centre** is the
panel at the top right (click the Wi-Fi/battery capsule, or press [[Super+S]]). **Launchpad** is the full-screen app grid ([[Super+G]]).
Commands in `code` go in a terminal (Alacritty, or the drop-down one on [[Super+Enter]]).

---

## a) What I can use

### Uni & coding

| App / tool | What it's for | How to open |
|---|---|---|
| **Lectern** | Your own app: timetable, modules, AI tutor, flashcards, mock exams | Start menu / dock → Lectern |
| **Kuro Writer** | Rewrites emails, applications and posts in your voice (Claude) and checks grammar offline (LanguageTool) | Start menu → Kuro Writer · [[Shift+Super+H]] rewrites whatever is on the clipboard |
| **Kuro AI** | A floating Claude Code terminal you can summon over anything | [[Super+A]] (press again to hide) |
| **Visual Studio Code** | Code editor | Start menu → Visual Studio Code |
| **IntelliJ IDEA, WebStorm, RustRover, DataGrip** | JetBrains IDEs for Java/Kotlin, JS/TS, Rust and databases | Start menu, or **JetBrains Toolbox** (starts hidden at login) |
| **Alacritty** | Your main terminal (themed, Starship-ready) | Dock / Start menu → Alacritty |
| **ddterm** | A drop-down terminal from the top of the screen | [[Super+Enter]] |
| **ONLYOFFICE** | Word / Excel / PowerPoint documents | Start menu → ONLYOFFICE |
| **MS-365-Electron** | Microsoft 365 (Outlook, Teams, OneDrive web) in its own window | Start menu → MS-365-Electron |
| **Text Editor, Meld** | Plain text editing; comparing two files or folders | Start menu |
| **Document Viewer, Document Scanner** | PDFs; scanning paper | Start menu |
| **Calculator** | Calculator (scientific mode inside) | Start menu, or type in Super+Space |
| **Google Chrome, Firefox** | Browsers (Chrome has the Kuro theme folder ready) | Dock / Start menu |

### Gaming & streaming

| App / tool | What it's for | How to open |
|---|---|---|
| **Game Mode (automatic)** | When a game goes fullscreen: Do Not Disturb, Performance profile held, instant replay running. Undone when you leave | Automatic (bapirlo-game extension) |
| **Instant replay** | Keeps the last 30 s of the screen in memory; save it when something good happens | [[Super+Alt+G]] save · [[Super+Alt+R]] on/off · files in `~/Videos/Replays` |
| **Screen recording** | Records the screen with the Intel GPU's encoder (no game lag) | Control Centre → Screen Rec · files in `~/Videos/Recordings` |
| **MangoHud** | FPS / temperature overlay in games | In Steam: launch option `mangohud %command%` · [[Right Shift+F12]] toggles it |
| **Gaming / Quiet modes** | Gaming = Turbo + DND + replay. Quiet = Eco + silent fans + no sounds | Kuro Welcome switches, or `bapirlo-mode gaming toggle` |
| **Discord** | Voice and chat | Start menu → Discord |
| **Vesktop** | Discord with Vencord built in, in the Kuro OS theme (Vencord settings → Themes) | Start menu → Vesktop |
| **Steam, OBS** | *Not installed yet.* The OBS Do-Not-Disturb script is ready in `~/bapirlo-os/game/obs` | Install with `paru -S steam obs-studio` |

### Media

| App / tool | What it's for | How to open |
|---|---|---|
| **Media in the top bar** | What's playing (any player): click for cover, seek, volume; middle-click = play/pause | Top bar music note · [[Super+Alt+M]] |
| **Spotify** | Music, with the Kuro theme (Spicetify), re-applied automatically after Spotify updates | Start menu → Spotify (Launcher) |
| **YouTube Music for Desktop** | YouTube Music app | Start menu |
| **Video Player, Clapper, mpv** | Videos (mpv for anything odd) | Double-click a video, or Start menu |
| **Audio Player** | Single audio files | Double-click an audio file |
| **Image Viewer** | Photos | Double-click a picture |
| **Live Captions** | Offline subtitles for whatever is playing (lectures, calls). *Not installed yet — about 1.5 GB* | `bash ~/bapirlo-os/810-round7.sh captions`, then Control Centre → Captions · [[Super+Alt+C]] |
| **Volume Control** | Per-app volume, inputs/outputs | Start menu → Volume Control |

### Design & video

| App / tool | What it's for | How to open |
|---|---|---|
| **Screenshot + annotate (Satty)** | Pick an area/window/screen, then draw, blur, add arrows or text | [[Print]] |
| **GNOME screenshot / screencast UI** | The built-in one (also records a short clip) | [[Shift+Print]] · [[Ctrl+Print]] full screen · [[Alt+Print]] window |
| **Colour picker** | Click anywhere and the hex colour is copied | [[Shift+Super+C]] |
| **Wallpapers** (one window with two tabs: *Wallpapers* and *Theme*) | Every wallpaper in one gallery, live ones too: click to use it, drop pictures or videos on the window to add them, ⋯ for time-of-day tags. Modes: Fixed · Time of day · Shuffle. The OS colours follow the wallpaper (switch it off for the original Kuro colours) | Start menu → Wallpapers · [[Super+Alt+P]] · [[Super+Alt+N]] next · Files → right-click → Scripts → *Set as wallpaper* · `bapirlo-wallpaper` |
| **Theme Studio** (the *Theme* tab of Wallpapers) | Re-themes all of Kuro OS from a wallpaper: preview, Apply, save it, switch back. "Original Kuro OS" is always one click away | Start menu → Wallpapers → Theme tab · [[Super+Alt+T]] · Control Centre → Theme Studio (right-click it for your saved themes) · drop pictures in `~/Pictures/Theme Studio` |
| **Camera** | Webcam photos and video | Start menu → Camera |
| **Kvantum Manager, Qt6 Settings, Tweaks** | Theme controls (already set to Kuro — leave unless you know why) | Start menu → Tools folder |
| *Editing apps* | None installed yet (GIMP, Kdenlive, Blender…) — `paru -S gimp kdenlive` | — |

### iPhone & Windows

| App / tool | What it's for | How to open |
|---|---|---|
| **LocalSend** | AirDrop-style file sharing with the LocalSend iPhone app (same Wi-Fi). Received files → `~/Downloads/iPhone` | Start menu → LocalSend (opens its firewall port only while it runs) |
| **AirPlay Receiver** | Mirror the iPhone screen to the laptop (code shown in the notification, first time only). Needs home Wi-Fi or the iPhone hotspot — on eduroam it offers to switch to the hotspot. Turns itself off after 15 min unused | Control Centre → AirPlay, or Start menu → AirPlay Receiver |
| **KDE Connect (GSConnect)** | Clipboard both ways, send files/links, run commands on the laptop from the phone | Phone: KDE Connect app (keep it open) · laptop: `bapirlo-iphone` |
| **iCloud** | iCloud.com (Photos, Drive, Notes) in its own window; optional Photos download | Start menu → iCloud · `bapirlo-icloud setup` |
| **LibrePods** | AirPods battery, noise control and ear detection | Top bar AirPods chip (when connected) · Start menu → LibrePods |
| **Windows drive** | Your Windows C: drive in Files (read-only unless you ask) | Files → **Windows** in the sidebar · Places menu in the top bar |
| **Restart to Windows** | Restart straight into Windows once; the next normal restart comes back here | Start menu → Restart to Windows · Control Centre footer (Windows icon) |
| **RustDesk** | Remote access to this laptop (off unless you switch it on) | Control Centre → Remote · Start menu → RustDesk shows your ID |

### Productivity

| App / tool | What it's for | How to open |
|---|---|---|
| **Kuro Welcome** | Clock, weather, today's events, battery/CPU/storage, updates, quick launchers, mode switches. Opens on your first login of the day | Start menu → Kuro Welcome |
| **Login briefing** | A short "today" card after login: events, weather, battery | Automatic · [[Super+Alt+B]] shows it again |
| **Desktop widgets** | Clock, Calendar, Up next (your Google Calendar via GNOME Online Accounts), Weather (3-day), System (CPU, memory, temperature, battery, disk). Colours follow the wallpaper. Edit mode: drag cards anywhere (they snap to edges and each other), click a name to show / hide a card, *Reset layout* | On the desktop; hidden when windows cover them · [[Super+Alt+E]] edit |
| **Launchpad** | Mac-style full-screen app grid with search and folders | [[Super+G]] · dock icon |
| **Start menu (ArcMenu)** | Apps, search, places | Tap [[Super]] |
| **Run box** | Spotlight-style search / launcher | [[Super+Space]] |
| **Clipboard history** | Everything you copied | [[Super+V]] |
| **Emoji picker** | Search and paste emoji | [[Super+.]] |
| **Focus timer** | 25 min focus blocks + 5 min breaks in the top bar, next to the clock. Notification pop-ups stay off during a block. Click = pause, right-click = stop. The Welcome app's FOCUS card shows today, this week and your streak | [[Super+Alt+F]] · Start menu → Focus Timer · `bapirlo-focus` (`start 50`, `stats`, `set 50 10`) |
| **Vault** | An encrypted folder (`~/Vault`) for private files; locks itself after 15 min idle, on lock and on logout | [[Super+Alt+V]] · Control Centre → Vault |
| **Bitwarden** | Password manager | Start menu → Bitwarden |
| **Downloads tidy** | Once a day sorts loose files in Downloads into folders; old installers and duplicate files go to the Bin | Automatic · `bapirlo-tidy --dupes` to clear duplicates now |
| **Google Drive** | Drive as a folder (`~/GoogleDrive`) | `bapirlo-gdrive setup` once |
| **Picture-in-picture** | PiP windows from Chrome/Firefox stay on top and remember their place | Automatic |
| **Pop-out (any window)** | A live mini copy of any window (video, call, game, build log) floats in a corner above everything, on every workspace — minimise the original or leave its workspace and it keeps playing. Drag = move (snaps to a corner), scroll = size, Ctrl+scroll = see-through, double-click = go to the window, middle-click / ✕ = close. Hidden in the overview and when locked | [[Super+Alt+I]] on the window (again closes it) · window menu ([[Alt+Space]] or right-click the title bar) → *Picture in Picture* |
| **Caffeine** | Stop the screen from sleeping (e.g. during a lecture video) | Control Centre → Caffeine |
| **Files** | File manager, with Windows bookmarks | [[Super+E]] · dock |

### Extensions (top bar & desktop)

| Extension | What it does | Where you see it |
|---|---|---|
| **Kuro Bar** | The whole top bar: logo, workspace numbers, quick launch, power chip, app name, capsules | Top bar |
| **Logo Menu** | Mac-style menu on the Kuro logo: About, App Grid, Software, System Monitor, Terminal, Extensions, Force Quit, Sleep/Restart/Shut Down, Lock, Log Out | Click the **B** logo |
| **Kuro Control Centre** | Mac-style tiles: Wi-Fi, Bluetooth, power mode, DND, Night Light, Caffeine, Screen Rec, Dark Style, sound, brightness, AirPlay, Remote, Captions, Vault, battery, storage, now playing | Top-right capsule · [[Super+S]] |
| **Kuro Dynamic Island** | The clock capsule grows to show volume/brightness, media, notifications, battery and screenshots | Top centre |
| **Kuro Media** | Media button and dropdown (cover, seek, volume, players) | Top bar music note |
| **Kuro Desk** | Desktop widgets, login briefing, Launchpad, PiP on top, pop-out PiP, privacy dots, AirPods chip | Desktop / top bar |
| **Kuro Game Mode, AI, Sounds, Session** | Game detection; Super+A terminal; the Kuro sound theme; reopening your apps after login | — |
| **Places Status Indicator** | Folder icon: Home, bookmarks, the **Windows** drive and its folders, Network, Trash | Folder icon in the top bar |
| **Removable Drive Menu** | Eject icon when a USB stick is plugged in | Eject icon in the top bar |
| **Lock Keys** | Shows a Caps Lock icon while Caps Lock is on; Caps/Num Lock changes pop up in the Island | Top bar (only when on) |
| **Bluetooth Battery Meter** | Battery of connected Bluetooth devices | Top bar / Bluetooth list |
| **Just Perfection** | Small tweaks: slightly faster animations, banners top-right when the Island steps aside, start on the desktop | — |
| **Alphabetical App Grid** | Keeps the app grid and folders A→Z | Launchpad / app grid |
| **Wiggly** | Shake the mouse to make the cursor big so you can find it | Shake the mouse |
| **Vitals** | CPU %, temperature, memory | Top bar |
| **SimpleWeather** | Weather | Top bar |
| **Arch Update** | Number of updates; click to update | Top bar (only when there are updates) |
| **Clipboard Indicator, Emoji Copy, Caffeine** | Clipboard history, emoji, keep awake | Shortcuts above |
| **Dash2Dock Animated** | The dock (hides when a window touches it, magnifies) | Bottom of the screen |
| **ArcMenu** | Start menu + run box | [[Super]] · [[Super+Space]] |
| **Coverflow Alt-Tab** | 3D window switcher | [[Alt+Tab]] |
| **Blur my Shell, Rounded Window Corners, Burn My Windows, Magic Lamp, Desktop Cube** | Blur, rounded windows, open/close animation, minimise animation, cube when switching workspaces | — |
| **Smart Auto Move NG** | Reopens apps on the workspace and position they had | — |
| **Desktop Icons (DING)** | Home and Bin on the desktop | Desktop |
| **GSConnect** | KDE Connect for the iPhone | — |
| **AppIndicator** | Tray icons (Toolbox, LibrePods…) | Top bar extras capsule |
| **Tiling Shell** | Snap layouts with 10 px gaps: drag a window to the top edge for the layout picker; Super+arrows move a window between tiles | [[Super+←]] [[Super+→]] [[Super+↑]] [[Super+↓]] |

### System tools

| App / tool | What it's for | How to open |
|---|---|---|
| **Kuro Doctor** | Checks every extension, service, snapshot, disk space and Spotify theme; tells you what to fix | Start menu → Kuro Doctor · `bapirlo-doctor` |
| **Kuro OS Guide** | This manual | Start menu → Kuro OS Guide |
| **About This PC** | Specs, battery health, MSI modes | Start menu → About This PC · Logo menu |
| **Settings** | GNOME settings (Wi-Fi, displays, sound, users…) | Control Centre gear · Start menu |
| **Timeshift** | System snapshots: browse, create, restore | Start menu → Tools → Timeshift |
| **Cachy-Update / Arch Update** | System + AUR update in a terminal (snapshot first, automatically) | Top-bar update icon · `bapirlo-update` |
| **CachyOS Package Installer, Shelly** | Install apps with a GUI | Start menu |
| **Extension Manager / Extensions** | Switch extensions on and off | Start menu · Logo menu → Extensions |
| **Resources, btop, Power Statistics** | What is using CPU/RAM/GPU; battery history | Start menu · Logo menu → System Monitor |
| **Disks, Disk Usage Analyzer** | Drives (look, don't format!), what fills the disk | Start menu → Tools |
| **MControlCenter** | MSI fan / battery settings (Kuro already manages them — see Power below) | Start menu → Tools |
| **NVIDIA Settings, CachyOS Kernel Manager, SchedExt Manager** | GPU, kernels, CPU schedulers | Start menu → Tools |
| **Kuro commands** | `bapirlo-doctor`, `bapirlo-windows`, `bapirlo-mode`, `bapirlo-vault`, `bapirlo-update`… | Any terminal (they live in `~/bapirlo-os/bin`) |

---

## b) Every keyboard shortcut

| Shortcut | What it does |
|---|---|
| [[Super]] (tap) | Start menu (ArcMenu) |
| [[Super+Space]] | Run / search box |
| [[Super+/]] | **Cheat sheet of every shortcut** (read live; type to filter) |
| [[Super+G]] | Launchpad (all apps) |
| [[Super+S]] | Control Centre |
| [[Shift+Super+S]] | GNOME's original quick settings ("Classic") |
| [[Super+A]] | Kuro AI terminal (Claude) |
| [[Super+Enter]] | Drop-down terminal (ddterm) |
| [[Super+E]] | Files (home folder) |
| [[Super+V]] | Clipboard history |
| [[Super+.]] | Emoji picker |
| [[Super+L]] | Lock the screen |
| [[Super+N]] | Focus the newest notification |
| [[Super+D]] | Show the desktop |
| [[Super+H]] | Minimise window |
| [[Super+Up]] / [[Alt+F10]] | Maximise / toggle maximise |
| [[Super+Down]] / [[Alt+F5]] | Restore window size |
| [[Super+Left]] / [[Super+Right]] | Snap window to the left / right half |
| [[Super+Shift+Left]] / [[Super+Shift+Right]] | Move window to the other monitor |
| [[Alt+Tab]] / [[Shift+Alt+Tab]] | Switch windows (Coverflow) |
| [[Super+Tab]] / [[Shift+Super+Tab]] | Switch apps |
| [[Alt+F4]] | Close window |
| [[Super+1]] … [[Super+4]] | Open/switch to dock app 1–4 · [[Super+Ctrl+1]]… = new window of it |
| [[Super+Page Up]] / [[Super+Page Down]] | Previous / next workspace (also [[Ctrl+Super+Left]] / [[Ctrl+Super+Right]], [[Ctrl+Alt+Left]] / [[Ctrl+Alt+Right]]) |
| [[Super+Shift+Page Up]] / [[Super+Shift+Page Down]] | Move window to previous / next workspace |
| [[Super+Home]] / [[Super+End]] | First / last workspace |
| [[Super+Shift+N]] / [[Ctrl+Super+D]] | Add a workspace after this one |
| [[Super+Shift+W]] / [[Ctrl+Super+F4]] | Remove this workspace (windows move to the previous one) |
| [[Print]] | Screenshot + annotate (Satty) |
| [[Shift+Print]] | GNOME screenshot / screencast tool |
| [[Ctrl+Print]] | Screenshot of the whole screen |
| [[Alt+Print]] | Screenshot of the window |
| [[Ctrl+Shift+Alt+R]] | GNOME screen recording |
| [[Shift+Super+C]] | Colour picker (copies hex) |
| [[Super+Alt+G]] | Save the last 30 s (instant replay) |
| [[Super+Alt+R]] | Instant replay on / off |
| [[Right Shift+F12]] | MangoHud overlay on / off (in games) |
| [[Super+Alt+M]] | Media panel |
| [[Super+Alt+B]] | Show today's briefing |
| [[Super+Alt+E]] | Edit desktop widgets (Esc when done) |
| [[Super+Alt+I]] | Pop the window out as a live picture-in-picture / close it |
| [[Super+Alt+L]] | Next top-bar look |
| [[Super+Alt+V]] | Vault lock / unlock |
| [[Super+Alt+F]] | Focus timer: start a 25 min block / stop (with the focus tunnel) |
| [[Super+Alt+X]] (hold) | X-ray peek: see what's behind the window under the pointer |
| [[Super+Alt+T]] | Wallpapers → Theme tab (Theme Studio) |
| [[Super+Alt+P]] | Wallpapers → Wallpapers tab |
| [[Super+Alt+N]] | Next wallpaper |
| [[Super+Alt+C]] | Live Captions on / off (once installed) |
| [[Shift+Super+H]] | Kuro Writer on the clipboard text |
| [[Super+Alt+8]], [[Super+Alt+=]] / [[Super+Alt+-]] | Magnifier on, zoom in / out |
| [[Super+Alt+S]] | Screen reader on / off |
| [[Super+F1]] | GNOME help |
| [[Ctrl+Alt+Delete]] | Log out dialog |
| [[Super+Escape]] | Give shortcuts back if an app grabbed the keyboard |
| [[Ctrl+Alt+F3]] | Text console (TTY) for emergencies · [[Ctrl+Alt+F8]] goes back to the desktop ([[Ctrl+Alt+F7]] = login screen) |
| *In fish:* [[Ctrl+R]] search past commands, [[Ctrl+T]] insert a file path, [[Alt+C]] jump into a sub-folder · `z part-of-name` jumps to a folder you've been in, `zi` picks from a list |
| *In ddterm:* [[Ctrl+Shift+N]] new tab, [[Ctrl+Shift+Q]] close tab, [[Alt+1]]…[[Alt+0]] go to tab, [[Ctrl+Shift+F]] find, [[Ctrl+Plus]] / [[Ctrl+Minus]] font size |

Touchpad: three fingers up = overview, three fingers left/right = switch workspace. In the top bar: scroll on the workspace numbers to switch,
scroll on the Control Centre capsule for volume.

---

## c) How each Kuro OS feature works — and how to turn it off

Every Kuro change was made by a script in `~/bapirlo-os`. Each one made a backup in `~/theme-backups` first, and each can undo itself
with `bash ~/bapirlo-os/<script>.sh restore`. For an extension the quick off switch is `gnome-extensions disable <name>`
(or the Extensions app). To put it back, use `enable`.

### Look & boot

- **Boot splash and menu.** The GRUB theme and the Plymouth "awakening" splash are themed. *Off:* `sudo bash ~/bapirlo-os/restore-boot-v2.sh`.
  (The Limine/GRUB boot setup itself was never changed.)
- **Login and lock screen.** This is the web-greeter "Kuro" theme. Because GNOME's own lock needs GDM, locking goes through the same screen:
  `bapirlo-lockd` locks on [[Super+L]], after 10 minutes idle and before suspend. *Back to the plain login screen:* `sudo bapirlo-greeter-revert`.
- **Theme everywhere.** GTK3, GTK4, Qt (Kvantum) and the shell all use one palette: ink black, crimson, ember, sakura and paper. *Undo:* `bash ~/bapirlo-os/410-toolkits.sh restore`, `bash ~/bapirlo-os/60-desktop-v2.sh restore`.
- **Wallpapers.** One library: your files in `~/Pictures/wallpapers/bapirlo` (files in its `dawn/ day/ dusk/ night/`
  folders are tagged with that time) plus the Kuro originals, 4 of them live. Pictures: jpg, png, webp. Live:
  mp4, webm, mkv, mov, gif — played by Hanabi on the Intel GPU (the NVIDIA card stays asleep), paused on battery,
  with a maximised or fullscreen window and in the overview; a still frame of the video is what the lock screen and
  the overview show. *Modes:* **Fixed** (what you picked), **Time of day** (dawn · day · dusk · night from sunrise and
  sunset, a different tagged one each day), **Shuffle** (every N hours). Picking one always switches to Fixed.
  *Colours follow the wallpaper:* a Theme Studio theme is made from it (cached per wallpaper, the 12 newest kept,
  named "Wallpaper · …") and applied with the usual cross-fade. Applying a theme yourself in Theme Studio wins — its
  own wallpaper shows — until you pick a wallpaper again. Night Light still follows sunrise and sunset.
  `bapirlo-wallpaper status` shows everything. *Undo:* `bash ~/bapirlo-os/1110-round11.sh restore`
  (and `bash ~/bapirlo-os/1100-round11-install.sh restore` for the live engine).
- **Wallpaper accent.** When the colours don't follow the wallpaper, the second accent colour (pink) still does, while black and crimson stay. *Off:* `systemctl --user disable --now bapirlo-autotheme.service`.
- **Theme Studio.** Pick a wallpaper (or drop one into `~/Pictures/Theme Studio` and press *Preview* on the
  notification). It reads the colours with matugen (the same code as the wallpaper accent), builds a palette in the
  Kuro shape — same dark base, same contrast — and checks every text/background pair against WCAG AA before you
  apply. *Apply* re-themes the shell, top bar, dock, ArcMenu, Control Centre, Island, media widget, notifications,
  GTK 3/4 apps, Qt (Kvantum), terminals, fastfetch, the lock & login screen, and VS Code / Chrome / Spotify / Discord
  themes when those apps are installed; the screen cross-fades, no logout. Every applied theme is saved; **Original
  Kuro OS** puts back the exact files and settings you had. *Also apply to login & boot* (password) recolours the
  boot splash and rebuilds the boot images, with a backup and automatic roll-back.
  How it stays safe: the original themes are never edited; Studio writes recoloured copies (`Bapirlo-Studio-A/B`) and
  switches names. *Off:* apply Original, then `bash ~/bapirlo-os/studio/install.sh restore`.
- **Cursor (Bapirlo-Cursors).** The WhiteSur shapes in ink and paper with a hard blood-red drop shadow, a crimson busy
  spinner; the login screen uses it too. *Off:* `bash ~/bapirlo-os/820-round8.sh restore` (session) and
  `bash ~/bapirlo-os/800-round8-install.sh restore` (login screen).
- **Folder icons.** Crimson manga folders (ink line art, halftone corner, same drop shadow) with white glyphs for Home,
  Desktop, Documents, Downloads, Music, Pictures, Videos and the rest. Rebuilt by `tools/build-folders.py`.
- **Pop-ups (OSD).** Volume and brightness normally show in the Island; in fullscreen apps, and for Caps Lock or
  display switching, GNOME's pop-up appears instead — styled as an ink pill with a crimson bar like the Island.
- **Window animation (Kuro Panels).** Windows open like a manga panel slapped on the page — slide in with a tilt,
  an ink frame and a comic "BAM!" burst — and flick away when closed. Dialogs, fullscreen windows and Settings →
  Accessibility → Reduce animation keep GNOME's own. No burst: `gsettings --schemadir ~/.local/share/gnome-shell/extensions/bapirlo-panels@bapirlo-os/schemas set org.gnome.shell.extensions.bapirlo-panels sfx false`.
  *Off:* `gnome-extensions disable bapirlo-panels@bapirlo-os` (then `gnome-extensions enable burn-my-windows@schneegans.github.com` for the old glide).
- **Sounds.** The Kuro sound theme plays on log-in, notifications and so on. *Off:* Settings → Sound → Alert sound, or `gnome-extensions disable bapirlo-sounds@bapirlo-os`.

### Top bar, dock & menus

- **Top bar (Kuro Bar).** Kuro Bar groups everything into capsules. Red appears only for states that need you: recording, low battery, Do Not Disturb, Caffeine.
  The bar hides over fullscreen apps; push the mouse to the top edge to bring it back. *Off:* `gnome-extensions disable bapirlo-bar@bapirlo-os`.
- **Focus timer.** Part of Kuro Bar. [[Super+Alt+F]] starts a block; the chip next to the clock counts down in crimson and switches notification
  pop-ups off (only if they were on). When the block ends, the Island says so with a sound, and a jade 5 min break starts on its own. The next block never starts by itself.
  Every finished or stopped block (1 min or longer) is written to `~/.local/state/bapirlo/focus.tsv`. *Change lengths:* `bapirlo-focus set 50 10`.
- **Logo menu.** Clicking the B logo opens the Mac-style menu. The Start menu (ArcMenu) still opens with [[Super]]. *Off:* disable `logomenu@aryan_k`,
  then `gsettings set org.gnome.shell.extensions.arcmenu menu-button-appearance Icon` to bring ArcMenu's logo back.
- **Control Centre.** It replaces GNOME's quick settings menu. GNOME's original is one click away ("Classic", or [[Shift+Super+S]]).
  Wi-Fi and Bluetooth tiles: click the round icon to toggle, click the rest to see networks or devices. Right-click or long-press a tile for its details.
  The pencil button edits which tiles are shown. *Off:* `gnome-extensions disable bapirlo-control-centre@bapirlo-os`.
- **Dynamic Island.** The clock capsule shows volume, brightness, media, notifications, battery and screenshots. With a fullscreen app on the main screen it steps aside,
  and normal banners appear top-right instead. *Off:* `gnome-extensions disable bapirlo-island@bapirlo-os`.
- **Dock (Dash to Dock).** At the bottom, hides when a window touches it, crimson dots for open apps; clicking an open app
  focuses it (or minimises it / shows its windows), middle-click opens a new window. It replaced dash2dock-lite on 23 Oct,
  which crashed GNOME when apps closed. Settings: `config/dash-to-dock-kuro.dconf`. *Back to the old dock:* `bash ~/bapirlo-os/960-dock-swap.sh restore`.
- **Shortcut cheat sheet (Kuro Keys).** [[Super+/]] lists every shortcut — your custom ones, every extension's and
  GNOME's window/workspace keys — read fresh each time, so it is never out of date. *Off:* `gnome-extensions disable bapirlo-keys@bapirlo-os`.
- **Launchpad.** [[Super+G]] opens it. It has search, A→Z sorting, folders, and [[Esc]] closes it. It lives in Kuro Desk:
  `gsettings set org.gnome.shell.extensions.bapirlo-desk launchpad-toggle "[]"` removes the shortcut.
- **Desktop widgets and login briefing** (Kuro Desk). Clock, Calendar, Up next, Weather and System only show on an empty desktop ([[Super+Alt+E]] to move or hide them). The briefing appears once after login.
  *Off:* Kuro Desk settings, or `gnome-extensions disable bapirlo-desk@bapirlo-os` (this also turns off Launchpad, PiP and privacy dots).
- **Privacy dots.** A red dot means the microphone is on, green means the camera, blue means screen sharing. They sit in the system capsule. Part of Kuro Desk.
- **Session restore.** After login, the apps you had open come back on their workspaces. *Off:* disable `bapirlo-session@bapirlo-os` and `SmartAutoMoveNG@lauinger-clan.de`.

### Kuro Lens (round 21)

- **X-ray peek.** Hold [[Super+Alt+X]]: a round lens at the pointer shows the windows and desktop underneath the
  window you're over. Let go of Super to close it. *Lens size:* `gsettings set org.gnome.shell.extensions.bapirlo-lens xray-radius 220`
  (needs `--schemadir ~/.local/share/gnome-shell/extensions/bapirlo-lens@bapirlo-os/schemas`).
- **Window shelf.** Fling a window fast sideways into the left or right screen edge: it's minimised and a live thumbnail
  peeks out of that edge. Hover = it slides out, click = the window comes back where it was, middle-click = close it.
  *Off:* set the `shelf` key to false (same schema as above).
- **Focus tunnel.** While a focus block runs ([[Super+Alt+F]]) everything but the focused window fades back behind a dark
  blur, and when it ends Kuro says how many notifications waited. *Off:* key `tunnel` false; `tunnel-blur` false = dim only (cheaper).
- **Air-draw.** With air gestures on, hold 🤟 and draw in the air: ◯ search, ✓ screenshot, Z zoom canvas, △ apps,
  ^ overview, L lock. Change them in `~/.config/bapirlo/gestures.json` → `"draw"`.

### Kuro Cosmos (round 22)

All of these live in one extension, `bapirlo-cosmos@bapirlo-os`. `bapirlo-cosmos` shows which are on and
`bapirlo-cosmos PART on|off` switches one (PART = blackhole echo supernova wormhole breathe shatter aurora living).
Kuro Settings → Extensions → Kuro Cosmos has the same switches.

- **Black hole.** Throw a window hard *diagonally* into a screen corner and a black hole swallows it: the window is closed
  (if the app asks to save, the window comes back). Sideways throws still go to the window shelf.
  Try it safely: `bapirlo-cosmos demo blackhole` feeds it a throwaway window of its own.
- **Echo windows.** A closed window leaves a fading after-image for ~5 s, with a **↺ Reopen** pill that opens the app again.
- **Supernova.** Critical notifications (battery very low, incoming calls) burst out of the island as a shockwave.
- **Wormhole.** Workspace switches fly through a short star tunnel.
- **Time dilation.** Hold [[Super+Shift+Z]]: animations ×5 slower, precision pointer, media at half speed (players that
  allow it). Let go of Super to end. `bapirlo-cosmos slow on|off` does it without holding keys.
- **Breathing desktop.** The wallpaper gently breathes (6 breaths/min, slower during focus or bedtime).
- **Gravity wells.** [[Super+Alt+P]] makes the focused window a planet: the others (and new ones) orbit it. Drag a moon far
  away to free it; [[Super+Alt+P]] on the planet again sends everything home.
- **Shatter lock.** Locking cracks the desktop like glass; unlocking puts it back together. The lock itself is instant, and
  nothing is drawn when locking for suspend or after idling.
- **Aurora sky** (off by default: `bapirlo-cosmos aurora on`). A night-sky wallpaper: the aurora follows CPU load, each
  notification is a shooting star, and a comet crosses while something downloads into ~/Downloads.
- **Constellation.** [[Super+Shift+Space]]: your apps as stars, bigger for apps you use more, linked when you use them on the
  same days. Type to light stars up, [[Enter]] launches, [[Esc]] closes.
- **Living OS.** Apps you use most glow on the dock; pinned apps unused for 2 weeks gather dust; a garden grows along the bottom
  corners of the wallpaper (a sprout per day you use the computer, flowers after two weeks). Folders untouched for 30/90/180
  days get a mossy icon (daily `bapirlo-living.timer`); `bapirlo-cosmos tidy` lists them with Open · Keep · Archive (→ ~/Archive)
  · Bin. Moss is only Files' custom-icon metadata: `bapirlo-living clear` removes it everywhere.
- *Remove all of round 22:* `bash ~/bapirlo-os/2200-round22.sh restore`.

### Kuro Flow (round 23)

Get-things-done tools in one extension, `bapirlo-flow@bapirlo-os`. `bapirlo-flow` shows the switches.

- **Window hints.** [[Super+;]]: every window gets a letter (minimised ones in a strip at the bottom). Type it to jump there; [[Esc]] cancels.
- **Command palette.** [[Super+Shift+P]]: run anything by name: the focused app's actions (launcher actions + the actions GTK
  apps publish), every Kuro command, dark/light mode, night light, every Settings page, your open windows. Fuzzy matching;
  [[↑]]/[[↓]] and [[Enter]], or [[Alt+1…9]].
- **Text expander.** Type a key such as `;ty` and a space (or Tab/Enter) in any text field: it becomes the snippet. Built in:
  `;date ;time ;now ;iso ;week ;shrug`. Yours: Kuro Settings → **Snippets**, or `bapirlo-snippets add ;sig "Best wishes"`.
  Never in password fields; terminals don't support it. *Off:* `bapirlo-flow expander off`.
- **One-key arrange.** [[Super+A]] tiles the windows on the focused monitor (latest gets the biggest spot); again within 5 s = undo.
- **Screen watch.** [[Super+Shift+W]], drag a box: you get a notification (with a picture) when that area changes. ✕ on its tag stops it.
- **Meeting mode.** Automatic when the camera is on or an app keeps the mic open 10 s: banners held, music paused, desk widgets and
  the creature hidden, a call timer under the bar. 20 s after the call everything is restored. *Off:* `bapirlo-flow meeting off`.
- **Text → task.** Select text, [[Super+Shift+D]]: a to-do on the desk card, with a due day if the text says one ("by Friday",
  "tomorrow", "12 Nov", "25/11"). `bapirlo-todo add --due 2026-11-06 …` works too.
- **Deep search.** Search shows **Inside your files**: files whose contents match (documents, PDFs, Office files, words in
  screenshots via OCR). Index: `bapirlo-deepsearch status`, refreshed every 30 min by `bapirlo-deepsearch.timer` at idle priority;
  `bapirlo-deepsearch forget` deletes it.
- **Files power tools.** Files → right-click → **Scripts** → Kuro: Rename… (batch, live preview), Convert to PNG/JPG/WebP, Resize,
  Compress to ZIP, Merge PDFs, Copy without photo metadata. Never overwrites. `kuro-files uninstall` removes the entries.
- **Autopilot.** Notices repeated habits (apps you open together, apps at the same time on weekdays, the folder you always move a
  file type to) and asks once whether to automate it. Only rules you accept run. `bapirlo-autopilot list` / `forget ID` /
  `reset`. *Off:* `bapirlo-flow autopilot off`.
- *Remove all of round 23:* `bash ~/bapirlo-os/2300-round23.sh restore`.

### Power, performance & games

- **Power modes (bapirlo-perfd).** On mains power it picks Performance (MSI Turbo); on battery it picks Power Saver (Eco + silent fans).
  The battery stops charging at **80%** to protect it. Set in `/etc/bapirlo/perfd.conf`: `CHARGE_LIMIT=100` charges fully (then `sudo systemctl restart bapirlo-perfd`). *Off:* `sudo systemctl disable --now bapirlo-perfd`.
  Use the Control Centre's power tile to pick a mode by hand until the next plug/unplug.
- **Game Mode.** A fullscreen game, or OBS going live, turns on Do Not Disturb, holds Performance and starts instant replay. *Off:* disable `bapirlo-game@bapirlo-os`.
- **Instant replay.** GPU Screen Recorder keeps the last 30 s in memory on the Intel GPU, and nothing touches the disk until you press [[Super+Alt+G]].
- **Gaming / Quiet modes.** Switches in Kuro Welcome, or `bapirlo-mode gaming|quiet|dnd on|off`.

### Phone, sharing & remote

- **LocalSend.** Opening the app opens port 53317, for home networks only, and quitting closes it again.
- **AirPlay.** UxPlay runs only while the toggle is on, asks for a code the first time, and switches off after 15 minutes with nobody connected. Settings: `~/.config/bapirlo/airplay.conf` (IDLE_MIN, SIZE, FPS, HOTSPOT).
- **RustDesk.** Off by default. When it's on, it connects out to RustDesk's servers, so no ports are opened, and it uses a permanent password saved in your keyring.
  The ID and password are available with `bapirlo-remote id` and `bapirlo-remote password`. It disconnects after 30 minutes idle and works only while you are logged in.
- **iPhone (GSConnect).** Run `bapirlo-iphone setup` once after pairing. The phone app must be open to talk to the laptop.
- **iCloud Photos.** Off until you run `bapirlo-icloud setup`, then it syncs every 6 hours. *Off:* `bapirlo-icloud off`.

### Files & privacy

- **Vault.** An encrypted folder (gocryptfs). Unlock it with [[Super+Alt+V]] and your Vault password. It locks after 15 minutes idle, on screen lock, before suspend and at logout.
  **Without the password or the recovery key it can't be opened, by anyone.**
- **Downloads tidy.** Runs once a day and moves loose files into folders. Installers older than 30 days go to the Bin, never deleted.
  *Duplicates:* identical files (e.g. `CV.pdf` and `CV (1).pdf`) keep one copy and the rest go to the Bin. Run `bapirlo-tidy --dupes` to do it right now, or `bapirlo-tidy --dupes --dry-run` to just see the list.
  *Off:* `systemctl --user disable --now bapirlo-tidy.timer`.
- **Shoulder-surf guard.** When the webcam sees a second face behind you, the screen blurs and notification
  banners wait until it's gone. Click the blur = "it's fine" for 2 minutes. A face that never moves for 30 s (a poster) is ignored.
  It shares the camera daemon with air gestures; nothing is saved or sent. *On / off:* `bapirlo-guard on|off`, `bapirlo-guard snooze 30`.
- **Security pass (round 21).** `sudo bash ~/bapirlo-os/2100-round21-security.sh` turns on: private DNS (Cloudflare + Quad9,
  encrypted when the network allows it; LLMNR off), a made-up Wi-Fi MAC per network (your home Wi-Fi keeps the real one),
  USBGuard (new USB devices are blocked until you click *Allow once* / *Always allow* in the popup — `kuro-usb-guard` service)
  and AppArmor (after a reboot). Kuro Doctor's *Security* section shows what's on. *Undo:* `sudo bash ~/bapirlo-os/2100-round21-security.sh restore`.
- **Firewall.** Blocks everything coming in. Only phone sharing, Steam LAN and mDNS are allowed, and only from home networks. *Check:* `sudo ufw status`.

### Keeping it healthy

- **Snapshot before every update.** A pacman hook takes a Timeshift snapshot once per update run and keeps only the newest one.
  It is skipped when less than 15 GB is free, so the update has room. Timeshift also keeps 2 weekly snapshots.
  *Skip once:* `sudo touch /run/bapirlo-nosnap`. *Off:* `sudo rm /etc/pacman.d/hooks/00-bapirlo-timeshift.hook`.
- **Kuro Doctor.** Runs after every system update and 90 s after each login, and only notifies you when something is wrong. For example, a GNOME update an extension doesn't
  support yet gets switched off at your next login. *Off:* `systemctl --user disable --now bapirlo-doctor.path bapirlo-doctor.timer`.
- **Health page.** The Welcome app's HEALTH card shows battery wear (capacity vs. new), the SSD's own health report
  (write life left, spare blocks, media errors, temperature, hours on, data written) and free space. The Doctor checks
  the same: battery below 60 % of new, or any SSD warning, is reported as a problem.
- **Low-space warning.** Every 30 min `bapirlo-diskwatch.timer` checks `/`; below 15 GB you get one notification a day
  (below that, updates skip their safety snapshot). *Off:* `systemctl --user disable --now bapirlo-diskwatch.timer`.
- **Spotify theme auto-reapply.** When Spotify updates itself, `bapirlo-spicetify.path` puts the theme back. *Off:* `systemctl --user disable --now bapirlo-spicetify.path`,
  then `bapirlo-spicetify off` for the stock look.
- **Every update cleans up after itself.** Old package versions and half-finished downloads go (pacman hook `zz-bapirlo-pkgcache.hook`),
  along with paru's AUR build files and old Claude Code versions (the one you run and one fallback stay). *Now, without updating:* `bapirlo-update --cleanup`.
- **Monthly cleanup.** Clears the package cache (keeps 2 versions), removes orphans and trims old logs, then tells you what it freed. *Off:* `sudo systemctl disable --now bapirlo-cleanup.timer`.
- **Extension updates.** Extensions from extensions.gnome.org update through the Extension Manager app. Kuro's own extensions come from `~/bapirlo-os`.

---

## d) Windows

**Your Windows files.** Open Files and click **Windows** in the sidebar, or use the folder icon in the top bar → Windows. You can also go straight to
**Windows Desktop / Documents / Downloads / Pictures / Shared**, which are bookmarks in Files. Your Desktop, Documents and Pictures are the OneDrive ones.
The drive opens **read-only**: you can open and copy anything, but you can't change it. That is deliberate.

**Writing to Windows.** Run `bapirlo-windows rw`. It refuses unless Windows was fully shut down: Fast Startup off, no hibernation, no BitLocker, and the drive clean.
When you're done, run `bapirlo-windows ro`. `bapirlo-windows check` shows the safety flags at any time.

**Switching systems.**
- **To Windows:** Start menu → **Restart to Windows**, or the Windows button in the Control Centre footer. This boots Windows **once**.
  The boot order isn't changed, so the next normal restart comes back to Kuro OS. During start-up you can also use the boot menu: Limine, or **F11** for the MSI boot picker.
- **Back to Linux:** in Windows, just restart (not "Update and restart" into a loop). Kuro OS is the default.

**Shared files (both ways).** Use the **`C:\Shared`** folder:
- In Windows, it's `C:\Shared`.
- In Linux, it's Files → **Windows Shared**.
- Windows → Linux: save into `C:\Shared` in Windows, and it's readable here immediately.
- Linux → Windows: run `bapirlo-windows rw`, copy into Windows Shared, then run `bapirlo-windows ro`.
- Windows can't read Linux drives. To go the other way, put files in Shared, or use OneDrive, Google Drive or LocalSend.

**Clock.** Linux keeps the hardware clock in UTC. Windows keeps local time, which makes the clock jump an hour after switching.
**Fix once, in Windows:** double-click `C:\Shared\Fix clock for Linux (double-click).reg`, say Yes, then restart Windows.

**Bluetooth (AirPods etc.).** A device paired on both systems has two different keys, so the other system "forgets" it. `sudo bapirlo-bt-sync`
compares the keys, and `sudo bapirlo-bt-sync --apply` copies Windows' keys to Linux so they work in both without re-pairing.
**Pair in Linux first, then in Windows, then run `--apply` in Linux.** Re-run it whenever you re-pair in Windows.

**Never do this:**
- **Never write to the Windows drive if Fast Startup or hibernation is on.** Windows keeps the drive "half-open", and writing can corrupt it.
  `bapirlo-windows rw` checks this for you. In Windows, Control Panel → Power Options → Choose what the power buttons do → untick **Turn on fast startup**.
  It's off at the moment.
- **Never use "Disks" or any partition tool on the NVMe drive.** Windows, its recovery partitions, the EFI partition and Linux all share it.
- **Never turn on BitLocker / Device Encryption in Windows** without telling Linux. The drive just disappears from Files, and Windows may ask for a recovery key after Linux boots.
  Save the key in your Microsoft account first.
- Don't let Windows Update "repair the boot". If Linux stops appearing, pick Limine or CachyOS in the F11 boot picker. Your boot entries are still there.
- Don't delete the old `vmlinuz-*`, `initramfs-*` and `intel-ucode.img` files in `C:\` from Linux while Windows is running. They're stale copies and harmless; delete them from Windows if you like.

---

## e) Troubleshooting

**First, always:** run **Kuro Doctor** (Start menu, or `bapirlo-doctor` in a terminal or TTY). It lists what is broken and changes nothing.

### The desktop is frozen
1. Wait 10 seconds. Then press [[Esc]] and [[Super]]. A stuck menu or popup is the usual cause, and Esc closes it.
2. Press [[Super+Escape]]; this gives the shortcuts back from an app.
3. Still frozen? Press [[Ctrl+Alt+F3]] for a text login (TTY). Log in with your username and password, then:
   ```
   bapirlo-doctor                         # what's wrong
   export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus
   gsettings set org.gnome.shell disable-user-extensions true    # all extensions off (live)
   ```
   Press [[Ctrl+Alt+F8]] to go back to your desktop. If it unfroze, an extension was the cause. Turn them back on one by one in the Extensions app,
   and finally turn the main switch back on with `gsettings set org.gnome.shell disable-user-extensions false`.
4. Still nothing: from the TTY run `sudo systemctl restart lightdm`. Unsaved work in open apps is lost.
5. Totally stuck, no TTY: hold the power button for 10 s.

### An extension disappeared or is "disabled" after an update
GNOME updates switch off any extension that doesn't list the new version. Kuro Doctor notifies you after the update.
- **Others' extensions** (Vitals, ArcMenu…): open **Extension Manager → Updates**. Usually a new version arrives within days.
- **Kuro's own extensions** (`bapirlo-*`): the code is in `~/bapirlo-os`. Ask Claude to add the new version and test it, or as a quick fix add the
  number to `"shell-version"` in the extension's `metadata.json` and log out and in.
- **Never** turn on "disable version validation" permanently. A truly incompatible extension can crash the shell at login. If that happens, use the TTY steps above.

### The login screen fails (black screen, loops, or won't accept the password)
1. [[Ctrl+Alt+F3]], log in, run `sudo bapirlo-greeter-revert`. This switches back to the plain LightDM login (slick-greeter), and then `sudo systemctl restart lightdm`.
2. Password refused everywhere? Caps Lock (the top bar shows its icon), keyboard layout (UK), or a broken keyring. In the TTY, `passwd` changes it.
3. Logs: `sudo journalctl -b -u lightdm` and `/var/log/lightdm/`.
4. Bring the Kuro login screen back later with `sudo bash ~/bapirlo-os/500-round5-greeter.sh switch`.

### No Wi-Fi
1. Control Centre → Wi-Fi tile: is it on? Is Aeroplane mode off? A Fn key may have switched the radio off.
2. In a terminal:
   ```
   nmcli radio wifi on
   rfkill unblock all
   nmcli device wifi list            # do you see networks?
   sudo systemctl restart NetworkManager
   ```
3. **eduroam:** forget and re-add it with your full uni email and password (Settings → Wi-Fi), with the security set to "PEAP / MSCHAPv2" and "No CA certificate is required" if the uni guide says so.
4. After a kernel update without a reboot, Wi-Fi, USB or Bluetooth can stop working (the old kernel's drivers were removed). **Reboot.** Kuro now keeps
   the running kernel's modules until the next reboot, so this should not happen again.
5. Phone hotspot or a USB-C Ethernet adapter gets you online to fix things.

### Boot problems
- **Stuck on the Plymouth splash:** press [[Esc]] to see the boot messages. Wait a minute, because a disk check can be running. Still stuck? Try [[Ctrl+Alt+F3]].
- **Pick another kernel or the Windows entry:** press [[F11]] at the MSI logo for the firmware boot picker, then choose **Limine**. In Limine, pick the CachyOS entry.
  GRUB itself is hidden (timeout 0); tap [[Esc]] while it starts to see its menu, where **linux-cachyos** (non-LTS) is the fallback kernel.
- **"Kernel panic" or "unable to mount root":** boot the other kernel (above). If both fail, restore a snapshot (below).
- **Broke after an update:** restore the automatic "Before update" snapshot. From the desktop, open Timeshift → select it → Restore.
  If the desktop doesn't start, use the TTY: `sudo timeshift --list`, then `sudo timeshift --restore --snapshot '<name>' --skip-grub`.

### Restore a Timeshift snapshot from the CachyOS USB (when nothing boots)
1. Plug in the CachyOS USB. At the MSI logo press [[F11]] and pick the USB (UEFI). Boot the live desktop.
2. Connect to Wi-Fi, open a terminal and run `sudo pacman -Sy --needed timeshift` (skip if Timeshift is already on the stick).
3. Run `sudo timeshift --list --snapshot-device /dev/nvme0n1p6` to see your snapshots ("Before update …", "Kuro OS final", weekly…).
4. Restore, choosing the snapshot by name:
   ```
   sudo timeshift --restore --snapshot-device /dev/nvme0n1p6 --target-device /dev/nvme0n1p6 \
                  --snapshot '2026-10-12_18-00-00' --skip-grub
   ```
   `--skip-grub` leaves the boot loader exactly as it is, which is what you want, because the boot setup (Limine/GRUB) is fine and separate.
   Or use the Timeshift app on the live desktop: Settings → Location = the 150 GB Linux partition → pick the snapshot → Restore → **don't reinstall the bootloader**.
5. Remove the USB and reboot.
   - **Never pick nvme0n1p1 (EFI) or p3 (Windows)** anywhere in this process. The Linux partition is **nvme0n1p6**, ext4, 150 GB.
   - Home folder files are included only as hidden settings. Your documents aren't in snapshots, so back those up separately (OneDrive or Google Drive).

### Other quick fixes
| Problem | Fix |
|---|---|
| Sound gone | Control Centre → Sound → pick the output; `systemctl --user restart pipewire wireplumber` |
| AirPods won't connect | Put them in the case, then hold the button until it flashes white. Bluetooth → remove → pair again, then `sudo bapirlo-bt-sync --apply` if they're also paired in Windows |
| Screen freezes ~2 s when opening Settings or other apps | The NVIDIA GPU waking up (known). Kuro's own buttons avoid it; it's harmless |
| Spotify lost its theme | `bapirlo-spicetify apply` |
| Disk almost full | Control Centre → Storage → Clean up · Disk Usage Analyzer · `sudo timeshift --list` and delete old snapshots |
| Windows drive won't open | It's in use by Windows hibernation or Fast Startup. Shut down Windows fully (Shift + Shut down), or run `bapirlo-windows check` |
| The bar or Island looks wrong after an update | Log out and in. Then Kuro Doctor |
| Undo any one Kuro change | `bash ~/bapirlo-os/<script>.sh restore` (see `~/theme-backups/LATEST-*`) |
| Undo everything since the final snapshot | Timeshift → **Kuro OS final** → Restore |

---

*Kuro OS · CachyOS + GNOME 51 · scripts, backups and this manual live in `~/bapirlo-os` (a git repo; push instructions in README).*
