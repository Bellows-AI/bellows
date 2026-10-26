import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { reduceUsage, type TokenType, type Tokens, type UsageReport } from '@factory-ai/core';
import { createPostgresTelemetryClient } from '../src/telemetry/postgres-client.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { buildRunActivity, gateActivityOf, prActivityOf } from '../src/telemetry/run-activity.js';
import { readGlobalReconciliation, readUsageFacts, type UsageFacts } from '../src/telemetry/usage-facts.js';
import { useTestDb } from './harness.js';
import { createWorld, type World } from './usage-world.js';

const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 3 });

const NOW = new Date('2026-09-20T00:00:00Z');
const TYPES: TokenType[] = ['input', 'output', 'cacheRead', 'cacheCreation'];
const FIELD: Record<TokenType, string> = {
    input: 'tokens_input',
    output: 'tokens_output',
    cacheRead: 'tokens_cacheRead',
    cacheCreation: 'tokens_cacheCreation',
};
const at = (hhmm: string, day = '10'): string => `2026-09-${day}T${hhmm}:00Z`;

/** Every amount is a distinct power of two per type, so a lost or doubled contribution changes the sum. */
const AMOUNT = {
    j1Run: 1,
    j1Gap: 2,
    j2Run: 4,
    review: 8,
    node: 16,
    removed: 32,
    hookless: 64,
    conflict: 128,
    cross: 256,
    orphan: 512,
    branchOnly: 1024,
    backfill: 2048,
    adoptedRun: 4096,
    otherOrg: 8192,
    sharedOpencode: 16384,
    sharedClaude: 32768,
    nullSession: 65536,
} as const;

interface Built {
    A: string;
    B: string;
    ids: Record<string, string>;
    markers: { a: string[]; b: string[] };
}

let w: World;
const SESSIONS_WITHOUT_HOOK = 7; // board-owned rollups with no branch report, counted in totals
let sql: Sql;
let built: Built;

