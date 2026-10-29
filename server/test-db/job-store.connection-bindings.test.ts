import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
    addBindingsInTx,
    bindingsOf,
    ConnectionRefusedError,
    recordMissingInTx,
    requirementsOf,
    unboundProvidersInTx,
} from '../src/db/connection-bindings.js';
import { createConnectionStore, type ConnectionStore } from '../src/db/connection-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { bindConnectionRow } from '../src/db/jobs/job-store-connections.js';
import { insertWorkflowSuccessor } from '../src/db/jobs/job-store-rows.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { waitForLockWaiters } from './lock-wait.js';
import { expireLease, testOrg, testUser } from './fixtures.js';

/**
 * BEL-59 slice 3: a task's connections are bindings on its thread root. Create resolves them (explicit
 * ids, the unambiguous personal default) in the create transaction; the claim never offers a queued
 * root whose required provider has no live binding, and spends no attempt on it.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('jb-alice');
const BOB = testUser('jb-bob');
const WORKER = 'worker-1';
const LEASE_SECONDS = 60;
const db = useTestDb({ orgs: [ORG], users: [ALICE, BOB], max: 8 });

let sql: Sql;
let store: JobStore;
let connections: ConnectionStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    connections = createConnectionStore({ sql, orgId: ORG });
});

const connect = async (ownerUserId: string | null): Promise<string> =>
    (
        await connections.create({
            ownerUserId,
            site: 'example.atlassian.net',
            cloudId: `cloud-${randomUUID()}`,
            email: `a-${randomUUID()}@example.com`,
            apiToken: 'tok',
            access: 'read',
        })
    ).id;

const create = async (
    by: string | null,
    target: { skills?: string[]; connectionIds?: string[] } = {}
): Promise<string> => {
    const created = await store.create('do the work', by, { repo: null, executor: null, ...target });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
};

const claimNext = async (): Promise<Claim | null> => (await store.claim(WORKER, LEASE_SECONDS)) as Claim | null;

const jobRow = async (id: string) => {
    const [row] = await sql<
        { status: string; attempts: number; claim_seq: number; execution_user_id: string | null; rev: number }[]
    >`select status, attempts, claim_seq, execution_user_id, binding_revision as rev from job where id = ${id}`;
    return row!;
};

const finish = async (claim: Claim) => {
    await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
};

describe.skipIf(!enabled)('job connection bindings — database', () => {
    it('create binds the lone personal default and stamps the execution user', async () => {
        const mine = await connect(ALICE.id);
        const id = await create(ALICE.id);
        const row = await jobRow(id);
        expect(row.execution_user_id).toBe(ALICE.id);
        expect(row.rev).toBe(1);
        const bound = await bindingsOf(sql, ORG, id);
        expect(bound.map((b) => [b.connectionId, b.source, b.live])).toEqual([[mine, 'default', true]]);
        expect(await requirementsOf(sql, ORG, id)).toEqual([]);
    });

    it('an explicit id wins over the default; two connections are both bindable', async () => {
        const first = await connect(ALICE.id);
        const second = await connect(ALICE.id);
        const id = await create(ALICE.id, { connectionIds: [second, first] });
        const bound = await bindingsOf(sql, ORG, id);
        expect(bound.map((b) => b.connectionId).sort()).toEqual([first, second].sort());
        expect(bound.every((b) => b.source === 'explicit')).toBe(true);
    });

    it('a legacy org connection is never a default; a jira skill then records a missing requirement', async () => {
        await connect(null);
        const id = await create(BOB.id, { skills: ['jira'] });
        expect(await bindingsOf(sql, ORG, id)).toEqual([]);
        expect((await requirementsOf(sql, ORG, id)).map((r) => [r.provider, r.reason])).toEqual([['jira', 'missing']]);
    });

    it('two personal candidates bind nothing and record an ambiguous requirement for a jira skill', async () => {
        await connect(BOB.id);
        await connect(BOB.id);
        const id = await create(BOB.id, { skills: ['jira'] });
        expect(await bindingsOf(sql, ORG, id)).toEqual([]);
        expect((await requirementsOf(sql, ORG, id)).map((r) => r.reason)).toEqual(['ambiguous']);
    });

    it('without a jira skill no requirement is recorded, with or without a default', async () => {
        const id = await create(BOB.id);
        expect(await requirementsOf(sql, ORG, id)).toEqual([]);
    });

    it('an explicit id owned by another member is refused and no job row is left', async () => {
        const alices = await connect(ALICE.id);
        const before = await sql<{ n: number }[]>`select count(*)::int as n from job where org_id = ${ORG}`;
        await expect(create(BOB.id, { connectionIds: [alices] })).rejects.toMatchObject({
            reason: 'not-authorized',
        });
        await expect(create(BOB.id, { connectionIds: [alices] })).rejects.toBeInstanceOf(ConnectionRefusedError);
        const after = await sql<{ n: number }[]>`select count(*)::int as n from job where org_id = ${ORG}`;
        expect(after[0]!.n).toBe(before[0]!.n);
    });

    it('a failure in binding resolution rolls the job row back (atomic with the requirement)', async () => {
        const before = await sql<{ n: number }[]>`select count(*)::int as n from job where org_id = ${ORG}`;
        await expect(create(ALICE.id, { skills: ['jira'], connectionIds: ['not-a-uuid'] })).rejects.toThrow();
        const after = await sql<{ n: number }[]>`select count(*)::int as n from job where org_id = ${ORG}`;
        expect(after[0]!.n).toBe(before[0]!.n);
    });

    it('follow-up, retry and workflow successor read the root: no rows of their own, no refusal', async () => {
        await connect(ALICE.id);
        const root = await create(ALICE.id, { skills: ['jira'] });
        const first = (await claimNext())!;
        expect(first.id).toBe(root);
        expect(first.skillRefusal).toBeNull();
        await finish(first);

        const followUp = await store.createFollowUp(root, 'again', ALICE.id);
        if (typeof followUp === 'string') throw new Error(followUp);
        const second = (await claimNext())!;
        expect(second.id).toBe(followUp.id);
        expect(second.skillRefusal).toBeNull();
        await finish(second);

        const retry = await store.createRetry(root, ALICE.id);
        if (typeof retry === 'string') throw new Error(retry);
        const third = (await claimNext())!;
        expect(third.id).toBe(retry.id);
        expect(third.skillRefusal).toBeNull();
        await finish(third);

        const successor = await sql.begin((tx) =>
            insertWorkflowSuccessor(tx, {
                orgId: ORG,
                command: 'next',
                createdBy: ALICE.id,
                repo: null,
                executor: null,
                executorScope: 'user',
                parentJobId: retry.id,
                sessionId: null,
                rootJobId: root,
                workflowId: null,
                workflowName: null,
                workflowNode: 'n',
            })
        );
        const fourth = (await claimNext())!;
        expect(fourth.id).toBe(successor);
        expect(fourth.skillRefusal).toBeNull();
        const own = await sql<{ n: number }[]>`
            select count(*)::int as n from job_connection_binding where org_id = ${ORG} and root_job_id <> ${root}`;
        expect(own[0]!.n).toBe(0);
    });

    it("another author's follow-up is refused and the execution user is unchanged (pin)", async () => {
        const root = await create(ALICE.id);
        const claim = (await claimNext())!;
        await finish(claim);
        expect(await store.createFollowUp(root, 'mine now', BOB.id)).toBe('forbidden');
        expect((await jobRow(root)).execution_user_id).toBe(ALICE.id);
    });

    it('a reviewer row gets no bindings (pin)', async () => {
        const id = randomUUID();
        await sql`
            insert into job (org_id, id, command, root_job_id, created_by, review_of, review_key, review_profile,
                             review_spec, review_revision, review_ref)
            values (${ORG}, ${id}, 'review', ${id}, ${ALICE.id}, ${randomUUID()}, 'k', 'security',
                    ${sql.json({ name: 'security' })}, 'abc', 'refs/factory/review/x')`;
        expect(await bindingsOf(sql, ORG, id)).toEqual([]);
    });

    it('a follow-up adds a binding at a new revision and keeps the old one', async () => {
        await connect(ALICE.id);
        const root = await create(ALICE.id);
        const claim = (await claimNext())!;
        await finish(claim);
        const extra = await connect(ALICE.id);
        const before = (await bindingsOf(sql, ORG, root)).map((b) => b.connectionId);
        const followUp = await store.createFollowUp(root, 'with more', ALICE.id, undefined, [extra]);
        if (typeof followUp === 'string') throw new Error(followUp);
        const bound = await bindingsOf(sql, ORG, root);
        expect(bound.map((b) => b.connectionId)).toEqual([...before, extra]);
        expect(bound.at(-1)).toMatchObject({ source: 'follow_up', revision: (await jobRow(root)).rev });
        expect((await jobRow(root)).rev).toBe(2);
    });

    it('a follow-up naming a connection the author may not bind is refused and queues nothing', async () => {
        const root = await create(ALICE.id);
        await finish((await claimNext())!);
        const bobs = await connect(BOB.id);
        const count = () => sql<{ n: number }[]>`select count(*)::int as n from job where root_job_id = ${root}`;
        const before = (await count())[0]!.n;
        await expect(store.createFollowUp(root, 'x', ALICE.id, undefined, [bobs])).rejects.toBeInstanceOf(
            ConnectionRefusedError
        );
        expect((await count())[0]!.n).toBe(before);
    });

    it('a queued root with an open requirement is never claimed; attempts and claim_seq are untouched', async () => {
        const id = await create(BOB.id, { skills: ['jira'] });
        expect((await requirementsOf(sql, ORG, id)).length).toBe(1);
        const before = await jobRow(id);
        expect(await claimNext()).toBeNull();
        const after = await jobRow(id);
        expect(after).toMatchObject({ status: 'queued', attempts: 0, claim_seq: before.claim_seq });
        const executions = await sql<{ n: number }[]>`
            select count(*)::int as n from job_execution where org_id = ${ORG} and job_id = ${id}`;
        expect(executions[0]!.n).toBe(0);
    });

    it('a queued root whose only binding was disconnected gets a missing requirement at acquire; a running takeover is offered', async () => {
        const mine = await connect(ALICE.id);
        const queued = await create(ALICE.id, { skills: ['jira'] });
        expect(await requirementsOf(sql, ORG, queued)).toEqual([]);
        await connections.disconnect(mine, { userId: ALICE.id, admin: false });

        expect(await claimNext()).toBeNull();
        expect((await requirementsOf(sql, ORG, queued)).map((r) => [r.provider, r.reason])).toEqual([
            ['jira', 'missing'],
        ]);
        expect(await jobRow(queued)).toMatchObject({ status: 'queued', attempts: 0 });

        // A row already running is a takeover: it is offered whatever the requirement says.
        const runner = await connect(ALICE.id);
        const running = await create(ALICE.id, { skills: ['jira'], connectionIds: [runner] });
        await sql`update job set status = 'stopped' where id = ${queued}`;
        const claim = (await claimNext())!;
        expect(claim.id).toBe(running);
        await sql`insert into job_integration_requirement (org_id, root_job_id, provider, reason)
                  values (${ORG}, ${running}, 'jira', 'missing')`;
        await expireLease(sql, running);
        expect((await claimNext())?.id).toBe(running);
    });

    it('binding a connection through the requirement makes the root claimable', async () => {
        const id = await create(ALICE.id, { skills: ['jira'] });
        expect(await claimNext()).toBeNull();
        const mine = await connect(ALICE.id);
        const revision = (await jobRow(id)).rev;
        const result = await sql.begin((tx) =>
            addBindingsInTx(tx, {
                orgId: ORG,
                rootJobId: id,
                expectedRevision: revision,
                connectionIds: [mine],
                actor: { userId: ALICE.id },
                source: 'requirement',
            })
        );
        expect(result).toEqual({ ok: true, revision: revision + 1 });
        expect((await claimNext())?.id).toBe(id);
    });

    it('the bind route waits for an acquire that read "unbound", then satisfies the requirement it recorded', async () => {
        const first = await connect(ALICE.id);
        const root = await create(ALICE.id, { skills: ['jira'] });
        await connections.disconnect(first, { userId: ALICE.id, admin: false });
        const replacement = await connect(ALICE.id);
        const revision = (await jobRow(root)).rev;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let read!: () => void;
        const readDone = new Promise<void>((resolve) => {
            read = resolve;
        });
        // The claim's acquire: the thread's advisory lock, then the read that says "unbound".
        const acquire = sql.begin(async (tx) => {
            await tx`select pg_advisory_xact_lock(hashtextextended(${root}::text, 0))`;
            expect(await unboundProvidersInTx(tx, { orgId: ORG, rootJobId: root, required: ['jira'] })).toEqual([
                'jira',
            ]);
            read();
            await held;
            await recordMissingInTx(tx, { orgId: ORG, rootJobId: root, providers: ['jira'] });
        });
        await readDone;
        let settled = false;
        const bind = bindConnectionRow(sql, {
            orgId: ORG,
            id: root,
            connectionId: replacement,
            bindingRevision: revision,
            userId: ALICE.id,
        }).then((r) => {
            settled = true;
            return r;
        });
        const state = await waitForLockWaiters(sql, 1, () => settled);
        release();
        await acquire;
        expect(await bind).toEqual({ ok: true, revision: revision + 1 });
        expect(state).toBe('blocked');
        expect(await requirementsOf(sql, ORG, root)).toEqual([]);
        expect((await claimNext())?.id).toBe(root);
    });

    it('binding an already-bound live connection while a requirement is open for it satisfies the requirement', async () => {
        const mine = await connect(ALICE.id);
        const root = await create(ALICE.id, { skills: ['jira'] });
        await sql`insert into job_integration_requirement (org_id, root_job_id, provider, reason)
                  values (${ORG}, ${root}, 'jira', 'missing')`;
        const revision = (await jobRow(root)).rev;
        const result = await bindConnectionRow(sql, {
            orgId: ORG,
            id: root,
            connectionId: mine,
            bindingRevision: revision,
            userId: ALICE.id,
        });
        expect(result).toEqual({ ok: true, revision });
        expect(await requirementsOf(sql, ORG, root)).toEqual([]);
        expect((await claimNext())?.id).toBe(root);
    });

    describe('jira_connection_id projection for old pods (dropped with the column)', () => {
        const projection = async (id: string): Promise<string | null> =>
            (await sql<{ c: string | null }[]>`select jira_connection_id as c from job where id = ${id}`)[0]!.c;

        it('create with one explicit jira binding projects it, with exactly one binding', async () => {
            const mine = await connect(ALICE.id);
            const root = await create(ALICE.id, { connectionIds: [mine] });
            expect(await projection(root)).toBe(mine);
            expect((await bindingsOf(sql, ORG, root)).map((b) => b.connectionId)).toEqual([mine]);
        });

        it('the default bind projects the lone personal connection', async () => {
            const mine = await connect(ALICE.id);
            const root = await create(ALICE.id);
            expect(await projection(root)).toBe(mine);
            expect(await bindingsOf(sql, ORG, root)).toHaveLength(1);
        });

        it('two live jira bindings project null (ambiguous fails closed); none project null', async () => {
            const one = await connect(ALICE.id);
            const two = await connect(ALICE.id);
            expect(await projection(await create(ALICE.id, { connectionIds: [one, two] }))).toBeNull();
            expect(await projection(await create(BOB.id))).toBeNull();
        });

        const disconnect = async (id: string) =>
            (await connections.disconnect(id, { userId: ALICE.id, admin: false })).disconnected;

        it('disconnecting one of two bindings projects the survivor; disconnecting the only one projects null', async () => {
            const one = await connect(ALICE.id);
            const two = await connect(ALICE.id);
            const pair = await create(ALICE.id, { connectionIds: [one, two] });
            expect(await projection(pair)).toBeNull();
            expect(await disconnect(one)).toBe(true);
            expect(await projection(pair)).toBe(two);
            expect(await disconnect(two)).toBe(true);
            expect(await projection(pair)).toBeNull();
        });

        it('a bind in flight on another thread is waited for, then recomputed: no stale projection, no deadlock', async () => {
            const one = await connect(ALICE.id);
            const two = await connect(ALICE.id);
            const first = await create(ALICE.id, { connectionIds: [one, two] });
            const other = await create(ALICE.id);
            const revision = (await jobRow(other)).rev;
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            let bound!: () => void;
            const boundDone = new Promise<void>((resolve) => {
                bound = resolve;
            });
            // The other thread's bind holds its thread lock and a share lock on `one`, uncommitted.
            const binding = sql.begin(async (tx) => {
                const result = await addBindingsInTx(tx, {
                    orgId: ORG,
                    rootJobId: other,
                    expectedRevision: revision,
                    connectionIds: [one],
                    actor: { userId: ALICE.id },
                    source: 'follow_up',
                });
                bound();
                await held;
                return result;
            });
            await boundDone;
            let settled = false;
            const disconnected = disconnect(one).then((r) => {
                settled = true;
                return r;
            });
            const state = await waitForLockWaiters(sql, 1, () => settled);
            release();
            expect(await binding).toMatchObject({ ok: true });
            expect(await disconnected).toBe(true);
            expect(state).toBe('blocked');
            expect(await projection(first)).toBe(two);
            expect(await projection(other)).toBeNull();
        });

        it('a follow-up adding the first jira binding projects it, a second one makes it null', async () => {
            const root = await create(ALICE.id);
            const claim = (await claimNext())!;
            await finish(claim);
            expect(await projection(root)).toBeNull();
            const one = await connect(ALICE.id);
            const followUp = await store.createFollowUp(root, 'add one', ALICE.id, undefined, [one]);
            if (typeof followUp === 'string') throw new Error(followUp);
            expect(await projection(root)).toBe(one);
            const claimed = (await claimNext())!;
            await finish(claimed);
            const two = await connect(ALICE.id);
            const second = await store.createFollowUp(root, 'add two', ALICE.id, undefined, [two]);
            if (typeof second === 'string') throw new Error(second);
            expect(await projection(root)).toBeNull();
        });
    });
});
