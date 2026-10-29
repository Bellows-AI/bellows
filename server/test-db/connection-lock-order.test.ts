import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
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
import { testOrg, testUser } from './fixtures.js';
import { attachJira } from './integration-store-faults.js';

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
const DEADLINE_MS = 10_000;
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

const pool = (name: string) => postgres(process.env.DATABASE_URL!, { max: 3, connection: { application_name: name } });

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

const connect = async (): Promise<string> =>
    (
        await connections.create({
            ownerUserId: ALICE.id,
            site: 'example.atlassian.net',
            cloudId: `cloud-${randomUUID()}`,
            email: `a-${randomUUID()}@example.com`,
            apiToken: 'tok',
            access: 'read',
        })
    ).id;

const create = async (target: { skills?: string[]; connectionIds?: string[] } = {}): Promise<string> => {
    const created = await plain.create('do the work', ALICE.id, { repo: REPO, executor: null, ...target });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
};

const revisionOf = async (id: string): Promise<number> =>
    (await sql<{ rev: number }[]>`select binding_revision as rev from job where id = ${id}`)[0]!.rev;

const projection = async (id: string): Promise<string | null> =>
    (await sql<{ c: string | null }[]>`select jira_connection_id as c from job where id = ${id}`)[0]!.c;

/** A plan reader that parks the first claim until `release()`; `entered` resolves once it is parked. */
function parkedReader() {
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    return {
        entered,
        release,
        readFor: async () => {
            enter();
            await gate;
            return { config: null, services: [], revision: null, error: null };
        },
    };
}

const claimerStore = (readFor: ReturnType<typeof parkedReader>['readFor']): JobStore =>
    createJobStore({ sql: claimPool, orgId: ORG, plan: { readFor } });

/** Resolves once a backend of `application` waits on a lock; one absolute deadline, no polling count. */
async function waitForLockWait(application: string, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
        const [row] = await sql<{ n: string }[]>`
            select count(*)::text as n from pg_stat_activity
            where datname = current_database() and application_name = ${application} and wait_event_type = 'Lock'
        `;
        if (Number(row!.n) > 0) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`no ${application} backend waited on a lock before the deadline`);
}

/** A transaction held open on `statement` until `release()`. */
async function holder(statement: (tx: Sql) => Promise<unknown>) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let taken!: () => void;
    const takenP = new Promise<void>((resolve) => {
        taken = resolve;
    });
    const done = sql.begin(async (tx) => {
        await statement(tx as unknown as Sql);
        taken();
        await held;
    });
    await takenP;
    return { release, done };
}

const settledWithin = async <T extends unknown[]>(
    work: readonly [...{ [K in keyof T]: Promise<T[K]> }]
): Promise<{ [K in keyof T]: PromiseSettledResult<T[K]> }> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the transactions did not settle before the deadline')), DEADLINE_MS);
    });
    try {
        const results = await Promise.race([Promise.allSettled(work), timeout]);
        const deadlocks = results.filter(
            (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === '40P01'
        );
        expect(deadlocks).toEqual([]);
        return results as { [K in keyof T]: PromiseSettledResult<T[K]> };
    } finally {
        clearTimeout(timer);
    }
};

const value = <T>(result: PromiseSettledResult<T>): T => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
};

