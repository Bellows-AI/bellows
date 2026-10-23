import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * scripts/bench-summary.mjs turns the benchmark phase's per-cell files into one TSV row per cell
 * (issue #831): a read that failed or a counter that went down is `?`, never 0, a bucket bound past the
 * last one is `?`, and no column names a cause. Absent or partial evidence (a pod's scrape, a metric family, a
 * task row) leaves a figure `?`; rates use each scrape's own answer time; per-task rates integrate the tasks
 * that ran in the window; saturation is judged on unrounded values.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/bench-summary.mjs', import.meta.url));

type Files = Record<string, string>;
type Row = Record<string, string>;

const summarize = (files: Files): { status: number | null; rows: Row[]; header: string[] } => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-summary-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const run = spawnSync('node', [SCRIPT, dir], { encoding: 'utf8' });
    const [head = '', ...lines] = run.stdout.split('\n').filter((l) => l !== '');
    const header = head.split('\t');
    return {
        status: run.status,
        header,
        rows: lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [header[i] ?? String(i), v]))),
    };
};

const meta = (kv: Record<string, string | number>): string =>
    `${Object.entries(kv)
        .map(([k, v]) => `${k}\t${v}`)
        .join('\n')}\n`;
const db = (rows: Array<[number, number, number, string]>): string =>
    `id\tcreated\tstarted\tfinished\tstatus\tattempts\tclaim_seq\n${rows
        .map(([created, started, finished, status], i) => `j${i}\t${created}\t${started}\t${finished}\t${status}\t1\t1`)
        .join('\n')}\n`;

const histogram = (name: string, buckets: Record<string, number>, sum: number, labels = ''): string => {
    const lead = labels === '' ? '' : `${labels},`;
    const count = buckets['+Inf'] ?? 0;
    return [
        ...Object.entries(buckets).map(([le, n]) => `${name}_bucket{${lead}le="${le}"} ${n}`),
        `${name}_sum${labels === '' ? '' : `{${labels}}`} ${sum}`,
        `${name}_count${labels === '' ? '' : `{${labels}}`} ${count}`,
    ].join('\n');
};

type Stage = 's' | 'a' | 'b' | 'c';
const AT: Record<Stage, number> = { s: 900, a: 1000, b: 1030, c: 1200 };
const FILLER = 'unrelated_family 1\n';

/**
 * The list and scrape files of one component's pods. `stages` gives a pod's text (and optionally its answer
 * time) per stage; a stage it leaves out holds an unrelated family; `'missing'` lists the pod but leaves its
 * scrape out.
 */
const scrapes = (
    cell: string,
    comp: 'board' | 'driver',
    pods: Record<string, Partial<Record<Stage, string | [string, number] | 'missing'>>>
): Files => {
    const files: Files = {};
    for (const stage of ['s', 'a', 'b', 'c'] as Stage[]) {
        files[`${cell}.${comp}.${stage}.list`] = `${Object.keys(pods).join('\n')}\n`;
        for (const [pod, byStage] of Object.entries(pods)) {
            const given = byStage[stage] ?? FILLER;
            if (given === 'missing') continue;
            const [text, at] = typeof given === 'string' ? [given, AT[stage]] : given;
            files[`${cell}.${comp}-${pod}.${stage}.prom`] = text;
            files[`${cell}.${comp}-${pod}.${stage}.at`] = `${at}\n`;
        }
    }
    return files;
};

const board = (cell: string, byStage: Partial<Record<Stage, string | [string, number]>>, pod = 'b0'): Files =>
    scrapes(cell, 'board', { [pod]: byStage });

/** A throughput cell with its meta; `extra` brings the cell's other files. */
const cell = (name: string, n: number, r: number, extra: Files = {}): Files => ({
    [`${name}.meta.tsv`]: meta({
        kind: 'throughput',
        n,
        r,
        pollMs: 5000,
        leaseSeconds: 300,
        running_at_b: n,
    }),
    ...extra,
});

const tasks = (n: number, finish: number, start = 2): Array<[number, number, number, string]> =>
    Array.from({ length: n }, () => [0, start, finish, 'succeeded']);

