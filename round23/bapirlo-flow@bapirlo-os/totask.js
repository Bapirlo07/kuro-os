// Kuro Text → task — select text anywhere (or copy it) and press Super+Shift+D: it becomes a to-do on the desk
// To-do card, with a due date when the words say one: "by Friday", "tomorrow", "next week", "in 3 days",
// "12 Nov", "Nov 12", "12/11", "end of the month"… The card shows the due day; overdue ones turn red.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// → 'YYYY-MM-DD' or null. Exported for the unit test (test/totask-test.js).
export function parseDue(text, now = new Date()) {
    const t = ` ${text.toLowerCase().replace(/[,.;!?]/g, ' ')} `;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let m;
    if (/\b(day after tomorrow)\b/.test(t))
        return iso(addDays(today, 2));
    if (/\b(tomorrow|tmrw|tmr)\b/.test(t))
        return iso(addDays(today, 1));
    if (/\b(today|tonight|this evening|eod)\b/.test(t))
        return iso(today);
    if ((m = t.match(/\bin (\d{1,3}|a|an|one|two|three|four|five|six|seven) (day|days|week|weeks)\b/))) {
        const words = {a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7};
        const n = /\d/.test(m[1]) ? Number(m[1]) : words[m[1]];
        return iso(addDays(today, n * (m[2].startsWith('week') ? 7 : 1)));
    }
    if (/\bend of (the )?month\b/.test(t))
        return iso(new Date(today.getFullYear(), today.getMonth() + 1, 0));
    if (/\b(end of (the )?week|this weekend)\b/.test(t))
        return iso(addDays(today, (5 - today.getDay() + 7) % 7));
    if (/\bnext week\b/.test(t))
        return iso(addDays(today, 7));
    if ((m = t.match(/\b(next |this |on |by |before |due )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|nesday|sday|urday|rsday)?\b/))) {
        const want = DAYS.indexOf(m[2].slice(0, 3));
        let diff = (want - today.getDay() + 7) % 7;
        if (diff === 0)
            diff = 7;                                   // "Friday" said on a Friday = next Friday
        if (m[1]?.trim() === 'next' && diff < 7)
            diff += 7;
        return iso(addDays(today, diff));
    }
    const fromParts = (day, mon, year) => {
        if (mon < 0 || day < 1 || day > 31)
            return null;
        let y = year ?? today.getFullYear();
        if (y < 100)
            y += 2000;
        let d = new Date(y, mon, day);
        if (year === undefined && d < today)
            d = new Date(y + 1, mon, day);              // "12 Jan" in November = next January
        return iso(d);
    };
    if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)))
        return iso(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if ((m = t.match(/\b(\d{1,2})(st|nd|rd|th)?( of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*( (\d{2,4}))?\b/)))
        return fromParts(Number(m[1]), MONTHS.indexOf(m[4]), m[6] ? Number(m[6]) : undefined);
    if ((m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})(st|nd|rd|th)?( (\d{4}))?\b/)))
        return fromParts(Number(m[2]), MONTHS.indexOf(m[1]), m[5] ? Number(m[5]) : undefined);
    if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})(\/(\d{2,4}))?\b/)))      // UK order: day/month
        return fromParts(Number(m[1]), Number(m[2]) - 1, m[4] ? Number(m[4]) : undefined);
    return null;
}

function clip(type) {
    return new Promise(resolve => St.Clipboard.get_default().get_text(type, (_c, text) => resolve(text ?? '')));
}

export class ToTask {
    async run() {
        let text = (await clip(St.ClipboardType.PRIMARY)).trim();
        if (!text)
            text = (await clip(St.ClipboardType.CLIPBOARD)).trim();
        text = text.replace(/\s+/g, ' ').slice(0, 300);
        if (!text) {
            Main.osdWindowManager.showAll(Gio.ThemedIcon.new('dialog-information-symbolic'), 'Select some text first', null, null);
            return;
        }
        const due = parseDue(text);
        const argv = ['bapirlo-todo', 'add', ...(due ? ['--due', due] : []), text];
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE);
        } catch (e) {
            Main.notifyError('Text → task', e.message);
            return;
        }
        const when = due ? ` · due ${GLib.DateTime.new_local(...due.split('-').map(Number), 0, 0, 0).format('%a %-d %b')}` : '';
        Main.osdWindowManager.showAll(Gio.ThemedIcon.new('object-select-symbolic'),
            `To-do: ${text.length > 48 ? `${text.slice(0, 46)}…` : text}${when}`, null, null);
    }

    destroy() {}
}
