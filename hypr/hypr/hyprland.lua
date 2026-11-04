-- Kuro OS — Hyprland session (Kuro). Linked into ~/.config/hypr by 1510-hyprland.sh.
-- Hyprland 0.57+ reads this Lua file (hyprland.conf is ignored once it exists).
-- Colours live in bapirlo-colors.lua, re-written by tools/hypr-theme.py whenever Theme Studio
-- re-themes for a new wallpaper, so edit the template there, not the generated file.

local home = os.getenv("HOME")
local bin  = home .. "/bapirlo-os/bin/"
local c    = dofile(home .. "/.config/hypr/bapirlo-colors.lua")

------------------------------------------------------------------ monitors
-- Laptop panel at native res, scale 1 (same as GNOME). Anything plugged in: preferred, to the right.
hl.monitor({ output = "eDP-1", mode = "highrr",    position = "0x0",  scale = 1 })
hl.monitor({ output = "",      mode = "preferred", position = "auto", scale = 1 })

------------------------------------------------------------------ environment
-- The Intel iGPU drives the panel; AQ_DRM_DEVICES is set by bapirlo-hyprland-session so the RTX stays asleep.
hl.env("XCURSOR_SIZE", "24")
hl.env("HYPRCURSOR_SIZE", "24")
hl.env("XCURSOR_THEME", "Bapirlo-Cursors")
hl.env("QT_QPA_PLATFORM", "wayland;xcb")
hl.env("QT_QPA_PLATFORMTHEME", "gtk3")
hl.env("MOZ_ENABLE_WAYLAND", "1")
hl.env("ELECTRON_OZONE_PLATFORM_HINT", "auto")
hl.env("XDG_CURRENT_DESKTOP", "Hyprland")
hl.env("XDG_SESSION_DESKTOP", "Hyprland")

------------------------------------------------------------------ autostart
hl.on("hyprland.start", function()
    hl.exec_cmd("dbus-update-activation-environment --systemd --all")
    hl.exec_cmd("systemctl --user start hyprpolkitagent")
    hl.exec_cmd("waybar")
    hl.exec_cmd("mako")
    hl.exec_cmd("hypridle")
    hl.exec_cmd("swayosd-server")
    hl.exec_cmd(bin .. "bapirlo-hypr-wallpaper")
    hl.exec_cmd("wl-paste --type text --watch cliphist store")
    hl.exec_cmd("wl-paste --type image --watch cliphist store")
    hl.exec_cmd("nm-applet --indicator")
end)

------------------------------------------------------------------ look
hl.config({
    general = {
        gaps_in     = 6,
        gaps_out    = 14,
        border_size = 2,
        col = {
            active_border   = { colors = { c.crimson, c.ember }, angle = 45 },
            inactive_border = c.line,
        },
        layout           = "dwindle",
        resize_on_border = true,
        allow_tearing    = false,
    },

    decoration = {
        rounding         = 14,
        active_opacity   = 1.0,
        inactive_opacity = 1.0,   -- 0.94 forced re-blurring the live video every frame (lag)
        shadow = {
            enabled      = true,
            range        = 18,
            render_power = 3,
            offset       = "5 5",
            color        = c.shadow,
        },
        blur = {
            enabled           = true,
            size              = 6,
            passes            = 1,
            vibrancy          = 0.17,
            new_optimizations = true,
        },
    },

    animations = { enabled = true },

    dwindle = {
        preserve_split = true,
    },

    misc = {
        disable_hyprland_logo    = true,
        disable_splash_rendering = true,
        force_default_wallpaper  = 0,
        background_color         = c.ink,
        focus_on_activate        = true,
    },

    input = {
        kb_layout    = "gb",
        follow_mouse = 1,
        sensitivity  = 0,
        touchpad = {
            natural_scroll       = true,
            tap_to_click         = true,
            disable_while_typing = true,
        },
    },

    cursor = { no_hardware_cursors = false },
})

hl.curve("snap",  { type = "bezier", points = { {0.22, 1}, {0.36, 1} } })
hl.curve("slash", { type = "bezier", points = { {0.7, 0},  {0.2, 1}  } })

hl.animation({ leaf = "windows",     enabled = true, speed = 5,  bezier = "snap",    style = "popin 82%" })
hl.animation({ leaf = "windowsOut",  enabled = true, speed = 4,  bezier = "slash",   style = "popin 82%" })
hl.animation({ leaf = "border",      enabled = true, speed = 8,  bezier = "default" })
hl.animation({ leaf = "borderangle", enabled = false })  -- "loop" redrew the whole screen at 240 Hz forever (lag)
hl.animation({ leaf = "fade",        enabled = true, speed = 5,  bezier = "snap" })
hl.animation({ leaf = "workspaces",  enabled = true, speed = 5,  bezier = "slash",   style = "slidefade 18%" })
hl.animation({ leaf = "layers",      enabled = true, speed = 4,  bezier = "snap",    style = "fade" })

hl.gesture({ fingers = 3, direction = "horizontal", action = "workspace" })

------------------------------------------------------------------ keys
-- Same muscle memory as the GNOME side where it makes sense.
local mod   = "SUPER"
local term  = "alacritty"
local files = "nautilus --new-window"
local menu  = "fuzzel"
local function key(k) return mod .. " + " .. k end
local function run(cmd) return hl.dsp.exec_cmd(cmd) end

