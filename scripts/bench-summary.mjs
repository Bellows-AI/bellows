#!/usr/bin/env node
// Reads what `scripts/test-k8s.sh --cluster --phase bench` wrote per cell (issue #831) and prints one
// TSV row per cell: measured columns only, no cause column. A read that failed, a scrape that is
// missing, a counter that went down (a restart) or a bucket bound past the last one is `?`, never 0;
// a column a kind of cell does not measure is `-`.
//
//   node scripts/bench-summary.mjs <dir>
//
// Per cell `<c>`, in <dir>:
//   <c>.meta.tsv                  key<TAB>value: kind (throughput|recovery), n, r, the effective driver values,
//                                 running_at_b, kill_confirmed/held_s/settled_s (recovery cells)
//   <c>.db.tsv                    header, then id, created, started, finished (epoch seconds), status, attempts, claim_seq
//   <c>.sampler.tsv               epoch|lock waiters|ungranted locks|active backends, or epoch|?
//   <c>.pods.tsv                  scripts/k8s-pod-timeline.mjs output for the cell's runner pods
//   <c>.<board|driver>.<s|a|b|c>.list         the pods listed at that stage, one a line (absent when the list was not read)
//   <c>.<board|driver>-<pod>.<s|a|b|c>.prom   one scrape: s before queueing, a all running, b thirty seconds on, c settled
//   <c>.<board|driver>-<pod>.<s|a|b|c>.at     the epoch second that scrape answered
//
// Every figure needs all its evidence: one board pod and R driver pods, each present in every stage with its
// scrape and time, N distinct task rows with their timestamps, and the metric families it is computed from.
// Rates divide each pod's own delta by that pod's own observation interval, and a per-task rate divides by the
// task-seconds that ran inside that interval, not by the count at one instant.
//
// Saturation, by rule: throughput(N) / throughput(N/2) < 1.2 (when the N/2 cell of the same replica
// count exists), or the claim-wait p95 above twice the N=1 cell's, or any task stalled or failed.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const UNKNOWN = '?';
const NONE = '-';
const dir = process.argv[2];
if (!dir) {
    console.error('usage: bench-summary.mjs <dir>');
    process.exit(2);
}

const read = (file) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : null);

/** One Prometheus exposition into [{ name, labels, value }]; a line that does not parse is dropped. */
export function parseProm(text) {
    const samples = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        let i = 0;
        while (i < line.length && line[i] !== '{' && line[i] !== ' ') i++;
        const name = line.slice(0, i);
        const labels = {};
        if (line[i] === '{') {
            i++;
            while (i < line.length && line[i] !== '}') {
                let eq = i;
                while (eq < line.length && line[eq] !== '=') eq++;
                const key = line.slice(i, eq).trim();
                i = eq + 1;
                if (line[i] !== '"') return samples;
                i++;
                let value = '';
                while (i < line.length && line[i] !== '"') {
                    if (line[i] === '\\') {
                        const next = line[i + 1];
                        value += next === 'n' ? '\n' : next;
                        i += 2;
                    } else {
                        value += line[i++];
                    }
                }
                i++;
                labels[key] = value;
                if (line[i] === ',') i++;
            }
            i++;
        }
        const value = Number(line.slice(i).trim().split(/\s+/)[0]);
        if (name !== '' && Number.isFinite(value)) samples.push({ name, labels, value });
    }
    return samples;
}

const seriesKey = (s) => `${s.name}|${JSON.stringify(Object.entries(s.labels).sort())}`;
const STAGES = ['s', 'a', 'b', 'c'];

/** The pods of one component at every stage, each with its samples and answer time; null unless all of it is present and agrees. */
function loadSet(cell, comp, expected) {
    const set = new Map();
    let names = null;
    for (const stage of STAGES) {
        const list = read(`${cell}.${comp}.${stage}.list`);
        if (list === null) return null;
        const pods = list.split('\n').filter((l) => l !== '').sort();
        if (pods.length !== expected || new Set(pods).size !== expected) return null;
        if (names !== null && names.join('\n') !== pods.join('\n')) return null;
        names = pods;
        for (const pod of pods) {
            const prom = read(`${cell}.${comp}-${pod}.${stage}.prom`);
            const at = Number(read(`${cell}.${comp}-${pod}.${stage}.at`));
            const samples = prom === null ? [] : parseProm(prom);
            if (samples.length === 0 || !Number.isFinite(at) || at <= 0) return null;
            set.set(`${pod}/${stage}`, { samples, at });
        }
    }
    return { pods: names, get: (pod, stage) => set.get(`${pod}/${stage}`) };
}

