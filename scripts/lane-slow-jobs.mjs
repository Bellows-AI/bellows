// What a lane's attempts spent their slots on (issue #829).
//
//   node scripts/lane-slow-jobs.mjs <driver.log> [threshold-seconds]
//
// Reads the driver's structured `attempt-transition` lines (driver/src/loop/loop-phase.ts) and prints
// each job and claim whose launched-to-ended span passed the threshold (default 30), then each that
// never ended: how long it was seen for after its launch, and the phase it was last in. The last
// line is the one-line summary. Diagnostics only: it always exits 0, an unreadable log is an empty run.
import { readFileSync } from 'node:fs';

const [, , file, limit = '30'] = process.argv;
const thresholdS = Number(limit);
const MARK = '{"event":"attempt-transition"';

const attempts = new Map();
let text = '';
try {
    text = readFileSync(file ?? '', 'utf8');
} catch {
    // an unreadable log reports nothing
}
for (const raw of text.split('\n')) {
    const at = raw.indexOf(MARK);
    if (at < 0) continue;
    let t;
    try {
        t = JSON.parse(raw.slice(at));
    } catch {
        continue;
    }
    const key = `${t.job} claim ${t.claimSeq}`;
    const a = attempts.get(key) ?? { first: t.at, launched: null, ended: null, last: t.at, phase: t.to };
    if (t.to === 'launched' && a.launched === null) a.launched = t.at;
    if (t.to === 'ended' && a.ended === null) a.ended = t.at;
    if (t.at >= a.last) {
        a.last = t.at;
        a.phase = t.to;
    }
    attempts.set(key, a);
}

const seconds = (ms) => Math.round(ms / 1000);
let slow = 0;
let open = 0;
for (const [key, a] of attempts) {
    const start = a.launched ?? a.first;
    if (a.ended !== null) {
        const span = seconds(a.ended - start);
        if (span > thresholdS) {
            slow += 1;
            console.log(`${key}: ${span}s launched to ended`);
        }
    } else {
        open += 1;
        console.log(`${key}: never ended, last seen ${seconds(a.last - start)}s after launch (${a.phase})`);
    }
}
console.log(`slow-jobs: ${slow} slow, ${open} never ended (threshold ${thresholdS}s)`);