describe.skipIf(!enabled)('connection lock order — database', () => {
    /** Parks the real claim at its plan read, then makes its acquire wait on the root's tuple behind a share lock. */
    async function claimWaitingOnRoot(root: string, whileParked?: () => Promise<unknown>) {
        const reader = parkedReader();
        const claim = claimerStore(reader.readFor).claim(WORKER, LEASE_SECONDS) as Promise<Claim | null>;
        await reader.entered;
        await whileParked?.();
        const share = await holder((tx) => tx`select id from job where id = ${root} for share`);
        reader.release();
        await waitForLockWait(CLAIMER, Date.now() + DEADLINE_MS);
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
        await waitForLockWait(BINDER, Date.now() + DEADLINE_MS);
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
        const disconnected = binderConnections.disconnect(mine, { userId: ALICE.id, admin: false });
        await waitForLockWait(BINDER, Date.now() + DEADLINE_MS);
        share.release();
        await share.done;
        const [claimed, gone] = await settledWithin([claim, disconnected]);
        expect(value(claimed)).toMatchObject({ id: root });
        expect(value(gone).disconnected).toBe(true);
        expect(await projection(root)).toBeNull();
        const [binding] = await bindingsOf(sql, ORG, root);
        expect(binding).toMatchObject({ connectionId: mine, live: false });
    });

    it('T3: a claim of a follow-up records a requirement while a bind on its root waits on the thread lock', async () => {
        const first = await connect();
        const root = await create({ skills: ['jira'] });
        const running = (await plain.claim(WORKER, LEASE_SECONDS)) as Claim;
        await plain.complete(running.id, running.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
        await connections.disconnect(first, { userId: ALICE.id, admin: false });
        const second = await connect();
        const followUp = await plain.createFollowUp(root, 'again', ALICE.id);
        if (typeof followUp === 'string') throw new Error(followUp);
        const advisory = await holder((tx) => tx`select pg_advisory_xact_lock(hashtextextended(${root}::text, 0))`);
        const reader = parkedReader();
        const claim = claimerStore(reader.readFor).claim(WORKER, LEASE_SECONDS) as Promise<Claim | null>;
        await reader.entered;
        reader.release();
        await waitForLockWait(CLAIMER, Date.now() + DEADLINE_MS);
        const bind = bindConnectionRow(binderPool, {
            orgId: ORG,
            id: root,
            connectionId: second,
            bindingRevision: await revisionOf(root),
            userId: ALICE.id,
        });
        await waitForLockWait(BINDER, Date.now() + DEADLINE_MS);
        advisory.release();
        await advisory.done;
        const [claimed, bound] = await settledWithin([claim, bind]);
        expect(value(claimed)).toBeNull();
        expect(value(bound)).toMatchObject({ ok: true });
        expect(await requirementsOf(sql, ORG, root)).toEqual([]);
        const [row] = await sql<{ status: string; attempts: number }[]>`
            select status, attempts from job where id = ${followUp.id}`;
        expect(row).toEqual({ status: 'queued', attempts: 0 });
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
        await waitForLockWait(BINDER, Date.now() + DEADLINE_MS);
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
            connections.disconnect(one, { userId: ALICE.id, admin: false }),
            connections.disconnect(two, { userId: ALICE.id, admin: false }),
        ]);
        expect(results.map((r) => value(r).disconnected)).toEqual([true, true]);
        expect(await projection(first)).toBeNull();
        expect(await projection(second)).toBeNull();
    });

    it('T7: the real acquire records a requirement for an unbound root, then the waiting bind satisfies it', async () => {
        const first = await connect();
        const root = await create({ skills: ['jira'] });
        await connections.disconnect(first, { userId: ALICE.id, admin: false });
        const second = await connect();
        const { claim, share } = await claimWaitingOnRoot(root);
        const bind = bindConnectionRow(binderPool, {
            orgId: ORG,
            id: root,
            connectionId: second,
            bindingRevision: await revisionOf(root),
            userId: ALICE.id,
        });
        await waitForLockWait(BINDER, Date.now() + DEADLINE_MS);
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
        await Promise.race([work.catch(() => undefined), waitForLockWait(application, Date.now() + DEADLINE_MS)]);
    }

    it('T8: a lineage claim queued behind a disconnect that holds the grant: no 40P01, the claim sees the revoke', async () => {
        const { connectionId, grant, lineage } = await grantWithBoundRoot();
        const bind = await holder((tx) => tx`select id from connector_connection where id = ${connectionId} for share`);
        // The disconnect holds its root, advisory and grant locks and waits on the connection a parked bind share-locks.
        const disconnected = binderConnections.disconnect(connectionId, { userId: ALICE.id, admin: false });
        await waitForLockWait(BINDER, Date.now() + DEADLINE_MS);
        const claimed = lineage.claimLineage(grant.id, 'refresh', { rotates: false });
        await waitForLockWait(CLAIMER, Date.now() + DEADLINE_MS);
        bind.release();
        await bind.done;
        const [gone, claim] = await settledWithin([disconnected, claimed]);
        expect(value(gone).disconnected).toBe(true);
        expect(value(claim)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('T9: a lineage claim that arrives before the disconnect leaves no lock behind for it to deadlock on', async () => {
        const { connectionId, grant, lineage } = await grantWithBoundRoot();
        const bind = await holder((tx) => tx`select id from connector_connection where id = ${connectionId} for share`);
        const claimed = lineage.claimLineage(grant.id, 'refresh', { rotates: false });
        await settledOrBlocked(claimed, CLAIMER);
        const disconnected = binderConnections.disconnect(connectionId, { userId: ALICE.id, admin: false });
        await waitForLockWait(BINDER, Date.now() + DEADLINE_MS);
        bind.release();
        await bind.done;
        const [claim, gone] = await settledWithin([claimed, disconnected]);
        expect(value(claim)).toMatchObject({ ok: true });
        expect(value(gone).disconnected).toBe(true);
    });
});
