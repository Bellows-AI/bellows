import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { DeploymentMode } from '@factory-ai/core';
import { type AuthStore, createAuthStore } from '../src/auth/store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { UNINSTALL_DELETE_WINDOW_DAYS } from '../src/db/org-status.js';
import type { PlanLimits } from '../src/db/plan-limits.js';
import { craftJob, randomGithubId, spendInterruptionBudget, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * A suspension interrupts an organization's running work resumably (docs/organizations.md): the next heartbeat of
 * each running attempt answers `release: 'org-suspended'`, the driver hands the attempt back flagged `orgSuspended`,
 * and the row is recorded interrupted — never failed, stopped or dead, never a node loss, never spending a budget.
 * While the org is not active the claim offers none of its rows, a takeover included; a reactivation makes the same
 * row claimable again, resuming its session under a new claim sequence. An App uninstall or a GitHub suspension
 * suspends the org with a deletion deadline; an unsuspension lifts what the installation set, and nothing else.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const LEASE_SECONDS = 300;
const OPERATOR = testUser('operator-357');
const FREE: PlanLimits = { running: 4, queued: 10, wallSeconds: 3600 };
const DAY_MS = 86_400_000;

const db = useTestDb({ max: 12, users: [OPERATOR] });
let sql: Sql;
let auth: AuthStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    auth = createAuthStore({ sql });
});

const storeFor = (orgId: string, deploymentMode: DeploymentMode = 'cloud'): JobStore =>
    createJobStore({ sql, orgId, planDefaults: FREE, deploymentMode });

async function signedInOrg(): Promise<string> {
    const org = testOrg();
    const login = `u-${org}`;
    await auth.signIn({ githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null }, org, [
        { id: org, name: `acct-${org}` },
    ]);
    return org;
}

const queued = (org: string) => craftJob({ sql, org, author: '' }, { author: null, repo: null });

/** A running attempt of a fresh org's one queued row, with a session reported. */
async function runningAttempt(deploymentMode: DeploymentMode = 'cloud') {
    const org = await signedInOrg();
    const store = storeFor(org, deploymentMode);
    const id = await queued(org);
    const claim = (await store.claim('w1', LEASE_SECONDS))!;
    expect(claim.id).toBe(id);
    const session = randomUUID();
    expect(await store.session(id, claim.leaseToken, session)).toBe('ok');
    return { org, store, id, claim, session };
}

const handBack = (store: JobStore, id: string, leaseToken: string) =>
    store.interrupt(id, leaseToken, { reason: 'the organization is suspended', release: true, orgSuspended: true });

const orgRow = async (org: string) =>
    (
        await sql<{ status: string; delete_after: Date | null }[]>`
            select status, delete_after from organization where id = ${org}`
    )[0]!;

const auditRows = (org: string) =>
    sql<{ actor_kind: string; actor_id: string | null; action: string; detail: Record<string, unknown> }[]>`
        select actor_kind, actor_id, action, detail from audit_event
        where org_id = ${org} and action like 'org.%' order by at, id
    `;

describe.skipIf(!enabled)('a suspension interrupts running work resumably', () => {
    it('answers the next heartbeat of a running attempt with release org-suspended; an active org with none', async () => {
        const { org, store, id, claim } = await runningAttempt();
        expect(await store.heartbeat(id, claim.leaseToken, LEASE_SECONDS)).toMatchObject({
            result: 'ok',
            release: null,
        });

        await auth.setOrgStatus(org, 'suspend', OPERATOR.id);
        expect(await store.heartbeat(id, claim.leaseToken, LEASE_SECONDS)).toMatchObject({
            result: 'ok',
            cancelRequested: false,
            release: 'org-suspended',
        });
        // The beat only asks: the row is still the attempt's until the driver hands it back.
        expect((await store.get(id))!.status).toBe('running');
    });

    it('answers release for a refused org too', async () => {
        const { org, store, id, claim } = await runningAttempt();
        await auth.setOrgStatus(org, 'refuse', OPERATOR.id);
        expect(await store.heartbeat(id, claim.leaseToken, LEASE_SECONDS)).toMatchObject({ release: 'org-suspended' });
    });

    it('asks no release on a self-hosted board, which reads no status', async () => {
        const { org, store, id, claim } = await runningAttempt('self-hosted');
        await auth.setOrgStatus(org, 'suspend', OPERATOR.id);
        expect(await store.heartbeat(id, claim.leaseToken, LEASE_SECONDS)).toMatchObject({ release: null });
    });

    it('records the hand-back as an interruption, held while suspended, resumed with its session on reactivation', async () => {
        const { org, store, id, claim, session } = await runningAttempt();
        await auth.setOrgStatus(org, 'suspend', OPERATOR.id);

        expect(await handBack(store, id, claim.leaseToken)).toEqual({ result: 'ok', status: 'queued' });
        const row = (await store.get(id))!;
        expect(row.status).toBe('queued');
        expect(row.attempts).toBe(0);
        expect(row.interruptions).toEqual([
            {
                at: expect.any(String),
                reason: 'the organization is suspended',
                claimSeq: claim.claimSeq,
                orgSuspended: true,
            },
        ]);
        expect(row.interruptions[0]).not.toHaveProperty('nodeLoss');

        // Held: no claim cycle offers it while the org is suspended.
        expect(await store.claim('w2', LEASE_SECONDS)).toBeNull();

        await auth.setOrgStatus(org, 'activate', OPERATOR.id);
        const resumed = (await store.claim('w2', LEASE_SECONDS))!;
        expect(resumed).toMatchObject({ id, resumeSessionId: session, continuesInterrupted: true });
        expect(resumed.claimSeq).toBe(claim.claimSeq + 1);
    });

    it('spends no interruption budget: accepted past a spent one', async () => {
        const org = await signedInOrg();
        const store = storeFor(org);
        const id = await queued(org);
        await spendInterruptionBudget(sql, id);
        const claim = (await store.claim('w1', LEASE_SECONDS))!;
        await auth.setOrgStatus(org, 'suspend', OPERATOR.id);
        expect(await handBack(store, id, claim.leaseToken)).toEqual({ result: 'ok', status: 'queued' });
    });
});

