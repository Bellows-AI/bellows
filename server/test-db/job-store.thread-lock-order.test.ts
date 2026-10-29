import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createPrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { expireLease, holdLock, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
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
 * BEL-157 / BEL-81: the claim holds its candidate's ROW and must never WAIT for the thread's advisory lock, because
 * every thread-wide writer (retry, follow-up, remove, merge close, done) takes the advisory lock first and then waits
 * on a member row the claim may hold. Each L case drives the real claim() to a pause in the plan reader, queues the
 * writer behind a shared row lock, and requires both to finish: a 40P01 is the inversion, never a timing accident.
 *
 * L1b is a guard, not a RED case: retry of a terminal member never waits on the running row the claim holds, so it
 * passes on the old code too; the RED proof of that shape is L9, where the retry names the running row itself.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('tlo-alice');
const WORKER = 'worker-tlo';
const LEASE_SECONDS = 60;
const REPO = 'acme/app';
const CLAIMER = 'tlo-claim';
const WRITER = 'tlo-writer';
const PULL = 11;
const GATE_KEY = 15_700_157;
const succeeded = { status: 'succeeded', exitCode: 0, output: 'ok' } as const;
const db = useTestDb({ orgs: [ORG], users: [ALICE], max: 8 });

let sql: Sql;
let claimPool: Sql;
let writerPool: Sql;
let plain: JobStore;
let writer: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    claimPool = pool(CLAIMER);
    writerPool = pool(WRITER);
    plain = createJobStore({ sql, orgId: ORG, prs: createPrLifecycleStore({ sql, orgId: ORG }) });
    writer = createJobStore({
        sql: writerPool,
        orgId: ORG,
        prs: createPrLifecycleStore({ sql: writerPool, orgId: ORG }),
    });
});

afterAll(async () => {
    await claimPool?.end({ timeout: 5 });
    await writerPool?.end({ timeout: 5 });
});

const claimerStore = (readFor: ReturnType<typeof parkedReader>['readFor']): JobStore =>
    createJobStore({ sql: claimPool, orgId: ORG, plan: { readFor } });

const queued = async (): Promise<string> => {
    const created = await plain.create('do the work', ALICE.id, { repo: REPO, executor: null });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
};

const mustClaim = async (): Promise<Claim> => {
    const claim = await plain.claim(WORKER, LEASE_SECONDS);
    if (!claim) throw new Error('nothing was claimable');
    return claim;
};

/** A thread whose root ran to a terminal verdict, optionally published to the suite's PR. */
const terminalRoot = async (published = false): Promise<string> => {
    const root = await queued();
    const claim = await mustClaim();
    await plain.complete(root, claim.leaseToken, {
        ...succeeded,
        ...(published && {
            publication: {
                repo: REPO,
                prNumber: PULL,
                prUrl: `https://github.com/${REPO}/pull/${PULL}`,
                headBranch: `factory/${root}`,
                baseBranch: 'main',
            },
        }),
    });
    return root;
};

const followUpOf = async (parent: string): Promise<string> => {
    const made = await plain.createFollowUp(parent, 'again', ALICE.id);
    if (typeof made === 'string') throw new Error(made);
    return made.id;
};

const rowOf = async (id: string) =>
    (
        await sql<
            {
                status: string;
                attempts: number;
                claim_seq: string;
                lease_token: string | null;
                interruptions: unknown[];
                deferred: Date | null;
                done_at: Date | null;
            }[]
        >`
            select status, attempts, claim_seq::text as claim_seq, lease_token, interruptions,
                   claim_deferred_until as deferred, done_at
            from job where id = ${id}`
    )[0]!;

/**
 * The shared shape: park the real claim after its reservation, optionally mutate the thread, hold the candidate row
 * `for share`, let the claim reach its row lock, start the writer and wait until it settles or waits on a lock.
 */
async function raceWithClaim<W>(
    candidate: string,
    whileParked: (() => Promise<unknown>) | undefined,
    start: () => Promise<W>
) {
    const reader = parkedReader();
    const claim = claimerStore(reader.readFor).claim(WORKER, LEASE_SECONDS) as Promise<Claim | null>;
    await reader.entered;
    await whileParked?.();
    const share = await holder(sql, (tx) => tx`select id from job where id = ${candidate} for share`);
    reader.release();
    await waitForLockWait(sql, CLAIMER, Date.now() + DEADLINE_MS);
    const written = start();
    const settled = written.then(
        () => undefined,
        () => undefined
    );
    const waited = waitForLockWait(sql, WRITER, Date.now() + DEADLINE_MS).catch(() => undefined);
    await Promise.race([settled, waited]);
    share.release();
    await share.done;
    const [claimed, result] = await settledWithin([claim, written]);
    return { claimed: value(claimed), result: value(result) };
}