/** Two organizations; the cases the spec names, one session each. */
async function buildWorld(): Promise<Built> {
    const A = w.org();
    const B = w.org();
    const ids: Record<string, string> = {};
    const s = (label: string): string => (ids[label] = w.marker(label));
    const a1 = await w.user('author-a1');
    const a2 = await w.user('author-a2');
    const b1 = await w.user('author-b1');
    const repoA = w.marker('acme-a/app');
    const repoA2 = w.marker('acme-a/lib');
    const repoB = w.marker('acme-b/app');

    // T1: a run and a follow-up share one session; a named review and a workflow node have their own.
    const j1 = await w.job({ org: A, author: a1.id, repo: repoA });
    const j2 = await w.job({ org: A, root: j1, parent: j1, author: a1.id, repo: repoA });
    const rv = await w.job({ org: A, root: j1, author: a1.id, repo: repoA, reviewOf: j1 });
    const node = await w.job({ org: A, root: j1, parent: j1, author: a1.id, repo: repoA });
    const exec = { org: A, root: j1, author: a1.id, repo: repoA } as const;
    await w.execution({ ...exec, job: j1, start: at('10:00'), end: at('11:00'), sessions: [{ id: s('shared') }] });
    await w.execution({ ...exec, job: j2, start: at('12:00'), end: at('13:00'), sessions: [{ id: ids.shared! }] });
    await w.execution({
        ...exec,
        job: rv,
        requestingJob: j1,
        requestingRoot: j1,
        start: at('10:20'),
        end: at('10:50'),
        sessions: [{ id: s('review') }],
    });
    await w.execution({
        ...exec,
        job: node,
        agent: 'opencode',
        start: at('10:00'),
        end: at('11:00'),
        sessions: [{ id: s('node'), agent: 'opencode' }],
    });
    await w.branch({ org: A, session: ids.shared!, repo: repoA });
    ids.root = j1;
    ids.followUp = j2;
    ids.reviewJob = rv;

    // A deleted task: its executions are marked removed and its job rows are gone.
    const gone = await w.job({ org: A, author: a2.id, repo: repoA });
    await w.execution({
        org: A,
        job: gone,
        root: gone,
        author: a2.id,
        repo: repoA,
        start: at('09:00'),
        end: at('10:00'),
        removed: true,
        sessions: [{ id: s('removed') }],
    });
    await sql`delete from job where org_id = ${A} and id = ${gone}`;

    // A board-owned session with no hook report at all.
    const t3 = await w.job({ org: A, author: a1.id, repo: repoA2 });
    await w.execution({
        org: A,
        job: t3,
        root: t3,
        author: a1.id,
        repo: repoA2,
        start: at('09:00'),
        end: at('10:00'),
        sessions: [{ id: s('hookless') }],
    });

    // Two tasks of one org claim one session: a conflict, never a min().
    const c1 = await w.job({ org: A, author: a1.id, repo: repoA });
    const c2 = await w.job({ org: A, author: a1.id, repo: repoA });
    const conflicted = s('conflict');
    for (const job of [c1, c2]) {
        await w.execution({
            org: A,
            job,
            root: job,
            author: a1.id,
            repo: repoA,
            start: at('09:00'),
            end: at('10:00'),
            sessions: [{ id: conflicted }],
        });
    }

    // One session id used by both organizations.
    const x1 = await w.job({ org: A, author: a1.id, repo: repoA });
    const x2 = await w.job({ org: B, author: b1.id, repo: repoB });
    await w.execution({
        org: A,
        job: x1,
        root: x1,
        author: a1.id,
        repo: repoA,
        start: at('09:00'),
        end: at('10:00'),
        sessions: [{ id: s('cross') }],
    });
    await w.execution({
        org: B,
        job: x2,
        root: x2,
        author: b1.id,
        repo: repoB,
        start: at('09:00'),
        end: at('10:00'),
        sessions: [{ id: ids.cross! }],
    });
    await w.branch({ org: A, session: ids.cross!, repo: repoA });

    // A hook-only session: a repo, no board task.
    await w.branch({ org: A, session: s('branchOnly'), repo: repoA });

    // An adoption chain: claim 2 adopts claim 1 of the same run.
    const adopted = await w.job({ org: A, author: a1.id, repo: repoA });
    await w.execution({
        org: A,
        job: adopted,
        root: adopted,
        author: a1.id,
        repo: repoA,
        claim: 1,
        start: at('08:00'),
        end: at('08:30'),
        sessions: [{ id: s('adopted') }],
    });
    ids.adoptedJob = adopted;

    // A backfilled execution: task-owned, no start.
    const bf = await w.job({ org: A, author: a1.id, repo: repoA });
    await w.execution({
        org: A,
        job: bf,
        root: bf,
        author: a1.id,
        repo: repoA,
        origin: 'backfill',
        launch: 'unknown',
        start: null,
        sessions: [{ id: s('backfill'), origin: 'backfill' }],
    });

    // Two agents share a session id, but only opencode is named by the evidence.
    const sh = await w.job({ org: A, author: a1.id, repo: repoA });
    await w.execution({
        org: A,
        job: sh,
        root: sh,
        author: a1.id,
        repo: repoA,
        agent: 'opencode',
        start: at('09:00'),
        end: at('10:00'),
        sessions: [{ id: s('twoAgents'), agent: 'opencode' }],
    });

    // The other organization's own task.
    const tb = await w.job({ org: B, author: b1.id, repo: repoB });
    await w.execution({
        org: B,
        job: tb,
        root: tb,
        author: b1.id,
        repo: repoB,
        start: at('09:00'),
        end: at('10:00'),
        sessions: [{ id: s('otherOrg') }],
    });
    await w.branch({ org: B, session: ids.otherOrg!, repo: repoB });
    ids.taskB = tb;

    const put = (
        session: string | null,
        value: number,
        time: string,
        over: Partial<Parameters<World['point']>[0]> = {}
    ) => w.point({ session, field: 'tokens_input', value, time, ...over });
    await put(ids.shared!, AMOUNT.j1Run, at('10:30'));
    await put(ids.shared!, AMOUNT.j1Gap, at('11:30'));
    await put(ids.shared!, AMOUNT.j2Run, at('12:30'));
    await put(ids.review!, AMOUNT.review, at('10:35'));
    await put(ids.node!, AMOUNT.node, at('10:15'), { agent: 'opencode' });
    await put(ids.removed!, AMOUNT.removed, at('09:30'));
    await put(ids.hookless!, AMOUNT.hookless, at('09:40'));
    await put(ids.conflict!, AMOUNT.conflict, at('09:45'));
    await put(ids.cross!, AMOUNT.cross, at('09:50'));
    await put(ids.orphan ?? s('orphan'), AMOUNT.orphan, at('09:20'));
    await put(ids.branchOnly!, AMOUNT.branchOnly, at('09:25'));
    await put(ids.backfill!, AMOUNT.backfill, at('09:00'));
    await put(ids.adopted!, AMOUNT.adoptedRun, at('08:10'));
    await put(ids.otherOrg!, AMOUNT.otherOrg, at('09:30'));
    await put(ids.twoAgents!, AMOUNT.sharedOpencode, at('09:30'), { agent: 'opencode' });
    await put(ids.twoAgents!, AMOUNT.sharedClaude, at('09:31'));
    await put(null, AMOUNT.nullSession, at('09:00'));
    // A cumulative counter on the shared session: first reading unlocated, then an increment inside the run
    // (assigned) and one that spans the gap between the runs (task-owned, run-unassigned).
    const cum = { temporality: 'cumulative', startTime: at('10:00'), field: 'tokens_output' } as const;
    await w.point({ session: ids.shared!, value: 5, time: at('10:10'), ...cum });
    await w.point({ session: ids.shared!, value: 8, time: at('10:40'), ...cum });
    await w.point({ session: ids.shared!, value: 20, time: at('12:20'), ...cum });
    // A cumulative counter with no start time: its first reading has no placement at all.
    const open = { temporality: 'cumulative', field: 'tokens_cacheRead' } as const;
    await w.point({ session: ids.shared!, value: 9, time: at('10:20'), ...open });
    await w.point({ session: ids.shared!, value: 11, time: at('10:45'), ...open });

    return {
        A,
        B,
        ids,
        markers: {
            a: [repoA, repoA2, a1.login, a1.id, a2.login, a2.id, j1, ids.cross!],
            b: [repoB, b1.login, b1.id, tb, ids.otherOrg!, x2],
        },
    };
}