/**
 * The per-series delta from one stage to another, summed over pods, and each pod's own interval. Null (`?`)
 * when a counter went down, a series vanished, a histogram is partial at either end, or a pod lacks a
 * required family at the end (or at both ends when `both` is set).
 */
function delta(set, from, to, required, both = false, check = () => true) {
    if (set === null) return null;
    const total = new Map();
    const pods = [];
    for (const pod of set.pods) {
        const start = set.get(pod, from);
        const end = set.get(pod, to);
        for (const name of required) {
            if (!end.samples.some((x) => x.name === name)) return null;
            if (both && !start.samples.some((x) => x.name === name)) return null;
        }
        // Both ends: a partial baseline subtracts the wrong amount; a series wholly absent at the start is whole.
        if (!check(start.samples) || !check(end.samples)) return null;
        const before = new Map(start.samples.map((x) => [seriesKey(x), x]));
        const own = [];
        for (const x of end.samples) {
            const first = before.get(seriesKey(x));
            const base = first ? first.value : 0;
            if (x.value < base) return null; // a counter that went down: a restart, so no delta
            own.push({ name: x.name, labels: x.labels, value: x.value - base });
            const prev = total.get(seriesKey(x)) ?? { name: x.name, labels: x.labels, value: 0 };
            prev.value += x.value - base;
            total.set(seriesKey(x), prev);
        }
        const ended = new Set(end.samples.map(seriesKey));
        if ([...before.keys()].some((k) => !ended.has(k))) return null;
        pods.push({ samples: own, seconds: end.at - start.at, from: start.at, to: end.at });
    }
    if (pods.some((x) => !(x.seconds > 0))) return null;
    return { samples: [...total.values()], pods };
}

const sum = (samples, name, where = () => true) =>
    samples.filter((s) => s.name === name && where(s.labels)).reduce((n, s) => n + s.value, 0);

/** The sum over pods of each pod's own rate for `name`. */
const rate = (d, name, where = () => true) => d.pods.reduce((n, p) => n + sum(p.samples, name, where) / p.seconds, 0);

/** Histogram `<base>` over the samples matching `where`: { count, sum, p95Le } with p95Le `?` past the last bucket. */
function histogram(samples, base, where = () => true) {
    const count = sum(samples, `${base}_count`, where);
    const total = sum(samples, `${base}_sum`, where);
    const bounds = new Map();
    for (const s of samples) {
        if (s.name !== `${base}_bucket` || !where(s.labels)) continue;
        bounds.set(s.labels.le, (bounds.get(s.labels.le) ?? 0) + s.value);
    }
    const ordered = [...bounds].map(([le, n]) => [le === '+Inf' ? Infinity : Number(le), n]).sort((x, y) => x[0] - y[0]);
    let p95Le = UNKNOWN;
    if (count > 0) {
        const hit = ordered.find(([, n]) => n >= 0.95 * count);
        if (hit && Number.isFinite(hit[0])) p95Le = String(hit[0]);
    }
    return { count, sum: total, p95Le };
}

/** True when every series of histogram `base` matching `where` has its count, sum and +Inf bucket, and nothing is left over. */
function histogramWhole(samples, base, where = () => true) {
    const key = (x) => JSON.stringify(Object.entries(x.labels).filter(([k]) => k !== 'le').sort());
    const parts = { count: new Set(), sum: new Set(), inf: new Set(), bucket: new Set() };
    for (const x of samples) {
        if (!where(x.labels)) continue;
        if (x.name === `${base}_count`) parts.count.add(key(x));
        else if (x.name === `${base}_sum`) parts.sum.add(key(x));
        else if (x.name === `${base}_bucket`) {
            parts.bucket.add(key(x));
            if (x.labels.le === '+Inf') parts.inf.add(key(x));
        }
    }
    const same = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));
    return same(parts.count, parts.sum) && same(parts.count, parts.inf) && same(parts.count, parts.bucket);
}

