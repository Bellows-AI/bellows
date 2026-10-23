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
//                                 a_at/b_at (epoch seconds of the two steady-state scrapes), running_at_b,
//                                 held_s/settled_s (recovery cells)
//   <c>.db.tsv                    header, then id, created, started, finished (epoch seconds), status, attempts, claim_seq
//   <c>.sampler.tsv               epoch|lock waiters|ungranted locks|active backends, or epoch|?
//   <c>.pods.tsv                  scripts/k8s-pod-timeline.mjs output for the cell's runner pods
//   <c>.<board|driver>-<pod>.<s|a|b|c>.prom   one scrape: s before queueing, a all running, b thirty seconds on, c settled
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

/**
 * The scrapes of one component at one stage as {pod: samples}; null when a pod has the other stage
 * missing or unparseable. Returns the per-series deltas summed over pods, or null (`?`).
 */
function loadPods(cell, comp, stage, files) {
    const pods = new Map();
    for (const f of files) {
        const m = new RegExp(`^${cell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${comp}-(.+)\\.${stage}\\.prom$`).exec(f);
        if (m) pods.set(m[1], parseProm(read(f) ?? ''));
    }
    return pods;
}

/** Per-series delta end - start across the pods of one component; null when any read is unconfirmed. */
function delta(cell, comp, from, to, files) {
    const a = loadPods(cell, comp, from, files);
    const b = loadPods(cell, comp, to, files);
    if (a.size === 0 || a.size !== b.size) return null;
    const total = new Map();
    for (const [pod, end] of b) {
        const start = a.get(pod);
        if (!start || start.length === 0 || end.length === 0) return null;
        const before = new Map(start.map((s) => [seriesKey(s), s]));
        for (const s of end) {
            const k = seriesKey(s);
            const first = before.get(k);
            const base = first ? first.value : 0;
            if (s.value < base) return null; // a counter that went down: a restart, so no delta
            const prev = total.get(k) ?? { name: s.name, labels: s.labels, value: 0 };
            prev.value += s.value - base;
            total.set(k, prev);
        }
        for (const [k, s] of before) if (!end.some((e) => seriesKey(e) === k)) total.set(`${k}#gone`, { ...s, value: Number.NaN });
    }
    if ([...total.values()].some((s) => Number.isNaN(s.value))) return null;
    return [...total.values()];
}

const sum = (samples, name, where = () => true) =>
    samples.filter((s) => s.name === name && where(s.labels)).reduce((n, s) => n + s.value, 0);

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

function dbRows(cell) {
    const text = read(`${cell}.db.tsv`);
    if (text === null) return null;
    const rows = text
        .split('\n')
        .slice(1)
        .filter((l) => l.trim() !== '')
        .map((l) => l.split('\t'));
    if (rows.length === 0 || rows.some((r) => r.length < 7)) return null;
    return rows.map(([id, created, started, finished, status, attempts, claimSeq]) => ({
        id,
        created: created === '' ? Number.NaN : Number(created),
        started: started === '' ? Number.NaN : Number(started),
        finished: finished === '' ? Number.NaN : Number(finished),
        status,
        attempts,
        claimSeq,
    }));
}

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

function runnerStart(cell) {
    const text = read(`${cell}.pods.tsv`);
    if (text === null) return UNKNOWN;
    const pods = new Map();
    for (const line of text.split('\n').slice(1)) {
        const [pod, , scheduled, , , started] = line.split('\t');
        if (pod?.startsWith('factory-runner-') && scheduled !== '' && started !== '') pods.set(pod, Number(started) - Number(scheduled));
    }
    if (pods.size === 0) return UNKNOWN;
    return fixed([...pods.values()].reduce((a, b) => a + b, 0) / pods.size, 1);
}

