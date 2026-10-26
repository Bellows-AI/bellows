import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { CLAUDE_CODE, OPENCODE } from '@factory-ai/core';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { GateRunWrite } from '../src/db/jobs/job-store-gate-runs.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { expireLease, testOrg } from './fixtures.js';

/**
 * Issue #983: tool calls read out of a transcript become classified rows, one per (org, job, executor,
 * session, call id, half), so a chunk put twice, a finalize repeated, an export taken again or a
 * resumed session replaying its history adds nothing. The session comes from the record; the run is
 * the claim that owns that session; a session the job does not own is dropped. Nothing but classified
 * fields is stored.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const WORKER = 'driver-1';
const LEASE_SECONDS = 300;
const REPO = 'example-org/example-repo';
const STREAM = 'transcript-raw';
/** The ids the synthetic fixtures carry in their gate and publish replies. */
const fixtureId = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const db = useTestDb({ max: 4, orgs: [ORG, OTHER_ORG] });

let sql: Sql;
let store: JobStore;
let other: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    other = createJobStore({ sql, orgId: OTHER_ORG });
});

const fixture = (name: string) =>
    readFileSync(new URL(`./../test/fixtures/transcripts/${name}`, import.meta.url), 'utf8');

async function claimed(on: JobStore = store, repo: string | null = REPO): Promise<Claim> {
    const job = await on.create('do the thing', null, { repo: null, executor: null });
    if (typeof job === 'string') throw new Error(job);
    const c = await on.claim(WORKER, LEASE_SECONDS);
    if (!c) throw new Error('nothing was claimable');
    await sql`update job set repo = ${repo} where id = ${c.id}`;
    return c;
}

/** The next claim of the same job, as after a lost lease. */
async function reclaimed(first: Claim): Promise<Claim> {
    await expireLease(sql, first.id);
    const next = await store.claim(WORKER, LEASE_SECONDS);
    if (!next || next.id !== first.id) throw new Error('the job was not reclaimed');
    return next;
}

const owns = async (c: Claim, session: string) => {
    expect(await store.session(c.id, c.leaseToken, session)).toBe('ok');
};

interface Row {
    session_id: string;
    tool_call_id: string;
    part: string;
    run_claim_seq: string;
    kind: string;
    operation: string;
    gate: string | null;
    outcome: string | null;
    exit_code: number | null;
    execution_id: string | null;
    operation_id: string | null;
    pr_repo: string | null;
    pr_number: number | null;
    byte_offset: string;
    claim_seq: string;
    stream: string;
}

const rowsOf = (jobId: string, orgId = ORG) =>
    sql<Row[]>`
        select * from transcript_tool_event where org_id = ${orgId} and job_id = ${jobId}
        order by session_id, tool_call_id, part
    `;

const claudeGates = () => [{ offset: 0, text: fixture('claude-gates.jsonl') }];
const ingest = (c: Claim, executor: string, chunks: { offset: number; text: string }[], on: JobStore = store) =>
    on.ingestTranscriptTools(c.id, { executor, stream: STREAM, claimSeq: c.claimSeq, chunks });

