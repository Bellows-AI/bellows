import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { bindingsOf } from '../src/db/connection-bindings.js';
import { createJobStore, INTERRUPTION_BUDGET } from '../src/db/jobs/job-store.js';
import { bindConnectionRow } from '../src/db/jobs/job-store-connections.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { expireLease, oauthConnection, testOrg, testUser } from './fixtures.js';

/**
 * A running task that needs a connection asks the board for it (`requireConnection`). The
 * attempt is then handed back as a requirement wait: queued, refunded, outside the interruption budget, held by the
 * claim gate until the owner binds or dismisses, and continued in the same session by the next claim.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const USERS = Array.from({ length: 36 }, (_, i) => testUser(`rr-${i}`));
const WORKER = 'worker-rr';
const LEASE_SECONDS = 60;
const SENTENCE = 'the task waits for a Jira connection';
const db = useTestDb({ orgs: [ORG], users: USERS, max: 8 });

let sql: Sql;
let store: JobStore;
let taken = 0;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
});

/** A user no earlier test gave a connection to: the lone-candidate default depends on it. */
const freshUser = () => USERS[taken++]!;

const create = async (by: string | null, target: { skills?: string[] } = {}): Promise<string> => {
    const created = await store.create('do the work', by, { repo: null, executor: null, ...target });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
};

const claimNext = async (id: string): Promise<Claim> => {
    const claim = (await store.claim(WORKER, LEASE_SECONDS)) as Claim | null;
    if (!claim || claim.id !== id) throw new Error(`expected ${id}, claimed ${claim?.id ?? 'nothing'}`);
    return claim;
};

const ask = (claim: Claim, provider = 'jira', target?: string) =>
    store.requireConnection(claim.id, claim.leaseToken, provider, target);

const handBack = (claim: Claim) =>
    store.interrupt(claim.id, claim.leaseToken, { reason: SENTENCE, release: true, requirement: true });

const requirementRows = (id: string) =>
    sql<
        {
            provider: string;
            reason: string;
            target: string | null;
            source: string;
            outcome: string | null;
            asked_job_id: string | null;
            satisfied_at: Date | null;
            delivered_claim_seq: string | null;
        }[]
    >`select provider, reason, target, source, outcome, asked_job_id, satisfied_at, delivered_claim_seq
      from job_integration_requirement where root_job_id = ${id} order by created_at, id`;

const rootRow = async (id: string) => {
    const [row] = await sql<
        { status: string; rev: number }[]
    >`select status, binding_revision as rev from job where id = ${id}`;
    return row!;
};

const connect = async (userId: string, site?: string) => oauthConnection(sql, ORG, userId, site ? { site } : {});

/** A task with no connection, claimed, asking for Jira, and handed back as a requirement wait. */
async function waiting(): Promise<{ id: string; userId: string; first: Claim; session: string }> {
    const user = freshUser();
    const id = await create(user.id);
    const first = await claimNext(id);
    const session = randomUUID();
    await store.session(id, first.leaseToken, session);
    expect(await ask(first)).toEqual({ result: 'ok', answer: 'waiting' });
    expect(await handBack(first)).toEqual({ result: 'ok', status: 'queued' });
    return { id, userId: user.id, first, session };
}

