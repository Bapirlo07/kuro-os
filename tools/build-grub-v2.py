#!/usr/bin/env python3
"""Kuro OS GRUB theme v2 "Kuro" -> ~/bapirlo-os/build/grub-v2/bapirlo  (no root needed).

Layout (native 2560x1600, everything in % so a 1920x1200 fallback keeps proportions):
  frosted dark-glass sidebar on the left (baked into background.png) holding the
  logo lockup, the boot menu, a thin countdown bar and key hints; the artwork
  (character + red aura) stays visible on the right.
"""
import os, subprocess, sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
sys.path.insert(0, os.path.dirname(__file__))
from palette import PAL, rgb

HOME = os.path.expanduser("~")
OUT = f"{HOME}/bapirlo-os/build/grub-v2/bapirlo"
ART = f"{HOME}/bapirlo-os/build/art/boot-2560x1600.png"
LOGO_SVG = f"{HOME}/bapirlo-os/build/art/logo-kuro.svg"
BANGERS = f"{HOME}/.local/share/fonts/bapirlo/Bangers-Regular.ttf"
INTER = "/usr/share/fonts/inter/Inter.ttc"
JBM = "/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-Regular.ttf"
W, H = 2560, 1600
I_REG, I_MED, I_SEMI, I_BOLD = 0, 10, 12, 14
os.makedirs(f"{OUT}/icons", exist_ok=True)

# geometry (px at 2560x1600) — converted to % for theme.txt
PANEL = (104, 96, 860, 1504)            # x0 y0 x1 y1
MENU = dict(x=150, y=470, w=664, h=780)
ITEM_H, ITEM_SP = 96, 10
BAR = dict(x=176, y=1338, w=612, h=4)


def pct(v, total): return f"{v / total * 100:.3f}%"
def font(path, size, idx=0): return ImageFont.truetype(path, size, index=idx)


def logo(size):
    tmp = f"{OUT}/_logo.png"
    subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), LOGO_SVG, "-o", tmp], check=True)
    im = Image.open(tmp).convert("RGBA"); os.remove(tmp); return im


def tracked(draw, xy, text, fnt, fill, track):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + track
    return x


# ---------------------------------------------------------------- logo recolour
svg = open(f"{HOME}/bapirlo-os/assets/bapirlo-logo.svg").read()
svg = (svg.replace("#2f7cff", PAL["blood"]).replace("#ff3d8b", PAL["sakura"])
          .replace("#10c98f", PAL["paper"]).replace("#e3242b", PAL["crimson"])
          .replace("#0b0b0d", PAL["ink"]))
open(LOGO_SVG, "w").write(svg)

# ---------------------------------------------------------------- background
bg = Image.open(ART).convert("RGB")
x0, y0, x1, y1 = PANEL
R = 40
region = bg.crop(PANEL).filter(ImageFilter.GaussianBlur(34))
glass = Image.blend(region, Image.new("RGB", region.size, rgb("ink")), 0.62)
# faint top-to-bottom crimson wash inside the glass
wash = Image.linear_gradient("L").resize(glass.size).point(lambda v: int((255 - v) * 0.10))
glass = Image.composite(Image.new("RGB", glass.size, rgb("blood")), glass, wash)
mask = Image.new("L", glass.size, 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, glass.width - 1, glass.height - 1], R, fill=255)
# soft drop shadow
shadow = Image.new("L", (W, H), 0)
ImageDraw.Draw(shadow).rounded_rectangle([x0 + 10, y0 + 24, x1 + 10, y1 + 30], R, fill=170)
shadow = shadow.filter(ImageFilter.GaussianBlur(40))
bg = Image.composite(Image.new("RGB", (W, H), (0, 0, 0)), bg, shadow)
bg.paste(glass, (x0, y0), mask)

