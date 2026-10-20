import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { EvidencePolicy, RecordedEvidence } from '../src/db/evidence-policy.js';
import { createJobStore } from '../src/db/job-store.js';
import { reviewRefOf } from '../src/db/job-store-reviews.js';
import type { Claim, JobStore, ReviewerSpec } from '../src/db/job-store-types.js';
import { REVIEW_BLOCKERS_MARKER, REVIEW_VERDICT_MARKER } from '../src/db/workflow-templates.js';
import { useTestDb } from './harness.js';
import { randomGithubId, spendInterruptionBudget, testOrg } from './fixtures.js';

/** Independent reviewer invocation (issue #549) on a real database: the SQL is what is under test. */

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
const ORG = testOrg();
/** A well-formed lease token no claim holds. */
const STALE_LEASE = randomUUID();
const LEASE_SECONDS = 300;
const REVIEWED = 'h:2';
const INBAND = new URL('../migrations/077_review_inband.sql', import.meta.url);

const db = useTestDb({ max: 4 });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
});

let accounts = 0;
const account = async (): Promise<string> => {
    accounts += 1;
    const [row] = await sql<{ id: string }[]>`
        insert into app_user (github_user_id, github_login)
        values (${randomGithubId()}, ${`reviews-${accounts}`})
        on conflict (github_user_id) do update set github_login = excluded.github_login
        returning id
    `;
    return row!.id;
};

const SECURITY: ReviewerSpec = {
    name: 'security',
    instructions: 'Look for injection and leaked secrets.',
    timeoutMinutes: 7,
    connections: ['JIRA_TOKEN'],
};

const MEMBER_ENV = { JIRA_TOKEN: 'jira', AWS_SECRET: 'aws', GITHUB_TOKEN: 'member-pat' };

/** A store whose plan reader answers the repository's policy and profiles from memory. */
const storeWith = (declared: { policy?: EvidencePolicy; reviewers?: ReviewerSpec[] } = {}): JobStore =>
    createJobStore({
        sql,
        orgId: ORG,
        plan: {
            readFor: async () => ({
                config: null,
                error: null,
                services: [],
                revision: null,
                ...(declared.policy ? { policy: declared.policy } : {}),
                ...(declared.reviewers ? { reviewers: declared.reviewers } : {}),
            }),
        },
        env: { resolveFor: async () => MEMBER_ENV },
        githubApp: true,
    });

const rowOf = async (id: string) => {
    const [row] = await sql<
        {
            id: string;
            root_job_id: string;
            status: string;
            failure_kind: string | null;
            output: string | null;
            cancel_requested_at: Date | null;
            review_of: string | null;
            review_revision: string | null;
            review_caller_seq: string | null;
            claimed_by: string | null;
            lease_token: string | null;
            session_id: string | null;
            reviewers: unknown;
        }[]
    >`select id, root_job_id, status, failure_kind, output, cancel_requested_at, review_of, review_revision,
             review_caller_seq, claimed_by, lease_token, session_id, reviewers
      from job where org_id = ${ORG} and id = ${id}`;
    return row!;
};

const reviewRows = (callerId: string) =>
    sql<{ id: string; status: string }[]>`
        select id, status from job where org_id = ${ORG} and review_of = ${callerId} order by created_at, id
    `;

/** Creates and claims one objective job, returning the lease. */
async function claimed(store: JobStore): Promise<Claim> {
    const created = await store.create('ship it', await account(), { repo: 'acme/web', executor: null });
    if (typeof created === 'string') throw new Error(`create refused: ${created}`);
    const claim = await store.claim('driver-1', LEASE_SECONDS);
    expect(claim?.id).toBe(created.id);
    return claim!;
}

const ask = (caller: Claim, key = 'sec-1', over: Partial<{ profile: string; ref: string }> = {}) =>
    storeWith({ reviewers: [SECURITY] }).requestReview(caller.id, caller.leaseToken, {
        key,
        profile: over.profile ?? 'security',
        revision: REVIEWED,
        ref: over.ref ?? reviewRefOf(caller.id, key),
    });

