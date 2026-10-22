// What the capacity phases' sampler read (issue #831).
//
//   node scripts/lane-capacity-samples.mjs <samples> <kill epoch> <takeover epoch> [budget]
//
// Each line is `<epoch>|<running>|<distinct global slots>|<running without one>`, or `<epoch>|?` when the
// read failed. Prints one JSON line of counts: readable and unreadable samples (a failed read is never a
// zero), samples over the budget (default 2), samples where the running rows did not hold distinct
// slots, samples with a running row holding none, and readable samples between the kill and the takeover.
import { readFileSync } from 'node:fs';

const [, , file, killAt, tookAt, budget = '2'] = process.argv;
const out = { readable: 0, unreadable: 0, over: 0, shared: 0, unslotted: 0, window: 0, max: 0 };
let text = '';
try {
    text = readFileSync(file ?? '', 'utf8');
} catch {
    // an unreadable file reports no samples, which the lane's coverage check fails
}
for (const line of text.split('\n').filter(Boolean)) {
    const [t, running, slots, unslotted] = line.split('|').map(Number);
    if (![t, running, slots, unslotted].every(Number.isInteger)) {
        out.unreadable++;
        continue;
    }
    out.readable++;
    out.max = Math.max(out.max, running);
    if (running > Number(budget)) out.over++;
    if (running !== slots) out.shared++;
    if (unslotted !== 0) out.unslotted++;
    if (t >= Number(killAt) && t <= Number(tookAt)) out.window++;
}
process.stdout.write(JSON.stringify(out));