# border: crimson at the top fading to a dim line at the bottom (drawn at 2x for AA)
S = 2
bw, bh = (x1 - x0) * S, (y1 - y0) * S
ring = Image.new("L", (bw, bh), 0)
d = ImageDraw.Draw(ring)
d.rounded_rectangle([0, 0, bw - 1, bh - 1], R * S, outline=255, width=2 * S)
ring = ring.resize((x1 - x0, y1 - y0), Image.LANCZOS)
fade = Image.linear_gradient("L").resize(ring.size)          # 0 top -> 255 bottom
top = ImageChops.multiply(ring, ImageChops.invert(fade).point(lambda v: int(60 + v * 0.62)))
bot = ImageChops.multiply(ring, fade.point(lambda v: int(v * 0.35)))
bg.paste(Image.new("RGB", ring.size, rgb("crimson")), (x0, y0), top)
bg.paste(Image.new("RGB", ring.size, rgb("line")), (x0, y0), bot)

lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(lay)
# lockup: logo + wordmark
lg = logo(132)
glow = lg.split()[3].filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * 0.55))
lay.paste(Image.new("RGBA", lg.size, rgb("crimson", 255)), (166, 150), glow)
lay.alpha_composite(lg, (166, 150))
d.text((318, 150), "KURO", font=font(BANGERS, 112), fill=rgb("paper", 255))
ox = tracked(d, (322, 266), "OS", font(INTER, 24, I_BOLD), rgb("crimson", 255), 6)
tracked(d, (ox + 8, 266), "·  OPERATING SYSTEM", font(INTER, 24, I_MED), rgb("mist", 220), 6)
# divider: crimson -> transparent
div = Image.linear_gradient("L").rotate(90, expand=True).resize((600, 2))
div = ImageChops.invert(div).point(lambda v: int(v * 0.9))
lay.paste(Image.new("RGBA", div.size, rgb("crimson", 255)), (166, 344), div)
tracked(d, (166, 400), "SELECT SYSTEM", font(INTER, 22, I_SEMI), rgb("muted", 255), 5)
# countdown track
d.rounded_rectangle([BAR["x"], BAR["y"], BAR["x"] + BAR["w"], BAR["y"] + BAR["h"]], 2, fill=rgb("surface", 255))
# key hints (baked: crisper than a GRUB label, and never changes)
hf, kf = font(INTER, 22, I_MED), font(INTER, 20, I_SEMI)
x, y = 166, 1426
for key, what in (("↑↓", "navigate"), ("Enter", "boot"), ("E", "edit"), ("C", "console")):
    tw = d.textlength(key, font=kf)
    d.rounded_rectangle([x, y - 4, x + tw + 22, y + 32], 8, fill=rgb("surface", 255), outline=rgb("line", 255), width=2)
    d.text((x + 11, y), key, font=kf, fill=rgb("paper", 255))
    x += tw + 32
    d.text((x, y + 1), what, font=hf, fill=rgb("muted", 255))
    x += d.textlength(what, font=hf) + 30
bg = bg.convert("RGBA"); bg.alpha_composite(lay); bg = bg.convert("RGB")
# baseline 4:2:0 JPEG: GRUB decodes it far faster than a multi-MB PNG (and can't read progressive)
bg.save(f"{OUT}/background.jpg", quality=92, subsampling=2, progressive=False, optimize=True)

# ---------------------------------------------------------------- selection pill (9-slice)
pw, ph, C = MENU["w"], ITEM_H, 24
SS = 4
big = Image.new("RGBA", (pw * SS, ph * SS), (0, 0, 0, 0))
grad = Image.new("RGBA", big.size)
gpx = []
cr, em, bl = rgb("crimson"), rgb("ember"), rgb("blood")
for xx in range(big.width):
    t = xx / (big.width - 1)
    if t < .5:
        k = t / .5; c = tuple(int(em[i] + (cr[i] - em[i]) * k) for i in range(3)); a = int(235 - 70 * k)
    else:
        k = (t - .5) / .5; c = tuple(int(cr[i] + (bl[i] - cr[i]) * k) for i in range(3)); a = int(165 - 125 * k)
    gpx.append(c + (a,))
