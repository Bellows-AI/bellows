/**
 * A small deterministic "usage specimen" the e2e browser checks assert on: one task per shape the
 * token-accounting panels must render honestly. Its ids, sessions and figures are fixed and
 * disjoint from the bulk synthetic data, so the bulk numbers other specs assert never move.
 *
 * | task | shape |
 * | S1 | two models (one a `[1m]` variant) x two query sources, all four types measured, cache write a measured 0 |
 * | S2 | no model and no query source |
 * | S3 | partial: cache write never reported, a second session measured no cache read |
 * | S4 | follow-up on a shared session, with a point in the gap between the runs |
 * | S5 | a named review whose usage folds into the task |
 * | S6 | a cumulative series: one estimated increase and one unlocated first reading |
 * | removed | an execution whose task was removed |
 * | input-only author | a second author with input only: the by-user table's unmeasured Output |
 */
import type postgres from 'postgres';
import { CLAUDE_CODE } from '@factory-ai/core';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

type TokenField = 'input' | 'output' | 'cacheRead' | 'cacheCreation';

interface Reading {
    session: string;
    /** Minutes after the specimen epoch. */
    at: number;
    field: TokenField;
    value: number;
    model?: string;
    source?: string;
    /** A cumulative counter reading; `from` is the minute the counter started, null when the reporter never said. */
    cumulative?: { from: number | null };
}

interface Execution {
    job: string;
    claimSeq?: number;
    root: string;
    /** The job this one reviews (its requesting job and root). */
    reviewOf?: string;
    parent?: string;
    sessions: string[];
    start: number;
    end: number;
    /** No job row, and the execution marked removed. */
    removed?: boolean;
    /** Write a job row for the execution. Reviews and removed tasks have none. */
    board?: boolean;
    /** The execution belongs to the input-only specimen author instead of the default one. */
    inputOnlyAuthor?: boolean;
}

/** A synthetic account, disjoint from the bulk seed's members. */
const INPUT_ONLY_GITHUB_USER_ID = 990_100;