const snapshot = <T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> =>
    sql.begin('isolation level repeatable read, read only', fn) as Promise<T>;

const facts = (org: string): Promise<UsageFacts> => snapshot((tx) => readUsageFacts(tx, org));

const text = (f: UsageFacts): string => JSON.stringify({ ...f, foreignSessionIds: [...f.foreignSessionIds] });

const reportOf = (f: UsageFacts): UsageReport => reduceUsage(f, { range: null, now: NOW });

const sumTypes = (t: Tokens): Record<TokenType, number> =>
    Object.fromEntries(TYPES.map((type) => [type, t[type] ?? 0])) as Record<TokenType, number>;

describe.skipIf(!enabled)('token reconciliation', () => {
    beforeEach(async () => {
        sql = db.sql;
        w = createWorld(sql);
        built = await buildWorld();
    });

    it("keeps the other organization's detail and the shared session out of a tenant read", async () => {
        const [a, b] = await Promise.all([facts(built.A), facts(built.B)]);
        for (const marker of built.markers.b) expect(text(a)).not.toContain(marker);
        // A's repos, logins and ids never appear in B's read (the one cross-org id is excluded too).
        for (const marker of built.markers.a) expect(text(b)).not.toContain(marker);
        expect(text(a)).not.toContain(built.ids.cross!);
        expect(text(b)).not.toContain(built.ids.cross!);
        // not even as a count in what the tenant reduces
        expect(JSON.stringify(reportOf(a))).not.toContain(built.ids.cross!);
        expect(sumTypes(reportOf(a).eligible.tokens).input & AMOUNT.cross).toBe(0);
        expect(sumTypes(reportOf(a).diagnostics.unresolvedOwnership.tokens).input & AMOUNT.cross).toBe(0);
    });

    it('answers the same canonical task from any job of it, equal to the stats task, review included', async () => {
        const client = createPostgresTelemetryClient({ sql, orgId: built.A });
        const reads = await Promise.all(
            [built.ids.root!, built.ids.followUp!, built.ids.reviewJob!].map(async (jobId) => {
                const { taskId, facts: taskFacts } = await client.fetchTaskFacts({
                    jobId,
                    rootJobId: jobId,
                    edits: true,
                });
                return { taskId, ...buildRunActivity(taskFacts, taskId, jobId, NOW) };
            })
        );
        const statsTask = reportOf(await facts(built.A)).tasks.find((t) => t.taskId === built.ids.root);

        for (const read of reads) {
            expect(read.taskId).toBe(built.ids.root);
            expect(read.task).toEqual(reads[0]!.task);
            expect(read.task!.usage.tokens).toEqual(statsTask!.usage.tokens);
        }
        const review = reads[2]!.run!.usage.tokens;
        expect(review.input).toBe(AMOUNT.review);
        expect(reads[2]!.task!.runs.map((r) => r.kind)).toContain('review');
    });

    it("resolves no task for another organization's job, and none of its sessions", async () => {
        const foreign = built.ids.taskB!;
        const { taskId, facts: taskFacts } = await createPostgresTelemetryClient({
            sql,
            orgId: built.A,
        }).fetchTaskFacts({ jobId: foreign, rootJobId: foreign, edits: true });
        expect(taskId).toBe(foreign);
        expect(buildRunActivity(taskFacts, taskId, foreign, NOW)).toEqual({ task: null, run: null });
        expect(text(taskFacts)).not.toContain(built.ids.otherOrg!);
    });

    it('reads edit decisions only when asked, and keeps them out of the token figures', async () => {
        await w.point({ session: built.ids.shared!, field: 'edits_accept', value: 3, time: at('10:30') });
        const client = createPostgresTelemetryClient({ sql, orgId: built.A });
        const jobId = built.ids.root!;

        const withEdits = await client.fetchTaskFacts({ jobId, rootJobId: jobId, edits: true });
        const without = await client.fetchTaskFacts({ jobId, rootJobId: jobId });
        const run = buildRunActivity(withEdits.facts, withEdits.taskId, jobId, NOW).run!;

        expect(run.buckets.reduce((n, b) => n + (b.edits ?? 0), 0)).toBe(3);
        expect(without.facts.edits).toEqual([]);
        expect(withEdits.facts.contributions).toEqual(without.facts.contributions);
    });

    it('reduces the board and transcript records of a task per run and per task, one org only (issue #983)', async () => {
        const store = createJobStore({ sql, orgId: built.A });
        const { root, followUp } = built.ids as Record<'root' | 'followUp', string>;
        const [adhoc, reusedOf, observed] = [randomUUID(), randomUUID(), randomUUID()];
        const [opCreated, opReused] = [randomUUID(), randomUUID()];
        const gateRow = ({
            job,
            execution,
            source,
            outcome,
            start,
            end,
        }: Record<'job' | 'execution' | 'source' | 'outcome', string> & Record<'start' | 'end', string | null>) =>
            sql`insert into job_gate_run (org_id, job_id, execution_id, run_claim_seq, claim_seq, gate, identity, filtered, source, outcome, started_at, finished_at)
                values (${built.A}, ${job}, ${execution}, 1, 1, 'test', 'id', false, ${source}, ${outcome}, ${start}, ${end})`;
        await gateRow({
            job: root,
            execution: adhoc,
            source: 'adhoc',
            outcome: 'passed',
            start: '2026-09-20T10:00:00Z',
            end: '2026-09-20T10:02:00Z',
        });
        await gateRow({
            job: followUp,
            execution: reusedOf,
            source: 'adhoc',
            outcome: 'failed',
            start: null,
            end: null,
        });
        await sql`update job set gates = ${sql.json([
            {
                name: 'test',
                status: 'passed',
                exitCode: 0,
                output: null,
                reused: { executionId: adhoc, finishedAt: null, reason: 'tree unchanged' },
            },
        ])} where org_id = ${built.A} and id = ${root}`;
        for (const [id, op, n] of [
            [opCreated, 'created', 7],
            [opReused, 'reused', 7],
        ] as const) {
            await sql`insert into job_pr_operation (org_id, job_id, operation_id, claim_seq, operation, repo, pr_number, pr_url, branch)
                values (${built.A}, ${root}, ${id}, 1, ${op}, 'acme/web', ${n}, ${`https://github.com/acme/web/pull/${n}`}, 'b')`;
        }
        const event = ({
            call,
            part,
            exec,
            outcome,
            at,
        }: {
            call: string;
            part: 'call' | 'result';
            exec: string | null;
            outcome: string | null;
            at: string;
        }) =>
            sql`insert into transcript_tool_event (org_id, job_id, executor, session_id, tool_call_id, part, run_claim_seq, kind, operation, outcome,
                    execution_id, started_at, ended_at, artifact_session, stream, claim_seq, byte_offset)
                values (${built.A}, ${root}, 'main', 's', ${call}, ${part}, 1, 'gate', 'run', ${outcome}, ${exec},
                    ${part === 'call' ? at : null}, ${part === 'result' ? at : null}, 's', 'transcript-raw', 1, 0)`;
        // The agent's own call of the managed execution `adhoc`, and one the board never recorded.
        for (const [call, exec] of [
            ['c1', adhoc],
            ['c2', observed],
        ] as const) {
            await event({ call, part: 'call', exec, outcome: null, at: '2026-09-20T10:00:00Z' });
            await event({ call, part: 'result', exec, outcome: 'passed', at: '2026-09-20T10:02:00Z' });
        }

        const records = await store.activityRecords([root, followUp]);
        const run = gateActivityOf(records, [root]);
        expect(run).toMatchObject({ executions: 1, byOutcome: { passed: 1 }, measuredMs: 120_000, unmeasuredCount: 0 });
        expect(run.reused).toMatchObject([{ jobId: root, executionId: adhoc, reason: 'tree unchanged' }]);
        expect(run.observed).toMatchObject({ executions: 1 });
        const task = gateActivityOf(records, [root, followUp]);
        expect(task).toMatchObject({
            executions: 2,
            byOutcome: { passed: 1, failed: 1 },
            measuredCount: 1,
            unmeasuredCount: 1,
            coverage: 'partial',
        });
        expect(prActivityOf(records, [root, followUp]).counts).toEqual({ operations: 2, distinct: 1 });
        expect(prActivityOf(records, [followUp]).counts).toBeNull();
        // Another organization's store never reads this one's rows.
        expect(await createJobStore({ sql, orgId: built.B }).activityRecords([root, followUp])).toEqual({
            gateRuns: [],
            reusedGates: [],
            prOperations: [],
            toolEvents: [],
        });
    });

    it('reads a job with no execution rows as its own thread root, unmeasured', async () => {
        const client = createPostgresTelemetryClient({ sql, orgId: built.A });
        const lonely = randomUUID();
        const { taskId, facts: taskFacts } = await client.fetchTaskFacts({ jobId: lonely, rootJobId: lonely });
        expect(taskId).toBe(lonely);
        expect(buildRunActivity(taskFacts, taskId, lonely, NOW)).toEqual({ task: null, run: null });
    });

    it('returns an org-less, hook-less session to no organization', async () => {
        const orphan = w.marker('orphan');
        await w.point({ session: orphan, field: 'tokens_input', value: 4, time: at('09:00', '11') });
        for (const org of [built.A, built.B]) {
            const f = await facts(org);
            expect(text(f)).not.toContain(orphan);
            const rollups = (await createPostgresTelemetryClient({ sql, orgId: org }).fetchRollups()).input;
            expect(rollups.sessions.map((s) => s.sessionId)).not.toContain(orphan);
        }
    });

    it('attributes a board-owned session without a hook to its task and author', async () => {
        const { input } = await createPostgresTelemetryClient({ sql, orgId: built.A }).fetchRollups();
        const row = input.sessions.find((s) => s.sessionId === built.ids.hookless);
        expect(row).toMatchObject({
            hook: false,
            taskKey: expect.any(String),
            repo: expect.stringContaining('acme-a/lib'),
        });
        expect(row?.user?.id).toBeTruthy();
        expect(input.sessions.find((s) => s.sessionId === built.ids.shared)?.hook).toBe(true);
    });

    it('classifies each case the way the spec says, in the tenant that owns it', async () => {
        const report = reportOf(await facts(built.A));
        // The review folds into the requesting task; the removed task is retained, flagged removed.
        const task = report.tasks.find((t) => t.taskId === built.ids.root)!;
        expect(task.runs.map((r) => r.kind).sort()).toEqual(['follow-up', 'follow-up', 'review', 'run']);
        const removed = report.tasks.find((t) => t.removed)!;
        expect(removed.usage.tokens.input).toBe(AMOUNT.removed);
        // The conflicting session is a tenant diagnostic, not eligible usage.
        expect(report.diagnostics.unresolvedOwnership.tokens.input).toBe(AMOUNT.conflict);
        expect(report.diagnostics.sessionsWithoutHook).toBe(SESSIONS_WITHOUT_HOOK);
        // Every point inside a confirmed claim is assigned (incl. the removed task and the hook-less
        // board session); the gap, the backfill row and the branch-only session are not.
        const reason = (r: string) => report.eligible.unassigned.find((u) => u.reason === r)?.tokens.input ?? 0;
        expect(reason('no-segment')).toBe(AMOUNT.j1Gap);
        expect(reason('unknown-boundary')).toBe(AMOUNT.backfill);
        expect(reason('no-task')).toBe(AMOUNT.branchOnly);
        expect(report.eligible.assigned.input).toBe(
            AMOUNT.j1Run +
                AMOUNT.j2Run +
                AMOUNT.review +
                AMOUNT.node +
                AMOUNT.adoptedRun +
                AMOUNT.hookless +
                AMOUNT.removed +
                AMOUNT.sharedOpencode
        );
        // Only the opencode key of the shared id is owned.
        expect(report.eligible.tokens.input! & AMOUNT.sharedOpencode).toBe(AMOUNT.sharedOpencode);
        expect(report.eligible.tokens.input! & AMOUNT.sharedClaude).toBe(0);
        // Cumulative increments inside a run are assigned (5 then 3); the one spanning the gap is run-unassigned.
        expect(report.eligible.unassigned.find((u) => u.reason === 'cumulative-spans-runs')?.tokens.output).toBe(12);
        expect(report.eligible.assigned.output).toBe(8);
        expect(report.eligible.unlocated.cacheRead).toBe(9);
        expect(report.eligible.assigned.cacheRead).toBe(2);
    });

    it('gives every eligible contribution exactly one destination across all tenants', async () => {
        const rec = await snapshot((tx) => readGlobalReconciliation(tx, NOW));
        const stored = await sql<{ field: string; value: number }[]>`
            select field, sum(value)::float8 as value from session_field_total where field like 'tokens\\_%' group by field
        `;
        const independent = Object.fromEntries(stored.map((r) => [r.field, Number(r.value)]));
        for (const type of TYPES) expect(rec.total[type] ?? 0).toBe(independent[FIELD[type]] ?? 0);
        // The cross-org session and the org-less ones are visible here and nowhere in a tenant read.
        expect(rec.foreign.input).toBe(AMOUNT.cross);
        expect(rec.unowned.input).toBe(AMOUNT.orphan + AMOUNT.sharedClaude + AMOUNT.nullSession);
        expect(rec.perOrg.get(built.A)?.unresolved.input).toBe(AMOUNT.conflict);
        expect(rec.perOrg.get(built.B)?.eligible.input).toBe(AMOUNT.otherOrg);
    });

    it('reads one snapshot: a membership change committed after it opens is not seen', async () => {
        const before = await facts(built.A);
        const during = await snapshot(async (tx) => {
            await tx`select 1`;
            // Another connection commits a new claim and a removal after the snapshot was taken.
            const extra = await w.job({ org: built.A, author: null, repo: 'x' });
            await w.execution({
                org: built.A,
                job: extra,
                root: extra,
                start: at('14:00'),
                end: at('15:00'),
                sessions: [{ id: built.ids.shared! }],
            });
            await sql`update job_execution set removed_at = now() where org_id = ${built.A} and job_id = ${built.ids.root!}`;
            return readUsageFacts(tx, built.A);
        });
        const strip = (f: UsageFacts) => text({ ...f, stats: { ...f.stats, ms: 0 } });
        expect(strip(during)).toBe(strip(before));
        // ...and the next snapshot sees it.
        expect(strip(await facts(built.A))).not.toBe(strip(before));
    });

    it('is unchanged by an adoption row or a dimension row', async () => {
        const before = reportOf(await facts(built.A));
        await w.execution({
            org: built.A,
            job: built.ids.adoptedJob!,
            claim: 2,
            root: built.ids.adoptedJob!,
            launch: 'adopted',
            adopts: 1,
            start: at('08:30'),
            end: at('09:00'),
            sessions: [{ id: built.ids.adopted! }],
        });
        await w.point({
            session: built.ids.adopted!,
            field: 'tokens_input',
            value: 0,
            time: at('08:12'),
            attrs: { model: 'm1' },
        });
        const after = reportOf(await facts(built.A));
        expect(after.eligible.tokens).toEqual(before.eligible.tokens);
        expect(after.eligible.counts.runs).toBe(before.eligible.counts.runs);
        expect(after.eligible.counts.tasks).toBe(before.eligible.counts.tasks);
    });

    it('reads no point of a key the tenant does not own: another agent on a tenant session id', async () => {
        const f = await facts(built.A);
        const two = built.ids.twoAgents!;
        const keyed = [...f.contributions.map((c) => c.selection), ...f.spans, ...f.fields].filter(
            (k) => k.sessionId === two
        );
        expect(keyed.length).toBeGreaterThan(0);
        expect(new Set(keyed.map((k) => k.agent))).toEqual(new Set(['opencode']));
    });

    it('measures the facts: rows per query and contributions per kind', async () => {
        const f = await facts(built.A);
        // Counted after the foreign drop: a row count must not reveal that another organization shares a session id.
        expect(f.stats.rows.evidence).toBe(f.board.length);
        expect(f.stats.rows.branch).toBe(f.branch.length);
        const cross = built.ids.cross!;
        expect(f.board.some((e) => e.sessionId === cross)).toBe(false);
        expect(f.branch.some((b) => b.sessionId === cross)).toBe(false);
        expect(
            [...f.contributions.map((c) => c.selection), ...f.spans, ...f.fields].some((k) => k.sessionId === cross)
        ).toBe(false);
        expect(f.stats.contributions.timed).toBeGreaterThan(0);
        const lines: string[] = [];
        await createPostgresTelemetryClient({ sql, orgId: built.A, log: (m) => lines.push(m) }).fetchRollups();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('contributions=');
        expect(lines[0]).toContain(`org=${built.A}`);
    });
});