row = Image.new("RGBA", (big.width, 1)); row.putdata(gpx)
grad = row.resize(big.size)
pm = Image.new("L", big.size, 0)
ImageDraw.Draw(pm).rounded_rectangle([0, 0, big.width - 1, big.height - 1], 18 * SS, fill=255)
big.paste(grad, (0, 0), ImageChops.multiply(pm, grad.split()[3]))
hl = Image.new("L", big.size, 0)   # 1px inner top highlight
ImageDraw.Draw(hl).rounded_rectangle([SS, SS, big.width - SS, big.height - SS], 17 * SS, outline=90, width=SS)
hl = ImageChops.multiply(hl, Image.linear_gradient("L").resize(big.size).point(lambda v: 255 - v))
big.alpha_composite(Image.merge("RGBA", (*Image.new("RGB", big.size, (255, 255, 255)).split(), hl)))
pill = big.resize((pw, ph), Image.LANCZOS)
boxes = {"nw": (0, 0, C, C), "n": (C, 0, pw - C, C), "ne": (pw - C, 0, pw, C),
         "w": (0, C, C, ph - C), "c": (C, C, pw - C, ph - C), "e": (pw - C, C, pw, ph - C),
         "sw": (0, ph - C, C, ph), "s": (C, ph - C, pw - C, ph), "se": (pw - C, ph - C, pw, ph)}
for k, b in boxes.items():
    pill.crop(b).save(f"{OUT}/select_{k}.png")

# terminal box ('c' console / 'e' editor): solid ink glass, crimson hairline
for k, b in boxes.items():
    tb = Image.new("RGBA", (8, 8), rgb("ink", 242))
    if k != "c":
        tb = Image.new("RGBA", (2, 2), rgb("crimson", 255))
    tb.save(f"{OUT}/terminal_box_{k}.png")

# ---------------------------------------------------------------- icons (64px, drawn at 4x)
IS = 64
def canvas(): return Image.new("RGBA", (IS * 4, IS * 4), (0, 0, 0, 0))
def save_icon(img, names):
    img = img.resize((IS, IS), Image.LANCZOS)
    for n in names: img.save(f"{OUT}/icons/{n}.png")

save_icon(logo(IS * 4), ["kuro", "bapirlo", "arch", "gnu-linux", "linux", "cachyos"])
# Windows: generic 2x2 rounded tiles (steel), not the trademarked logo shape
img = canvas(); d = ImageDraw.Draw(img); st = rgb("steel", 255)
for cx, cy in ((36, 36), (136, 36), (36, 136), (136, 136)):
    d.rounded_rectangle([cx, cy, cx + 84, cy + 84], 14, fill=st)
save_icon(img, ["windows"])
# USB / other EFI targets: hollow ring
img = canvas(); d = ImageDraw.Draw(img)
d.ellipse([40, 40, 216, 216], outline=rgb("mist", 255), width=22)
d.ellipse([104, 104, 152, 152], fill=rgb("crimson", 255))
save_icon(img, ["uefi_", "efi", "os"])
# submenu / firmware: three slider lines
img = canvas(); d = ImageDraw.Draw(img)
for i, kx in enumerate((150, 80, 180)):
    yy = 64 + i * 64
    d.rounded_rectangle([30, yy - 8, 226, yy + 8], 8, fill=rgb("mist", 255))
    d.ellipse([kx - 22, yy - 22, kx + 22, yy + 22], fill=rgb("crimson", 255))
save_icon(img, ["submenu", "recovery", "firmware", "setup", "uefi"])

# ---------------------------------------------------------------- fonts
def mkfont(src, size, out, idx=None):
    cmd = ["grub-mkfont", "-s", str(size), "-o", f"{OUT}/{out}"]
    if idx is not None: cmd += ["-i", str(idx)]
    subprocess.run(cmd + [src], check=True)

