// node round23/test/totask-test.mjs — checks the due-date parser (no GNOME needed: the parser is pure JS)
import {readFileSync} from 'node:fs';
const src = readFileSync(new URL('../bapirlo-flow@bapirlo-os/totask.js', import.meta.url), 'utf8');
const code = src.slice(src.indexOf('const DAYS'), src.indexOf('function clip'));
const parseDue = new Function(`${code}; return parseDue;`.replace('export function', 'function'))();
const now = new Date(2026, 10, 1);   // Sun 1 Nov 2026
const cases = {
    'send report by Friday': '2026-11-06', 'call mum tomorrow': '2026-11-02', 'pay rent today': '2026-11-01',
    'dentist next tuesday': '2026-11-10', 'tuesday standup notes': '2026-11-03', 'in 3 days renew': '2026-11-04',
    'in two weeks visa': '2026-11-15', 'invoice end of the month': '2026-11-30', 'exam on 12th Nov': '2026-11-12',
    'party Dec 24': '2026-12-24', 'flight 3 jan': '2027-01-03', 'form 25/11': '2026-11-25', 'meet 2026-12-01': '2026-12-01',
    'plan next week': '2026-11-08', 'buy milk': null, 'Sunday chores': '2026-11-08', 'by end of week': '2026-11-06',
};
let bad = 0;
for (const [t, want] of Object.entries(cases)) {
    const got = parseDue(t, now);
    if (got !== want) { bad++; console.log(`✗ ${t} → ${got} (want ${want})`); }
}
console.log(bad ? `${bad} failed` : `all ${Object.keys(cases).length} ok`);
process.exit(bad ? 1 : 0);
