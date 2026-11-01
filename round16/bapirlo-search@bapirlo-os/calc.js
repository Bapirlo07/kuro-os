// Kuro Search Actions — the sums and unit conversions (no eval: a small parser).
//   calculate('12*7') → 84      calculate('2^10 + sqrt(9)') → 1027      calculate('15% of 80') → 12
//   convert('5 km in mi') → {value: 3.107, from: 'km', to: 'mi'}
// Both return null for anything they don't understand, so the provider just shows nothing.

const FUNCS = {
    sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
    ln: Math.log, log: Math.log10, exp: Math.exp,
    sin: x => Math.sin(x * Math.PI / 180), cos: x => Math.cos(x * Math.PI / 180),
    tan: x => Math.tan(x * Math.PI / 180),      // degrees: what a person typing "sin 30" means
};
const CONSTS = {pi: Math.PI, 'π': Math.PI, e: Math.E};

function tokenize(s) {
    const out = [];
    const re = /\s*(\d[\d_,]*\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-zπ]+|\*\*|[-+*/×÷^%()])/giy;
    let m;
    while (re.lastIndex < s.length) {
        const at = re.lastIndex;
        m = re.exec(s);
        if (!m) {
            if (/^\s*$/.test(s.slice(at)))
                break;
            return null;
        }
        out.push(m[1]);
    }
    return out;
}

// expr := term (('+'|'-') term)*        "x% of y" and "y + x%" handled in term/primary
export function calculate(text) {
    let s = text.trim().replace(/^=\s*/, '').toLowerCase();
    s = s.replace(/(\d)\s*%\s*of\s*/g, '$1% * ');
    const toks = tokenize(s);
    if (!toks?.length)
        return null;
    let i = 0;
    const peek = () => toks[i];
    const next = () => toks[i++];

    function primary() {
        const t = next();
        if (t === undefined)
            throw new Error('end');
        if (t === '(') {
            const v = expr();
            if (next() !== ')')
                throw new Error(')');
            return v;
        }
        if (t === '-')
            return -power();
        if (t === '+')
            return power();
        if (/^[\d.]/.test(t))
            return Number(t.replace(/[_,]/g, ''));
        if (t in CONSTS)
            return CONSTS[t];
        if (t in FUNCS)
            return FUNCS[t](power());
        throw new Error(t);
    }
    function postfix() {
        let v = primary();
        while (peek() === '%') {
            next();
            v /= 100;
        }
        return v;
    }
    function power() {
        const b = postfix();
        if (peek() === '^' || peek() === '**') {
            next();
            return b ** power();
        }
        return b;
    }
    function term() {
        let v = power();
        for (;;) {
            const t = peek();
            if (t === '*' || t === '×') {
                next(); v *= power();
            } else if (t === '/' || t === '÷') {
                next(); v /= power();
            } else if (t === '(' || (t && /^[a-zπ]/.test(t))) {
                v *= power();      // 2pi, 3(4+1)
            } else {
                return v;
            }
        }
    }
    function expr() {
        let v = term();
        for (;;) {
            const t = peek();
            if (t !== '+' && t !== '-')
                return v;
            next();
            const start = i;
            let r = term();
            // "80 + 15%" means 80 plus 15 % of 80
            if (toks[i - 1] === '%' && toks.slice(start, i).filter(x => /^[-+*/×÷^(]$/.test(x)).length === 0)
                r *= v;
            v = t === '+' ? v + r : v - r;
        }
    }
    try {
        const v = expr();
        return i === toks.length && Number.isFinite(v) ? v : null;
    } catch {
        return null;
    }
}

// does this look like a sum someone wants answered? (a lone "42" or a word is not)
export function looksLikeSum(text) {
    const s = text.trim();
    if (s.startsWith('='))
        return s.length > 1;
    return /\d/.test(s) && (/[-+*/×÷^%()]|\bof\b/.test(s.slice(1)) || /^(sqrt|sin|cos|tan|log|ln)\b|\bpi\b/i.test(s)) &&
        !/[a-z]{2,}\s+(in|to)\s+[a-z]/i.test(s);
}

export function format(v, digits = 10) {
    if (Number.isInteger(v) && Math.abs(v) < 1e15)
        return v.toLocaleString('en-GB');
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-6 || a >= 1e15))
        return v.toExponential(6).replace(/\.?0+e/, 'e');
    return Number(v.toPrecision(digits)).toLocaleString('en-GB', {maximumFractionDigits: 8});
}