const quantile = (sorted, q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
const fixed = (n, digits = 2) => (Number.isFinite(n) ? String(Number(n.toFixed(digits))) : UNKNOWN);

function meta(cell) {
    const text = read(`${cell}.meta.tsv`);
    const out = {};
    for (const line of (text ?? '').split('\n')) {
        const [k, ...v] = line.split('\t');
        if (k) out[k] = v.join('\t');
    }
    return out;
}

/** The N task rows, or null unless there are N distinct ones with a finite creation time. */
function dbRows(cell, n) {
    const text = read(`${cell}.db.tsv`);
    if (text === null || !Number.isInteger(n) || n < 1) return null;
    const rows = text
        .split('\n')
        .slice(1)
        .filter((l) => l.trim() !== '')
        .map((l) => l.split('\t'));
    if (rows.length !== n || rows.some((r) => r.length < 7) || new Set(rows.map((r) => r[0])).size !== n) return null;
    const mapped = rows.map(([id, created, started, finished, status, attempts, claimSeq]) => ({
        id,
        created: created === '' ? Number.NaN : Number(created),
        started: started === '' ? Number.NaN : Number(started),
        finished: finished === '' ? Number.NaN : Number(finished),
        status,
        attempts,
        claimSeq,
    }));
    return mapped.every((x) => Number.isFinite(x.created) && x.id !== '' && x.status !== '') ? mapped : null;
}

/** Task-seconds that ran inside [from, to]: a task is active from its claim to its end (or the window's end). */
const activeSeconds = (rows, from, to) =>
    rows.reduce((n, x) => {
        if (!Number.isFinite(x.started)) return n;
        const end = Number.isFinite(x.finished) ? x.finished : to;
        return n + Math.max(0, Math.min(end, to) - Math.max(x.started, from));
    }, 0);

function sampler(cell) {
    const text = read(`${cell}.sampler.tsv`);
    if (text === null) return null;
    const ok = [];
    let unread = 0;
    for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const f = line.split('|');
        if (f.length === 4 && f.slice(1).every((x) => /^\d+$/.test(x))) ok.push(f.slice(1).map(Number));
        else unread++;
    }
    return { ok, unread };
}

/** Mean scheduled-to-started seconds over the runner pods; `?` unless at least `expected` runners all have both times. */
function runnerStart(cell, expected) {
    const text = read(`${cell}.pods.tsv`);
    if (text === null || !Number.isInteger(expected)) return UNKNOWN;
    const pods = new Map();
    for (const line of text.split('\n').slice(1)) {
        const [pod, , scheduled, , , started] = line.split('\t');
        if (!pod?.startsWith('factory-runner-')) continue;
        const span = scheduled === '' || started === '' ? Number.NaN : Number(started) - Number(scheduled);
        pods.set(pod, Math.min(pods.get(pod) ?? Number.POSITIVE_INFINITY, span));
    }
    if (pods.size < expected || [...pods.values()].some((x) => !Number.isFinite(x))) return UNKNOWN;
    return fixed([...pods.values()].reduce((x, y) => x + y, 0) / pods.size, 1);
}

const COLUMNS = [
    'cell', 'kind', 'n', 'r', 'poll_ms', 'lease_s', 'reap_interval_ms', 'reap_grace_ms', 'stalled', 'failed',
    'throughput_per_min', 'wait_p50_s', 'wait_p95_s', 'wait_max_s', 'claim_wait_p95_le_s', 'claim_lock_wait_p95_le_s',
    'running_at_b', 'board_rps', 'board_rps_per_task', 'heartbeats_per_task_min', 'claim_polls_per_min',
    'k8s_rps', 'k8s_rps_per_task', 'k8s_by_client_verb_resource', 'reaper_sweep_p95_le_s', 'reaper_objects_per_sweep',
    'db_lock_waiters_max', 'db_lock_waiters_mean', 'db_ungranted_max', 'db_ungranted_mean', 'db_unread',
    'sync_mean_s', 'sync_p95_le_s', 'runner_start_mean_s', 'held_s', 'settled_s', 'saturated',
];

const HTTP = 'factory_http_request_duration_seconds_count';
const POLLS = 'factory_claim_polls_total';
const K8S = 'factory_driver_k8s_request_duration_seconds_count';

