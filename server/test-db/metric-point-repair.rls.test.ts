import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgSql, REQUEST_ROLE } from '../src/db/org-sql.js';
import { boardPool } from '../src/db/pool.js';
import { createPostgresStore } from '../src/telemetry/store.js';
import { readUsageFacts } from '../src/telemetry/usage-facts.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * A point an older board stored before its session carried an org has a null org_id, which no org's policy shows. The
 * first evidence for its session (an attempt's binding, a branch report, an owner row) gives it that org, through a
 * definer trigger function: written by the request role under one org, the repair still finds the org-less point,
 * and the point then counts as that org's usage.
 */
const orgA = testOrg();
const db = useTestDb({ orgs: [orgA] });
const enabled = Boolean(db.url);

describe.skipIf(!enabled)('the org repair of a legacy point, under the request role', () => {
    let pool: Sql;

    beforeAll(() => {
        pool = boardPool(db.url as string, { max: 2, statementTimeoutMs: 10_000, role: REQUEST_ROLE });
    });
    afterAll(async () => {
        await pool.end({ timeout: 5 });
    });

    /** A point as a board from before 145 wrote it: no org, a session no evidence binds yet. */
    const legacyPoint = async (session: string) => {
        await db.sql`insert into metric_point ${db.sql({
            org_id: null,
            agent: 'claude-code',
            source: 'otel',
            metric: 'claude_code.token.usage',
            field: 'tokens_input',
            session_id: session,
            value: 7,
            temporality: 'delta',
            start_time: null,
            time: new Date('2026-08-01T10:00:00Z'),
            attrs: { type: 'input' },
        })}`;
        const [row] = await db.sql<
            { org_id: string | null }[]
        >`select org_id from metric_point where session_id = ${session}`;
        expect(row?.org_id).toBeNull();
    };

    /** What org A reads of the session as the request role: its points and its view row. */
    const seenByA = async (session: string) => {
        const a = orgSql(pool, orgA);
        const [points] = await a<
            { n: number }[]
        >`select count(*)::int as n from metric_point where session_id = ${session}`;
        const [sources] = await a<
            { n: number }[]
        >`select count(*)::int as n from session_source where session_id = ${session}`;
        return { points: points!.n, sources: sources!.n };
    };

    const tokensOfA = async (): Promise<number> => {
        const facts = await orgSql(pool, orgA).begin((tx) => readUsageFacts(tx, orgA));
        return facts.contributions.reduce((sum, c) => sum + (c.tokens.input ?? 0), 0);
    };

    it('repairs it when the first credential to write its session reserves the session', async () => {
        const session = `owner-${randomUUID()}`;
        await legacyPoint(session);
        await createPostgresStore({ sql: pool }).claimSessions({ orgId: orgA, jobId: null }, [session]);
        expect(await seenByA(session)).toEqual({ points: 1, sources: 1 });
    });

    it('repairs it when a branch report names its session, and the point counts as usage', async () => {
        const session = `branch-${randomUUID()}`;
        await legacyPoint(session);
        await createPostgresStore({ sql: pool }).recordBranch(
            {
                agent: 'claude-code',
                sessionId: session,
                repo: 'acme/widgets',
                branch: 'main',
                headSha: null,
                at: '2026-08-01T10:00:00Z',
            },
            orgA
        );
        expect(await seenByA(session)).toEqual({ points: 1, sources: 1 });
        expect(await tokensOfA()).toBe(7);
    });

    it("repairs it when an attempt's binding names its session", async () => {
        const session = `binding-${randomUUID()}`;
        await legacyPoint(session);
        const jobId = randomUUID();
        // The execution row, written past its job's foreign key; the binding itself is the request role's.
        await db.sql.begin(async (tx) => {
            await tx`set local session_replication_role = replica`;
            await tx`insert into job_execution (org_id, job_id, claim_seq, root_job_id, origin)
                     values (${orgA}, ${jobId}, 1, ${jobId}, 'claim')`;
        });
        await orgSql(pool, orgA)`
            insert into job_execution_session (org_id, job_id, claim_seq, session_id, origin)
            values (${orgA}, ${jobId}, 1, ${session}, 'reported')
        `;
        expect(await seenByA(session)).toEqual({ points: 1, sources: 1 });
    });
});
