// Kuro the ink spirit — drawn with Cairo, no image files. Everything is relative to a 64×64 canvas
// with the feet on the bottom edge. pose = {mood, t, step, squash, look, blink, stage, cap, facing}
const TAU = Math.PI * 2;

function rgb(cr, hex, a = 1) {
    const n = parseInt(hex.slice(1), 16);
    cr.setSourceRGBA((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, a);
}

function ellipse(cr, x, y, rx, ry) {
    cr.save();
    cr.translate(x, y);
    cr.scale(rx, ry);
    cr.arc(0, 0, 1, 0, TAU);
    cr.restore();
}

export function drawKuro(cr, W, H, p, col) {
    const s = W / 64;
    cr.save();
    cr.scale(s, s);
    if (p.facing < 0) {
        cr.translate(64, 0);
        cr.scale(-1, 1);
    }
    const ink = col.ink, accent = col.crimson, soft = col.accent3_bright;
    const grow = [0.82, 0.9, 0.96, 1][p.stage];
    const sq = p.squash;                       // >1 = squashed (wide/low), <1 = stretched
    const bw = 21 * grow * sq, bh = 18 * grow / sq;
    const cx = 32, cy = 62 - 5 - bh;           // body centre (feet below it)

    // halo (30 days)
    if (p.stage >= 3) {
        const g = 0.55 + 0.25 * Math.sin(p.t * 2);
        rgb(cr, soft, 0.85 * g);
        cr.setLineWidth(2);
        ellipse(cr, cx, cy - bh - 8, 9, 2.6);
        cr.stroke();
    }

    // tail (10 days) — a curl that sways
    if (p.stage >= 2) {
        const sway = Math.sin(p.t * 3) * 3;
        rgb(cr, ink);
        cr.setLineWidth(4);
        cr.setLineCap(1);
        cr.moveTo(cx - bw + 3, cy + bh * 0.4);
        cr.curveTo(cx - bw - 8, cy + bh * 0.3, cx - bw - 10 + sway, cy - 6, cx - bw - 4 + sway, cy - 9);
        cr.stroke();
    }

    // feet
    const lift = p.mood === 'walk' ? Math.sin(p.step) * 2.4 : 0;
    rgb(cr, ink);
    ellipse(cr, cx - 8, 59.5 - Math.max(0, lift), 5, 3);
    cr.fill();
    ellipse(cr, cx + 8, 59.5 - Math.max(0, -lift), 5, 3);
    cr.fill();

    // ears
    const earT = p.mood === 'sleep' ? 4 : 0;
    for (const side of [-1, 1]) {
        cr.moveTo(cx + side * bw * 0.35, cy - bh * 0.7);
        cr.lineTo(cx + side * bw * 0.85, cy - bh - 9 * grow + earT + (side > 0 ? Math.sin(p.t * 1.7) : 0));
        cr.lineTo(cx + side * bw * 0.95, cy - bh * 0.25);
        cr.closePath();
        rgb(cr, ink);
        cr.fill();
    }

    // body + rim light in the accent colour
    ellipse(cr, cx, cy, bw, bh);
    rgb(cr, ink);
    cr.fillPreserve();
    rgb(cr, accent, 0.55);
    cr.setLineWidth(1.4);
    cr.stroke();
    // inner ear tint
    rgb(cr, accent, 0.6);
    for (const side of [-1, 1]) {
        cr.moveTo(cx + side * bw * 0.55, cy - bh * 0.72);
        cr.lineTo(cx + side * bw * 0.82, cy - bh - 5 * grow + earT);
        cr.lineTo(cx + side * bw * 0.86, cy - bh * 0.5);
        cr.closePath();
        cr.fill();
    }

    // face
    const ex = 7.5 * grow, ey = cy - 2 + p.look.y;
    const lx = p.look.x;
    if (p.mood === 'sleep' || p.blink) {
        rgb(cr, soft, 0.9);
        cr.setLineWidth(1.6);
        for (const side of [-1, 1]) {
            cr.arc(cx + side * ex, ey, 3, 0.15 * Math.PI, 0.85 * Math.PI);
            cr.stroke();
        }
    } else if (p.mood === 'happy' || p.mood === 'dance') {
        rgb(cr, soft);
        cr.setLineWidth(1.8);
        for (const side of [-1, 1]) {
            cr.arc(cx + side * ex, ey + 1.5, 3, 1.15 * Math.PI, 1.85 * Math.PI);
            cr.stroke();
        }
    } else {
        for (const side of [-1, 1]) {
            rgb(cr, '#F4EEEE');
            ellipse(cr, cx + side * ex, ey, 3.6, 4.3);
            cr.fill();
            rgb(cr, accent);
            ellipse(cr, cx + side * ex + lx, ey + 0.6, 2.1, 2.6);
            cr.fill();
            rgb(cr, '#FFFFFF');
            ellipse(cr, cx + side * ex + lx + 0.8, ey - 0.8, 0.8, 0.8);
            cr.fill();
        }
    }
    // little mouth
    rgb(cr, soft, 0.85);
    cr.setLineWidth(1.2);
    if (p.mood === 'surprised') {
        ellipse(cr, cx, ey + 7, 1.6, 2);
        cr.stroke();
    } else if (p.mood !== 'sleep') {
        cr.arc(cx, ey + 5.2, 1.8, 0.2 * Math.PI, 0.8 * Math.PI);
        cr.stroke();
    }
    // blush when petted
    if (p.mood === 'happy') {
        rgb(cr, accent, 0.45);
        ellipse(cr, cx - ex - 3, ey + 4, 2.4, 1.3);
        cr.fill();
        ellipse(cr, cx + ex + 3, ey + 4, 2.4, 1.3);
        cr.fill();
    }

    // scarf (3 days) with a fluttering end
    if (p.stage >= 1) {
        const yy = cy + bh * 0.42;
        rgb(cr, accent);
        cr.save();
        ellipse(cr, cx, cy, bw + 0.8, bh + 0.8);      // wrap around the body, not a flat strip
        cr.clip();
        cr.moveTo(cx - bw - 1, yy - 3.2);
        cr.curveTo(cx - bw * 0.3, yy + 0.6, cx + bw * 0.3, yy + 0.6, cx + bw + 1, yy - 3.2);
        cr.lineTo(cx + bw + 1, yy + 1.4);
        cr.curveTo(cx + bw * 0.3, yy + 5.2, cx - bw * 0.3, yy + 5.2, cx - bw - 1, yy + 1.4);
        cr.closePath();
        cr.fill();
        cr.restore();
        const fl = Math.sin(p.t * 6) * 2 + (p.mood === 'walk' ? -3 : 0);
        cr.moveTo(cx + bw * 0.45, yy);
        cr.lineTo(cx + bw * 0.45 + 9, yy + 5 + fl);
        cr.lineTo(cx + bw * 0.45 + 4, yy + 8 + fl);
        cr.closePath();
        cr.fill();
    }

    // night cap (bedtime)
    if (p.cap) {
        rgb(cr, '#3B3F7A');
        cr.moveTo(cx - bw * 0.7, cy - bh * 0.62);
        cr.curveTo(cx - 2, cy - bh - 16, cx + bw * 0.9, cy - bh - 12, cx + bw + 4, cy - bh * 0.1);
        cr.lineTo(cx + bw * 0.7, cy - bh * 0.62);
        cr.closePath();
        cr.fill();
        rgb(cr, '#F4EEEE');
        ellipse(cr, cx + bw + 4, cy - bh * 0.1, 2.6, 2.6);
        cr.fill();
    }
    cr.restore();
}