function row(cell) {
    const m = meta(cell);
    const r = Object.fromEntries(COLUMNS.map((c) => [c, UNKNOWN]));
    const raw = { throughput: Number.NaN, wait95: Number.NaN, stalled: Number.NaN, failed: Number.NaN };
    r.cell = cell;
    r.kind = m.kind ?? UNKNOWN;
    r.n = m.n ?? UNKNOWN;
    r.r = m.r ?? UNKNOWN;
    r.poll_ms = m.pollMs ?? UNKNOWN;
    r.lease_s = m.leaseSeconds ?? UNKNOWN;
    r.reap_interval_ms = m.reapIntervalMs ?? UNKNOWN;
    r.reap_grace_ms = m.reapGraceMs ?? UNKNOWN;
    const n = Number(m.n);
    const replicas = Number(m.r);
    const rows = dbRows(cell, n);
    r.held_s = NONE;
    r.settled_s = NONE;
    if (rows) {
        raw.stalled = rows.filter((x) => !Number.isFinite(x.finished)).length;
        raw.failed = rows.filter((x) => Number.isFinite(x.finished) && x.status !== 'succeeded').length;
        r.stalled = String(raw.stalled);
        r.failed = String(raw.failed);
    }
    if (m.kind === 'throughput') {
        if (rows && raw.stalled === 0) {
            const span = Math.max(...rows.map((x) => x.finished)) - Math.min(...rows.map((x) => x.created));
            if (span > 0) {
                raw.throughput = (rows.length * 60) / span;
                r.throughput_per_min = fixed(raw.throughput, 2);
            }
        }
        if (rows && rows.every((x) => Number.isFinite(x.started))) {
            const waits = rows.map((x) => x.started - x.created).sort((x, y) => x - y);
            raw.wait95 = quantile(waits, 0.95);
            r.wait_p50_s = fixed(quantile(waits, 0.5));
            r.wait_p95_s = fixed(raw.wait95);
            r.wait_max_s = fixed(waits[waits.length - 1]);
        }
        const running = Number(m.running_at_b);
        r.running_at_b = m.running_at_b !== undefined && m.running_at_b !== '' && Number.isFinite(running) ? String(running) : UNKNOWN;
        const board = loadSet(cell, 'board', 1);
        const driver = Number.isInteger(replicas) ? loadSet(cell, 'driver', replicas) : null;

        const whole = (base, where) => (samples) => histogramWhole(samples, base, where);
        const fams = (base) => [`${base}_count`, `${base}_sum`, `${base}_bucket`];
        const wait = delta(board, 's', 'c', fams('factory_claim_wait_seconds'), false, whole('factory_claim_wait_seconds'));
        if (wait) r.claim_wait_p95_le_s = histogram(wait.samples, 'factory_claim_wait_seconds').p95Le;
        const lock = delta(board, 's', 'c', fams('factory_claim_lock_wait_seconds'), false, whole('factory_claim_lock_wait_seconds'));
        if (lock) r.claim_lock_wait_p95_le_s = histogram(lock.samples, 'factory_claim_lock_wait_seconds').p95Le;
        const sweepD = delta(
            driver,
            's',
            'c',
            [...fams('factory_driver_reaper_sweep_seconds'), 'factory_driver_reaper_scanned_total'],
            false,
            whole('factory_driver_reaper_sweep_seconds')
        );
        if (sweepD) {
            const sweep = histogram(sweepD.samples, 'factory_driver_reaper_sweep_seconds');
            if (sweep.count > 0) {
                r.reaper_sweep_p95_le_s = sweep.p95Le;
                r.reaper_objects_per_sweep = fixed(sum(sweepD.samples, 'factory_driver_reaper_scanned_total') / sweep.count);
            }
        }
        // Each pod's sync series are whole on their own (count, sum, +Inf bucket, none left over) before any pod is added up.
        const isSync = (l) => l.kind === 'sync';
        const stepD = delta(driver, 's', 'c', fams('factory_driver_step_seconds'), false, whole('factory_driver_step_seconds', isSync));
        if (stepD) {
            const sync = histogram(stepD.samples, 'factory_driver_step_seconds', isSync);
            if (sync.count > 0) {
                r.sync_mean_s = fixed(sync.sum / sync.count, 3);
                r.sync_p95_le_s = sync.p95Le;
            }
        }

        // Per-task rates: each pod's requests over its own interval, per task-second that ran in that interval,
        // and only then added up. Every task needs its claim and its end, or no per-task figure exists.
        const timed = rows !== null && rows.every((x) => Number.isFinite(x.started) && Number.isFinite(x.finished));
        const perTask = (d, valueOf) => {
            if (!timed || !d) return UNKNOWN;
            let total = 0;
            for (const p of d.pods) {
                const avg = activeSeconds(rows, p.from, p.to) / p.seconds;
                if (!(avg > 0)) return UNKNOWN;
                total += valueOf(p) / avg;
            }
            return fixed(total, 3);
        };
        const podRate = (p, name, where = () => true) => sum(p.samples, name, where) / p.seconds;
        const beat = (l) => (l.route ?? '').includes('heartbeat');
        const steadyBoard = delta(board, 'a', 'b', [HTTP, POLLS], true);
        if (steadyBoard) {
            r.board_rps = fixed(rate(steadyBoard, HTTP), 3);
            r.board_rps_per_task = perTask(steadyBoard, (p) => podRate(p, HTTP));
            r.claim_polls_per_min = fixed(rate(steadyBoard, POLLS) * 60, 1);
            if (steadyBoard.pods.every((p) => p.samples.some((x) => x.name === HTTP && beat(x.labels)))) {
                r.heartbeats_per_task_min = perTask(steadyBoard, (p) => podRate(p, HTTP, beat) * 60);
            }
        }
        const steadyDriver = delta(driver, 'a', 'b', [K8S], true);
        if (steadyDriver) {
            const by = new Map();
            for (const p of steadyDriver.pods) {
                for (const x of p.samples) {
                    if (x.name !== K8S) continue;
                    const k = `${x.labels.client}/${x.labels.verb}/${x.labels.resource}`;
                    by.set(k, (by.get(k) ?? 0) + x.value / p.seconds);
                }
            }
            const total = [...by.values()].reduce((a, b) => a + b, 0);
            r.k8s_rps = fixed(total, 3);
            r.k8s_rps_per_task = perTask(steadyDriver, (p) => podRate(p, K8S));
            r.k8s_by_client_verb_resource = [...by]
                .sort((x, y) => y[1] - x[1])
                .map(([k, v]) => `${k}=${fixed(v, 3)}`)
                .join(';');
        }
        const lanes = sampler(cell);
        if (lanes) {
            r.db_unread = String(lanes.unread);
            if (lanes.ok.length > 0) {
                const col = (i) => lanes.ok.map((x) => x[i]);
                const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
                r.db_lock_waiters_max = String(Math.max(...col(0)));
                r.db_lock_waiters_mean = fixed(mean(col(0)));
                r.db_ungranted_max = String(Math.max(...col(1)));
                r.db_ungranted_mean = fixed(mean(col(1)));
            }
        }
        r.runner_start_mean_s = runnerStart(cell, n);
    } else if (m.kind === 'recovery') {
        for (const c of COLUMNS.slice(10, 34)) r[c] = NONE;
        r.running_at_b = NONE;
        r.runner_start_mean_s = runnerStart(cell, n);
        // Only a confirmed kill makes the seconds after it recovery evidence.
        const confirmed = m.kill_confirmed === 'yes';
        r.held_s = confirmed && m.held_s !== undefined ? m.held_s : UNKNOWN;
        r.settled_s = confirmed && m.settled_s !== undefined ? m.settled_s : UNKNOWN;
    }
    return { cells: r, raw };
}