const COLUMNS = [
    'cell', 'kind', 'n', 'r', 'poll_ms', 'lease_s', 'reap_interval_ms', 'reap_grace_ms', 'stalled', 'failed',
    'throughput_per_min', 'wait_p50_s', 'wait_p95_s', 'wait_max_s', 'claim_wait_p95_le_s', 'claim_lock_wait_p95_le_s',
    'running_at_b', 'board_rps', 'board_rps_per_task', 'heartbeats_per_task_min', 'claim_polls_per_min',
    'k8s_rps', 'k8s_rps_per_task', 'k8s_by_client_verb_resource', 'reaper_sweep_p95_le_s', 'reaper_objects_per_sweep',
    'db_lock_waiters_max', 'db_lock_waiters_mean', 'db_ungranted_max', 'db_ungranted_mean', 'db_unread',
    'sync_mean_s', 'sync_p95_le_s', 'runner_start_mean_s', 'held_s', 'settled_s', 'saturated',
];

function row(cell, files) {
    const m = meta(cell);
    const r = Object.fromEntries(COLUMNS.map((c) => [c, UNKNOWN]));
    r.cell = cell;
    r.kind = m.kind ?? UNKNOWN;
    r.n = m.n ?? UNKNOWN;
    r.r = m.r ?? UNKNOWN;
    r.poll_ms = m.pollMs ?? UNKNOWN;
    r.lease_s = m.leaseSeconds ?? UNKNOWN;
    r.reap_interval_ms = m.reapIntervalMs ?? UNKNOWN;
    r.reap_grace_ms = m.reapGraceMs ?? UNKNOWN;
    const rows = dbRows(cell);
    r.held_s = m.held_s ?? NONE;
    r.settled_s = m.settled_s ?? NONE;
    r.stalled = rows ? String(rows.filter((x) => Number.isNaN(x.finished)).length) : UNKNOWN;
    r.failed = rows ? String(rows.filter((x) => !Number.isNaN(x.finished) && x.status !== 'succeeded').length) : UNKNOWN;
    const settledAll = rows !== null && rows.every((x) => !Number.isNaN(x.finished));
    const windowS = Number(m.b_at) - Number(m.a_at);
    const running = Number(m.running_at_b);
    r.running_at_b = Number.isFinite(running) && m.running_at_b !== '' && m.running_at_b !== undefined ? String(running) : UNKNOWN;
    const perTask = (value) => (Number.isFinite(running) && running > 0 ? fixed(value / running, 3) : UNKNOWN);

    if (m.kind === 'throughput') {
        if (rows && settledAll) {
            const span = Math.max(...rows.map((x) => x.finished)) - Math.min(...rows.map((x) => x.created));
            r.throughput_per_min = span > 0 ? fixed((rows.length * 60) / span, 2) : UNKNOWN;
        }
        if (rows && rows.every((x) => !Number.isNaN(x.started))) {
            const waits = rows.map((x) => x.started - x.created).sort((x, y) => x - y);
            r.wait_p50_s = fixed(quantile(waits, 0.5));
            r.wait_p95_s = fixed(quantile(waits, 0.95));
            r.wait_max_s = fixed(waits[waits.length - 1]);
        }
        const whole = delta(cell, 'board', 's', 'c', files);
        if (whole) {
            r.claim_wait_p95_le_s = histogram(whole, 'factory_claim_wait_seconds').p95Le;
            r.claim_lock_wait_p95_le_s = histogram(whole, 'factory_claim_lock_wait_seconds').p95Le;
        }
        const driverWhole = delta(cell, 'driver', 's', 'c', files);
        if (driverWhole) {
            const sweep = histogram(driverWhole, 'factory_driver_reaper_sweep_seconds');
            r.reaper_sweep_p95_le_s = sweep.count > 0 ? sweep.p95Le : UNKNOWN;
            r.reaper_objects_per_sweep = sweep.count > 0 ? fixed(sum(driverWhole, 'factory_driver_reaper_scanned_total') / sweep.count) : UNKNOWN;
            const sync = histogram(driverWhole, 'factory_driver_step_seconds', (l) => l.kind === 'sync');
            r.sync_mean_s = sync.count > 0 ? fixed(sync.sum / sync.count, 3) : UNKNOWN;
            r.sync_p95_le_s = sync.p95Le;
        }
        const boardSteady = windowS > 0 ? delta(cell, 'board', 'a', 'b', files) : null;
        if (boardSteady) {
            const rps = sum(boardSteady, 'factory_http_request_duration_seconds_count') / windowS;
            r.board_rps = fixed(rps, 3);
            r.board_rps_per_task = perTask(rps);
            const beats = sum(boardSteady, 'factory_http_request_duration_seconds_count', (l) => (l.route ?? '').includes('heartbeat'));
            r.heartbeats_per_task_min = perTask((beats * 60) / windowS);
            r.claim_polls_per_min = fixed((sum(boardSteady, 'factory_claim_polls_total') * 60) / windowS, 1);
        }
        const driverSteady = windowS > 0 ? delta(cell, 'driver', 'a', 'b', files) : null;
        if (driverSteady) {
            const by = new Map();
            for (const s of driverSteady) {
                if (s.name !== 'factory_driver_k8s_request_duration_seconds_count') continue;
                const k = `${s.labels.client}/${s.labels.verb}/${s.labels.resource}`;
                by.set(k, (by.get(k) ?? 0) + s.value);
            }
            const total = [...by.values()].reduce((a, b) => a + b, 0) / windowS;
            r.k8s_rps = fixed(total, 3);
            r.k8s_rps_per_task = perTask(total);
            r.k8s_by_client_verb_resource =
                by.size === 0
                    ? NONE
                    : [...by]
                          .sort((x, y) => y[1] - x[1])
                          .map(([k, v]) => `${k}=${fixed(v / windowS, 3)}`)
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
        r.runner_start_mean_s = runnerStart(cell);
    } else if (m.kind === 'recovery') {
        for (const c of COLUMNS.slice(10, 34)) r[c] = NONE;
        r.running_at_b = NONE;
        r.runner_start_mean_s = runnerStart(cell);
    }
    return r;
}

/** saturated=yes|no|? for each throughput row, by the rule in the header comment. */
function judge(rows) {
    const by = new Map(rows.filter((x) => x.kind === 'throughput').map((x) => [`${x.r}/${x.n}`, x]));
    for (const x of rows) {
        if (x.kind === 'recovery') {
            x.saturated = NONE;
            continue;
        }
        if (x.stalled === UNKNOWN || x.failed === UNKNOWN) continue;
        if (Number(x.stalled) > 0 || Number(x.failed) > 0) {
            x.saturated = 'yes';
            continue;
        }
        const half = by.get(`${x.r}/${Number(x.n) / 2}`);
        const one = by.get(`${x.r}/1`);
        const checks = [];
        if (half && x.throughput_per_min !== UNKNOWN && half.throughput_per_min !== UNKNOWN) {
            checks.push(Number(x.throughput_per_min) / Number(half.throughput_per_min) < 1.2);
        }
        if (one && x.n !== '1' && x.wait_p95_s !== UNKNOWN && one.wait_p95_s !== UNKNOWN) {
            checks.push(Number(x.wait_p95_s) > 2 * Number(one.wait_p95_s));
        }
        if (checks.length === 0) {
            x.saturated = x.n === '1' ? 'no' : UNKNOWN;
        } else {
            x.saturated = checks.some(Boolean) ? 'yes' : 'no';
        }
    }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const files = readdirSync(dir);
    const cells = [...new Set(files.filter((f) => f.endsWith('.meta.tsv')).map((f) => f.slice(0, -'.meta.tsv'.length)))].sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
    const rows = cells.map((c) => row(c, files));
    judge(rows);
    process.stdout.write(`${COLUMNS.join('\t')}\n${rows.map((x) => COLUMNS.map((c) => x[c]).join('\t')).join('\n')}\n`);
}
