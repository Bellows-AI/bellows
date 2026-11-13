import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { loadConfig } from '../src/config.js';
import { type AuthStore, createAuthStore } from '../src/auth/store.js';
import { createBatchStore } from '../src/db/batches/batch-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { OrgInactiveError } from '../src/db/org-status.js';
import { PlanLimitError, type PlanLimits, planLimits } from '../src/db/plan-limits.js';
import type { DeploymentMode } from '@factory-ai/core';
import { batchPlan, prTask } from './batch-fixtures.js';
import { craftJob, expireLease, randomGithubId, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * An organization's status (docs/organizations.md): in cloud mode a freshly signed-in org is active on the Free plan
 * and never unlimited; the operator suspends, refuses and reactivates it, and a suspended or refused org's create is
 * refused while the claim offers none of its queued rows. A self-hosted board has no status gate.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const LEASE_SECONDS = 300;
const OPERATOR = testUser('operator');

const db = useTestDb({ max: 12, users: [OPERATOR] });
let sql: Sql;
let auth: AuthStore;

/** The Free plan, as a cloud board must configure it. */
const cloud = () =>
    loadConfig(
        {
            DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev',
            DEPLOYMENT_MODE: 'cloud',
            PLAN_DEFAULT_MAX_RUNNING: '1',
            PLAN_DEFAULT_MAX_QUEUED: '2',
            PLAN_DEFAULT_MAX_WALL_SECONDS: '3600',
        },
        { mode: 'none' }
    );

const FREE: PlanLimits = { running: 1, queued: 2, wallSeconds: 3600 };

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    auth = createAuthStore({ sql });
});

const storeFor = (orgId: string, deploymentMode: DeploymentMode = 'cloud', planDefaults: PlanLimits = FREE): JobStore =>
    createJobStore({ sql, orgId, planDefaults, deploymentMode });

const create = (store: JobStore) => store.create('work', null, { repo: null, executor: null });

const queued = (org: string) => craftJob({ sql, org, author: '' }, { author: null, repo: null });

/** Signs a fresh account into a fresh installation: the org row is the sign-in's own. */
async function signedInOrg(): Promise<string> {
    const org = testOrg();
    const login = `u-${org}`;
    await auth.signIn({ githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null }, org, [
        { id: org, name: `acct-${org}` },
    ]);
    return org;
}

const statusOf = async (org: string): Promise<string | undefined> =>
    (await sql<{ status: string }[]>`select status from organization where id = ${org}`)[0]?.status;

const operatorRows = (org: string) =>
    sql<{ actor_kind: string; actor_id: string; action: string; target: string; detail: Record<string, unknown> }[]>`
        select actor_kind, actor_id, action, target, detail from audit_event
        where org_id = ${org} and actor_kind = 'operator' order by at, id
    `;

describe.skipIf(!enabled)('a cloud organization (no pending state)', () => {
    it('is active at sign-in, with no pushed plan resolving to the Free limits', async () => {
        const org = await signedInOrg();
        expect(await statusOf(org)).toBe('active');
        expect(await planLimits(sql, org, cloud().planDefaults)).toEqual(FREE);
    });

    it('is held to the Free caps: a create past the queued cap names `queued`, a claim past the running cap skips', async () => {
        const org = await signedInOrg();
        const store = storeFor(org);
        await create(store);
        await create(store);
        const refused = await create(store).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(PlanLimitError);
        expect(refused).toMatchObject({ limit: 'queued', max: 2 });

        expect(await store.claim('w1', LEASE_SECONDS)).not.toBeNull();
        expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();
    });

    it('is never unlimited: every organization row resolves every limit', async () => {
        const orgs = [await signedInOrg(), await signedInOrg(), await signedInOrg()];
        // A pushed plan that leaves every limit null, and one that sets only some, both still resolve every limit.
        await sql`insert into org_plan (org_id, plan, version) values (${orgs[1]!}, 'pro', 1)`;
        await sql`insert into org_plan (org_id, plan, version, max_running) values (${orgs[2]!}, 'pro', 1, 4)`;
        const defaults = cloud().planDefaults;
        const all = await sql<{ id: string }[]>`select id from organization`;
        expect(all.length).toBeGreaterThanOrEqual(orgs.length);
        for (const { id } of all) {
            const limits = await planLimits(sql, id, defaults);
            expect(Object.keys(limits).sort(), id).toEqual(['queued', 'running', 'wallSeconds']);
        }
    });
});