/**
 * saturated=yes|no|? for each throughput row, by the rule in the header comment, on unrounded values: yes when
 * any applicable condition is confirmed, ? when none is but one is unknown, no when all are confirmed false.
 */
function judge(rows) {
    const by = new Map(rows.filter((x) => x.cells.kind === 'throughput').map((x) => [`${x.cells.r}/${x.cells.n}`, x]));
    for (const x of rows) {
        const c = x.cells;
        if (c.kind === 'recovery') {
            c.saturated = NONE;
            continue;
        }
        if (c.kind !== 'throughput') continue;
        const verdicts = []; // true | false | undefined (unknown), one per applicable condition
        verdicts.push(Number.isNaN(x.raw.stalled) || Number.isNaN(x.raw.failed) ? undefined : x.raw.stalled > 0 || x.raw.failed > 0);
        const half = by.get(`${c.r}/${Number(c.n) / 2}`);
        const one = by.get(`${c.r}/1`);
        if (half) {
            const ok = Number.isFinite(x.raw.throughput) && Number.isFinite(half.raw.throughput);
            verdicts.push(ok ? x.raw.throughput / half.raw.throughput < 1.2 : undefined);
        }
        if (one && c.n !== '1') {
            const ok = Number.isFinite(x.raw.wait95) && Number.isFinite(one.raw.wait95);
            verdicts.push(ok ? x.raw.wait95 > 2 * one.raw.wait95 : undefined);
        }
        if (verdicts.includes(true)) c.saturated = 'yes';
        else if (verdicts.includes(undefined)) c.saturated = UNKNOWN;
        else c.saturated = 'no';
    }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const files = readdirSync(dir);
    const cells = [...new Set(files.filter((f) => f.endsWith('.meta.tsv')).map((f) => f.slice(0, -'.meta.tsv'.length)))].sort((x, y) =>
        x.localeCompare(y, 'en', { numeric: true })
    );
    const rows = cells.map((c) => row(c));
    judge(rows);
    process.stdout.write(`${COLUMNS.join('\t')}\n${rows.map((x) => COLUMNS.map((c) => x.cells[c]).join('\t')).join('\n')}\n`);
}
