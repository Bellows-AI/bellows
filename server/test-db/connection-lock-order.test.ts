import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindingsOf, requirementsOf } from '../src/db/connection-bindings.js';
import { createConnectionGrants } from '../src/db/connection-grants.js';
import { createConnectionStore, type ConnectionStore } from '../src/db/connection-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { bindConnectionRow } from '../src/db/jobs/job-store-connections.js';
import { createGrantLineage } from '../src/integrations/grant-lineage.js';
import { createSecretRef } from '../src/secrets/secret-input.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { oauthConnection, testOrg, testUser } from './fixtures.js';
import { attachJira } from './integration-store-faults.js';
import {
    DEADLINE_MS,
    holder,
    parkedReader,
    pool,
    settledWithin,
    value,
    waitForLockWait,
} from './lock-order-harness.js';

/**
 * BEL-59 lock order: thread root row (no key update) -> thread advisory lock -> grant -> connection -> child
 * inserts. Each test drives the REAL claim() to a pause in the plan reader, queues a second transaction behind it,
 * and requires both to finish: a lock-order inversion is a 40P01 here, never a timing accident.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('lo-alice');
const WORKER = 'worker-lo';
const LEASE_SECONDS = 60;
const REPO = 'acme/app';
const CLAIMER = 'claim-under-test';
const BINDER = 'bind-under-test';
const db = useTestDb({ orgs: [ORG], users: [ALICE], max: 8 });

let sql: Sql;
let claimPool: Sql;
let binderPool: Sql;
let plain: JobStore;
let connections: ConnectionStore;
let binderConnections: ConnectionStore;
let binderJobs: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    claimPool = pool(CLAIMER);
    binderPool = pool(BINDER);
    plain = createJobStore({ sql, orgId: ORG });
    connections = createConnectionStore({ sql, orgId: ORG });
    binderConnections = createConnectionStore({ sql: binderPool, orgId: ORG });
    binderJobs = createJobStore({ sql: binderPool, orgId: ORG });
});

afterAll(async () => {
    await claimPool?.end({ timeout: 5 });
    await binderPool?.end({ timeout: 5 });
});

const connect = async (): Promise<string> => (await oauthConnection(sql, ORG, ALICE.id)).id;

const create = async (target: { skills?: string[]; connectionIds?: string[] } = {}): Promise<string> => {
    const created = await plain.create('do the work', ALICE.id, { repo: REPO, executor: null, ...target });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
};

const revisionOf = async (id: string): Promise<number> =>
    (await sql<{ rev: number }[]>`select binding_revision as rev from job where id = ${id}`)[0]!.rev;

const projection = async (id: string): Promise<string | null> =>
    (await sql<{ c: string | null }[]>`select jira_connection_id as c from job where id = ${id}`)[0]!.c;

const claimerStore = (readFor: ReturnType<typeof parkedReader>['readFor']): JobStore =>
    createJobStore({ sql: claimPool, orgId: ORG, plan: { readFor } });

describe.skipIf(!enabled)('connection lock order — database', () => {
    /** Parks the real claim at its plan read, then makes its acquire wait on the root's tuple behind a share lock. */
    async function claimWaitingOnRoot(root: string, whileParked?: () => Promise<unknown>) {
        const reader = parkedReader();
        const claim = claimerStore(reader.readFor).claim(WORKER, LEASE_SECONDS) as Promise<Claim | null>;
        await reader.entered;
        await whileParked?.();
        const share = await holder(sql, (tx) => tx`select id from job where id = ${root} for share`);
        reader.release();
        await waitForLockWait(sql, CLAIMER, Date.now() + DEADLINE_MS);
        return { claim, share };
    }

    it('T1: a bind and the claim of the same root do not deadlock; the bind lands after the claim', async () => {
        const root = await create();
        const fresh = await connect();
        const { claim, share } = await claimWaitingOnRoot(root);
        const bind = bindConnectionRow(binderPool, {
            orgId: ORG,
            id: root,
            connectionId: fresh,
            bindingRevision: await revisionOf(root),
            userId: ALICE.id,
        });
        await waitForLockWait(sql, BINDER, Date.now() + DEADLINE_MS);
        share.release();
        await share.done;
        const [claimed, bound] = await settledWithin([claim, bind]);
        expect(value(claimed)).toMatchObject({ id: root });
        expect(value(bound)).toEqual({ ok: true, revision: 1 });
        expect((await bindingsOf(sql, ORG, root)).map((b) => b.connectionId)).toEqual([fresh]);
        expect(await projection(root)).toBe(fresh);
    });

    it('T2: disconnecting a bound connection and the claim of that root do not deadlock', async () => {
        const mine = await connect();
        const root = await create();
        expect(await projection(root)).toBe(mine);
        const { claim, share } = await claimWaitingOnRoot(root);
        const disconnected = binderConnections.disconnect(mine, { userId: ALICE.id });
        await waitForLockWait(sql, BINDER, Date.now() + DEADLINE_MS);
        share.release();
        await share.done;
        const [claimed, gone] = await settledWithin([claim, disconnected]);
        expect(value(claimed)).toMatchObject({ id: root });
        expect(value(gone).disconnected).toBe(true);
        expect(await projection(root)).toBeNull();
        const [binding] = await bindingsOf(sql, ORG, root);
        expect(binding).toMatchObject({ connectionId: mine, live: false });
    });

    it('T3: a claim of a follow-up skips a thread whose lock is held, records the requirement next poll, and a bind satisfies it', async () => {
        const first = await connect();
        const root = await create({ skills: ['jira'] });
        const running = (await plain.claim(WORKER, LEASE_SECONDS)) as Claim;
        await plain.complete(running.id, running.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
        await connections.disconnect(first, { userId: ALICE.id });
        const second = await connect();
        const followUp = await plain.createFollowUp(root, 'again', ALICE.id);
        if (typeof followUp === 'string') throw new Error(followUp);
        const queuedFollowUp = { status: 'queued', attempts: 0 };
        const stateOf = async () =>
            (
                await sql<{ status: string; attempts: number }[]>`
                select status, attempts from job where id = ${followUp.id}`
            )[0];
        // A held thread lock stands in for a bind's tail: the claim holds the follow-up's row, only TRIES the lock,
        // and skips the thread, so it records nothing and spends nothing.
        const advisory = await holder(
            sql,
            (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${root}::text, 0))`
        );
        const reader = parkedReader();
        const skipped = claimerStore(reader.readFor).claim(WORKER, LEASE_SECONDS) as Promise<Claim | null>;
        await reader.entered;
        reader.release();
        const [answer] = await settledWithin([skipped]);
        expect(value(answer)).toBeNull();
        expect(await requirementsOf(sql, ORG, root)).toEqual([]);
        expect(await stateOf()).toEqual(queuedFollowUp);
        advisory.release();
        await advisory.done;

        expect(await plain.claim(WORKER, LEASE_SECONDS)).toBeNull();
        expect(await requirementsOf(sql, ORG, root)).not.toEqual([]);
        expect(await stateOf()).toEqual(queuedFollowUp);
        const bound = await bindConnectionRow(binderPool, {
            orgId: ORG,
            id: root,
            connectionId: second,
            bindingRevision: await revisionOf(root),
            userId: ALICE.id,
        });
        expect(bound).toMatchObject({ ok: true });
        expect(await requirementsOf(sql, ORG, root)).toEqual([]);
    });

    it('T4: a follow-up naming connections and the claim of the thread root do not deadlock', async () => {
        const root = await create();
        const [member] = await sql<{ id: string }[]>`
            insert into job (org_id, command, created_by, repo, root_job_id, status, finished_at)
            values (${ORG}, 'earlier', ${ALICE.id}, ${REPO}, ${root}, 'stopped', now())
            returning id
        `;
        const fresh = await connect();
        const { claim, share } = await claimWaitingOnRoot(root, () => plain.stop(root, ALICE.id));
        const followUp = binderJobs.createFollowUp(member!.id, 'more', ALICE.id, undefined, [fresh]);
        await waitForLockWait(sql, BINDER, Date.now() + DEADLINE_MS);
        share.release();
        await share.done;
        const [claimed, created] = await settledWithin([claim, followUp]);
        expect(value(claimed)).toBeNull();
        const made = value(created);
        if (typeof made === 'string') throw new Error(made);
        expect((await bindingsOf(sql, ORG, root)).map((b) => b.connectionId)).toEqual([fresh]);
    });

    it('T6: two disconnects over two shared roots both finish and project null', async () => {
        const one = await connect();
        const two = await connect();
        const first = await create({ connectionIds: [one, two] });
        const second = await create({ connectionIds: [two, one] });
        const results = await settledWithin([
            connections.disconnect(one, { userId: ALICE.id }),
            connections.disconnect(two, { userId: ALICE.id }),
        ]);
        expect(results.map((r) => value(r).disconnected)).toEqual([true, true]);
        expect(await projection(first)).toBeNull();
        expect(await projection(second)).toBeNull();
    });

    it('T7: the real acquire records a requirement for an unbound root, then the waiting bind satisfies it', async () => {
        const first = await connect();
        const root = await create({ skills: ['jira'] });
        await connections.disconnect(first, { userId: ALICE.id });
        const second = await connect();
        const { claim, share } = await claimWaitingOnRoot(root);
        const bind = bindConnectionRow(binderPool, {
            orgId: ORG,
            id: root,
            connectionId: second,
            bindingRevision: await revisionOf(root),
            userId: ALICE.id,
        });
        await waitForLockWait(sql, BINDER, Date.now() + DEADLINE_MS);
        share.release();
        await share.done;
        const [claimed, bound] = await settledWithin([claim, bind]);
        expect(value(claimed)).toBeNull();
        expect(value(bound)).toMatchObject({ ok: true });
        expect(await requirementsOf(sql, ORG, root)).toEqual([]);
        expect(((await plain.claim(WORKER, LEASE_SECONDS)) as Claim | null)?.id).toBe(root);
    });
    /** A grant with a secret version (so a refresh claim is possible), one connection, and a root bound to it. */
    async function grantWithBoundRoot() {
        const grants = createConnectionGrants({ sql, orgId: ORG });
        const attached = await attachJira(grants, ALICE.id, {
            externalAccountId: `acct-${randomUUID()}`,
            cloudId: `cloud-${randomUUID()}`,
        });
        await sql`update integration_grant set secret_ref = ${createSecretRef()}, secret_version = 'v1' where id = ${attached.grant.id}`;
        const root = await create({ connectionIds: [attached.connectionId] });
        const lineage = createGrantLineage({
            sql: claimPool,
            orgId: ORG,
            secrets: undefined as never,
            providers: () => undefined,
        });
        return { ...attached, root, lineage };
    }

    /** Resolves once `work` settled or one of `application`'s backends waits on a lock, whichever comes first. */
    async function settledOrBlocked(work: Promise<unknown>, application: string): Promise<void> {
        await Promise.race([work.catch(() => undefined), waitForLockWait(sql, application, Date.now() + DEADLINE_MS)]);
    }

    it('T8: a lineage claim queued behind a disconnect that holds the grant: no 40P01, the claim sees the revoke', async () => {
        const { connectionId, grant, lineage } = await grantWithBoundRoot();
        const bind = await holder(
            sql,
            (tx) => tx`select id from connector_connection where id = ${connectionId} for share`
        );
        // The disconnect holds its root, advisory and grant locks and waits on the connection a parked bind share-locks.
        const disconnected = binderConnections.disconnect(connectionId, { userId: ALICE.id });
        await waitForLockWait(sql, BINDER, Date.now() + DEADLINE_MS);
        const claimed = lineage.claimLineage(grant.id, 'refresh', { rotates: false });
        await waitForLockWait(sql, CLAIMER, Date.now() + DEADLINE_MS);
        bind.release();
        await bind.done;
        const [gone, claim] = await settledWithin([disconnected, claimed]);
        expect(value(gone).disconnected).toBe(true);
        expect(value(claim)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('T9: a lineage claim that arrives before the disconnect leaves no lock behind for it to deadlock on', async () => {
        const { connectionId, grant, lineage } = await grantWithBoundRoot();
        const bind = await holder(
            sql,
            (tx) => tx`select id from connector_connection where id = ${connectionId} for share`
        );
        const claimed = lineage.claimLineage(grant.id, 'refresh', { rotates: false });
        await settledOrBlocked(claimed, CLAIMER);
        const disconnected = binderConnections.disconnect(connectionId, { userId: ALICE.id });
        await waitForLockWait(sql, BINDER, Date.now() + DEADLINE_MS);
        bind.release();
        await bind.done;
        const [claim, gone] = await settledWithin([claimed, disconnected]);
        expect(value(claim)).toMatchObject({ ok: true });
        expect(value(gone).disconnected).toBe(true);
    });
});
