import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrgRegistry } from '../src/orgs.js';
import { ingestRoutes } from '../src/routes/ingest.js';
import { backfillMetricPointOrgs } from '../src/telemetry/org-backfill.js';
import { createPostgresStore, type SessionClaimant } from '../src/telemetry/store.js';
import { readUsageFacts } from '../src/telemetry/usage-facts.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

/**
 * Telemetry bound to the organization: every point carries the org of the credential that wrote it, a session id
 * another attempt or organization holds is refused on both ingest routes, the views never mix two organizations'
 * points for one session key, and points stored before the column get the org their session evidence names.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const A = testOrg();
const B = testOrg();
const db = useTestDb({ max: 4, orgs: [A, B] });

const at = (iso: string) => new Date(iso);

/** A claim of `job` in `org` whose execution names `session`: the board's binding of a session to an attempt. */
async function bind(org: string, job: string, session: string): Promise<void> {
    await db.sql`
        insert into job_execution (org_id, job_id, claim_seq, root_job_id, launch, origin, created_at, ended_at)
        values (${org}, ${job}, 1, ${job}, 'observed', 'claim', ${at('2026-08-01T00:00:00Z')}, null)
        on conflict do nothing
    `;
    await db.sql`
        insert into job_execution_session (org_id, job_id, claim_seq, session_id, agent, origin)
        values (${org}, ${job}, 1, ${session}, 'claude-code', 'reported')
    `;
}

async function point(row: {
    org: string | null;
    session: string | null;
    value: number;
    time: string;
    source?: string;
    temporality?: string;
}): Promise<void> {
    await db.sql`insert into metric_point ${db.sql({
        org_id: row.org,
        agent: 'claude-code',
        source: row.source ?? 'otel',
        metric: 'claude_code.token.usage',
        field: 'tokens_input',
        session_id: row.session,
        value: row.value,
        temporality: row.temporality ?? 'delta',
        start_time: null,
        time: at(row.time),
        attrs: { type: 'input' },
    })}`;
}

const tokensOf = async (org: string): Promise<number> => {
    const facts = await db.sql.begin('isolation level repeatable read, read only', (tx) => readUsageFacts(tx, org));
    return facts.contributions.reduce((sum, c) => sum + (c.tokens.input ?? 0), 0);
};

describe.skipIf(!enabled)('session ownership (one validator, both routes)', () => {
    const store = () => createPostgresStore({ sql: db.sql });
    const refused = async (claimant: SessionClaimant, ids: string[]) =>
        [...(await store().foreignSessions(claimant, ids))].sort();

    it('an attempt may write its own sessions and unbound ones, never another attempt’s or organization’s', async () => {
        const [jobA, siblingA, jobB] = [randomUUID(), randomUUID(), randomUUID()];
        const [own, sibling, foreign, branchOnly, fresh] = ['own', 'sibling', 'foreign', 'branch', 'fresh'].map(
            (s) => `${s}-${randomUUID()}`
        ) as [string, string, string, string, string];
        await bind(A, jobA, own);
        await bind(A, siblingA, sibling);
        await bind(B, jobB, foreign);
        await db.sql`
            insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen, samples)
            values (${B}, 'claude-code', ${branchOnly}, 'acme/b', 'main', now(), now(), 1)
        `;

        expect(await refused({ orgId: A, jobId: jobA }, [own, sibling, foreign, branchOnly, fresh])).toEqual(
            [sibling, foreign, branchOnly].sort()
        );
    });

    it('a personal credential may write any session no other organization holds', async () => {
        const [jobA, jobB] = [randomUUID(), randomUUID()];
        const [mine, theirs, fresh] = [`mine-${randomUUID()}`, `theirs-${randomUUID()}`, `fresh-${randomUUID()}`];
        await bind(A, jobA, mine);
        await bind(B, jobB, theirs);

        expect(await refused({ orgId: A, jobId: null }, [mine, theirs, fresh])).toEqual([theirs]);
    });
});