describe.skipIf(!enabled)('the operator', () => {
    it('suspends: a create is refused naming the status, the claim offers no queued row, one operator audit row', async () => {
        const org = await signedInOrg();
        const store = storeFor(org);
        const waiting = await queued(org);

        const change = await auth.setOrgStatus(org, 'suspend', OPERATOR.id);
        expect(change).toMatchObject({ outcome: 'changed', org: { id: org, status: 'suspended' } });
        expect(await statusOf(org)).toBe('suspended');

        const refused = await create(store).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(OrgInactiveError);
        expect(refused).toMatchObject({ status: 'suspended' });
        await expect(
            createBatchStore({ sql, orgId: org, deploymentMode: 'cloud' }).create(
                batchPlan('Suspended', [{ key: 's1', tasks: [prTask('a')] }]),
                OPERATOR.id
            )
        ).rejects.toBeInstanceOf(OrgInactiveError);
        expect(await store.claim('w', LEASE_SECONDS)).toBeNull();

        expect(await operatorRows(org)).toEqual([
            {
                actor_kind: 'operator',
                actor_id: OPERATOR.id,
                action: 'org.suspend',
                target: org,
                detail: { from: 'active', to: 'suspended' },
            },
        ]);

        // Reactivated, the same row is claimable and creates are admitted.
        expect(await auth.setOrgStatus(org, 'activate', OPERATOR.id)).toMatchObject({ outcome: 'changed' });
        expect((await store.claim('w', LEASE_SECONDS))?.id).toBe(waiting);
        await expect(create(store)).resolves.toMatchObject({ id: expect.any(String) });
        expect((await operatorRows(org)).map((row) => row.action)).toEqual(['org.suspend', 'org.activate']);
    });

    it('refuses: terminal until reactivated — a suspend and a sign-in leave it refused', async () => {
        const org = await signedInOrg();
        const store = storeFor(org);
        await queued(org);

        expect(await auth.setOrgStatus(org, 'refuse', OPERATOR.id)).toMatchObject({
            outcome: 'changed',
            org: { status: 'refused' },
        });
        const refused = await create(store).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(OrgInactiveError);
        expect(refused).toMatchObject({ status: 'refused' });
        expect(await store.claim('w', LEASE_SECONDS)).toBeNull();

        expect(await auth.setOrgStatus(org, 'suspend', OPERATOR.id)).toMatchObject({ outcome: 'refused' });
        await auth.signIn(
            { githubUserId: randomGithubId(), login: `again-${org}`, displayName: null, avatarUrl: null },
            org,
            [{ id: org, name: `renamed-${org}` }]
        );
        expect(await statusOf(org)).toBe('refused');
        expect((await operatorRows(org)).map((row) => row.action)).toEqual(['org.refuse']);

        expect(await auth.setOrgStatus(org, 'activate', OPERATOR.id)).toMatchObject({ outcome: 'changed' });
        expect(await store.claim('w', LEASE_SECONDS)).not.toBeNull();
    });

    it('writes no audit row for a status that already holds, and answers missing for an unknown org', async () => {
        const org = await signedInOrg();
        expect(await auth.setOrgStatus(org, 'activate', OPERATOR.id)).toMatchObject({
            outcome: 'unchanged',
            org: { status: 'active' },
        });
        expect(await operatorRows(org)).toEqual([]);
        expect(await auth.setOrgStatus(testOrg(), 'suspend', OPERATOR.id)).toEqual({ outcome: 'missing' });
    });

    it('lists every organization with its status', async () => {
        const [a, b] = [await signedInOrg(), await signedInOrg()];
        await auth.setOrgStatus(b, 'suspend', OPERATOR.id);
        const listed = await auth.listOrganizations();
        expect(listed).toEqual(
            expect.arrayContaining([
                { id: a, name: `acct-${a}`, status: 'active' },
                { id: b, name: `acct-${b}`, status: 'suspended' },
            ])
        );
    });

    it('leaves a suspended org’s running row to its takeover: suspension refuses new work only', async () => {
        const org = await signedInOrg();
        const store = storeFor(org);
        await queued(org);
        const claimed = await store.claim('w1', LEASE_SECONDS);
        expect(claimed).not.toBeNull();
        await auth.setOrgStatus(org, 'suspend', OPERATOR.id);
        await expireLease(sql, claimed!.id);
        expect((await store.claim('w2', LEASE_SECONDS))?.id).toBe(claimed!.id);
    });

    it('treats a missing organization row as not active in cloud mode', async () => {
        const org = testOrg();
        await queued(org);
        const store = storeFor(org);
        expect(await store.claim('w', LEASE_SECONDS)).toBeNull();
        const refused = await create(store).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(OrgInactiveError);
        expect(refused).toMatchObject({ status: null });
    });
});

describe.skipIf(!enabled)('a self-hosted board', () => {
    it('has no status gate: a suspended org and an org with no row both create and claim', async () => {
        const org = await signedInOrg();
        await sql`update organization set status = 'suspended' where id = ${org}`;
        const store = storeFor(org, 'self-hosted', {});
        await queued(org);
        await expect(create(store)).resolves.toMatchObject({ id: expect.any(String) });
        expect(await store.claim('w', LEASE_SECONDS)).not.toBeNull();
        await expect(
            createBatchStore({ sql, orgId: org }).create(
                batchPlan('Self-hosted', [{ key: 's1', tasks: [prTask('a')] }]),
                OPERATOR.id
            )
        ).resolves.toMatchObject({ id: expect.any(String) });

        const rowless = testOrg();
        await queued(rowless);
        expect(await storeFor(rowless, 'self-hosted', {}).claim('w', LEASE_SECONDS)).not.toBeNull();
    });
});
