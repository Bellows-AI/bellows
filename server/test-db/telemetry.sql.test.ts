import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { reduceUsage, telemetryStats, type TokenType } from '@factory-ai/core';
import type { TelemetryFetch } from '../src/telemetry/client.js';
import { migrate } from '../src/db/migrate.js';
import { createPostgresTelemetryClient } from '../src/telemetry/postgres-client.js';
import { useTestDb } from './harness.js';
import { account, randomGithubId, testOrg } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;

const ORG = testOrg();
const OTHER_ORG = testOrg();

const db = useTestDb({ max: 2 });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
});

const T = (iso: string) => new Date(iso);

/** What the stats service does at read time for the all-time, org-wide request. */
const statsOf = ({ input, facts }: Pick<TelemetryFetch, 'input' | 'facts'>) => {
    const now = new Date();
    return telemetryStats(input, { now, usage: reduceUsage(facts, { range: null, now }) });
};

/** The raw timed points of one session summed per type, straight from the fetched facts. */
const pointSum = (facts: TelemetryFetch['facts'], session: string, type: TokenType, agent = 'claude-code') =>
    facts.contributions
        .filter((c) => c.kind === 'timed' && c.selection.sessionId === session && c.selection.agent === agent)
        .reduce<number | null>((sum, c) => (c.tokens[type] === null ? sum : (sum ?? 0) + c.tokens[type]), null);

async function point(row: {
    session: string;
    field: string;
    value: number;
    time: string;
    temporality?: string;
    startTime?: string;
    metric?: string;
    agent?: string;
    source?: string;
    attrs?: Record<string, string>;
}) {
    await sql`insert into metric_point ${sql({
        agent: row.agent ?? 'claude-code',
        source: row.source ?? 'otel',
        metric: row.metric ?? 'claude_code.token.usage',
        field: row.field,
        session_id: row.session,
        value: row.value,
        temporality: row.temporality ?? 'delta',
        start_time: row.startTime ? T(row.startTime) : null,
        time: T(row.time),
        attrs: row.attrs ?? {},
    })}`;
}

async function branch(row: {
    session: string;
    branch: string | null;
    from: string;
    to: string;
    repo?: string;
    org?: string;
}) {
    await sql`insert into session_branch ${sql({
        org_id: row.org ?? ORG,
        agent: 'claude-code',
        session_id: row.session,
        repo: row.repo ?? 'acme/app',
        branch: row.branch,
        head_sha: null,
        first_seen: T(row.from),
        last_seen: T(row.to),
        samples: 1,
    })}`;
}

/** An account with a generated github id, for the attribution joins to resolve. */
const member = (login: string): Promise<string> => account(sql, randomGithubId(), login);

/** The execution row a claim leaves: provenance for a session, the board's own evidence of who owns it. */
const claim = async (row: {
    org?: string;
    job: string;
    root: string;
    session: string;
    author?: string | null;
    repo?: string | null;
    agent?: string | null;
    requesting?: { job: string; root: string };
}): Promise<void> => {
    const org = row.org ?? ORG;
    await sql`
        insert into job_execution (org_id, job_id, claim_seq, root_job_id, requesting_job_id, requesting_root_job_id,
                                   author_id, repo, launch, origin, created_at, ended_at)
        values (${org}, ${row.job}, 1, ${row.root}, ${row.requesting?.job ?? null}, ${row.requesting?.root ?? null},
                ${row.author ?? null}, ${row.repo ?? null}, 'observed', 'claim', ${T('2026-08-01T00:00:00Z')},
                ${T('2026-08-02T00:00:00Z')})
    `;
    await sql`
        insert into job_execution_session (org_id, job_id, claim_seq, session_id, agent, origin)
        values (${org}, ${row.job}, 1, ${row.session}, ${row.agent ?? null}, 'reported')
    `;
};

/** A finished board job; with a session id it also files the claim that owns that session. */
const job = async (row: {
    session?: string | null;
    createdBy?: string | null;
    root?: string;
    parent?: string;
    org?: string;
    repo?: string | null;
}): Promise<string> => {
    const id = randomUUID();
    const root = row.root ?? id;
    await sql`
        insert into job (org_id, id, command, status, root_job_id, parent_job_id, created_by, session_id, created_at)
        values (${row.org ?? ORG}, ${id}, 'attributed', 'succeeded', ${root}, ${row.parent ?? null},
                ${row.createdBy ?? null}, ${row.session ?? null}, now())
    `;
    if (row.session) {
        await claim({
            org: row.org ?? ORG,
            job: id,
            root,
            session: row.session,
            author: row.createdBy ?? null,
            repo: row.repo ?? null,
        });
    }
    return id;
};