/** The live claim of the caller's review under `key` (a replay hands it back), settled with `output`. */
async function reviewRuns(
    store: JobStore,
    caller: Claim,
    output: string,
    over: { status?: 'succeeded' | 'failed'; key?: string } = {}
) {
    const { status = 'succeeded', key = 'sec-1' } = over;
    const asked = await ask(caller, key);
    if (!('claim' in asked) || !asked.claim) throw new Error('no live review claim');
    const claim = asked.claim;
    await store.complete(claim.id, claim.leaseToken, { status, exitCode: status === 'succeeded' ? 0 : 1, output });
    return claim;
}

const completeCaller = (store: JobStore, caller: Claim, treeAfter: string) =>
    store.complete(caller.id, caller.leaseToken, {
        status: 'succeeded',
        exitCode: 0,
        output: 'done',
        evidence: { treeBefore: 'h:1', treeAfter, gates: 'none' } as RecordedEvidence,
    });

describe.runIf(enabled)('named reviewer invocation on the job store', () => {
    it('stamps the declared profiles on the caller’s row at every claim, and none when none are declared', async () => {
        const declared = await claimed(storeWith({ reviewers: [SECURITY] }));
        expect((await rowOf(declared.id)).reviewers).toEqual([SECURITY]);
        const bare = await claimed(storeWith());
        expect((await rowOf(bare.id)).reviewers).toBeNull();
    });

    it('creates a review as a thread of its own, already leased to its caller, and bound to the revision', async () => {
        const caller = await claimed(storeWith({ reviewers: [SECURITY] }));
        const asked = await ask(caller);
        expect(asked.result).toBe('created');
        if (!('review' in asked)) throw new Error('no review');
        expect(asked.review).toMatchObject({
            key: 'sec-1',
            profile: 'security',
            status: 'running',
            verdict: 'none',
            revision: REVIEWED,
        });
        const row = await rowOf(asked.review.id);
        expect(row).toMatchObject({
            review_of: caller.id,
            review_revision: REVIEWED,
            status: 'running',
            claimed_by: 'driver-1',
            review_caller_seq: String(caller.claimSeq),
        });
        expect(row.root_job_id).toBe(row.id);
        expect(row.root_job_id).not.toBe(caller.rootJobId);
    });

    it('never offers a requested review to the open queue', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        await ask(caller);
        expect(await store.claim('driver-2', LEASE_SECONDS)).toBeNull();
        // Not even once its lease has lapsed: only the caller's next claim leases it again.
        await sql`update job set lease_expires_at = now() - interval '1 minute' where org_id = ${ORG} and review_of = ${caller.id}`;
        expect(await store.claim('driver-2', LEASE_SECONDS)).toBeNull();
    });

    it('hands the caller the repository’s reviewer profiles by name, and none when none are declared', async () => {
        const declared = await claimed(storeWith({ reviewers: [SECURITY] }));
        expect(declared.reviewerProfiles).toEqual(['security']);
        const bare = await claimed(storeWith());
        expect(bare.reviewerProfiles).toBeUndefined();
    });

    it('answers the stored review for a repeated key — a retried or reclaimed caller never starts a second', async () => {
        const caller = await claimed(storeWith({ reviewers: [SECURITY] }));
        const first = await ask(caller);
        const again = await ask(caller);
        expect(again.result).toBe('existing');
        if (!('review' in first) || !('review' in again)) throw new Error('no review');
        expect(again.review.id).toBe(first.review.id);
        expect(await reviewRows(caller.id)).toHaveLength(1);
        // A response lost in flight: the same caller claim gets the SAME live claim, not a new lease.
        expect(again.claim).toBeDefined();
        expect(again.claim).toEqual(first.claim);
        await reviewRuns(storeWith({ reviewers: [SECURITY] }), caller, `ok\n${REVIEW_VERDICT_MARKER}`);
        await ask(caller, 'sec-2');
        expect(await reviewRows(caller.id)).toHaveLength(2);
    });

    it('refuses an undeclared profile, a ref outside the thread’s snapshot namespace, and a lost lease', async () => {
        const caller = await claimed(storeWith({ reviewers: [SECURITY] }));
        expect(await ask(caller, 'k', { profile: 'style' })).toEqual({ result: 'unknown_profile' });
        expect(await ask(caller, 'k', { ref: 'refs/heads/main' })).toEqual({ result: 'invalid_ref' });
        const lost = await storeWith({ reviewers: [SECURITY] }).requestReview(caller.id, STALE_LEASE, {
            key: 'k',
            profile: 'security',
            revision: REVIEWED,
            ref: reviewRefOf(caller.id, 'k'),
        });
        expect(lost).toEqual({ result: 'lost' });
        expect(await reviewRows(caller.id)).toHaveLength(0);
    });

    it('answers a created review with its claim, leased under its own token and carrying only what the profile grants', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        // No GitHub token either way: the App's is the runner's to obtain (docs/connections.md).
        expect(caller.env).toEqual({ AWS_SECRET: 'aws', JIRA_TOKEN: 'jira' });
        const asked = await ask(caller);
        if (!('review' in asked) || !asked.claim) throw new Error('no review claim');

        const review = asked.claim;
        expect(review).toMatchObject({
            id: asked.review.id,
            publish: false,
            reviewRun: { profile: 'security', ref: reviewRefOf(caller.id, 'sec-1'), timeoutMinutes: 7 },
        });
        expect(review.leaseToken).not.toBe(caller.leaseToken);
        expect((await rowOf(asked.review.id)).lease_token).toBe(review.leaseToken);
        // The caller's access does not follow: only the granted connection, no token of any kind.
        expect(review.env).toEqual({ JIRA_TOKEN: 'jira' });
        expect(review.gates).toBeUndefined();
        expect(review.policy).toBeUndefined();
        expect(review.helperPlans).toBeUndefined();
        expect(review.reviewerProfiles).toBeUndefined();
        expect(review.masterPrompt).toContain('independent reviewer');
        expect(review.masterPrompt).toContain(SECURITY.instructions);
        expect((await rowOf(caller.id)).status).toBe('running');
    });

    it('refuses a second key while one review runs, and reading the first still works', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        await ask(caller, 'a');
        expect(await ask(caller, 'b')).toMatchObject({ result: 'running', review: { key: 'a' } });
        expect(await ask(caller, 'b')).not.toHaveProperty('claim');
        expect(await reviewRows(caller.id)).toHaveLength(1);
        expect(await store.readReview(caller.id, caller.leaseToken, 'a')).toMatchObject({
            result: 'ok',
            review: { key: 'a', status: 'running' },
        });
        await reviewRuns(store, caller, `ok\n${REVIEW_VERDICT_MARKER}`, { key: 'a' });
        expect((await ask(caller, 'b')).result).toBe('created');
    });

    it('re-leases a running review to the caller’s next claim and hands back its session', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        const first = await ask(caller);
        if (!('claim' in first) || !first.claim) throw new Error('no review claim');
        await sql`update job set session_id = 'review-session' where org_id = ${ORG} and id = ${first.review.id}`;
        await sql`update job set lease_expires_at = now() - interval '1 minute' where org_id = ${ORG} and id = ${caller.id}`;
        const reclaimed = await store.claim('driver-2', LEASE_SECONDS);
        expect(reclaimed?.id).toBe(caller.id);

        const again = await ask(reclaimed!);
        expect(again.result).toBe('existing');
        if (!('claim' in again) || !again.claim) throw new Error('no review claim');
        expect(again.claim.id).toBe(first.review.id);
        expect(again.claim.leaseToken).not.toBe(first.claim.leaseToken);
        expect(again.claim.claimSeq).toBe(first.claim.claimSeq + 1);
        expect(again.claim).toMatchObject({ resumeSessionId: 'review-session', continuesInterrupted: true });
        expect(await rowOf(first.review.id)).toMatchObject({
            claimed_by: 'driver-2',
            review_caller_seq: String(reclaimed!.claimSeq),
        });
        // The lease the lost supervisor held is dead.
        expect((await store.heartbeat(first.review.id, first.claim.leaseToken, LEASE_SECONDS)).result).not.toBe('ok');
        expect((await store.heartbeat(first.review.id, again.claim.leaseToken, LEASE_SECONDS)).result).toBe('ok');
        // And the new caller claim's replay is the new lease, not a third one.
        const replay = await ask(reclaimed!);
        expect('claim' in replay && replay.claim?.leaseToken).toBe(again.claim.leaseToken);
    });

    it('re-leases a running review to the caller’s next claim when it is READ, so a different key can never strand it', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        const first = await ask(caller);
        if (!('claim' in first) || !first.claim) throw new Error('no review claim');
        await sql`update job set lease_expires_at = now() - interval '1 minute' where org_id = ${ORG} and id = ${caller.id}`;
        const reclaimed = await store.claim('driver-2', LEASE_SECONDS);
        expect(reclaimed?.id).toBe(caller.id);

        const read = await store.readReview(reclaimed!.id, reclaimed!.leaseToken, 'sec-1');
        if (read.result !== 'ok' || !read.claim) throw new Error('no review claim on the read');
        expect(read.claim.id).toBe(first.review.id);
        expect(read.claim.leaseToken).not.toBe(first.claim.leaseToken);
        expect(await rowOf(first.review.id)).toMatchObject({ review_caller_seq: String(reclaimed!.claimSeq) });
        // A second read of this claim is the same lease, and a finished review carries none.
        const replay = await store.readReview(reclaimed!.id, reclaimed!.leaseToken, 'sec-1');
        expect('claim' in replay && replay.claim?.leaseToken).toBe(read.claim.leaseToken);
        await reviewRuns(store, reclaimed!, `ok\n${REVIEW_VERDICT_MARKER}`);
        expect(await store.readReview(reclaimed!.id, reclaimed!.leaseToken, 'sec-1')).not.toHaveProperty('claim');
    });

    it('answers a finished review from its row, with no claim', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        await ask(caller);
        await reviewRuns(store, caller, `ok\n${REVIEW_VERDICT_MARKER}`);
        const again = await ask(caller);
        expect(again).toMatchObject({ result: 'existing', review: { status: 'succeeded', verdict: 'clean' } });
        expect(again).not.toHaveProperty('claim');
    });

    it('stores a timeout on the review row as its failure kind', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        const asked = await ask(caller);
        if (!('claim' in asked) || !asked.claim) throw new Error('no review claim');
        await store.complete(asked.claim.id, asked.claim.leaseToken, {
            status: 'failed',
            exitCode: 124,
            output: 'timed out',
            failureKind: 'timeout',
        });
        expect(await rowOf(asked.claim.id)).toMatchObject({ status: 'failed', failure_kind: 'timeout' });
    });

    it('migration 077 fails a review that was still queued, and leaves a running one alone', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        const live = await ask(caller);
        if (!('review' in live)) throw new Error('no review');
        const orphan = randomUUID();
        await sql`
            insert into job (org_id, command, id, root_job_id, mode, review_of, review_key, review_profile,
                             review_spec, review_revision, review_ref)
            values (${ORG}, 'review it', ${orphan}, ${orphan}, 'objective', ${caller.id}, 'old', 'security',
                    ${sql.json(SECURITY as never)}, ${REVIEWED}, ${reviewRefOf(caller.id, 'old')})
        `;
        await sql.unsafe(readFileSync(INBAND, 'utf8'));
        expect(await rowOf(orphan)).toMatchObject({ status: 'failed', lease_token: null });
        expect((await rowOf(live.review.id)).status).toBe('running');
    });

    it('reads the verdict by key with the thread’s review evidence: running is incomplete, clean at the revision approves', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        await ask(caller);
        const queued = await store.readReview(caller.id, caller.leaseToken, 'sec-1');
        expect(queued).toMatchObject({
            result: 'ok',
            review: { status: 'running', verdict: 'none', evidence: { state: 'incomplete' } },
        });

        await reviewRuns(store, caller, `no issues\n${REVIEW_VERDICT_MARKER}`);
        expect(await store.readReview(caller.id, caller.leaseToken, 'sec-1')).toMatchObject({
            result: 'ok',
            review: {
                status: 'succeeded',
                verdict: 'clean',
                findings: `no issues\n${REVIEW_VERDICT_MARKER}`,
                evidence: { state: 'approved', revision: REVIEWED },
            },
        });
        expect(await store.readReview(caller.id, caller.leaseToken, 'nope')).toEqual({ result: 'unknown' });
    });

    it('queues no reclaim when a review settles: its files leave with its caller thread’s', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        const asked = await ask(caller);
        if (!('claim' in asked) || !asked.claim) throw new Error('no review claim');
        const done = await store.complete(asked.claim.id, asked.claim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: `ok\n${REVIEW_VERDICT_MARKER}`,
        });
        expect(done).toEqual({ result: 'ok', threadDone: false, reclaimId: null });
        const reclaims =
            await sql`select 1 from task_reclaim where org_id = ${ORG} and root_job_id = ${asked.claim.id}`;
        expect(reclaims).toHaveLength(0);
        expect((await rowOf(caller.id)).status).toBe('running');
    });

    it('reads blockers as a rejection, and a failed run as no verdict at all', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        await ask(caller);
        await reviewRuns(store, caller, `1. a.ts: injection\n${REVIEW_BLOCKERS_MARKER}`);
        expect(await store.readReview(caller.id, caller.leaseToken, 'sec-1')).toMatchObject({
            review: { verdict: 'blockers', evidence: { state: 'rejected' } },
        });
        await reviewRuns(store, caller, `crashed\n${REVIEW_VERDICT_MARKER}`, { status: 'failed', key: 'sec-2' });
        expect(await store.readReview(caller.id, caller.leaseToken, 'sec-2')).toMatchObject({
            review: { status: 'failed', verdict: 'none', evidence: { state: 'incomplete' } },
        });
    });

    describe('a required review', () => {
        const required = { policy: { review: true } as EvidencePolicy, reviewers: [SECURITY] };

        it('lets the caller complete once the review approved the revision the work ends on', async () => {
            const store = storeWith(required);
            const caller = await claimed(store);
            await ask(caller);
            await reviewRuns(store, caller, `fine\n${REVIEW_VERDICT_MARKER}`);
            await completeCaller(store, caller, REVIEWED);
            expect(await rowOf(caller.id)).toMatchObject({ status: 'succeeded', failure_kind: null });
        });

        it('refuses the completion while the review is unfinished — the verdict stops it, and a stopped review never approves', async () => {
            const store = storeWith(required);
            const caller = await claimed(store);
            await ask(caller);
            await completeCaller(store, caller, REVIEWED);
            const row = await rowOf(caller.id);
            expect(row).toMatchObject({ status: 'failed', failure_kind: 'policy' });
            expect(row.output).toContain('unfinished, failed or cancelled');
        });

        it('refuses an approval of a revision the work moved past', async () => {
            const store = storeWith(required);
            const caller = await claimed(store);
            await ask(caller);
            await reviewRuns(store, caller, `fine\n${REVIEW_VERDICT_MARKER}`);
            await completeCaller(store, caller, 'h:3-edited-after-review');
            const row = await rowOf(caller.id);
            expect(row).toMatchObject({ status: 'failed', failure_kind: 'policy' });
            expect(row.output).toContain('assessed a different revision');
        });

        it('refuses when profiles are declared and none was ever asked for, with the missing-review reason', async () => {
            const store = storeWith(required);
            const caller = await claimed(store);
            await completeCaller(store, caller, REVIEWED);
            expect((await rowOf(caller.id)).output).toContain('a review is required and none has run');
        });
    });

    describe('cancellation and cleanup', () => {
        it('stamps a running review for its heartbeat to deliver on the caller’s Stop, and stops one whose lease lapsed', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            const live = await ask(caller, 'live');
            if (!('review' in live)) throw new Error('no review');
            expect(await store.stop(caller.id, null)).toMatchObject({ result: 'requested' });
            expect(await rowOf(live.review.id)).toMatchObject({ status: 'running' });
            expect((await rowOf(live.review.id)).cancel_requested_at).not.toBeNull();

            const other = await claimed(store);
            const lapsed = await ask(other, 'lapsed');
            if (!('review' in lapsed)) throw new Error('no review');
            await sql`update job set lease_expires_at = now() - interval '1 minute' where org_id = ${ORG} and id = ${lapsed.review.id}`;
            await store.stop(other.id, null);
            expect(await rowOf(lapsed.review.id)).toMatchObject({ status: 'stopped', cancel_requested_at: null });
        });

        it('stamps the reviews still open when the caller’s verdict lands', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            const asked = await ask(caller);
            if (!('review' in asked)) throw new Error('no review');
            await completeCaller(store, caller, REVIEWED);
            expect((await rowOf(asked.review.id)).cancel_requested_at).not.toBeNull();
        });

        it('stops them when the caller is retired dead, so none is orphaned', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            await ask(caller);
            await spendInterruptionBudget(sql, caller.id);
            await sql`
                update job set lease_expires_at = now() - interval '1 minute', attempts = max_attempts
                where org_id = ${ORG} and id = ${caller.id}
            `;
            await store.claim('driver-9', LEASE_SECONDS);
            expect((await rowOf(caller.id)).status).toBe('dead');
            const [review] = await reviewRows(caller.id);
            expect((await rowOf(review!.id)).cancel_requested_at).not.toBeNull();
        });

        it('keeps a review across a caller reclaim, and the re-asked key finds it', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            const first = await ask(caller);
            await sql`update job set lease_expires_at = now() - interval '1 minute' where org_id = ${ORG} and id = ${caller.id}`;
            const reclaimed = await store.claim('driver-2', LEASE_SECONDS);
            expect(reclaimed?.id).toBe(caller.id);
            const again = await ask(reclaimed!);
            if (!('review' in first) || !('review' in again)) throw new Error('no review');
            expect(again.review.id).toBe(first.review.id);
            expect(await reviewRows(caller.id)).toHaveLength(1);
        });

        it('is not a task once settled: out of the terminal list, and no follow-up or retry runs it as an ordinary job', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            await ask(caller);
            const review = await reviewRuns(store, caller, `fine\n${REVIEW_VERDICT_MARKER}`);
            const [row] = await sql<{ created_by: string }[]>`
                select created_by from job where org_id = ${ORG} and id = ${review.id}
            `;
            await completeCaller(store, caller, REVIEWED);

            const settled = await store.list({ status: 'terminal', limit: 50 });
            expect(settled.map((job) => job.id)).not.toContain(review.id);
            expect(settled.map((job) => job.rootJobId)).toContain(caller.rootJobId);

            expect(await store.createFollowUp(review.id, 'again', row!.created_by)).not.toHaveProperty('id');
            expect(await store.createRetry(review.id, row!.created_by)).not.toHaveProperty('id');
            const [members] = await sql<{ count: number }[]>`
                select count(*)::int as count from job where org_id = ${ORG} and root_job_id = ${review.id}
            `;
            expect(members?.count).toBe(1);
        });

        it('keeps reviews out of the task list, and removes them with their thread', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            const asked = await ask(caller);
            if (!('review' in asked)) throw new Error('no review');
            const { page } = await store.listTasks({ state: 'running', sort: 'newest', limit: 10 });
            expect(page.items.map((task) => task.id)).toEqual([caller.rootJobId]);

            // The review settles first: a running one is stamped, and a stamped one keeps its thread.
            await reviewRuns(store, caller, `fine\n${REVIEW_VERDICT_MARKER}`);
            await completeCaller(store, caller, REVIEWED);
            expect(await store.removeThread(caller.id, null)).toMatchObject({ result: 'ok' });
            expect(await reviewRows(caller.id)).toEqual([]);
            const reclaims = await sql<{ root_job_id: string }[]>`
                select root_job_id from task_reclaim where org_id = ${ORG} order by created_at, id
            `;
            expect(reclaims.map((row) => row.root_job_id).sort()).toEqual([caller.rootJobId, asked.review.id].sort());
        });
    });
});