describe.skipIf(!enabled)('transcript tool events', () => {
    it('stores the classified calls and results, and puts the run on the claim that owns the session', async () => {
        const c = await claimed();
        await owns(c, 'claude-session-1');
        expect(await ingest(c, CLAUDE_CODE, claudeGates())).toMatchObject({ result: 'ok' });
        const rows = await rowsOf(c.id);
        const pass = rows.filter((r) => r.tool_call_id === 'toolu_gate_pass');
        expect(pass.map((r) => r.part)).toEqual(['call', 'result']);
        expect(pass[1]).toMatchObject({
            kind: 'gate',
            gate: 'test',
            outcome: 'passed',
            exit_code: 0,
            execution_id: fixtureId(1),
            stream: STREAM,
            run_claim_seq: String(c.claimSeq),
        });
        expect(pass[0]?.outcome).toBeNull();
        // Interrupted: a call row, no result row.
        expect(rows.filter((r) => r.tool_call_id === 'toolu_gate_interrupted').map((r) => r.part)).toEqual(['call']);
        // Unmatched and non-gate results leave nothing.
        expect(rows.some((r) => r.tool_call_id === 'toolu_orphan_result')).toBe(false);
        expect(rows.some((r) => r.tool_call_id === 'toolu_plain_tests')).toBe(false);
    });

    it('is idempotent: the same chunks twice, and a split delivery, give the same rows', async () => {
        const c = await claimed();
        await owns(c, 'claude-session-1');
        await ingest(c, CLAUDE_CODE, claudeGates());
        const once = await rowsOf(c.id);
        await ingest(c, CLAUDE_CODE, claudeGates());
        expect(await rowsOf(c.id)).toEqual(once);

        // The same transcript delivered as two chunks, the second first.
        const c2 = await claimed();
        await owns(c2, 'claude-session-1');
        const lines = fixture('claude-gates.jsonl').split('\n');
        const head = `${lines.slice(0, 6).join('\n')}\n`;
        const tail = lines.slice(6).join('\n');
        const tailOffset = Buffer.byteLength(head);
        await ingest(c2, CLAUDE_CODE, [{ offset: tailOffset, text: tail }]);
        await ingest(c2, CLAUDE_CODE, [{ offset: 0, text: head }]);
        await ingest(c2, CLAUDE_CODE, [
            { offset: 0, text: head },
            { offset: tailOffset, text: tail },
        ]);
        expect(await rowsOf(c2.id)).toHaveLength(once.length);
    });

    it('a call delivered in one chunk and its result in the next pairs across the two puts', async () => {
        const c = await claimed();
        await owns(c, 'claude-session-1');
        const lines = fixture('claude-gates.jsonl').split('\n');
        await ingest(c, CLAUDE_CODE, [{ offset: 0, text: `${lines[0]}\n` }]);
        expect((await rowsOf(c.id)).map((r) => r.part)).toEqual(['call']);
        await ingest(c, CLAUDE_CODE, [
            { offset: 0, text: `${lines[0]}\n` },
            { offset: Buffer.byteLength(`${lines[0]}\n`), text: `${lines[1]}\n` },
        ]);
        expect((await rowsOf(c.id)).map((r) => r.part)).toEqual(['call', 'result']);
    });

    it('a resumed session replaying its history under a later claim adds no rows', async () => {
        const c1 = await claimed();
        await owns(c1, 'claude-session-1');
        await ingest(c1, CLAUDE_CODE, claudeGates());
        const before = await rowsOf(c1.id);
        const c2 = await reclaimed(c1);
        await owns(c2, 'claude-session-1');
        await ingest(c2, CLAUDE_CODE, claudeGates());
        const after = await rowsOf(c1.id);
        expect(after).toEqual(before);
        expect(new Set(after.map((r) => r.run_claim_seq))).toEqual(new Set([String(c1.claimSeq)]));
    });

    it('an export holding two sessions attributes each to its own run; a session the job does not own is dropped', async () => {
        const c1 = await claimed();
        await owns(c1, 'opencode-session-A');
        const c2 = await reclaimed(c1);
        await owns(c2, 'opencode-session-B');
        // The export arrives on the SECOND claim's stream but holds the first run's history too.
        await ingest(c2, OPENCODE, [{ offset: 0, text: fixture('opencode-export.jsonl') }]);
        const rows = await rowsOf(c1.id);
        const runs = (session: string) =>
            new Set(rows.filter((r) => r.session_id === session).map((r) => r.run_claim_seq));
        expect(runs('opencode-session-A')).toEqual(new Set([String(c1.claimSeq)]));
        expect(runs('opencode-session-B')).toEqual(new Set([String(c2.claimSeq)]));
        // A call id that two sessions share is two events.
        expect(rows.filter((r) => r.tool_call_id === 'call_pass' && r.part === 'result')).toHaveLength(2);

        const stranger = await claimed();
        await owns(stranger, 'opencode-session-A');
        await ingest(stranger, OPENCODE, [{ offset: 0, text: fixture('opencode-export.jsonl') }]);
        const kept = await rowsOf(stranger.id);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept.every((r) => r.session_id === 'opencode-session-A')).toBe(true);
    });

    it('a session no execution of the job reported leaves no rows', async () => {
        const c = await claimed();
        expect(await ingest(c, CLAUDE_CODE, claudeGates())).toMatchObject({ result: 'ok', written: 0 });
        expect(await rowsOf(c.id)).toEqual([]);
    });

    it('the artifact label never decides the session: the record does', async () => {
        const c = await claimed();
        await owns(c, 'claude-session-1');
        // The stream below is filed under another session label; the ingest never receives it.
        await ingest(c, CLAUDE_CODE, claudeGates());
        expect((await rowsOf(c.id)).every((r) => r.session_id === 'claude-session-1')).toBe(true);
    });

    it('PR events: only a confirmed result of the job repo carries the PR fields, with the operation id of a publish', async () => {
        const c = await claimed();
        await owns(c, 'claude-session-1');
        await ingest(c, CLAUDE_CODE, [{ offset: 0, text: fixture('claude-pr.jsonl') }]);
        const rows = await rowsOf(c.id);
        const get = (id: string) => rows.find((r) => r.tool_call_id === id && r.part === 'result');
        expect(get('toolu_pr_create')).toMatchObject({
            operation: 'create',
            outcome: 'passed',
            pr_repo: REPO,
            pr_number: 12,
        });
        expect(get('toolu_pr_foreign')).toMatchObject({ outcome: 'unknown', pr_repo: null, pr_number: null });
        expect(get('toolu_publish')).toMatchObject({
            operation: 'publish',
            outcome: 'passed',
            operation_id: fixtureId(7),
        });
        // Lookups are classified but never stored.
        expect(rows.some((r) => r.operation === 'lookup')).toBe(false);
    });

    it('joins the gate run by execution id and the PR operation by operation id; an id with no row stays an unlinked observation', async () => {
        const c = await claimed();
        await owns(c, 'claude-session-1');
        const executionId = fixtureId(1);
        const run: GateRunWrite = {
            runClaimSeq: c.claimSeq,
            executionId,
            gate: 'test',
            identity: 'a'.repeat(64),
            filtered: false,
            source: 'adhoc',
            outcome: 'passed',
            exitCode: 0,
            treeBefore: 'h:1',
            treeAfter: 'h:1',
            mutatedSince: false,
            startedAt: '2026-10-26T10:00:00.000Z',
            finishedAt: '2026-10-26T10:01:00.000Z',
        };
        expect(
            await store.writeGateRun(c.id, c.leaseToken, {
                ...run,
                outcome: 'running',
                exitCode: null,
                finishedAt: null,
            })
        ).toEqual({ result: 'ok' });
        expect(await store.writeGateRun(c.id, c.leaseToken, run)).toEqual({ result: 'ok' });
        const operationId = fixtureId(7);
        await store.writePrOperation(c.id, c.leaseToken, {
            operationId,
            operation: 'created',
            repo: REPO,
            prNumber: 12,
            prUrl: `https://github.com/${REPO}/pull/12`,
            branch: 'task',
        });
        await ingest(c, CLAUDE_CODE, claudeGates());
        await ingest(c, CLAUDE_CODE, [{ offset: 0, text: fixture('claude-pr.jsonl') }]);

        const gates = await sql<{ tool_call_id: string; gate_outcome: string }[]>`
            select e.tool_call_id, g.outcome as gate_outcome
            from transcript_tool_event e
            join job_gate_run g on g.org_id = e.org_id and g.job_id = e.job_id and g.execution_id = e.execution_id
            where e.org_id = ${ORG} and e.job_id = ${c.id} and e.part = 'result'
        `;
        expect(gates).toEqual([{ tool_call_id: 'toolu_gate_pass', gate_outcome: 'passed' }]);
        const prs = await sql<{ tool_call_id: string; operation: string }[]>`
            select e.tool_call_id, o.operation
            from transcript_tool_event e
            join job_pr_operation o on o.org_id = e.org_id and o.job_id = e.job_id and o.operation_id = e.operation_id
            where e.org_id = ${ORG} and e.job_id = ${c.id} and e.part = 'result'
        `;
        expect(prs).toEqual([{ tool_call_id: 'toolu_publish', operation: 'created' }]);
        // The other gate results carry ids no row holds: still observed, never failed.
        const rows = await rowsOf(c.id);
        expect(rows.filter((r) => r.part === 'result' && r.execution_id !== null).length).toBeGreaterThan(1);
    });

    it('stores no raw output, command or token', async () => {
        const c = await claimed();
        await owns(c, 'claude-session-1');
        await ingest(c, CLAUDE_CODE, claudeGates());
        const [stored] = await sql<{ text: string }[]>`
            select coalesce(string_agg(row_to_json(e)::text, ' '), '') as text
            from transcript_tool_event e where org_id = ${ORG} and job_id = ${c.id}
        `;
        const text = stored!.text;
        expect(text.length).toBeGreaterThan(0);
        for (const leaked of ['FAIL 1 test', 'BELLOWS_GATE', 'authorization', 'curl', 'tests passed']) {
            expect(text).not.toContain(leaked);
        }
    });

    it('is scoped to its organization: another org cannot ingest into this job, and every row carries its org', async () => {
        const c = await claimed();
        await owns(c, 'claude-session-1');
        expect(await ingest(c, CLAUDE_CODE, claudeGates(), other)).toEqual({ result: 'missing' });
        await ingest(c, CLAUDE_CODE, claudeGates());
        expect(await rowsOf(c.id, OTHER_ORG)).toEqual([]);
        const [counted] = await sql<{ count: string }[]>`
            select count(*) from transcript_tool_event where job_id = ${c.id} and org_id <> ${ORG}
        `;
        expect(counted!.count).toBe('0');
        expect(await ingest({ ...c, id: randomUUID() }, CLAUDE_CODE, claudeGates())).toEqual({ result: 'missing' });
    });

    it('removing the thread removes its rows', async () => {
        const c = await claimed();
        await owns(c, 'claude-session-1');
        await ingest(c, CLAUDE_CODE, claudeGates());
        await sql`delete from job where org_id = ${ORG} and id = ${c.id}`;
        expect(await rowsOf(c.id)).toEqual([]);
    });
});