mkfont(INTER, 34, "inter_medium_34.pf2", I_MED)     # GRUB names it "Inter Regular 34"
mkfont(INTER, 34, "inter_bold_34.pf2", I_BOLD)      # "Inter Bold 34"
mkfont(INTER, 24, "inter_medium_24.pf2", I_MED)     # GRUB names it "Inter Regular 24"
mkfont(JBM, 26, "jbm_26.pf2")                       # console / editor

# ---------------------------------------------------------------- theme.txt
P = PAL
theme = f"""# Kuro OS GRUB theme v2 "Kuro" — generated by tools/build-grub-v2.py
title-text: ""
desktop-image: "background.jpg"
desktop-image-scale-method: "stretch"
desktop-color: "{P['ink']}"
terminal-font: "JetBrainsMono NFM Regular 26"
terminal-box: "terminal_box_*.png"
terminal-left: "8%"
terminal-top: "8%"
terminal-width: "84%"
terminal-height: "84%"
terminal-border: "0"

+ boot_menu {{
  left = {pct(MENU['x'], W)}
  top = {pct(MENU['y'], H)}
  width = {pct(MENU['w'], W)}
  height = {pct(MENU['h'], H)}
  item_font = "Inter Regular 34"
  item_color = "{P['mist']}"
  selected_item_font = "Inter Bold 34"
  selected_item_color = "#FFFFFF"
  icon_width = 52
  icon_height = 52
  item_icon_space = 24
  item_height = {ITEM_H}
  item_padding = 22
  item_spacing = {ITEM_SP}
  selected_item_pixmap_style = "select_*.png"
  scrollbar = false
}}

+ progress_bar {{
  id = "__timeout__"
  left = {pct(BAR['x'], W)}
  top = {pct(BAR['y'], H)}
  width = {pct(BAR['w'], W)}
  height = {BAR['h']}
  show_text = false
  fg_color = "{P['crimson']}"
  bg_color = "{P['surface']}"
  border_color = "{P['surface']}"
}}

+ label {{
  id = "__timeout__"
  left = {pct(BAR['x'], W)}
  top = {pct(BAR['y'] + 22, H)}
  width = {pct(BAR['w'], W)}
  align = "left"
  color = "{P['mist']}"
  font = "Inter Regular 24"
  text = "Starting the highlighted system in %d s"
}}
"""
open(f"{OUT}/theme.txt", "w").write(theme)
# preview with the two real entries drawn on, for review before installing
prev = Image.open(f"{OUT}/background.jpg").convert("RGBA")
d = ImageDraw.Draw(prev)
ent = [("Kuro OS", "bapirlo", True), ("Advanced options for Kuro OS", "submenu", False),
       ("Windows", "windows", False), ("UEFI Firmware Settings", "uefi", False)]
y = MENU["y"]
for name, ic, sel in ent:
    if sel: prev.alpha_composite(pill, (MENU["x"], y))
    icon = Image.open(f"{OUT}/icons/{ic}.png"); icon = icon.resize((52, 52))
    prev.alpha_composite(icon, (MENU["x"] + 22, y + (ITEM_H - 52) // 2))
    d.text((MENU["x"] + 22 + 52 + 24, y + ITEM_H // 2), name, anchor="lm",
           font=font(INTER, 34, I_BOLD if sel else I_MED), fill=(255, 255, 255) if sel else rgb("mist"))
    y += ITEM_H + ITEM_SP
d.rounded_rectangle([BAR["x"], BAR["y"], BAR["x"] + int(BAR["w"] * .66), BAR["y"] + BAR["h"]], 2, fill=rgb("crimson"))
d.text((BAR["x"], BAR["y"] + 22), "Starting the highlighted system in 2 s", font=font(INTER, 24, I_MED), fill=rgb("mist"))
prev.convert("RGB").save(f"{HOME}/bapirlo-os/build/grub-v2/preview.png")
prev.convert("RGB").resize((1280, 800), Image.LANCZOS).save(f"{HOME}/bapirlo-os/build/grub-v2/preview-small.png")
print("GRUB v2 built in", OUT)