describe.skipIf(!enabled)('an App uninstall or a GitHub suspension', () => {
    it.each(['deleted', 'suspend'] as const)(
        'installation.%s suspends with a deletion deadline, once: a replay changes nothing',
        async (action) => {
            const org = await signedInOrg();
            const before = Date.now();
            expect(await auth.setInstallationStatus(org, action)).toMatchObject({
                outcome: 'changed',
                org: { status: 'suspended' },
            });
            const row = await orgRow(org);
            expect(row.status).toBe('suspended');
            const window = UNINSTALL_DELETE_WINDOW_DAYS * DAY_MS;
            expect(row.delete_after!.getTime()).toBeGreaterThanOrEqual(before + window - 60_000);
            expect(row.delete_after!.getTime()).toBeLessThanOrEqual(Date.now() + window + 60_000);

            expect(await auth.setInstallationStatus(org, action)).toMatchObject({ outcome: 'unchanged' });
            expect((await orgRow(org)).delete_after).toEqual(row.delete_after);
            expect(await auditRows(org)).toEqual([
                {
                    actor_kind: 'system',
                    actor_id: null,
                    action: 'org.suspend',
                    detail: {
                        from: 'active',
                        to: 'suspended',
                        source: `installation.${action}`,
                        deleteAfter: row.delete_after!.toISOString(),
                    },
                },
            ]);
        }
    );

    it('installation.unsuspend reactivates and clears the deadline; a replay changes nothing', async () => {
        const org = await signedInOrg();
        await auth.setInstallationStatus(org, 'suspend');
        expect(await auth.setInstallationStatus(org, 'unsuspend')).toMatchObject({
            outcome: 'changed',
            org: { status: 'active' },
        });
        expect(await orgRow(org)).toEqual({ status: 'active', delete_after: null });
        expect(await auth.setInstallationStatus(org, 'unsuspend')).toMatchObject({ outcome: 'unchanged' });
        expect((await auditRows(org)).map((row) => [row.action, row.detail.source])).toEqual([
            ['org.suspend', 'installation.suspend'],
            ['org.activate', 'installation.unsuspend'],
        ]);
    });

    it('never lifts the operator’s suspension or refusal', async () => {
        const suspended = await signedInOrg();
        await auth.setOrgStatus(suspended, 'suspend', OPERATOR.id);
        expect(await auth.setInstallationStatus(suspended, 'unsuspend')).toMatchObject({ outcome: 'unchanged' });
        expect((await orgRow(suspended)).status).toBe('suspended');

        const refused = await signedInOrg();
        await auth.setOrgStatus(refused, 'refuse', OPERATOR.id);
        expect(await auth.setInstallationStatus(refused, 'deleted')).toMatchObject({
            outcome: 'changed',
            org: { status: 'refused' },
        });
        expect((await orgRow(refused)).delete_after).not.toBeNull();
        await auth.setInstallationStatus(refused, 'unsuspend');
        expect((await orgRow(refused)).status).toBe('refused');
    });

    it('keeps every row: an uninstall only suspends, and the operator’s activate clears the deadline', async () => {
        const { org, store, id } = await runningAttempt();
        await auth.setInstallationStatus(org, 'deleted');
        expect(await store.get(id)).toMatchObject({ id, status: 'running' });
        await auth.setOrgStatus(org, 'activate', OPERATOR.id);
        expect(await orgRow(org)).toEqual({ status: 'active', delete_after: null });
    });

    it('answers missing for an unknown installation', async () => {
        expect(await auth.setInstallationStatus(testOrg(), 'deleted')).toEqual({ outcome: 'missing' });
    });
});