describe.skipIf(!enabled)('migrations', () => {
    it('range-partitions metric_point on time, with no extension behind it', async () => {
        const [table] = await sql<{ strategy: string; key: string }[]>`
            select partstrat as strategy, pg_get_partkeydef(partrelid) as key
            from pg_partitioned_table where partrelid = 'metric_point'::regclass
        `;
        expect(table?.strategy).toBe('r');
        expect(table?.key).toBe('RANGE ("time")');
    });

    it('covers every timestamp with a DEFAULT partition, so no insert can be rejected', async () => {
        const partitions = await sql<{ name: string; bound: string }[]>`
            select c.relname as name, pg_get_expr(c.relpartbound, c.oid) as bound
            from pg_inherits i join pg_class c on c.oid = i.inhrelid
            where i.inhparent = 'metric_point'::regclass
        `;
        expect(partitions).toEqual([{ name: 'metric_point_default', bound: 'DEFAULT' }]);

        // An OTLP client's clock can skew
        // ahead; a range table with no covering partition rejects it.
        const session = `partition-${randomUUID()}`;
        await point({ session, field: 'tokens_input', value: 1, time: '2001-01-01T00:00:00Z' });
        await point({ session, field: 'tokens_input', value: 1, time: '2099-01-01T00:00:00Z' });
        const [row] = await sql<{ n: number }[]>`
            select count(*)::int as n from metric_point where session_id = ${session}
        `;
        expect(row?.n).toBe(2);
    });

    it('is idempotent, recording each versioned file once', async () => {
        await migrate(sql, { attempts: 1 });
        await migrate(sql, { attempts: 1 });
        const rows = await sql<{ version: string; n: number }[]>`
            select version, count(*)::int as n from schema_migrations group by version
        `;
        for (const row of rows) expect(row.n).toBe(1);
        expect(rows.map((r) => r.version)).toContain('001_init.sql');
        // Repeatable files are re-applied rather than recorded, so a view fix actually lands
        // instead of being skipped until someone deletes the volume.
        expect(rows.filter((r) => r.version.endsWith('.repeatable.sql'))).toEqual([]);
    });

    it('re-applies a repeatable file on every run', async () => {
        await sql`drop view if exists session_summary`;
        await migrate(sql, { attempts: 1 });
        const [row] = await sql<{ n: number }[]>`
            select count(*)::int as n from pg_views where viewname = 'session_summary'
        `;
        expect(row?.n).toBe(1);
    });

    it('rejects a replayed datapoint rather than double-counting it', async () => {
        // OTLP delivery is at-least-once, so this index is the only thing between a retry and
        // a doubled token count.
        await point({ session: 's1', field: 'tokens_input', value: 100, time: '2026-08-01T10:00:00Z' });
        await expect(
            point({ session: 's1', field: 'tokens_input', value: 100, time: '2026-08-01T10:00:00Z' })
        ).rejects.toThrow(/duplicate key/);
        const [row] = await sql<{ n: number }[]>`select count(*)::int as n from metric_point`;
        expect(row?.n).toBe(1);
    });
});

describe.skipIf(!enabled)('temporality reduction', () => {
    it('sums a delta series', async () => {
        const SECOND_DELTA = 20;
        const THIRD_DELTA = 30;
        const DELTA_VALUES = [10, SECOND_DELTA, THIRD_DELTA];
        for (const [i, v] of DELTA_VALUES.entries()) {
            await point({ session: 's1', field: 'tokens_input', value: v, time: `2026-08-01T10:0${i}:00Z` });
        }
        const [row] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        const EXPECTED_TOTAL = 60;
        expect(Number(row?.value)).toBe(EXPECTED_TOTAL);
    });

    it('takes the last value of a cumulative series, not the sum', async () => {
        // The naive sum here is 150 against a real total of 60 — 2.5x wrong, with no error
        // anywhere. This is the assertion that stops a "simplify to SUM" refactor.
        const SECOND_CUMULATIVE = 20;
        const THIRD_CUMULATIVE = 40;
        const FOURTH_CUMULATIVE = 50;
        const CUMULATIVE_VALUES = [10, SECOND_CUMULATIVE, THIRD_CUMULATIVE, FOURTH_CUMULATIVE, 60];
        for (const [i, v] of CUMULATIVE_VALUES.entries()) {
            await point({
                session: 's1',
                field: 'tokens_input',
                value: v,
                time: `2026-08-01T10:0${i}:00Z`,
                temporality: 'cumulative',
                startTime: '2026-08-01T10:00:00Z',
            });
        }
        const [row] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        const EXPECTED_TOTAL = 60;
        expect(Number(row?.value)).toBe(EXPECTED_TOTAL);
    });

    it('adds cumulative series across a restart', async () => {
        // A new start_time is a new counter, so the totals add rather than replace.
        const FIRST_WINDOW_SECOND_VALUE = 30;
        const FIRST_WINDOW_VALUES = [10, FIRST_WINDOW_SECOND_VALUE];
        for (const [i, v] of FIRST_WINDOW_VALUES.entries()) {
            await point({
                session: 's1',
                field: 'tokens_input',
                value: v,
                time: `2026-08-01T10:0${i}:00Z`,
                temporality: 'cumulative',
                startTime: '2026-08-01T10:00:00Z',
            });
        }
        const SECOND_WINDOW_FIRST_VALUE = 5;
        const SECOND_WINDOW_SECOND_VALUE = 12;
        const SECOND_WINDOW_VALUES = [SECOND_WINDOW_FIRST_VALUE, SECOND_WINDOW_SECOND_VALUE];
        for (const [i, v] of SECOND_WINDOW_VALUES.entries()) {
            await point({
                session: 's1',
                field: 'tokens_input',
                value: v,
                time: `2026-08-01T11:0${i}:00Z`,
                temporality: 'cumulative',
                startTime: '2026-08-01T11:00:00Z',
            });
        }
        const [row] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        const EXPECTED_TOTAL = 42;
        expect(Number(row?.value)).toBe(EXPECTED_TOTAL);
    });
});

