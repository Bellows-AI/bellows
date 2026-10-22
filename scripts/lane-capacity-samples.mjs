// What the capacity phases' sampler read (issue #831).
//
//   node scripts/lane-capacity-samples.mjs <samples> <kill epoch> <takeover epoch> [budget]
//
// Each line is `<epoch>|<running>|<distinct global slots>|<running without one>`, or `<epoch>|?` when the
// read failed. A line is readable only when it holds exactly four non-empty digit columns: an empty or
// non-numeric column is a failed read, never a zero. Prints one JSON line of counts: readable and unreadable
// samples, samples over the budget (default 2), samples where the running rows did not hold distinct slots,
// samples with a running row holding none, readable samples between the kill and the takeover (`window`),
// failed reads in that window (`windowUnreadable`), and the longest stretch in seconds between two readable
// samples (`gap`), so a run of failed reads cannot hide behind a clean count.
import { readFileSync } from 'node:fs';

const [, , file, killAt, tookAt, budget = '2'] = process.argv;
const out = { readable: 0, unreadable: 0, over: 0, shared: 0, unslotted: 0, window: 0, windowUnreadable: 0, gap: 0, max: 0 };
let text = '';
try {
    text = readFileSync(file ?? '', 'utf8');
} catch {
    // an unreadable file reports no samples, which the lane's coverage check fails
}
let lastReadable = null;
for (const line of text.split('\n').filter(Boolean)) {
    const columns = line.split('|');
    const inWindow = /^\d+$/.test(columns[0] ?? '') && Number(columns[0]) >= Number(killAt) && Number(columns[0]) <= Number(tookAt);
    if (columns.length !== 4 || !columns.every((column) => /^\d+$/.test(column))) {
        out.unreadable++;
        if (inWindow) out.windowUnreadable++;
        continue;
    }
    const [t, running, slots, unslotted] = columns.map(Number);
    out.readable++;
    out.max = Math.max(out.max, running);
    if (running > Number(budget)) out.over++;
    if (running !== slots) out.shared++;
    if (unslotted !== 0) out.unslotted++;
    if (inWindow) out.window++;
    if (lastReadable !== null) out.gap = Math.max(out.gap, t - lastReadable);
    lastReadable = t;
}
process.stdout.write(JSON.stringify(out));