const id = (n: number): string => `5bec1000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Minutes after the epoch; every figure below is a fixed number, not a measurement. */
const EXECUTIONS: Execution[] = [
    { job: id(1), root: id(1), sessions: ['specimen-s1'], start: 0, end: 60, board: true },
    { job: id(2), root: id(2), sessions: ['specimen-s2'], start: 0, end: 60, board: true },
    { job: id(3), root: id(3), sessions: ['specimen-s3a', 'specimen-s3b'], start: 0, end: 60, board: true },
    { job: id(4), root: id(4), sessions: ['specimen-s4'], start: 0, end: 30, board: true },
    { job: id(14), root: id(4), parent: id(4), sessions: ['specimen-s4'], start: 120, end: 150, board: true },
    { job: id(5), root: id(5), sessions: ['specimen-s5'], start: 0, end: 60, board: true },
    { job: id(15), root: id(15), reviewOf: id(5), sessions: ['specimen-r5'], start: 70, end: 90 },
    { job: id(6), root: id(6), sessions: ['specimen-s6'], start: 0, end: 120, board: true },
    { job: id(9), root: id(9), sessions: ['specimen-rm'], start: 0, end: 60, removed: true },
    { job: id(10), root: id(10), sessions: ['specimen-nu'], start: 0, end: 60, inputOnlyAuthor: true },
];

const TYPES: TokenField[] = ['input', 'cacheRead', 'cacheCreation', 'output'];
const quad = (
    base: Pick<Reading, 'session' | 'at' | 'model' | 'source'>,
    values: [number, number, number, number]
): Reading[] => TYPES.map((field, i) => ({ ...base, field, value: values[i] as number }));

const READINGS: Reading[] = [
    // S1: model-a and its [1m] variant normalize together; cache write is a measured zero.
    ...quad({ session: 'specimen-s1', at: 10, model: 'model-a', source: 'main' }, [1000, 4000, 0, 300]),
    ...quad({ session: 'specimen-s1', at: 20, model: 'model-a[1m]', source: 'subagent' }, [500, 2000, 0, 100]),
    // S2: neither model nor query source.
    ...quad({ session: 'specimen-s2', at: 10 }, [800, 1500, 300, 200]),
    // S3: cache write never reported; the second session reported no cache read.
    { session: 'specimen-s3a', at: 10, field: 'input', value: 600, model: 'model-a', source: 'main' },
    { session: 'specimen-s3a', at: 10, field: 'output', value: 150, model: 'model-a', source: 'main' },
    { session: 'specimen-s3a', at: 10, field: 'cacheRead', value: 900, model: 'model-a', source: 'main' },
    { session: 'specimen-s3b', at: 20, field: 'input', value: 400, model: 'model-a', source: 'main' },
    { session: 'specimen-s3b', at: 20, field: 'output', value: 100, model: 'model-a', source: 'main' },
    // S4: one point per run and one in the gap between them (no run segment holds it).
    ...quad({ session: 'specimen-s4', at: 10, model: 'model-a', source: 'main' }, [100, 200, 10, 50]),
    ...quad({ session: 'specimen-s4', at: 60, model: 'model-a', source: 'main' }, [10, 20, 1, 5]),
    ...quad({ session: 'specimen-s4', at: 130, model: 'model-a', source: 'main' }, [300, 600, 30, 150]),
    // S5 and its review.
    ...quad({ session: 'specimen-s5', at: 10, model: 'model-a', source: 'main' }, [700, 1400, 70, 350]),
    ...quad({ session: 'specimen-r5', at: 80, model: 'model-b', source: 'main' }, [250, 500, 25, 125]),
    // S6: a cumulative counter. The first reading is unlocated, the increase is an estimate.
    ...[
        { at: 30, value: 100 },
        { at: 90, value: 350 },
    ].map(
        ({ at, value }): Reading => ({
            session: 'specimen-s6',
            at,
            field: 'output',
            value,
            model: 'model-b',
            source: 'main',
            cumulative: { from: null },
        })
    ),
    // A cumulative counter that did say when it started: one estimated amount, placed in time.
    {
        session: 'specimen-s6',
        at: 100,
        field: 'cacheRead',
        value: 500,
        model: 'model-b',
        source: 'main',
        cumulative: { from: 20 },
    },
    // A second author whose usage is input only, so its Output is unmeasured.
    { session: 'specimen-nu', at: 10, field: 'input', value: 90, model: 'model-a', source: 'main' },
    // The removed task's retained usage.
    ...quad({ session: 'specimen-rm', at: 10, model: 'model-a', source: 'main' }, [400, 800, 40, 200]),
];

const SESSION_SPAN = new Map<string, [number, number]>([
    ['specimen-s3b', [15, 25]],
    ['specimen-r5', [75, 85]],
]);

interface Plant {
    sql: postgres.Sql;
    orgId: string;
    repo: string;
    at: (minutes: number) => Date;
}

async function plantExecution(p: Plant, e: Execution, author: string): Promise<void> {
    const { sql, orgId, repo, at } = p;
    if (e.board) {
        await sql`
            insert into job (org_id, id, root_job_id, parent_job_id, command, status, created_by, session_id, repo,
                             created_at, started_at, finished_at, agent_turns)
            values (${orgId}, ${e.job}, ${e.root}, ${e.parent ?? null}, 'specimen task', 'succeeded', ${author},
                    ${e.sessions[0] as string}, ${repo}, ${at(e.start)}, ${at(e.start)}, ${at(e.end)}, 3)
            on conflict (org_id, id) do nothing
        `;
    }
    await sql`
        insert into job_execution (org_id, job_id, claim_seq, root_job_id, requesting_job_id, requesting_root_job_id,
                                   author_id, repo, agent, launch, origin, removed_at, created_at, ended_at)
        values (${orgId}, ${e.job}, 1, ${e.root}, ${e.reviewOf ?? null}, ${e.reviewOf ?? null}, ${author}, ${repo},
                ${CLAUDE_CODE}, 'observed', 'claim', ${e.removed ? at(e.end) : null}, ${at(e.start)}, ${at(e.end)})
        on conflict (org_id, job_id, claim_seq) do nothing
    `;
    for (const session of e.sessions) {
        await sql`
            insert into job_execution_session (org_id, job_id, claim_seq, session_id, agent, origin)
            values (${orgId}, ${e.job}, 1, ${session}, ${CLAUDE_CODE}, 'reported')
            on conflict (org_id, job_id, claim_seq, session_id) do nothing
        `;
    }
}

async function plantReading(p: Plant, r: Reading): Promise<void> {
    const { sql, at } = p;
    const attrs: Record<string, string> = { 'session.id': r.session, type: r.field };
    if (r.model !== undefined) attrs.model = r.model;
    if (r.source !== undefined) attrs.query_source = r.source;
    const startedAt = r.cumulative?.from == null ? null : at(r.cumulative.from);
    await sql`
        insert into metric_point (agent, metric, field, session_id, value, temporality, start_time, time, attrs, source)
        values (${CLAUDE_CODE}, 'claude_code.token.usage', ${`tokens_${r.field}`}, ${r.session}, ${r.value},
                ${r.cumulative === undefined ? 'delta' : 'cumulative'}, ${startedAt}, ${at(r.at)}, ${sql.json(attrs)},
                'seed')
        on conflict do nothing
    `;
}

/** Writes the specimen into `sql`; `epochAgoDays` days before `now` is minute 0 of every timeline. */
export async function plantUsageSpecimen(
    sql: postgres.Sql,
    opts: { orgId: string; repo: string; authorId: string; now: Date; epochAgoDays: number }
): Promise<{ tasks: number; readings: number }> {
    const { orgId, repo, authorId, now, epochAgoDays } = opts;
    const epoch = now.getTime() - epochAgoDays * MS_PER_DAY;
    const p: Plant = { sql, orgId, repo, at: (minutes) => new Date(epoch + minutes * MS_PER_MINUTE) };

    const [inputOnly] = await sql<{ id: string }[]>`
        insert into app_user (github_user_id, github_login, display_name)
        values (${INPUT_ONLY_GITHUB_USER_ID}, 'specimen-input-only', 'Specimen Input Only')
        on conflict (github_user_id) do update set display_name = excluded.display_name
        returning id
    `;
    const inputOnlyAuthor = (inputOnly as { id: string }).id;

    for (const e of EXECUTIONS) await plantExecution(p, e, e.inputOnlyAuthor ? inputOnlyAuthor : authorId);
    for (const session of new Set(READINGS.map((r) => r.session))) {
        const [first, last] = SESSION_SPAN.get(session) ?? [0, 60];
        await sql`
            insert into session_branch (org_id, agent, session_id, repo, branch, head_sha, first_seen, last_seen, samples)
            values (${orgId}, ${CLAUDE_CODE}, ${session}, ${repo}, 'main', null, ${p.at(first)}, ${p.at(last)}, 1)
            on conflict (org_id, agent, session_id, repo, branch) do nothing
        `;
    }
    for (const r of READINGS) await plantReading(p, r);
    return { tasks: new Set(EXECUTIONS.filter((e) => !e.reviewOf).map((e) => e.root)).size, readings: READINGS.length };
}