describe.skipIf(!enabled)('runtime connection requirement — database', () => {
    it('a runtime ask records an open runtime requirement and answers waiting', async () => {
        const id = await create(freshUser().id);
        const claim = await claimNext(id);
        expect(await ask(claim)).toEqual({ result: 'ok', answer: 'waiting' });
        expect(await requirementRows(id)).toMatchObject([
            { provider: 'jira', reason: 'missing', source: 'runtime', asked_job_id: id, satisfied_at: null },
        ]);
        expect((await rootRow(id)).status).toBe('running');
        // Asked again (a re-ask after a lost runner), it is still the one requirement.
        expect(await ask(claim)).toEqual({ result: 'ok', answer: 'waiting' });
        expect(await requirementRows(id)).toHaveLength(1);
    });

    it('the requirement hand-back requeues held, refunds the attempt and is not a failure', async () => {
        const { id } = await waiting();
        expect(await store.get(id)).toMatchObject({ status: 'queued', attempts: 0, failureKind: null });
        const job = await store.get(id);
        expect(job!.interruptions).toEqual([
            { at: expect.any(String), reason: SENTENCE, claimSeq: 1, requirement: true },
        ]);
        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
    });

    it('binding from the task releases it and the claim continues the session with the outcome', async () => {
        const { id, userId, session } = await waiting();
        const conn = await connect(userId);
        const bound = await bindConnectionRow(sql, {
            orgId: ORG,
            id,
            connectionId: conn.id,
            bindingRevision: (await rootRow(id)).rev,
            userId,
        });
        expect(bound).toMatchObject({ ok: true });
        expect(await requirementRows(id)).toMatchObject([{ outcome: 'bound' }]);
        const second = await claimNext(id);
        expect(second).toMatchObject({
            resumeSessionId: session,
            continuesInterrupted: true,
            connectionOutcomes: [{ provider: 'jira', label: 'Jira', outcome: 'bound' }],
        });
    });

    it('outcomes are delivered once to an ordinary re-claim', async () => {
        const { id, userId } = await waiting();
        const conn = await connect(userId);
        await bindConnectionRow(sql, {
            orgId: ORG,
            id,
            connectionId: conn.id,
            bindingRevision: (await rootRow(id)).rev,
            userId,
        });
        const second = await claimNext(id);
        expect(second.connectionOutcomes).toHaveLength(1);
        await store.interrupt(id, second.leaseToken, { reason: 'drained', release: true });
        expect((await claimNext(id)).connectionOutcomes).toBeUndefined();
    });

    it('outcomes are delivered again to a takeover of the claim that received them', async () => {
        const { id, userId } = await waiting();
        const conn = await connect(userId);
        await bindConnectionRow(sql, {
            orgId: ORG,
            id,
            connectionId: conn.id,
            bindingRevision: (await rootRow(id)).rev,
            userId,
        });
        const second = await claimNext(id);
        expect(second.connectionOutcomes).toHaveLength(1);
        await expireLease(sql, id);
        const takeover = await claimNext(id);
        expect(takeover.claimSeq).toBe(second.claimSeq + 1);
        expect(takeover.connectionOutcomes).toEqual([{ provider: 'jira', label: 'Jira', outcome: 'bound' }]);
        // The next takeover is of the claim that received them again.
        await expireLease(sql, id);
        expect((await claimNext(id)).connectionOutcomes).toHaveLength(1);
    });

    it('dismiss releases it and the resumed claim says unavailable', async () => {
        const { id, userId, session } = await waiting();
        expect(await store.dismissRequirement(id, 'jira', userId)).toEqual({ ok: true });
        expect(await requirementRows(id)).toMatchObject([{ outcome: 'dismissed' }]);
        const second = await claimNext(id);
        expect(second).toMatchObject({
            resumeSessionId: session,
            connectionOutcomes: [{ provider: 'jira', label: 'Jira', outcome: 'dismissed' }],
        });
    });

    it('a later ask at the same revision answers unavailable and records nothing', async () => {
        const { id, userId } = await waiting();
        await store.dismissRequirement(id, 'jira', userId);
        const second = await claimNext(id);
        expect(await ask(second)).toEqual({ result: 'ok', answer: 'unavailable' });
        expect(await requirementRows(id)).toHaveLength(1);
        expect((await rootRow(id)).status).toBe('running');
    });

    it('a new binding revision asks again', async () => {
        const { id, userId } = await waiting();
        await store.dismissRequirement(id, 'jira', userId);
        const second = await claimNext(id);
        const conn = await connect(userId);
        await bindConnectionRow(sql, {
            orgId: ORG,
            id,
            connectionId: conn.id,
            bindingRevision: (await rootRow(id)).rev,
            userId,
        });
        // The binding is no longer usable: the dismissal was of an earlier revision, so the block is raised again.
        await sql`update integration_grant set status = 'reconnect_required' where id = ${conn.grantId}`;
        expect(await ask(second)).toEqual({ result: 'ok', answer: 'waiting' });
        expect(await requirementRows(id)).toMatchObject([
            { outcome: 'dismissed' },
            { reason: 'reconnect', satisfied_at: null },
        ]);
    });

    it('dismiss is the execution user only, and only for an open requirement', async () => {
        const { id } = await waiting();
        const stranger = freshUser();
        expect(await store.dismissRequirement(id, 'jira', stranger.id)).toEqual({ ok: false, reason: 'missing' });
        expect(await store.dismissRequirement(randomUUID(), 'jira', stranger.id)).toEqual({
            ok: false,
            reason: 'missing',
        });
        const { id: other, userId } = await waiting();
        expect(await store.dismissRequirement(other, 'jira', userId)).toEqual({ ok: true });
        expect(await store.dismissRequirement(other, 'jira', userId)).toEqual({ ok: false, reason: 'none-open' });
    });

    it('dismissing a creation-time requirement launches the task', async () => {
        const user = freshUser();
        const id = await create(user.id, { skills: ['jira'] });
        expect(await requirementRows(id)).toMatchObject([{ source: 'create', satisfied_at: null }]);
        expect(await store.claim(WORKER, LEASE_SECONDS)).toBeNull();
        expect(await store.dismissRequirement(id, 'jira', user.id)).toEqual({ ok: true });
        const claim = await claimNext(id);
        expect(claim.skillRefusal ?? null).toBeNull();
        expect(await requirementRows(id)).toHaveLength(1);
    });

    it('a bound connection whose grant needs reconnect answers waiting with reason reconnect', async () => {
        const user = freshUser();
        const conn = await connect(user.id);
        const id = await create(user.id);
        expect((await bindingsOf(sql, ORG, id)).map((b) => b.connectionId)).toEqual([conn.id]);
        const claim = await claimNext(id);
        expect(await ask(claim)).toEqual({ result: 'ok', answer: 'bound' });
        await sql`update integration_grant set status = 'reconnect_required' where id = ${conn.grantId}`;
        expect(await ask(claim)).toEqual({ result: 'ok', answer: 'waiting' });
        expect(await requirementRows(id)).toMatchObject([{ reason: 'reconnect', source: 'runtime' }]);
    });

    it('a connection moved to another grant is a reconnect, never bound', async () => {
        const user = freshUser();
        const conn = await connect(user.id);
        const other = await connect(freshUser().id);
        const id = await create(user.id);
        const claim = await claimNext(id);
        await sql`update connector_connection set grant_id = ${other.grantId} where id = ${conn.id}`;
        expect(await ask(claim)).toEqual({ result: 'ok', answer: 'waiting' });
        expect(await requirementRows(id)).toMatchObject([{ reason: 'reconnect' }]);
    });

    it('a lone usable candidate binds automatically and answers bound', async () => {
        const user = freshUser();
        const id = await create(user.id);
        const claim = await claimNext(id);
        const conn = await connect(user.id);
        expect(await ask(claim)).toEqual({ result: 'ok', answer: 'bound' });
        const bound = await bindingsOf(sql, ORG, id);
        expect(bound).toMatchObject([{ connectionId: conn.id, source: 'default', revision: 1 }]);
        expect((await rootRow(id)).rev).toBe(1);
        expect(await requirementRows(id)).toEqual([]);
    });

    it('two candidates read ambiguous', async () => {
        const user = freshUser();
        const id = await create(user.id);
        const claim = await claimNext(id);
        await connect(user.id);
        await connect(user.id);
        expect(await ask(claim)).toEqual({ result: 'ok', answer: 'waiting' });
        expect(await requirementRows(id)).toMatchObject([{ reason: 'ambiguous', source: 'runtime' }]);
        expect(await bindingsOf(sql, ORG, id)).toEqual([]);
    });

    it('a usable binding answers bound and records nothing', async () => {
        const user = freshUser();
        await connect(user.id);
        const id = await create(user.id);
        const claim = await claimNext(id);
        expect(await ask(claim)).toEqual({ result: 'ok', answer: 'bound' });
        expect(await requirementRows(id)).toEqual([]);
    });

    it('no execution user answers unavailable and records nothing', async () => {
        const id = await create(null);
        const claim = await claimNext(id);
        expect(await ask(claim)).toEqual({ result: 'ok', answer: 'unavailable' });
        expect(await requirementRows(id)).toEqual([]);
    });

    it('a provider the board cannot bind answers unavailable', async () => {
        const id = await create(freshUser().id);
        const claim = await claimNext(id);
        expect(await ask(claim, 'github')).toEqual({ result: 'ok', answer: 'unavailable' });
        expect(await requirementRows(id)).toEqual([]);
    });

    it('requirement hand-backs never spend the interruption budget', async () => {
        const user = freshUser();
        const id = await create(user.id);
        for (let round = 0; round <= INTERRUPTION_BUDGET; round++) {
            const claim = await claimNext(id);
            expect(await ask(claim)).toEqual({ result: 'ok', answer: 'waiting' });
            expect(await handBack(claim)).toEqual({ result: 'ok', status: 'queued' });
            await sql`update job_integration_requirement set satisfied_at = now(), outcome = 'bound'
                      where root_job_id = ${id} and satisfied_at is null`;
        }
        const last = await claimNext(id);
        expect(await store.interrupt(id, last.leaseToken, { reason: 'drained', release: true })).toEqual({
            result: 'ok',
            status: 'queued',
        });
    });

    it('a requirement hand-back is accepted past a spent budget', async () => {
        const id = await create(freshUser().id);
        const claim = await claimNext(id);
        await ask(claim);
        await sql`update job set interruptions = (
            select jsonb_agg(jsonb_build_object('reason', 'spent', 'at', now(), 'claimSeq', -n))
            from generate_series(1, ${INTERRUPTION_BUDGET}) as n) where id = ${id}`;
        expect(await store.interrupt(id, claim.leaseToken, { reason: 'drained', release: true })).toEqual({
            result: 'exhausted',
        });
        expect(await handBack(claim)).toEqual({ result: 'ok', status: 'queued' });
    });

    it('the heartbeat reports requirementWait to a takeover of the asking row', async () => {
        const id = await create(freshUser().id);
        const first = await claimNext(id);
        const beat = (claim: Claim) => store.heartbeat(claim.id, claim.leaseToken, LEASE_SECONDS);
        expect(await beat(first)).toMatchObject({ requirementWait: false });
        await ask(first);
        expect(await beat(first)).toMatchObject({ result: 'ok', requirementWait: true });
        await expireLease(sql, id);
        const takeover = await claimNext(id);
        expect(takeover.claimSeq).toBe(first.claimSeq + 1);
        expect(await beat(takeover)).toMatchObject({ result: 'ok', requirementWait: true });

        const otherId = await create(freshUser().id);
        const other = await claimNext(otherId);
        expect(await beat(other)).toMatchObject({ requirementWait: false });
    });

    describe.each(['bound', 'dismissed'] as const)('answered before any hand-back (%s)', (answer) => {
        it('a takeover is still told to hand back, and the claim after the hand-back gets the outcome', async () => {
            const user = freshUser();
            const id = await create(user.id);
            const first = await claimNext(id);
            const session = randomUUID();
            await store.session(id, first.leaseToken, session);
            expect(await ask(first)).toEqual({ result: 'ok', answer: 'waiting' });
            // The driver dies here: the board answered `waiting` and nothing was handed back.
            if (answer === 'bound') {
                const conn = await connect(user.id);
                await bindConnectionRow(sql, {
                    orgId: ORG,
                    id,
                    connectionId: conn.id,
                    bindingRevision: (await rootRow(id)).rev,
                    userId: user.id,
                });
            } else {
                expect(await store.dismissRequirement(id, 'jira', user.id)).toMatchObject({ ok: true });
            }
            await expireLease(sql, id);
            const takeover = await claimNext(id);
            expect(takeover.claimSeq).toBe(first.claimSeq + 1);
            const beat = () => store.heartbeat(takeover.id, takeover.leaseToken, LEASE_SECONDS);
            expect(await beat()).toMatchObject({ result: 'ok', requirementWait: true });

            expect(await handBack(takeover)).toEqual({ result: 'ok', status: 'queued' });
            const resumed = await claimNext(id);
            expect(resumed).toMatchObject({
                resumeSessionId: session,
                connectionOutcomes: [{ provider: 'jira', label: 'Jira', outcome: answer }],
            });
            expect(await store.heartbeat(resumed.id, resumed.leaseToken, LEASE_SECONDS)).toMatchObject({
                requirementWait: false,
            });
        });
    });

    describe('an ask that names a target (the site a helper needs)', () => {
        const SITE_A = 'a.example.net';
        const SITE_B = 'b.example.net';
        /** A running task of a fresh user with a usable binding to SITE_A and nothing else bound. */
        async function boundToA() {
            const user = freshUser();
            const id = await create(user.id);
            const conn = await connect(user.id, SITE_A);
            await bindConnectionRow(sql, {
                orgId: ORG,
                id,
                connectionId: conn.id,
                bindingRevision: (await rootRow(id)).rev,
                userId: user.id,
            });
            return { user, id, claim: await claimNext(id) };
        }

        it('is bound when a usable binding matches it, whatever the case', async () => {
            const { id, claim } = await boundToA();
            expect(await ask(claim, 'jira', SITE_A.toUpperCase())).toEqual({ result: 'ok', answer: 'bound' });
            expect(await requirementRows(id)).toEqual([]);
        });

        it('opens a missing requirement recording the target when the binding is for another site', async () => {
            const { id, claim } = await boundToA();
            expect(await ask(claim, 'jira', SITE_B)).toEqual({ result: 'ok', answer: 'waiting' });
            expect(await requirementRows(id)).toMatchObject([
                { reason: 'missing', target: SITE_B, source: 'runtime', satisfied_at: null },
            ]);
        });

        it('binds the lone unbound connection that matches the target', async () => {
            const { user, id, claim } = await boundToA();
            const other = await connect(user.id, SITE_B);
            expect(await ask(claim, 'jira', SITE_B)).toEqual({ result: 'ok', answer: 'bound' });
            expect((await bindingsOf(sql, ORG, id)).map((b) => b.connectionId)).toContain(other.id);
            expect(await requirementRows(id)).toEqual([]);
        });

        it('is ambiguous when several unbound connections match the target', async () => {
            const { user, id, claim } = await boundToA();
            await connect(user.id, SITE_B);
            await connect(user.id, SITE_B);
            expect(await ask(claim, 'jira', SITE_B)).toEqual({ result: 'ok', answer: 'waiting' });
            expect(await requirementRows(id)).toMatchObject([{ reason: 'ambiguous', target: SITE_B }]);
        });

        it('a later ask refreshes the target of the one open requirement', async () => {
            const { id, claim } = await boundToA();
            await ask(claim, 'jira', SITE_B);
            await ask(claim, 'jira', 'c.example.net');
            expect(await requirementRows(id)).toMatchObject([{ target: 'c.example.net' }]);
        });
    });

    it('an ask from a row not running under that lease is lost', async () => {
        const id = await create(freshUser().id);
        const claim = await claimNext(id);
        expect(await store.requireConnection(id, randomUUID(), 'jira')).toEqual({ result: 'lost' });
        expect(await store.requireConnection(randomUUID(), claim.leaseToken, 'jira')).toEqual({ result: 'missing' });
        expect(await requirementRows(id)).toEqual([]);
    });
});
