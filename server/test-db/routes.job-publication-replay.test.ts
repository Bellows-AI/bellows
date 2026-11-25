import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { staticRegistry, stubTelemetryClient, testConfig } from '../test/helpers.js';
import { useTestDb } from './harness.js';
import { expireLease, mustCreate, repoRefOf, testOrg } from './fixtures.js';

/**
 * The repo-identity check on a verdict's publication runs in the store's settle transaction, behind the receipt:
 * an identical retry of a completed or board-committed verdict replays its answer even though the attempt is no
 * longer running, while a live attempt reporting another repository's change request is refused and writes nothing.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'driver-1';
const LEASE_SECONDS = 300;
const db = useTestDb({ orgs: [ORG], max: 4 });

let sql: Sql;
let store: JobStore;
let app: FastifyInstance;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    const config = testConfig();
    app = await buildApp({ config, orgs: staticRegistry({ config, jobs: store, telemetry: stubTelemetryClient() }) });
    return () => app.close();
});

const PUBLICATION = {
    repo: 'acme/web',
    prNumber: 7,
    prUrl: 'https://github.com/acme/web/pull/7',
    headBranch: 'factory/x',
    baseBranch: 'main',
};
const verdict = (leaseToken: string, publication: Record<string, unknown> = PUBLICATION) => ({
    leaseToken,
    status: 'succeeded',
    exitCode: 0,
    output: 'done',
    publication,
});

async function claimedTask(): Promise<{ id: string; leaseToken: string }> {
    const { id } = await mustCreate(store.create('do it', null, { repo: repoRefOf('acme/web'), executor: null }));
    const claim = await store.claim(WORKER, LEASE_SECONDS);
    if (!claim) throw new Error('nothing was claimable');
    return { id, leaseToken: claim.leaseToken };
}

const post = (id: string, route: 'complete' | 'conclusion', payload: object) =>
    app.inject({ method: 'POST', url: `/api/jobs/${id}/${route}`, payload });
const settled = async (id: string) => {
    const [row] = await sql<{ status: string }[]>`select status from job where org_id = ${ORG} and id = ${id}`;
    const [receiptRow] = await sql<{ n: number }[]>`
        select count(*)::int as n from job_settle_receipt where org_id = ${ORG} and job_id = ${id}`;
    const [conclusionRow] = await sql<{ n: number }[]>`
        select count(*)::int as n from job_conclusion where org_id = ${ORG} and job_id = ${id}`;
    return { status: row!.status, receipts: receiptRow!.n, conclusions: conclusionRow!.n };
};

describe.skipIf(!enabled)('a verdict with a publication, behind the receipt', () => {
    it('replays the receipt for the identical complete after its response was lost', async () => {
        const { id, leaseToken } = await claimedTask();
        const first = await post(id, 'complete', verdict(leaseToken));
        expect(first.statusCode).toBe(200);

        const retry = await post(id, 'complete', verdict(leaseToken));
        expect([retry.statusCode, retry.json()]).toEqual([200, first.json()]);
    });

    it('replays the board-committed conclusion for the identical complete', async () => {
        const { id, leaseToken } = await claimedTask();
        const staged = await post(id, 'conclusion', verdict(leaseToken));
        expect(staged.statusCode).toBe(200);
        await expireLease(sql, id);
        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
        expect((await settled(id)).status).toBe('succeeded');

        const retry = await post(id, 'complete', verdict(leaseToken));
        expect([retry.statusCode, retry.json()]).toMatchObject([200, { id, status: 'succeeded' }]);
    });

    it.each([
        [
            'another path',
            async () => ({ ...PUBLICATION, repo: 'acme/other', prUrl: 'https://github.com/acme/other/pull/7' }),
        ],
        [
            'the same path on another GitHub host',
            async () => ({ ...PUBLICATION, prUrl: 'https://ghe.example/acme/web/pull/7' }),
        ],
    ])('refuses %s on complete and conclusion with BAD_PUBLICATION, writing nothing', async (_name, publicationOf) => {
        const { id, leaseToken } = await claimedTask();
        const publication = await publicationOf();

        for (const route of ['conclusion', 'complete'] as const) {
            const res = await post(id, route, verdict(leaseToken, publication));
            expect([res.statusCode, res.json().code]).toEqual([400, 'BAD_PUBLICATION']);
        }
        expect(await settled(id)).toEqual({ status: 'running', receipts: 0, conclusions: 0 });
    });

    it('refuses the same path when the task is on another host', async () => {
        const { id, leaseToken } = await claimedTask();
        await sql`update job set host = 'ghe.example' where org_id = ${ORG} and id = ${id}`;

        const res = await post(id, 'complete', verdict(leaseToken));
        expect([res.statusCode, res.json().code]).toEqual([400, 'BAD_PUBLICATION']);
        expect(await settled(id)).toEqual({ status: 'running', receipts: 0, conclusions: 0 });
    });

    it('refuses a publication on a repo-less task', async () => {
        const { id } = await mustCreate(store.create('no repo', null, { repo: null, executor: null }));
        const claim = await store.claim(WORKER, LEASE_SECONDS);
        const res = await post(id, 'complete', verdict(claim!.leaseToken));
        expect([res.statusCode, res.json().code]).toEqual([400, 'BAD_PUBLICATION']);
    });
});