describe.skipIf(!enabled)('branch slicing', () => {
    it('clamps overlapping intervals so a datapoint is counted once', async () => {
        // The upsert widens intervals, so consecutive branches routinely overlap. Without the
        // clamp in session_branch_slice this datapoint lands on both branches.
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z' });
        await branch({ session: 's1', branch: 'feat/b', from: '2026-08-01T10:30:00Z', to: '2026-08-01T11:30:00Z' });
        await point({ session: 's1', field: 'tokens_input', value: 100, time: '2026-08-01T10:45:00Z' });

        const rows = await sql<{ branch: string; value: number }[]>`
            select branch, value from branch_field_total where session_id = 's1'
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.branch).toBe('feat/b');
        const EXPECTED_VALUE = 100;
        expect(Number(rows[0]?.value)).toBe(EXPECTED_VALUE);
    });

    it('divides a delta session across the branches it held', async () => {
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T10:30:00Z' });
        await branch({ session: 's1', branch: 'feat/b', from: '2026-08-01T10:30:00Z', to: '2026-08-01T11:00:00Z' });
        await point({ session: 's1', field: 'tokens_input', value: 60, time: '2026-08-01T10:10:00Z' });
        await point({ session: 's1', field: 'tokens_input', value: 40, time: '2026-08-01T10:45:00Z' });

        const rows = await sql<{ branch: string; value: number }[]>`
            select branch, value from branch_field_total where session_id = 's1' order by branch
        `;
        const FEAT_B_VALUE = 40;
        expect(rows.map((r) => [r.branch, Number(r.value)])).toEqual([
            ['feat/a', 60],
            ['feat/b', FEAT_B_VALUE],
        ]);
        // Conservation: nothing created, nothing lost.
        const [total] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = 's1' and field = 'tokens_input'
        `;
        const EXPECTED_TOTAL = 100;
        expect(Number(total?.value)).toBe(EXPECTED_TOTAL);
    });

    it('widens rather than overwrites on a repeated upsert', async () => {
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T10:10:00Z' });
        await sql`
            insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen, samples)
            values (${ORG}, 'claude-code', 's1', 'acme/app', 'feat/a', ${T('2026-08-01T10:20:00Z')}, ${T('2026-08-01T10:30:00Z')}, 1)
            on conflict (org_id, agent, session_id, repo, branch) do update
                set first_seen = least(session_branch.first_seen, excluded.first_seen),
                    last_seen  = greatest(session_branch.last_seen, excluded.last_seen),
                    samples    = session_branch.samples + 1
        `;
        const [row] = await sql<{ first_seen: Date; last_seen: Date; samples: number }[]>`
            select first_seen, last_seen, samples from session_branch where session_id = 's1'
        `;
        expect(row?.first_seen.toISOString()).toBe('2026-08-01T10:00:00.000Z');
        expect(row?.last_seen.toISOString()).toBe('2026-08-01T10:30:00.000Z');
        expect(row?.samples).toBe(2);
    });
});