describe.skipIf(!enabled)('a forged report from another organization’s attempt', () => {
    let app: FastifyInstance;
    const jobA = randomUUID();
    const jobB = randomUUID();
    let victim: string;

    beforeAll(async () => {
        app = Fastify();
        // The auth hook's answer for attempt A's credential, without the hook: these cases are about what the routes
        // do with an authenticated attempt, not about the credential.
        app.decorateRequest('auth', null);
        app.addHook('onRequest', async (request) => {
            request.auth = { kind: 'job', orgId: A, jobId: jobA };
        });
        await app.register(ingestRoutes(createPostgresStore({ sql: db.sql }), {} as OrgRegistry));
    });
    afterAll(async () => {
        await app?.close();
    });
    beforeEach(async () => {
        victim = `victim-${randomUUID()}`;
        await bind(B, jobB, victim);
        await point({ org: B, session: victim, value: 40, time: '2026-08-01T10:00:00Z' });
    });

    it('refuses attempt A’s branch report naming org B’s session, and org B’s usage is unchanged', async () => {
        const before = await tokensOf(B);
        expect(before).toBe(40);

        const res = await app.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            headers: { 'content-type': 'application/json' },
            payload: {
                agent: 'claude-code',
                sessionId: victim,
                repo: 'acme/a',
                branch: 'main',
                at: '2026-08-01T10:00:00Z',
            },
        });

        expect(res.statusCode).toBe(403);
        expect(await db.sql`select 1 from session_branch where session_id = ${victim}`).toHaveLength(0);
        expect(await tokensOf(B)).toBe(before);
    });

    it('refuses attempt A’s export naming org B’s session: nothing stored, org B’s usage unchanged', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/api/otlp/v1/metrics',
            headers: { 'content-type': 'application/json' },
            payload: {
                resourceMetrics: [
                    {
                        resource: { attributes: [{ key: 'session.id', value: { stringValue: victim } }] },
                        scopeMetrics: [
                            {
                                metrics: [
                                    {
                                        name: 'claude_code.token.usage',
                                        sum: {
                                            aggregationTemporality: 1,
                                            dataPoints: [
                                                {
                                                    asInt: '1000000',
                                                    timeUnixNano: '1785578400000000000',
                                                    attributes: [{ key: 'type', value: { stringValue: 'input' } }],
                                                },
                                            ],
                                        },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().partialSuccess.rejectedDataPoints).toBe(1);
        expect(await db.sql`select 1 from metric_point where session_id = ${victim}`).toHaveLength(1);
        expect(await tokensOf(B)).toBe(40);
    });
});

describe.skipIf(!enabled)('two organizations with one session key', () => {
    let session: string;

    beforeEach(async () => {
        session = `shared-${randomUUID()}`;
        // A's live export and B's transcript copy of a colliding (agent, session id), each org with its own branch.
        await point({ org: A, session, value: 100, time: '2026-08-01T10:00:00Z' });
        await point({ org: B, session, value: 7, time: '2026-08-01T10:05:00Z', source: 'transcript' });
        for (const org of [A, B]) {
            await db.sql`
                insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen, samples)
                values (${org}, 'claude-code', ${session}, ${`acme/${org}`}, 'main',
                        ${at('2026-08-01T09:00:00Z')}, ${at('2026-08-01T11:00:00Z')}, 1)
            `;
        }
    });

    it('keeps them apart in every view: source, used points, field, branch and summary totals', async () => {
        const bySource = await db.sql<{ org_id: string; source: string }[]>`
            select org_id, source from session_source where session_id = ${session} order by source`;
        expect(bySource).toEqual([
            { org_id: A, source: 'otel' },
            { org_id: B, source: 'transcript' },
        ]);
        const used = await db.sql<{ org_id: string; value: number }[]>`
            select org_id, value from metric_point_used where session_id = ${session} order by value`;
        expect(used).toEqual([
            { org_id: B, value: 7 },
            { org_id: A, value: 100 },
        ]);
        expect(await db.sql`select 1 from metric_point_suppressed where session_id = ${session}`).toHaveLength(0);
        for (const view of ['session_field_total', 'branch_field_total']) {
            const totals = await db.sql<{ org_id: string; value: number }[]>`
                select org_id, value from ${db.sql(view)} where session_id = ${session} order by value`;
            expect(totals, view).toEqual([
                { org_id: B, value: 7 },
                { org_id: A, value: 100 },
            ]);
        }
        const summary = await db.sql<{ org_id: string; repo: string; branch_count: number }[]>`
            select org_id, repo, branch_count from session_summary where session_id = ${session} order by repo`;
        expect(summary).toEqual(
            [
                { org_id: A, repo: `acme/${A}`, branch_count: 1 },
                { org_id: B, repo: `acme/${B}`, branch_count: 1 },
            ].sort((x, y) => x.repo.localeCompare(y.repo))
        );
    });

    it('an organization’s usage reads only the points it wrote', async () => {
        // Only A holds board evidence now; B's points on the same key, a live export among them, are B's, never A's
        // usage.
        await db.sql`delete from session_branch where session_id = ${session}`;
        await point({ org: B, session, value: 9, time: '2026-08-01T10:06:00Z' });
        await bind(A, randomUUID(), session);
        expect(await tokensOf(A)).toBe(100);
    });
});

describe.skipIf(!enabled)('points stored before they carried an organization', () => {
    const restartBackfill = () => db.sql`delete from metric_point_org_backfill`;

    it('takes the org its session evidence names; ambiguous and unmatched points stay null, out of every view', async () => {
        const [inA, inB, inBoth, nowhere] = ['a', 'b', 'both', 'nowhere'].map((s) => `${s}-${randomUUID()}`) as [
            string,
            string,
            string,
            string,
        ];
        // Written first: at insert time no evidence names any of them, as for a point an older board stored.
        for (const [i, session] of [inA, inB, inBoth, nowhere, null].entries()) {
            await point({ org: null, session, value: i + 1, time: '2026-08-01T10:00:00Z' });
        }
        expect(await db.sql`select 1 from metric_point where org_id is not null`).toHaveLength(0);
        await bind(A, randomUUID(), inA);
        await db.sql`
            insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen, samples)
            values (${B}, 'claude-code', ${inB}, 'acme/b', 'main', now(), now(), 1),
                   (${B}, 'claude-code', ${inBoth}, 'acme/b', 'main', now(), now(), 1)
        `;
        await bind(A, randomUUID(), inBoth);
        await restartBackfill();

        const pass = await backfillMetricPointOrgs(db.sql, { batchBlocks: 1 });

        expect(pass.done).toBe(true);
        const rows = await db.sql<{ session_id: string | null; org_id: string | null }[]>`
            select session_id, org_id from metric_point order by value`;
        expect(rows).toEqual([
            { session_id: inA, org_id: A },
            { session_id: inB, org_id: B },
            { session_id: inBoth, org_id: null },
            { session_id: nowhere, org_id: null },
            { session_id: null, org_id: null },
        ]);
        expect(await db.sql`select 1 from metric_point_used where org_id is null`).toHaveLength(0);
        expect(await db.sql`select 1 from session_field_total where org_id is null`).toHaveLength(0);
        expect(await tokensOf(A)).toBe(1);
    });

    it('resumes from its cursor and, once done, scans nothing again', async () => {
        const session = `later-${randomUUID()}`;
        await restartBackfill();
        expect((await backfillMetricPointOrgs(db.sql)).done).toBe(true);
        await point({ org: null, session, value: 1, time: '2026-08-01T10:00:00Z' });
        await bind(A, randomUUID(), session);

        const again = await backfillMetricPointOrgs(db.sql);

        expect(again).toEqual({ done: true, updated: 0 });
        const [row] = await db.sql<{ org_id: string | null }[]>`
            select org_id from metric_point where session_id = ${session}`;
        expect(row?.org_id).toBeNull();
    });

    it('an older board’s insert without an org takes the org its session is already bound to', async () => {
        const session = `old-writer-${randomUUID()}`;
        await bind(B, randomUUID(), session);
        await point({ org: null, session, value: 1, time: '2026-08-01T10:00:00Z' });
        const [row] = await db.sql<{ org_id: string | null }[]>`
            select org_id from metric_point where session_id = ${session}`;
        expect(row?.org_id).toBe(B);
    });
});