hl.bind(key("Return"), run(term))
hl.bind(key("Space"),  run(menu))
hl.bind(key("A"),      run(menu))
hl.bind(key("E"),      run(files))
hl.bind(key("Q"),      hl.dsp.window.close())
hl.bind("ALT + F4",    hl.dsp.window.close())
hl.bind(key("F"),      hl.dsp.window.fullscreen({ mode = "fullscreen" }))
hl.bind(key("M"),      hl.dsp.window.fullscreen({ mode = "maximized" }))
hl.bind(key("T"),      hl.dsp.window.float({ action = "toggle" }))
hl.bind(key("P"),      hl.dsp.window.pseudo())
hl.bind(key("J"),      hl.dsp.layout("togglesplit"))
hl.bind(key("L"),      run("loginctl lock-session"))
hl.bind(key("SHIFT + E"), run(bin .. "bapirlo-hypr-power"))
hl.bind(key("V"),      run("cliphist list | fuzzel --dmenu --prompt 'clipboard › ' | cliphist decode | wl-copy"))

-- Kuro apps (same chords as GNOME)
hl.bind(key("ALT + P"), run(bin .. "bapirlo-wallpaper"))
hl.bind(key("ALT + N"), run(bin .. "bapirlo-wallpaper next"))
hl.bind(key("ALT + W"), run(bin .. "bapirlo-wallpaper live toggle"))
hl.bind(key("ALT + T"), run(bin .. "bapirlo-wallpapers --page theme"))
hl.bind(key("ALT + R"), hl.dsp.reload_config())

-- screenshots
hl.bind("Print",           run("hyprshot -m region -o ~/Pictures/Screenshots"))
hl.bind("SHIFT + Print",   run("hyprshot -m output -o ~/Pictures/Screenshots"))
hl.bind(key("SHIFT + S"),  run("hyprshot -m region --clipboard-only"))

-- focus / move / resize
for _, d in ipairs({ "left", "right", "up", "down" }) do
    hl.bind(key(d),             hl.dsp.focus({ direction = d }))
    hl.bind(key("SHIFT + " .. d), hl.dsp.window.move({ direction = d }))
end
local step = { left = { -40, 0 }, right = { 40, 0 }, up = { 0, -40 }, down = { 0, 40 } }
for d, xy in pairs(step) do
    hl.bind(key("CTRL + " .. d), hl.dsp.window.resize({ x = xy[1], y = xy[2], relative = true }), { repeating = true })
end

-- workspaces
for i = 1, 9 do
    hl.bind(key(tostring(i)),             hl.dsp.focus({ workspace = i }))
    hl.bind(key("SHIFT + " .. i),         hl.dsp.window.move({ workspace = i }))
end
hl.bind(key("Tab"),         hl.dsp.focus({ workspace = "e+1" }))
hl.bind(key("SHIFT + Tab"), hl.dsp.focus({ workspace = "e-1" }))
hl.bind(key("mouse_down"),  hl.dsp.focus({ workspace = "e+1" }))
hl.bind(key("mouse_up"),    hl.dsp.focus({ workspace = "e-1" }))
hl.bind(key("S"),           hl.dsp.workspace.toggle_special("scratch"))
hl.bind(key("CTRL + S"),    hl.dsp.window.move({ workspace = "special:scratch" }))

hl.bind(key("mouse:272"), hl.dsp.window.drag(),   { mouse = true })
hl.bind(key("mouse:273"), hl.dsp.window.resize(), { mouse = true })

-- media / hardware keys (swayosd draws the on-screen bubble)
local held   = { locked = true, repeating = true }
local locked = { locked = true }
hl.bind("XF86AudioRaiseVolume",  run("swayosd-client --output-volume raise"), held)
hl.bind("XF86AudioLowerVolume",  run("swayosd-client --output-volume lower"), held)
hl.bind("XF86AudioMute",         run("swayosd-client --output-volume mute-toggle"), locked)
hl.bind("XF86AudioMicMute",      run("swayosd-client --input-volume mute-toggle"), locked)
hl.bind("XF86MonBrightnessUp",   run("swayosd-client --brightness raise"), held)
hl.bind("XF86MonBrightnessDown", run("swayosd-client --brightness lower"), held)
hl.bind("XF86AudioPlay",  run("playerctl play-pause"), locked)
hl.bind("XF86AudioPause", run("playerctl play-pause"), locked)
hl.bind("XF86AudioNext",  run("playerctl next"), locked)
hl.bind("XF86AudioPrev",  run("playerctl previous"), locked)

------------------------------------------------------------------ windows
hl.window_rule({
    name  = "float-utilities",
    match = { class = "^(pavucontrol|blueman-manager|nm-connection-editor|os\\.bapirlo\\..*)$" },
    float = true,
})
hl.window_rule({
    name  = "pip",
    match = { title = "^(Picture-in-Picture|Picture in picture)$" },
    float = true,
    pin   = true,
})
hl.window_rule({
    name  = "suppress-maximize-events",
    match = { class = ".*" },
    suppress_event = "maximize",
})

for _, ns in ipairs({ "waybar", "launcher", "notifications" }) do
    hl.layer_rule({ name = "blur-" .. ns, match = { namespace = ns }, blur = true, ignore_alpha = 0.2 })
end