describe.skipIf(!enabled)('the postgres client', () => {
    it('reports an empty store as empty, not unreachable', async () => {
        const client = createPostgresTelemetryClient({ sql, orgId: ORG });
        expect((await client.health()).status).toBe('empty');
        const { input } = await client.fetchRollups();
        expect(input.sessions).toEqual([]);
        expect(input.coverage).toEqual({ from: null, to: null });
    });

    it('attributes a board-owned session without a hook to its task and author, repo from the execution', async () => {
        const session = randomUUID();
        const userId = await member('hookless-author');
        const root = await job({ session: session, createdBy: userId, repo: 'acme/app' });
        await point({ session: session, field: 'tokens_input', value: 10, time: '2026-08-01T10:00:00Z' });
        const fetched = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        const { input } = fetched;
        expect(input.sessions).toHaveLength(1);
        expect(input.sessions[0]).toMatchObject({ repo: 'acme/app', hook: false, taskKey: root });
        expect(input.sessions[0]?.user?.login).toBe('hookless-author');
        const stats = statsOf(fetched);
        expect(stats.usage.totals.tokens.input).toBe(10);
        expect(stats.sessionsWithoutHook).toBe(1);
        expect(stats.totals.sessions).toBe(1);
    });

    it('returns a session with neither a board owner nor a hook to no organization', async () => {
        const session = randomUUID();
        // It used to be returned to EVERY organization (`session_summary.org_id is null`): usage of
        // a stranger's local run in each tenant's totals. Nobody's evidence names it, so it is
        // nobody's; only the global reconciliation sees it.
        await point({ session: session, field: 'tokens_input', value: 10, time: '2026-08-01T10:00:00Z' });
        for (const org of [ORG, OTHER_ORG]) {
            const { input, facts } = await createPostgresTelemetryClient({ sql, orgId: org }).fetchRollups();
            expect(input.sessions).toEqual([]);
            expect(JSON.stringify(facts)).not.toContain(session);
        }
    });

    it('keys a rollup by agent and session: a session shared by two agents does not collide', async () => {
        const session = randomUUID();
        const root = await job({ session: session, createdBy: null });
        await point({ session: session, field: 'tokens_input', value: 7, time: '2026-08-01T10:00:00Z' });
        await point({
            session: session,
            field: 'tokens_input',
            value: 9,
            time: '2026-08-01T10:00:00Z',
            agent: 'opencode',
        });
        const { input, facts } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(
            Object.fromEntries(
                input.sessions.map((s) => [s.agent, [pointSum(facts, s.sessionId, 'input', s.agent), s.taskKey]])
            )
        ).toEqual({
            'claude-code': [7, root],
            opencode: [9, root],
        });
    });

    it('does not let evidence naming one agent own the other agent’s session', async () => {
        const session = randomUUID();
        const root = await job({ session: null });
        await claim({ job: root, root, session: session, agent: 'opencode' });
        await point({ session: session, field: 'tokens_input', value: 7, time: '2026-08-01T10:00:00Z' });
        await point({
            session: session,
            field: 'tokens_input',
            value: 9,
            time: '2026-08-01T10:00:00Z',
            agent: 'opencode',
        });
        const { input, facts } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions.map((s) => [s.agent, pointSum(facts, s.sessionId, 'input', s.agent)])).toEqual([
            ['opencode', 9],
        ]);
    });

    it('leaves unmeasured fields null rather than zero', async () => {
        await branch({ session: 's1', branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z' });
        await point({ session: 's1', field: 'tokens_input', value: 10, time: '2026-08-01T10:00:00Z' });
        const fetched = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        const session = fetched.input.sessions[0];
        const { tokens } = statsOf(fetched).usage.totals;
        expect(tokens.input).toBe(10);
        expect(tokens.output).toBeNull();
        expect(session?.linesAdded).toBeNull();
        expect(session?.editsAccepted).toBeNull();
        expect(session?.activeSeconds).toBeNull();
    });

    it('stores an unmapped metric rather than rejecting it', async () => {
        // A future tool's data must accumulate before support for it is written.
        await sql`insert into metric_point ${sql({
            agent: 'unknown',
            metric: 'opencode.tokens.total',
            field: null,
            session_id: 's9',
            value: 5,
            temporality: 'delta',
            start_time: null,
            time: T('2026-08-01T10:00:00Z'),
            attrs: {},
        })}`;
        const [row] = await sql<{ n: number }[]>`
            select count(*)::int as n from metric_point where field is null
        `;
        expect(row?.n).toBe(1);
        // ...and it does not leak into the aggregation.
        const totals = await sql`select * from session_field_total where session_id = 's9'`;
        expect(totals).toHaveLength(0);
    });

    it('aggregates an opencode run under its own agent', async () => {
        // The opencode-executor emits `opencode.*` metrics; they must price as their own agent,
        // not vanish into the null-field filter or mislabel as claude-code.
        await sql`insert into metric_point ${sql({
            agent: 'opencode',
            metric: 'opencode.active_time.total',
            field: 'active_seconds',
            session_id: 's10',
            value: 12,
            temporality: 'delta',
            start_time: null,
            time: T('2026-08-01T10:00:00Z'),
            attrs: {},
        })}`;
        const [row] = await sql<{ agent: string; value: number }[]>`
            select agent, value from session_field_total where session_id = 's10'
        `;
        expect(row?.agent).toBe('opencode');
        const EXPECTED_ACTIVE_SECONDS = 12;
        expect(row?.value).toBe(EXPECTED_ACTIVE_SECONDS);
    });
});

describe.skipIf(!enabled)('session attribution', () => {
    // WHO queued the board task a session belongs to, resolved by joining the telemetry rows to
    // the job audit rows on session id at read time. The telemetry tables stay identity-free —
    // the collector strips identity on purpose — so a session with no matching job row (a local
    // dev run) reads user null, never a guess.

    it('resolves the user of the board task a session belongs to', async () => {
        const userId = await member('attributor');
        await job({ session: 'attr-1', createdBy: userId });
        await point({ session: 'attr-1', field: 'tokens_input', value: 1, time: '2026-08-01T10:30:00Z' });
        await branch({
            session: 'attr-1',
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });

        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions[0]?.user).toEqual({
            id: userId,
            login: 'attributor',
            name: null,
            avatarUrl: null,
        });
    });

    it('carries the display labels the account has, and null when it has none', async () => {
        const userId = (
            await sql<{ id: string }[]>`
                insert into app_user (github_user_id, github_login, display_name, avatar_url)
                values (${randomGithubId()}, 'labeled', 'Ada Lovelace', 'https://example.com/ada.png')
                returning id
            `
        )[0]!.id;
        await job({ session: 'attr-2', createdBy: userId });
        await point({ session: 'attr-2', field: 'tokens_input', value: 1, time: '2026-08-01T10:30:00Z' });
        await branch({
            session: 'attr-2',
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });

        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions[0]?.user).toEqual({
            id: userId,
            login: 'labeled',
            name: 'Ada Lovelace',
            avatarUrl: 'https://example.com/ada.png',
        });
    });

    it('keeps a session with no matching task unattributed rather than guessed', async () => {
        await branch({
            session: 'attr-3',
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });
        await point({ session: 'attr-3', field: 'tokens_input', value: 1, time: '2026-08-01T10:30:00Z' });

        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions[0]?.user).toBeNull();
    });

    it('resolves a follow-up chain to its one shared author', async () => {
        const session = randomUUID();
        // Every member of a thread shares the parent's session AND, by the follow-up author
        // guard, the parent's author — so the join is deterministic no matter which member's row
        // the minimum happens to pick.
        const userId = await member('thread-author');
        const rootId = await job({ session: session, createdBy: userId });
        await job({ session: session, createdBy: userId, root: rootId, parent: rootId });
        await branch({
            session: session,
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });
        await point({ session: session, field: 'tokens_input', value: 1, time: '2026-08-01T10:30:00Z' });

        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions).toHaveLength(1);
        expect(input.sessions[0]?.user?.login).toBe('thread-author');
    });

    it('does not pick an author when the trusted evidence names two: the task stays, the user is unknown', async () => {
        const session = randomUUID();
        const first = await member('author-one');
        const second = await member('author-two');
        const rootId = await job({ session: session, createdBy: first });
        await job({ session: session, createdBy: second, root: rootId, parent: rootId });
        await point({ session: session, field: 'tokens_input', value: 1, time: '2026-08-01T10:30:00Z' });

        const { input } = await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups();
        expect(input.sessions).toHaveLength(1);
        expect(input.sessions[0]).toMatchObject({ taskKey: rootId, user: null });
    });

    it('keeps a session two organizations both have evidence for out of both reads', async () => {
        const session = randomUUID();
        const userId = await member('other-org-author');
        await job({ session, createdBy: userId, org: OTHER_ORG });
        await branch({
            session,
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });
        await point({ session, field: 'tokens_input', value: 1, time: '2026-08-01T10:30:00Z' });

        // The session id is also evidence of another organization: it belongs to neither tenant's read.
        const mine = (await createPostgresTelemetryClient({ sql, orgId: ORG }).fetchRollups()).input;
        expect(mine.sessions).toEqual([]);
        const theirs = (await createPostgresTelemetryClient({ sql, orgId: OTHER_ORG }).fetchRollups()).input;
        expect(theirs.sessions).toEqual([]);
    });
});