// ---------- units: every unit → [group, factor to the group's base] (temperature is special) ----------
const U = {};
function unit(group, factor, ...names) {
    for (const n of names)
        U[n] = {group, factor, name: names[0]};
}
unit('length', 1, 'm', 'metre', 'metres', 'meter', 'meters');
unit('length', 1000, 'km', 'kilometre', 'kilometres', 'kilometer', 'kilometers');
unit('length', 0.01, 'cm', 'centimetre', 'centimetres');
unit('length', 0.001, 'mm', 'millimetre', 'millimetres');
unit('length', 1609.344, 'mi', 'mile', 'miles');
unit('length', 0.9144, 'yd', 'yard', 'yards');
unit('length', 0.3048, 'ft', 'foot', 'feet', "'");
unit('length', 0.0254, 'in', 'inch', 'inches', '"');
unit('mass', 1, 'kg', 'kilo', 'kilos', 'kilogram', 'kilograms');
unit('mass', 0.001, 'g', 'gram', 'grams');
unit('mass', 1e-6, 'mg', 'milligram', 'milligrams');
unit('mass', 0.45359237, 'lb', 'lbs', 'pound', 'pounds');
unit('mass', 0.028349523125, 'oz', 'ounce', 'ounces');
unit('mass', 6.35029318, 'st', 'stone', 'stones');
unit('data', 1, 'b', 'byte', 'bytes');
unit('data', 1e3, 'kb', 'kilobyte', 'kilobytes');
unit('data', 1e6, 'mb', 'megabyte', 'megabytes');
unit('data', 1e9, 'gb', 'gigabyte', 'gigabytes');
unit('data', 1e12, 'tb', 'terabyte', 'terabytes');
unit('data', 1024, 'kib');
unit('data', 1024 ** 2, 'mib');
unit('data', 1024 ** 3, 'gib');
unit('data', 1024 ** 4, 'tib');
unit('speed', 1, 'km/h', 'kmh', 'kph');
unit('speed', 1.609344, 'mph');
unit('speed', 3.6, 'm/s', 'mps');
unit('speed', 1.852, 'kn', 'knot', 'knots');
unit('volume', 1, 'l', 'litre', 'litres', 'liter', 'liters');
unit('volume', 0.001, 'ml', 'millilitre', 'millilitres');
unit('volume', 4.54609, 'gal', 'gallon', 'gallons');            // UK gallon
unit('volume', 0.56826125, 'pt', 'pint', 'pints');               // UK pint
unit('volume', 0.0284130625, 'floz');
unit('volume', 0.25, 'cup', 'cups');
unit('time', 1, 's', 'sec', 'secs', 'second', 'seconds');
unit('time', 60, 'min', 'mins', 'minute', 'minutes');
unit('time', 3600, 'h', 'hr', 'hrs', 'hour', 'hours');
unit('time', 86400, 'd', 'day', 'days');
unit('time', 604800, 'wk', 'week', 'weeks');
unit('temp', 0, 'c', '°c', 'celsius');
unit('temp', 0, 'f', '°f', 'fahrenheit');
unit('temp', 0, 'k', 'kelvin');

function toC(v, u) {
    return u === 'c' ? v : u === 'f' ? (v - 32) * 5 / 9 : v - 273.15;
}
function fromC(v, u) {
    return u === 'c' ? v : u === 'f' ? v * 9 / 5 + 32 : v + 273.15;
}

export function convert(text) {
    const m = text.trim().toLowerCase()
        .match(/^(-?[\d.,]+(?:e[+-]?\d+)?)\s*([a-z°/'"]+)\s+(?:in|to|as|into|->|=)\s+([a-z°/'"]+)$/);
    if (!m)
        return null;
    const v = Number(m[1].replace(/,/g, ''));
    const a = U[m[2]], b = U[m[3]];
    if (!Number.isFinite(v) || !a || !b || a.group !== b.group || a.name === b.name)
        return null;
    const value = a.group === 'temp' ? fromC(toC(v, a.name), b.name) : v * a.factor / b.factor;
    const label = u => u.group === 'temp' ? (u.name === 'k' ? 'K' : `°${u.name.toUpperCase()}`) : u.name;
    return {value, input: v, from: label(a), to: label(b)};
}