describe.skipIf(!enabled)('claim vs thread writers', () => {
    it('L1: retry of a queued root the claim holds answers not_finished, without a deadlock', async () => {
        const root = await queued();
        const { claimed, result } = await raceWithClaim(root, undefined, () => writer.createRetry(root, ALICE.id));
        expect(result).toBe('not_finished');
        // The retry answered before the holder let go and changed nothing: the claim takes its candidate.
        expect(claimed).toMatchObject({ id: root });
    });

    it('L1b: retry of a terminal member beside a recovering running row answers not_finished, without a deadlock', async () => {
        const terminal = await terminalRoot();
        const recovering = await followUpOf(terminal);
        await mustClaim();
        await expireLease(sql, recovering);
        const { result } = await raceWithClaim(recovering, undefined, () => writer.createRetry(terminal, ALICE.id));
        expect(result).toBe('not_finished');
    });

    it('L2: retry of a queued member of a stopped root answers not_finished, without a deadlock', async () => {
        const root = await queued();
        await plain.stop(root, ALICE.id);
        const member = await followUpOf(root);
        const { claimed, result } = await raceWithClaim(member, undefined, () => writer.createRetry(member, ALICE.id));
        expect(result).toBe('not_finished');
        expect(claimed).toMatchObject({ id: member });
    });

    it('L3: a follow-up of a root stopped while the claim holds it is created, without a deadlock', async () => {
        const root = await queued();
        const { claimed, result } = await raceWithClaim(
            root,
            () => plain.stop(root, ALICE.id),
            () => writer.createFollowUp(root, 'more', ALICE.id)
        );
        if (typeof result === 'string') throw new Error(result);
        expect(result.id).toEqual(expect.any(String));
        // The skipped poll may be followed, in the same call, by the follow-up the writer just committed.
        if (claimed) expect(claimed.id).toBe(result.id);
    });

    it('L4: removing a thread whose queued member the claim holds succeeds, without a deadlock', async () => {
        const root = await terminalRoot();
        const member = await followUpOf(root);
        const { claimed, result } = await raceWithClaim(member, undefined, () => writer.removeThread(root, null));
        expect(result).toMatchObject({ result: 'ok', rootJobId: root });
        expect(claimed).toBeNull();
        const left = await sql<{ id: string }[]>`select id from job where root_job_id = ${root}`;
        expect(left).toEqual([]);
    });

    it('L5: a merged-PR closure of a thread whose queued member the claim holds applies, without a deadlock', async () => {
        const root = await terminalRoot(true);
        const member = await followUpOf(root);
        const { result } = await raceWithClaim(member, undefined, () =>
            writer.closeMergedPr(REPO, PULL, `guid-${randomUUID()}`)
        );
        expect(result).toEqual({ outcome: 'applied', closedRoots: 1 });
        expect(await rowOf(member)).toMatchObject({ status: 'stopped', done_at: expect.any(Date) });
    });

    it('L6: done on a queued member stopped while the claim holds it answers stopped, without a deadlock', async () => {
        const root = await terminalRoot();
        const member = await followUpOf(root);
        const { claimed, result } = await raceWithClaim(
            member,
            () => plain.stop(member, ALICE.id),
            () => writer.markDone(member, null)
        );
        expect(result).toMatchObject({ status: 'stopped', doneAt: expect.any(String) });
        expect(claimed).toBeNull();
    });

    it('L7: a claim skips a queued task whose thread lock is held and takes the next, restoring the skipped one', async () => {
        const skipped = await queued();
        const next = await queued();
        const before = await rowOf(skipped);
        const lock = await holdLock(sql, 'thread', skipped);
        let first: Claim | null;
        try {
            first = await within(plain.claim(WORKER, LEASE_SECONDS));
        } finally {
            await lock.release();
        }
        expect(first?.id).toBe(next);
        expect(await rowOf(skipped)).toEqual(before);
        expect((await plain.claim(WORKER, LEASE_SECONDS))?.id).toBe(skipped);
    });

    it('L8: a takeover of a lost run whose thread lock is held is skipped untouched, then adopts it', async () => {
        const id = await queued();
        const lost = await mustClaim();
        await expireLease(sql, id);
        const before = await rowOf(id);
        const lock = await holdLock(sql, 'thread', id);
        let first: Claim | null;
        try {
            first = await within(plain.claim(WORKER, LEASE_SECONDS));
        } finally {
            await lock.release();
        }
        expect(first).toBeNull();
        expect(await rowOf(id)).toEqual(before);
        expect(before.lease_token).toBe(lost.leaseToken);
        const adopted = await plain.claim(WORKER, LEASE_SECONDS);
        expect(adopted?.id).toBe(id);
        const after = await rowOf(id);
        expect(after.claim_seq).toBe(String(Number(before.claim_seq) + 1));
        expect(after.attempts).toBe(before.attempts);
        expect(after.interruptions).toHaveLength(before.interruptions.length + 1);
    });

    it('L9: retry naming the running follow-up a verdict holds answers not_finished, without a deadlock', async () => {
        const root = await queued();
        const first = await mustClaim();
        await plain.session(root, first.leaseToken, randomUUID());
        await plain.complete(root, first.leaseToken, succeeded);
        const followUp = await followUpOf(root);
        await plain.markDone(root, null);
        const lease = await mustClaim();
        expect(lease.id).toBe(followUp);

        const share = await holder(sql, (tx) => tx`select id from job where id = ${followUp} for share`);
        const verdict = createJobStore({ sql: claimPool, orgId: ORG }).complete(followUp, lease.leaseToken, succeeded);
        await waitForLockWait(sql, CLAIMER, Date.now() + DEADLINE_MS);
        const retry = writer.createRetry(followUp, null);
        await Promise.race([
            retry.then(
                () => undefined,
                () => undefined
            ),
            waitForLockWait(sql, WRITER, Date.now() + DEADLINE_MS).catch(() => undefined),
        ]);
        share.release();
        await share.done;
        const [completed, retried] = await settledWithin([verdict, retry]);
        expect(value(retried)).toBe('not_finished');
        expect(value(completed)).toMatchObject({ result: 'ok' });
    });

    // The insert's snapshot is taken at its statement start, the refusal read is a later statement: a verdict that
    // commits between them must not turn the answer into 'forbidden'. A statement trigger, armed for the writer's
    // backend only, parks the insert after its snapshot until the test lets go.
    async function withVerdictAfterInsertRead<R>(write: () => Promise<R>, verdictOf: () => Promise<unknown>) {
        await sql.unsafe(`
            create function tlo_gate() returns trigger language plpgsql as $$
            begin
                if current_setting('application_name') = '${WRITER}' then
                    perform pg_advisory_lock(${GATE_KEY}::bigint);
                    perform pg_advisory_unlock(${GATE_KEY}::bigint);
                end if;
                return null;
            end $$`);
        await sql`create trigger tlo_gate before insert on job for each statement execute function tlo_gate()`;
        try {
            const gate = await holder(sql, (tx) => tx`select pg_advisory_xact_lock(${GATE_KEY}::bigint)`);
            const retry = write();
            await Promise.race([
                retry.then(
                    () => undefined,
                    () => undefined
                ),
                waitForLockWait(sql, WRITER, Date.now() + DEADLINE_MS),
            ]);
            await within(verdictOf());
            gate.release();
            await gate.done;
            return await retry;
        } finally {
            await sql`drop trigger tlo_gate on job`;
            await sql`drop function tlo_gate()`;
        }
    }

    it('L10: retry of a running task whose verdict commits after the insert read still answers not_finished', async () => {
        const root = await queued();
        const lease = await mustClaim();
        expect(
            await withVerdictAfterInsertRead(
                () => writer.createRetry(root, ALICE.id),
                () => plain.complete(root, lease.leaseToken, succeeded)
            )
        ).toBe('not_finished');
    });

    it('L10b: retry of a terminal root whose running follow-up commits its verdict after the insert read answers not_finished', async () => {
        const root = await terminalRoot();
        const followUp = await followUpOf(root);
        const lease = await mustClaim();
        expect(lease.id).toBe(followUp);
        expect(
            await withVerdictAfterInsertRead(
                () => writer.createRetry(root, ALICE.id),
                () => plain.complete(followUp, lease.leaseToken, succeeded)
            )
        ).toBe('not_finished');
    });

    it('L11: follow-up of a running task whose verdict commits after the insert read answers not_finished', async () => {
        const root = await queued();
        const lease = await mustClaim();
        expect(
            await withVerdictAfterInsertRead(
                () => writer.createFollowUp(root, 'more', ALICE.id),
                () => plain.complete(root, lease.leaseToken, succeeded)
            )
        ).toBe('not_finished');
    });

    it('L11b: follow-up of a terminal root whose running follow-up commits its verdict after the insert read answers not_finished', async () => {
        const root = await terminalRoot();
        const followUp = await followUpOf(root);
        const lease = await mustClaim();
        expect(lease.id).toBe(followUp);
        expect(
            await withVerdictAfterInsertRead(
                () => writer.createFollowUp(root, 'more', ALICE.id),
                () => plain.complete(followUp, lease.leaseToken, succeeded)
            )
        ).toBe('not_finished');
    });
});

/** Fails, instead of hanging, a claim that waits where it must skip. */
async function within<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the claim did not answer before the deadline')), DEADLINE_MS);
    });
    try {
        return await Promise.race([work, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