describe('bench-summary', () => {
    it('reads a histogram delta, picks the p95 bucket bound and labels it as a bound', () => {
        const start = histogram('factory_claim_wait_seconds', { '1': 0, '5': 0, '15': 0, '+Inf': 0 }, 0, 'kind="new"');
        const end = histogram(
            'factory_claim_wait_seconds',
            { '1': 1, '5': 10, '15': 20, '+Inf': 20 },
            90,
            'kind="new"'
        );
        const { rows } = summarize(cell('t-n4-r1', 4, 1, board('t-n4-r1', { s: start, c: end })));
        expect(rows[0]?.claim_wait_p95_le_s).toBe('15');
    });

    it('parses escaped label values and sums series', () => {
        const line = (n: number, status: string) =>
            `factory_http_request_duration_seconds_count{method="GET",route="/a\\"b\\\\c",status_class="${status}"} ${n}\nfactory_claim_polls_total{outcome="x"} 0\n`;
        const files = board('t-n1-r1', { a: line(10, '2xx'), b: `${line(70, '2xx')}${line(30, '5xx')}` });
        // (60 + 30) requests over 30 s.
        expect(summarize(cell('t-n1-r1', 1, 1, files)).rows[0]?.board_rps).toBe('3');
    });

    it('counts heartbeats per task per minute from the heartbeat route only', () => {
        const at = (beats: number, other: number) =>
            [
                `factory_http_request_duration_seconds_count{method="POST",route="/api/jobs/:id/heartbeat",status_class="2xx"} ${beats}`,
                `factory_http_request_duration_seconds_count{method="GET",route="/api/ready",status_class="2xx"} ${other}`,
                'factory_claim_polls_total{outcome="claimed"} 0',
            ].join('\n');
        const { rows } = summarize(
            cell('t-n2-r1', 2, 1, {
                ...board('t-n2-r1', { a: `${at(0, 0)}\n`, b: `${at(20, 5)}\n` }),
                // both tasks run through the whole window
                't-n2-r1.db.tsv': db([
                    [0, 900, 1300, 'succeeded'],
                    [0, 900, 1300, 'succeeded'],
                ]),
            })
        );
        // 20 beats in 30 s over 2 tasks: 20 per task per minute.
        expect(rows[0]?.heartbeats_per_task_min).toBe('20');
    });

    it('reports a counter that went down as ?, never as a negative or a zero', () => {
        const { rows } = summarize(
            cell(
                't-n1-r1',
                1,
                1,
                board('t-n1-r1', {
                    a: 'factory_claim_polls_total{outcome="claimed"} 50\nfactory_http_request_duration_seconds_count{route="/x"} 5\n',
                    b: 'factory_claim_polls_total{outcome="claimed"} 3\nfactory_http_request_duration_seconds_count{route="/x"} 9\n',
                })
            )
        );
        expect(rows[0]?.claim_polls_per_min).toBe('?');
        expect(rows[0]?.board_rps).toBe('?');
    });

    it('reports a missing scrape as ?', () => {
        const files = board('t-n1-r1', { a: 'factory_claim_polls_total{outcome="claimed"} 5\n' });
        delete files['t-n1-r1.board-b0.b.prom'];
        delete files['t-n1-r1.board-b0.b.at'];
        const { rows } = summarize(cell('t-n1-r1', 1, 1, files));
        expect(rows[0]?.claim_polls_per_min).toBe('?');
        expect(rows[0]?.claim_wait_p95_le_s).toBe('?');
    });

    it('reports a p95 that falls in the +Inf bucket as ?', () => {
        const end = histogram('factory_claim_lock_wait_seconds', { '1': 0, '5': 1, '+Inf': 10 }, 500);
        const zero = histogram('factory_claim_lock_wait_seconds', { '1': 0, '5': 0, '+Inf': 0 }, 0);
        const { rows } = summarize(cell('t-n4-r1', 4, 1, board('t-n4-r1', { s: zero, c: end })));
        expect(rows[0]?.claim_lock_wait_p95_le_s).toBe('?');
    });

    it('takes throughput and the queued to claimed percentiles from the database rows', () => {
        const rows = db([
            [100, 102, 170, 'succeeded'],
            [100, 103, 171, 'succeeded'],
            [100, 105, 172, 'succeeded'],
            [100, 120, 190, 'succeeded'],
        ]);
        const { rows: out } = summarize(cell('t-n4-r1', 4, 1, { 't-n4-r1.db.tsv': rows }));
        // 4 tasks over 90 s: 2.67 per minute.
        expect(out[0]).toMatchObject({
            throughput_per_min: '2.67',
            wait_p50_s: '3',
            wait_p95_s: '20',
            wait_max_s: '20',
            stalled: '0',
            failed: '0',
        });
    });

    it('counts an unfinished task as stalled and leaves the throughput unknown', () => {
        const { rows } = summarize(
            cell('t-n2-r1', 2, 1, {
                't-n2-r1.db.tsv':
                    'id\tcreated\tstarted\tfinished\tstatus\tattempts\tclaim_seq\nj0\t100\t101\t170\tsucceeded\t1\t1\nj1\t100\t\t\tqueued\t0\t0\n',
            })
        );
        expect(rows[0]).toMatchObject({ stalled: '1', throughput_per_min: '?', wait_p95_s: '?', saturated: 'yes' });
    });

    it('reports an empty or absent database read as ?', () => {
        const { rows } = summarize(
            cell('t-n1-r1', 1, 1, { 't-n1-r1.db.tsv': 'id\tcreated\tstarted\tfinished\tstatus\tattempts\tclaim_seq\n' })
        );
        expect(rows[0]).toMatchObject({ stalled: '?', failed: '?', throughput_per_min: '?', wait_p95_s: '?' });
    });

    it('reports ? when fewer or duplicate task rows came back than the cell queued', () => {
        const one = summarize(cell('t-n4-r1', 4, 1, { 't-n4-r1.db.tsv': db([[0, 2, 60, 'succeeded']]) })).rows[0];
        expect(one).toMatchObject({
            stalled: '?',
            failed: '?',
            throughput_per_min: '?',
            wait_p95_s: '?',
            saturated: '?',
        });
        const twice =
            'id\tcreated\tstarted\tfinished\tstatus\tattempts\tclaim_seq\nj0\t0\t2\t60\tsucceeded\t1\t1\nj0\t0\t2\t60\tsucceeded\t1\t1\n';
        expect(summarize(cell('t-n2-r1', 2, 1, { 't-n2-r1.db.tsv': twice })).rows[0]).toMatchObject({
            stalled: '?',
            throughput_per_min: '?',
        });
    });

    it('reports ? for a task row with no creation time', () => {
        const bad = 'id\tcreated\tstarted\tfinished\tstatus\tattempts\tclaim_seq\nj0\t\t2\t60\tsucceeded\t1\t1\n';
        expect(summarize(cell('t-n1-r1', 1, 1, { 't-n1-r1.db.tsv': bad })).rows[0]).toMatchObject({
            stalled: '?',
            throughput_per_min: '?',
        });
    });

    it('takes the lock-waiter max and mean from readable samples and counts the unread ones apart', () => {
        const { rows } = summarize(
            cell('t-n1-r1', 1, 1, { 't-n1-r1.sampler.tsv': '1|0|0|1\n2|3|1|2\n3|?\n4|0|0|1\ngarbage\n' })
        );
        expect(rows[0]).toMatchObject({
            db_lock_waiters_max: '3',
            db_lock_waiters_mean: '1',
            db_ungranted_max: '1',
            db_ungranted_mean: '0.33',
            db_unread: '2',
        });
    });

    it('leaves the sampler columns ? when no sample was readable', () => {
        const { rows } = summarize(cell('t-n1-r1', 1, 1, { 't-n1-r1.sampler.tsv': '1|?\n2|?\n' }));
        expect(rows[0]).toMatchObject({ db_lock_waiters_max: '?', db_unread: '2' });
    });

    const step = (sync: number, other: number) =>
        [
            histogram(
                'factory_driver_step_seconds',
                { '1': sync, '5': sync, '+Inf': sync },
                sync * 0.5,
                'kind="sync",outcome="ok"'
            ),
            histogram(
                'factory_driver_step_seconds',
                { '1': other, '5': other, '+Inf': other },
                other * 100,
                'kind="agent",outcome="ok"'
            ),
            'factory_driver_reaper_sweep_seconds_count{outcome="ok"} 0',
            'factory_driver_reaper_scanned_total{what="jobs"} 0',
        ].join('\n');

    it('reads the per-thread checkout cost as the sync step only', () => {
        const { rows } = summarize(
            cell('t-n4-r1', 4, 1, scrapes('t-n4-r1', 'driver', { d0: { s: `${step(0, 0)}\n`, c: `${step(4, 4)}\n` } }))
        );
        expect(rows[0]).toMatchObject({ sync_mean_s: '0.5', sync_p95_le_s: '1' });
    });

    // Class A: a missing family or pod is never a zero.
    it('reports ? for every rate when the scrapes carry none of the families', () => {
        const only = 'unrelated 1\n';
        const { rows } = summarize(
            cell('t-n2-r1', 2, 1, {
                ...board('t-n2-r1', { a: only, b: only, s: only, c: only }),
                ...scrapes('t-n2-r1', 'driver', { d0: { a: only, b: only, s: only, c: only } }),
            })
        );
        expect(rows[0]).toMatchObject({
            board_rps: '?',
            heartbeats_per_task_min: '?',
            claim_polls_per_min: '?',
            k8s_rps: '?',
            reaper_objects_per_sweep: '?',
            sync_mean_s: '?',
            claim_wait_p95_le_s: '?',
        });
    });

    it('reports ? for objects per sweep when the scanned counter is absent', () => {
        const noScan = 'factory_driver_reaper_sweep_seconds_count{outcome="ok"} 2\n';
        const { rows } = summarize(
            cell('t-n2-r1', 2, 1, scrapes('t-n2-r1', 'driver', { d0: { s: noScan, c: noScan } }))
        );
        expect(rows[0]?.reaper_objects_per_sweep).toBe('?');
    });

    it('reports ? when a driver replica of two has no scrape, and when the list differs between stages', () => {
        const k8s = (n: number) =>
            `factory_driver_k8s_request_duration_seconds_count{client="runner",verb="get",resource="pods"} ${n}\n`;
        const both = scrapes('t-n2-r2', 'driver', { d0: { a: k8s(0), b: k8s(30) }, d1: { a: k8s(0), b: k8s(30) } });
        expect(summarize(cell('t-n2-r2', 2, 2, both)).rows[0]?.k8s_rps).toBe('2');
        const lost = { ...both };
        delete lost['t-n2-r2.driver-d1.a.prom'];
        delete lost['t-n2-r2.driver-d1.a.at'];
        expect(summarize(cell('t-n2-r2', 2, 2, lost)).rows[0]?.k8s_rps).toBe('?');
        const oneListed = scrapes('t-n2-r2', 'driver', { d0: { a: k8s(0), b: k8s(30) } });
        expect(summarize(cell('t-n2-r2', 2, 2, oneListed)).rows[0]?.k8s_rps).toBe('?');
        const swapped = { ...both, 't-n2-r2.driver.b.list': 'd0\nd9\n' };
        expect(summarize(cell('t-n2-r2', 2, 2, swapped)).rows[0]?.k8s_rps).toBe('?');
    });

    it('reports ? when a scrape has no answer time', () => {
        const files = board('t-n1-r1', {
            a: 'factory_claim_polls_total{outcome="x"} 1\nfactory_http_request_duration_seconds_count{route="/x"} 1\n',
            b: 'factory_claim_polls_total{outcome="x"} 9\nfactory_http_request_duration_seconds_count{route="/x"} 9\n',
        });
        expect(summarize(cell('t-n1-r1', 1, 1, files)).rows[0]?.claim_polls_per_min).toBe('16');
        delete files['t-n1-r1.board-b0.b.at'];
        expect(summarize(cell('t-n1-r1', 1, 1, files)).rows[0]?.claim_polls_per_min).toBe('?');
    });

    // Class B: arithmetic.
    it('divides each pod by its own observation interval, not by one recorded window', () => {
        const polls = (n: number) =>
            `factory_claim_polls_total{outcome="x"} ${n}\nfactory_http_request_duration_seconds_count{route="/x"} ${n}\n`;
        // 40 polls between answers 1005 and 1045 (40 s): 1 per second, not 40 / 30.
        const files = board('t-n1-r1', { a: [polls(0), 1005], b: [polls(40), 1045] });
        expect(summarize(cell('t-n1-r1', 1, 1, files)).rows[0]).toMatchObject({
            board_rps: '1',
            claim_polls_per_min: '60',
        });
    });

    it('integrates the tasks that ran inside the window instead of dividing by the last count', () => {
        const http = (n: number) =>
            `factory_http_request_duration_seconds_count{route="/api/jobs/:id/heartbeat"} ${n}\nfactory_claim_polls_total{outcome="x"} 0\n`;
        // Four tasks run for the first half of the 30 s window, two for the second: 3 on average.
        const files = cell('t-n4-r1', 4, 1, {
            ...board('t-n4-r1', { a: [http(0), 1000], b: [http(90), 1030] }),
            't-n4-r1.db.tsv': db([
                [900, 901, 1015, 'succeeded'],
                [900, 901, 1015, 'succeeded'],
                [900, 901, 1100, 'succeeded'],
                [900, 901, 1100, 'succeeded'],
            ]),
        });
        // 90 requests in 30 s = 3/s over an average of 3 tasks: 1 per task per second.
        expect(summarize(files).rows[0]).toMatchObject({ board_rps: '3', board_rps_per_task: '1' });
    });

    const cellWith = (n: number, r: number, finish: number, wait = 2): Files =>
        cell(`t-n${n}-r${r}`, n, r, { [`t-n${n}-r${r}.db.tsv`]: db(tasks(n, finish, wait)) });
    const verdict = (files: Files, name: string) => summarize(files).rows.find((x) => x.cell === name)?.saturated;

    it('marks a cell saturated when its throughput does not rise against half the tasks', () => {
        expect(verdict({ ...cellWith(4, 1, 60), ...cellWith(8, 1, 100) }, 't-n8-r1')).toBe('no');
        expect(verdict({ ...cellWith(4, 1, 60), ...cellWith(8, 1, 130) }, 't-n8-r1')).toBe('yes');
    });

    it('judges both saturation thresholds on unrounded values', () => {
        // 4 in 60 s and 8 in 100.1 s: the ratio is 1.199, below 1.2, while the rounded rates read 4 and 4.8.
        expect(verdict({ ...cellWith(4, 1, 60), ...cellWith(8, 1, 100.1) }, 't-n8-r1')).toBe('yes');
        // A wait p95 of 4.004 s against twice 2.001 s passes the threshold; the rounded 4 and 2 would not.
        const one = cell('t-n1-r1', 1, 1, { 't-n1-r1.db.tsv': db([[0, 2.001, 62, 'succeeded']]) });
        const sixteen = cell('t-n16-r1', 16, 1, { 't-n16-r1.db.tsv': db(tasks(16, 70, 4.004)) });
        expect(verdict({ ...one, ...sixteen }, 't-n16-r1')).toBe('yes');
    });

    it('marks a cell saturated when its claim-wait p95 passes twice the single-task cell', () => {
        const one = cell('t-n1-r1', 1, 1, { 't-n1-r1.db.tsv': db([[0, 2, 62, 'succeeded']]) });
        const sixteen = cell('t-n16-r1', 16, 1, {
            't-n16-r1.db.tsv': db(Array.from({ length: 16 }, (_, i) => [0, 2 + i, 70, 'succeeded'])),
        });
        const files = { ...one, ...sixteen };
        expect(verdict(files, 't-n16-r1')).toBe('yes');
        expect(verdict(files, 't-n1-r1')).toBe('no');
    });

    it('reports ? when an applicable saturation condition is unknown and none is confirmed', () => {
        // N=4 has no usable rows, so N=8's throughput condition is unknown; its wait condition is false.
        const four = cell('t-n4-r1', 4, 1, { 't-n4-r1.db.tsv': db([[0, 2, 60, 'succeeded']]) });
        const one = cellWith(1, 1, 62);
        expect(verdict({ ...one, ...four, ...cellWith(8, 1, 100) }, 't-n8-r1')).toBe('?');
        // A confirmed condition still wins over an unknown one.
        expect(verdict({ ...one, ...four, ...cellWith(8, 1, 100, 30) }, 't-n8-r1')).toBe('yes');
    });

    it('carries a confirmed recovery cell as held and settled seconds and measures no throughput', () => {
        const { rows } = summarize({
            'r-n8-r2.meta.tsv': meta({
                kind: 'recovery',
                n: 8,
                r: 2,
                kill_confirmed: 'yes',
                held_s: 41,
                settled_s: 120,
            }),
        });
        expect(rows[0]).toMatchObject({
            kind: 'recovery',
            held_s: '41',
            settled_s: '120',
            throughput_per_min: '-',
            saturated: '-',
        });
    });

    it('accepts no recovery seconds from a kill nobody confirmed', () => {
        const unconfirmed = summarize({
            'r-n8-r2.meta.tsv': meta({
                kind: 'recovery',
                n: 8,
                r: 2,
                kill_confirmed: 'no',
                held_s: 41,
                settled_s: 120,
            }),
        });
        expect(unconfirmed.rows[0]).toMatchObject({ held_s: '?', settled_s: '?' });
        const absent = summarize({ 'r-n8-r2.meta.tsv': meta({ kind: 'recovery', n: 8, r: 2, held_s: 41 }) });
        expect(absent.rows[0]).toMatchObject({ held_s: '?', settled_s: '?' });
    });

    it('prints an empty directory as a header and no rows, and has no cause column', () => {
        const { rows, header, status } = summarize({});
        expect(status).toBe(0);
        expect(rows).toEqual([]);
        expect(header).not.toContain('cause');
        expect(header).toContain('saturated');
    });
});
