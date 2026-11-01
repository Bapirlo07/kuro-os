// Kuro Air-draw shape matcher — a small "$1 recognizer" (no shell imports, so it can be tested with plain gjs).
export const DEFAULT_DRAW = {
    'circle': 'search', 'check': 'screenshot', 'z': 'canvas', 'triangle': 'apps', 'caret': 'overview', 'l': 'lock',
};

const N = 64;                  // resampled points
const SIZE = 250;

function circle(ccw) {
    const p = [];
    for (let i = 0; i <= 32; i++) {
        const a = -Math.PI / 2 + (ccw ? -1 : 1) * i / 32 * 2 * Math.PI;
        p.push([Math.cos(a), Math.sin(a)]);
    }
    return p;
}

// screen coordinates (y grows downwards); several variants per shape
const RAW = {
    'circle': [circle(false), circle(true)],
    'check': [[[0, 0.55], [0.32, 1], [1, 0]]],
    'z': [[[0, 0], [1, 0], [0, 1], [1, 1]]],
    'triangle': [[[0.5, 0], [1, 1], [0, 1], [0.5, 0]], [[0.5, 0], [0, 1], [1, 1], [0.5, 0]]],
    'caret': [[[0, 1], [0.5, 0], [1, 1]]],
    'l': [[[0, 0], [0, 1], [0.7, 1]]],
};

// ---------- $1 recognizer (without the rotate-to-zero step, so ✓ and ^ stay different) ----------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function pathLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++)
        d += dist(pts[i - 1], pts[i]);
    return d;
}

function densify(pts) {           // templates are corners only; give them enough points to resample well
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        for (let k = 1; k <= 20; k++)
            out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k / 20, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k / 20]);
    }
    return out;
}

function resample(pts, n) {
    const I = pathLength(pts) / (n - 1);
    const src = pts.map(p => [...p]);
    const out = [src[0]];
    let D = 0;
    for (let i = 1; i < src.length; i++) {
        const d = dist(src[i - 1], src[i]);
        if (D + d >= I && d > 0) {
            const t = (I - D) / d;
            const q = [src[i - 1][0] + t * (src[i][0] - src[i - 1][0]), src[i - 1][1] + t * (src[i][1] - src[i - 1][1])];
            out.push(q);
            src.splice(i, 0, q);
            D = 0;
        } else {
            D += d;
        }
    }
    while (out.length < n)
        out.push(src[src.length - 1]);
    return out.slice(0, n);
}

function centroid(pts) {
    let x = 0, y = 0;
    for (const p of pts) {
        x += p[0];
        y += p[1];
    }
    return [x / pts.length, y / pts.length];
}

function normalise(pts) {
    let r = resample(pts, N);
    const xs = r.map(p => p[0]), ys = r.map(p => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    // an L or a line is thin one way: scale both axes by the same amount when it's very thin
    const sx = SIZE / Math.max(w, 1e-6), sy = SIZE / Math.max(h, 1e-6);
    const thin = Math.min(w, h) / Math.max(w, h, 1e-6) < 0.3;
    const s = Math.min(sx, sy);
    r = r.map(p => [p[0] * (thin ? s : sx), p[1] * (thin ? s : sy)]);
    const c = centroid(r);
    return r.map(p => [p[0] - c[0], p[1] - c[1]]);
}

function rotate(pts, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return pts.map(p => [p[0] * c - p[1] * s, p[0] * s + p[1] * c]);
}

function pathDist(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++)
        d += dist(a[i], b[i]);
    return d / a.length;
}

function bestAngle(pts, tpl) {     // golden-section search over ±35°
    const phi = 0.5 * (Math.sqrt(5) - 1);
    let a = -0.61, b = 0.61;
    let x1 = phi * a + (1 - phi) * b, x2 = (1 - phi) * a + phi * b;
    let f1 = pathDist(rotate(pts, x1), tpl), f2 = pathDist(rotate(pts, x2), tpl);
    while (Math.abs(b - a) > 0.035) {
        if (f1 < f2) {
            b = x2; x2 = x1; f2 = f1;
            x1 = phi * a + (1 - phi) * b;
            f1 = pathDist(rotate(pts, x1), tpl);
        } else {
            a = x1; x1 = x2; f1 = f2;
            x2 = (1 - phi) * a + phi * b;
            f2 = pathDist(rotate(pts, x2), tpl);
        }
    }
    return Math.min(f1, f2);
}

const TEMPLATES = [];
for (const [name, variants] of Object.entries(RAW)) {
    for (const v of variants)
        TEMPLATES.push({name, pts: normalise(densify(v.map(p => [p[0] * 100, p[1] * 100])))});
}

/** pts: [[x, y], ...] in any units → {name, score 0..1} (best match, even if poor) */
export function recognise(pts) {
    const n = normalise(pts);
    let best = {name: null, score: 0};
    const half = 0.5 * Math.hypot(SIZE, SIZE);
    for (const t of TEMPLATES) {
        const score = 1 - bestAngle(n, t.pts) / half;
        if (score > best.score)
            best = {name: t.name, score};
    }
    return best;
}