describe.skipIf(!enabled)('task attribution', () => {
    // WHICH task thread a session belongs to, resolved by the SAME subquery that resolves its
    // member: a session id carried by any job row resolves to that row's thread root, so the
    // task travels beside the user it was landed with — never through a second lookup.

    const fetchOrg = async (org = ORG) => createPostgresTelemetryClient({ sql, orgId: org }).fetchRollups();

    const seedSession = async (session: string) => {
        await branch({
            session,
            branch: 'feat/a',
            from: '2026-08-01T10:00:00Z',
            to: '2026-08-01T11:00:00Z',
        });
        await point({ session, field: 'tokens_input', value: 10, time: '2026-08-01T10:30:00Z' });
    };

    it('attributes an executor session to its task beside the member attribution', async () => {
        const userId = await member('task-author');
        const rootId = await job({ session: 'task-1', createdBy: userId });
        await seedSession('task-1');

        const { input } = await fetchOrg();
        expect(input.sessions[0]?.user?.login).toBe('task-author');
        expect(input.sessions[0]?.taskKey).toBe(rootId);
    });

    it('resolves a follow-up chain to the one thread root', async () => {
        // The follow-up copies the parent's session AND root_job_id, so both rows land in the
        // same group and the minimum is that root — the session is counted once under it.
        const userId = await member('chain-author');
        const rootId = await job({ session: 'task-2', createdBy: userId });
        await job({ session: 'task-2', createdBy: userId, root: rootId, parent: rootId });
        await seedSession('task-2');

        const { input } = await fetchOrg();
        expect(input.sessions).toHaveLength(1);
        expect(input.sessions[0]?.taskKey).toBe(rootId);
    });

    // Issue #774 (B5): an in-band review row carries its OWN session id, so the reviewer's tokens are
    // a session of the review row's — they are never summed into the caller's session, whatever
    // thread (task) both belong to.
    it('keeps a reviewer’s tokens on its review row’s session, apart from the caller’s', async () => {
        const userId = await member('review-author');
        const callerSession = randomUUID();
        const reviewerSession = randomUUID();
        const rootId = await job({ session: callerSession, createdBy: userId });
        const reviewId = randomUUID();
        await sql`
            insert into job (org_id, id, command, status, root_job_id, created_by, session_id, created_at,
                             review_of, review_key, review_profile, review_spec, review_revision, review_ref)
            values (${ORG}, ${reviewId}, 'review', 'succeeded', ${rootId}, ${userId}, ${reviewerSession}, now(),
                    ${rootId}, 'sec-1', 'security', '{}'::jsonb, 'head:abc', 'refs/factory/review/x/sec-1')
        `;
        await claim({
            job: reviewId,
            root: rootId,
            session: reviewerSession,
            author: userId,
            requesting: { job: rootId, root: rootId },
        });
        for (const [session, tokens] of [
            [callerSession, 10],
            [reviewerSession, 7],
        ] as const) {
            await branch({ session, branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z' });
            await point({ session, field: 'tokens_input', value: tokens, time: '2026-08-01T10:30:00Z' });
        }

        const { input, facts } = await fetchOrg();
        expect(pointSum(facts, callerSession, 'input')).toBe(10);
        expect(pointSum(facts, reviewerSession, 'input')).toBe(7);
        expect(input.sessions.map((s) => s.taskKey)).toEqual([rootId, rootId]);
    });

    it('keeps a session with no matching job row task-less, exactly as it is member-less', async () => {
        await seedSession('task-3');
        const { input } = await fetchOrg();
        expect(input.sessions[0]?.taskKey).toBeNull();
        expect(input.sessions[0]?.user).toBeNull();
    });

    it('resolves the task of an author-less row even though the member stays null', async () => {
        // A row that predates attribution still names its thread: min() ignores the null
        // author, so member resolution is untouched — and the task is still known.
        const rootId = await job({ session: 'task-4', createdBy: null });
        await seedSession('task-4');

        const { input } = await fetchOrg();
        expect(input.sessions[0]?.taskKey).toBe(rootId);
        expect(input.sessions[0]?.user).toBeNull();
    });

    it('keeps a deleted thread attributable from the retained execution evidence, tokens in the totals', async () => {
        // Deleting the thread's job rows must not erase who it belonged to: the execution rows
        // are the retained provenance, so the task and author survive and the usage report
        // (not the rollup) is what says the task was removed.
        const userId = await member('doomed-author');
        const rootId = await job({ session: 'task-5', createdBy: userId });
        await seedSession('task-5');

        const before = await fetchOrg();
        expect(before.input.sessions[0]?.taskKey).toBe(rootId);
        expect(pointSum(before.facts, 'task-5', 'input')).toBe(10);

        await sql`delete from job where root_job_id = ${rootId}`;
        const after = await fetchOrg();
        expect(pointSum(after.facts, 'task-5', 'input')).toBe(10);
        const stats = statsOf(after);
        expect(stats.usage.totals.tokens.input).toBe(10);
        expect(stats.totals.sessions).toBe(1);
        const task = reduceUsage(after.facts, { range: null, now: new Date() }).tasks.find((t) => t.taskId === rootId);
        expect(task?.usage.tokens.input).toBe(10);
    });

    it('fetches the org run rows beside the rollups, and never another orgs', async () => {
        const mineRoot = await job({ session: 'task-6', createdBy: null });
        await seedSession('task-6');
        await job({ session: 'task-7', createdBy: null, org: OTHER_ORG });

        const { input, runs } = await fetchOrg();
        expect(input.sessions.map((s) => s.sessionId)).toEqual(['task-6']);
        // Org-scoped: the other organization's run row stays out of this snapshot.
        expect(runs.map((r) => r.rootJobId)).toEqual([mineRoot]);
        // The column is new: every row so far reads unmeasured, never zero.
        expect(runs[0]?.agentTurns).toBeNull();
    });

    it('serves stats whose token totals equal the independent SQL sums of the raw points', async () => {
        // End to end: fetchRollups -> the read-time reduction /api/stats performs -> numbers a
        // second query over the same rows reproduces without any of the reducer's code.
        const hooked = randomUUID();
        const hookless = randomUUID();
        const userId = await member('sum-author');
        await job({ session: hooked, createdBy: userId });
        await job({ session: hookless, createdBy: userId });
        await branch({ session: hooked, branch: 'feat/a', from: '2026-08-01T10:00:00Z', to: '2026-08-01T11:00:00Z' });
        for (const [session, base] of [
            [hooked, 100],
            [hookless, 3],
        ] as const) {
            await point({ session, field: 'tokens_input', value: base, time: '2026-08-01T10:10:00Z' });
            await point({ session, field: 'tokens_input', value: base * 2, time: '2026-08-01T10:40:00Z' });
            await point({ session, field: 'tokens_output', value: base + 1, time: '2026-08-01T10:20:00Z' });
        }

        const stats = statsOf(await fetchOrg());
        const [sums] = await sql<{ input: string; output: string }[]>`
            select coalesce(sum(value) filter (where field = 'tokens_input'), 0) as input,
                   coalesce(sum(value) filter (where field = 'tokens_output'), 0) as output
            from metric_point_used
            where session_id in (${hooked}, ${hookless})`;
        expect(stats.usage.totals.tokens.input).toBe(Number(sums?.input));
        expect(stats.usage.totals.tokens.output).toBe(Number(sums?.output));
        expect(stats.usage.totals.tokens.cacheRead).toBeNull();
        expect(stats.sessionsWithoutHook).toBe(1);
        expect(stats.totals.sessions).toBe(2);
    });
});

describe.skipIf(!enabled)('runActivity — the per-run telemetry read (issue #339)', () => {
    const FROM = '2026-09-22T10:00:00.000Z';
    const TO = '2026-09-22T10:45:00.000Z';
    const FIFTEEN_MIN = 900_000;

    it('buckets one session’s points over the run window, and nothing else’s', async () => {
        // Minted per test: a shared factory_test database must never let one run's session id
        // collide with another's rows.
        const sessionId = randomUUID();
        const otherSession = randomUUID();
        await point({ session: sessionId, field: 'tokens_input', value: 2_000_000, time: '2026-09-22T10:05:00Z' });
        await point({ session: sessionId, field: 'tokens_output', value: 500_000, time: '2026-09-22T10:07:00Z' });
        await point({ session: sessionId, field: 'edits_accept', value: 3, time: '2026-09-22T10:20:00Z' });
        // A cumulative series rides the same window and must be differenced, not summed.
        await point({
            session: sessionId,
            field: 'tokens_cacheRead',
            value: 100,
            time: '2026-09-22T10:06:00Z',
            temporality: 'cumulative',
            startTime: FROM,
        });
        await point({
            session: sessionId,
            field: 'tokens_cacheRead',
            value: 160,
            time: '2026-09-22T10:21:00Z',
            temporality: 'cumulative',
            startTime: FROM,
        });
        // Another session's points and points outside the window both stay out.
        await point({ session: otherSession, field: 'tokens_input', value: 9_000_000, time: '2026-09-22T10:05:00Z' });
        await point({ session: sessionId, field: 'tokens_input', value: 7_000_000, time: '2026-09-22T09:55:00Z' });

        const buckets = await createPostgresTelemetryClient({ sql, orgId: ORG }).runActivity({
            sessionId,
            from: FROM,
            to: TO,
            bucketMs: FIFTEEN_MIN,
        });

        expect(buckets).toHaveLength(3);
        expect(buckets[0]).toEqual({
            start: FROM,
            tokens: { input: 2_000_000, output: 500_000, cacheRead: 100, cacheCreation: 0 },
            edits: 0,
        });
        expect(buckets[1]).toEqual({
            start: '2026-09-22T10:15:00.000Z',
            tokens: { input: 0, output: 0, cacheRead: 60, cacheCreation: 0 },
            edits: 3,
        });
        expect(buckets[2]).toEqual({
            start: '2026-09-22T10:30:00.000Z',
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            edits: 0,
        });
    });

    it('answers empty for a session the pipeline holds nothing about', async () => {
        const buckets = await createPostgresTelemetryClient({ sql, orgId: ORG }).runActivity({
            sessionId: randomUUID(),
            from: FROM,
            to: TO,
            bucketMs: FIFTEEN_MIN,
        });
        expect(buckets).toEqual([]);
    });
});

describe.skipIf(!enabled)('token series reduction', () => {
    const cumulative = (session: string, value: number, minute: number, attrs: Record<string, string>) =>
        point({
            session,
            field: 'tokens_input',
            value,
            time: `2026-08-01T10:0${minute}:00Z`,
            temporality: 'cumulative',
            startTime: '2026-08-01T10:00:00Z',
            attrs,
        });
    const inputTotal = async (session: string) => {
        const [row] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = ${session} and field = 'tokens_input'
        `;
        return row === undefined ? null : Number(row.value);
    };

    it('keeps counters of different models apart even when they share a start time', async () => {
        const session = randomUUID();
        await cumulative(session, 100, 1, { model: 'model-a' });
        await cumulative(session, 80, 1, { model: 'model-b' });
        expect(await inputTotal(session)).toBe(180);
    });

    it('keeps counters of different query sources apart', async () => {
        const session = randomUUID();
        await cumulative(session, 100, 1, { query_source: 'main' });
        await cumulative(session, 30, 1, { query_source: 'subagent' });
        expect(await inputTotal(session)).toBe(130);
    });

    it('counts a cumulative series at its high-water mark when a reading falls back', async () => {
        const session = randomUUID();
        for (const [i, v] of [10, 40, 25].entries()) await cumulative(session, v, i, { model: 'model-a' });
        expect(await inputTotal(session)).toBe(40);
    });

    it('does not add an unspecified reading as a delta', async () => {
        const session = randomUUID();
        await point({ session, field: 'tokens_input', value: 4, time: '2026-08-01T10:00:00Z' });
        await point({
            session,
            field: 'tokens_input',
            value: 100,
            time: '2026-08-01T10:01:00Z',
            temporality: 'unspecified',
        });
        await point({
            session,
            field: 'tokens_output',
            value: 60,
            time: '2026-08-01T10:02:00Z',
            temporality: 'unspecified',
        });
        await branch({ session, branch: 'feat/a', from: '2026-08-01T09:00:00Z', to: '2026-08-01T11:00:00Z' });
        expect(await inputTotal(session)).toBe(4);
        const outputs =
            await sql`select 1 from session_field_total where session_id = ${session} and field = 'tokens_output'`;
        expect(outputs).toHaveLength(0);
        const [slice] = await sql<{ value: number }[]>`
            select value from branch_field_total where session_id = ${session} and field = 'tokens_input'
        `;
        expect(Number(slice?.value)).toBe(4);
    });

    it('totals a null-session group per agent and keeps it out of the session summaries', async () => {
        await point({
            session: null as unknown as string,
            field: 'tokens_input',
            value: 3,
            time: '2026-08-01T10:00:00Z',
        });
        await point({
            session: null as unknown as string,
            field: 'tokens_input',
            value: 4,
            time: '2026-08-01T10:01:00Z',
        });
        const rows = await sql<{ agent: string; value: number }[]>`
            select agent, value from session_field_total where session_id is null and field = 'tokens_input'
        `;
        expect(rows.map((r) => [r.agent, Number(r.value)])).toEqual([['claude-code', 7]]);
        const summaries = await sql`select 1 from session_summary where session_id is null`;
        expect(summaries).toHaveLength(0);
    });

    it('sets a transcript copy aside as a diagnostic when OTEL owns the session', async () => {
        const session = randomUUID();
        await point({ session, field: 'tokens_input', value: 50, time: '2026-08-01T10:00:00Z' });
        await point({ session, field: 'tokens_input', value: 999, time: '2026-08-01T10:00:00Z', source: 'transcript' });
        expect(await inputTotal(session)).toBe(50);
        const set = await sql<{ source: string; value: number }[]>`
            select source, value from metric_point_suppressed where session_id = ${session}
        `;
        expect(set.map((r) => [r.source, Number(r.value)])).toEqual([['transcript', 999]]);
    });

    it('folds legacy rows per counter type for a non-token field', async () => {
        const session = randomUUID();
        const active = (value: number, minute: number, type: string, series?: string) =>
            point({
                session,
                field: 'active_seconds',
                metric: 'claude_code.active_time.total',
                value,
                time: `2026-08-01T10:0${minute}:00Z`,
                temporality: 'cumulative',
                startTime: '2026-08-01T10:00:00Z',
                attrs: series === undefined ? { type } : { type, series },
            });
        await active(10, 1, 'user', 'digest-user');
        await active(20, 1, 'cli', 'digest-cli');
        await active(15, 2, 'user');
        await active(25, 2, 'cli');
        const [row] = await sql<{ value: number }[]>`
            select value from session_field_total where session_id = ${session} and field = 'active_seconds'
        `;
        expect(Number(row?.value)).toBe(40);
    });
});
