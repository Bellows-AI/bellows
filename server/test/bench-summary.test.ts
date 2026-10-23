import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * scripts/bench-summary.mjs turns the benchmark phase's per-cell files into one TSV row per cell
 * (issue #831): a read that failed or a counter that went down is `?`, never 0, a bucket bound past the
 * last one is `?`, and no column names a cause.
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

/** A throughput cell whose board answers `waitBuckets` for the whole cell. */
const cell = (name: string, n: number, r: number, extra: Files = {}): Files => ({
    [`${name}.meta.tsv`]: meta({
        kind: 'throughput',
        n,
        r,
        pollMs: 5000,
        leaseSeconds: 300,
        a_at: 1000,
        b_at: 1030,
        running_at_b: n,
    }),
    ...extra,
});

describe('bench-summary', () => {
    it('reads a histogram delta, picks the p95 bucket bound and labels it as a bound', () => {
        const start = histogram('factory_claim_wait_seconds', { '1': 0, '5': 0, '15': 0, '+Inf': 0 }, 0, 'kind="new"');
        const end = histogram(
            'factory_claim_wait_seconds',
            { '1': 1, '5': 10, '15': 20, '+Inf': 20 },
            90,
            'kind="new"'
        );
        const { rows } = summarize(
            cell('t-n4-r1', 4, 1, { 't-n4-r1.board-b0.s.prom': `${start}\n`, 't-n4-r1.board-b0.c.prom': `${end}\n` })
        );
        expect(rows[0]?.claim_wait_p95_le_s).toBe('15');
    });

    it('parses escaped label values and sums series across pods', () => {
        const line = (n: number) =>
            `factory_http_request_duration_seconds_count{method="GET",route="/a\\"b\\\\c",status_class="2xx"} ${n}`;
        const { rows } = summarize(
            cell('t-n1-r1', 1, 1, {
                't-n1-r1.board-b0.a.prom': `${line(10)}\n`,
                't-n1-r1.board-b0.b.prom': `${line(70)}\n`,
                't-n1-r1.board-b1.a.prom': `${line(0)}\n`,
                't-n1-r1.board-b1.b.prom': `${line(30)}\n`,
            })
        );
        // (60 + 30) requests over 30 s, one running task.
        expect(rows[0]?.board_rps).toBe('3');
        expect(rows[0]?.board_rps_per_task).toBe('3');
    });

    it('counts heartbeats per task per minute from the heartbeat route only', () => {
        const at = (beats: number, other: number) =>
            [
                `factory_http_request_duration_seconds_count{method="POST",route="/api/jobs/:id/heartbeat",status_class="2xx"} ${beats}`,
                `factory_http_request_duration_seconds_count{method="GET",route="/api/ready",status_class="2xx"} ${other}`,
            ].join('\n');
        const { rows } = summarize(
            cell('t-n2-r1', 2, 1, {
                't-n2-r1.board-b0.a.prom': `${at(0, 0)}\n`,
                't-n2-r1.board-b0.b.prom': `${at(20, 5)}\n`,
            })
        );
        // 20 beats in 30 s over 2 tasks: 20 per task per minute.
        expect(rows[0]?.heartbeats_per_task_min).toBe('20');
    });

    it('reports a counter that went down as ?, never as a negative or a zero', () => {
        const { rows } = summarize(
            cell('t-n1-r1', 1, 1, {
                't-n1-r1.board-b0.a.prom': 'factory_claim_polls_total{outcome="claimed"} 50\n',
                't-n1-r1.board-b0.b.prom': 'factory_claim_polls_total{outcome="claimed"} 3\n',
            })
        );
        expect(rows[0]?.claim_polls_per_min).toBe('?');
        expect(rows[0]?.board_rps).toBe('?');
    });

    it('reports a missing scrape as ? on both sides of the delta', () => {
        const { rows } = summarize(
            cell('t-n1-r1', 1, 1, { 't-n1-r1.board-b0.a.prom': 'factory_claim_polls_total{outcome="claimed"} 5\n' })
        );
        expect(rows[0]?.claim_polls_per_min).toBe('?');
        expect(rows[0]?.claim_wait_p95_le_s).toBe('?');
    });

    it('reports a p95 that falls in the +Inf bucket as ?', () => {
        const end = histogram('factory_claim_lock_wait_seconds', { '1': 0, '5': 1, '+Inf': 10 }, 500);
        const zero = histogram('factory_claim_lock_wait_seconds', { '1': 0, '5': 0, '+Inf': 0 }, 0);
        const { rows } = summarize(
            cell('t-n4-r1', 4, 1, { 't-n4-r1.board-b0.s.prom': `${zero}\n`, 't-n4-r1.board-b0.c.prom': `${end}\n` })
        );
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

    it('reads the per-thread checkout cost as the sync step only', () => {
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
            ].join('\n');
        const { rows } = summarize(
            cell('t-n4-r1', 4, 1, {
                't-n4-r1.driver-d0.s.prom': `${step(0, 0)}\n`,
                't-n4-r1.driver-d0.c.prom': `${step(4, 4)}\n`,
            })
        );
        expect(rows[0]).toMatchObject({ sync_mean_s: '0.5', sync_p95_le_s: '1' });
    });

    it('marks a cell saturated when its throughput does not rise against half the tasks', () => {
        const base = (n: number, finish: number): Files =>
            cell(`t-n${n}-r1`, n, 1, {
                [`t-n${n}-r1.db.tsv`]: db(
                    Array.from({ length: n }, () => [0, 2, finish, 'succeeded'] as [number, number, number, string])
                ),
            });
        const { rows } = summarize({ ...base(4, 60), ...base(8, 100) });
        const by = Object.fromEntries(rows.map((x) => [x.cell, x]));
        // 4 tasks in 60 s is 4/min, 8 in 100 s is 4.8/min: 1.2x is not below 1.2, a slower 8 would be.
        expect(by['t-n8-r1']?.saturated).toBe('no');
        const slower = summarize({ ...base(4, 60), ...base(8, 130) }).rows.find((x) => x.cell === 't-n8-r1');
        expect(slower?.saturated).toBe('yes');
    });

    it('marks a cell saturated when its claim-wait p95 passes twice the single-task cell', () => {
        const one = cell('t-n1-r1', 1, 1, { 't-n1-r1.db.tsv': db([[0, 2, 62, 'succeeded']]) });
        const sixteen = cell('t-n16-r1', 16, 1, {
            't-n16-r1.db.tsv': db(
                Array.from({ length: 16 }, (_, i) => [0, 2 + i, 70, 'succeeded'] as [number, number, number, string])
            ),
        });
        const { rows } = summarize({ ...one, ...sixteen });
        expect(rows.find((x) => x.cell === 't-n16-r1')?.saturated).toBe('yes');
        expect(rows.find((x) => x.cell === 't-n1-r1')?.saturated).toBe('no');
    });

    it('carries a recovery cell as held and settled seconds and measures no throughput', () => {
        const { rows } = summarize({
            'r-n8-r2.meta.tsv': meta({ kind: 'recovery', n: 8, r: 2, held_s: 41, settled_s: 120 }),
        });
        expect(rows[0]).toMatchObject({
            kind: 'recovery',
            held_s: '41',
            settled_s: '120',
            throughput_per_min: '-',
            saturated: '-',
        });
    });

    it('prints an empty directory as a header and no rows, and has no cause column', () => {
        const { rows, header, status } = summarize({});
        expect(status).toBe(0);
        expect(rows).toEqual([]);
        expect(header).not.toContain('cause');
        expect(header).toContain('saturated');
    });
});
