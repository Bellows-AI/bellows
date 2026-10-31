import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { effectiveAttachments } from '../src/db/jobs/job-store-attachments.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import { insertWorkflowSuccessor } from '../src/db/jobs/job-store-rows.js';
import type { Claim, JobStore, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { testOrg, testUser, withoutTransitionGuard } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The claim's attachment manifest: what a run is told it carries is computed at read, from the thread root and the
 * created_at of the row (a review inherits the row it reviews), so a retry, a takeover and a late follow-up all agree.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('manifest-alice');
const WORKER = 'manifest-worker';
const LEASE_SECONDS = 60;
const SMALL = 512;
const db = useTestDb({ orgs: [ORG], users: [ALICE], max: 8 });

const SECURITY: ReviewerSpec = { name: 'security', instructions: 'Look.', timeoutMinutes: 7, connections: [] };

let sql: Sql;
let store: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({
        sql,
        orgId: ORG,
        plan: {
            readFor: async () => ({ config: null, error: null, services: [], revision: null, reviewers: [SECURITY] }),
        },
        githubApp: true,
    });
});

/** One ready file, written directly: the upload path has its own tests. */
const file = async (name = 'notes.txt'): Promise<{ id: string; name: string; sha256: string }> => {
    const id = randomUUID();
    const sha256 = randomUUID().replaceAll('-', '').padEnd(64, '0');
    await sql`
        insert into input_attachment (org_id, id, uploader_id, name, media_type, size_bytes, sha256, object_key, state)
        values (${ORG}, ${id}, ${ALICE.id}, ${name}, 'text/plain', ${SMALL}, ${sha256}, ${`k/${id}`}, 'ready')
    `;
    return { id, name, sha256 };
};

const claimNext = async (): Promise<Claim> => {
    const claim = await store.claim(WORKER, LEASE_SECONDS);
    if (!claim) throw new Error('nothing to claim');
    return claim as Claim;
};

const finish = (claim: Claim) =>
    store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });

const unwrap = <T extends { id: string }>(ref: T | string): T => {
    if (typeof ref === 'string') throw new Error(ref);
    return ref;
};

/** A claimed, finished root that carried `files`. */
const finishedRoot = async (files: { id: string }[]) => {
    const root = unwrap(
        await store.create('do the work', ALICE.id, {
            repo: 'acme/web',
            executor: null,
            attachmentIds: files.map((f) => f.id),
        })
    );
    const claim = await claimNext();
    expect(claim.id).toBe(root.id);
    await finish(claim);
    return { root, claim };
};

const followUp = async (rootId: string, files: { id: string }[]) =>
    unwrap(
        await store.createFollowUp(
            rootId,
            'again',
            ALICE.id,
            undefined,
            [],
            files.map((f) => f.id)
        )
    );

const manifest = (origin: string, f: { id: string; name: string; sha256: string }) => ({
    id: f.id,
    name: f.name,
    mediaType: 'text/plain',
    size: SMALL,
    sha256: f.sha256,
    originJobId: origin,
});

describe.runIf(enabled)('the claim attachment manifest', () => {
    it('hands the root its own files, in the order named', async () => {
        const [a, b] = [await file('a.txt'), await file('b.txt')];
        const root = unwrap(
            await store.create('do the work', ALICE.id, {
                repo: 'acme/web',
                executor: null,
                attachmentIds: [b.id, a.id],
            })
        );

        const claim = await claimNext();

        expect(claim.id).toBe(root.id);
        expect(claim.attachments).toEqual([manifest(root.id, b), manifest(root.id, a)]);
        await finish(claim);
    });

    it('hands a task without files an empty manifest', async () => {
        unwrap(await store.create('plain', ALICE.id, { repo: 'acme/web', executor: null }));
        const claim = await claimNext();
        expect(claim.attachments).toEqual([]);
        await finish(claim);
    });

    it('hands a follow-up the root files then its own, each naming the task that carried it', async () => {
        const [rootFile, own] = [await file('root.txt'), await file('own.txt')];
        const { root } = await finishedRoot([rootFile]);

        const next = await followUp(root.id, [own]);
        const claim = await claimNext();

        expect(claim.id).toBe(next.id);
        expect(claim.attachments).toEqual([manifest(root.id, rootFile), manifest(next.id, own)]);
        await finish(claim);
    });

    it('hands a retry of the follow-up the identical set', async () => {
        const [rootFile, own] = [await file(), await file()];
        const { root } = await finishedRoot([rootFile]);
        const next = await followUp(root.id, [own]);
        const first = await claimNext();
        await store.complete(first.id, first.leaseToken, { status: 'failed', exitCode: 1, output: 'no' });

        const retry = unwrap(await store.createRetry(next.id, ALICE.id));
        const second = await claimNext();

        expect(second.id).toBe(retry.id);
        expect(second.attachments).toEqual(first.attachments);
        expect(second.attachments.map((a) => a.sha256)).toEqual([rootFile.sha256, own.sha256]);
        await finish(second);
    });

    it('hands a workflow successor everything bound up to its own created_at', async () => {
        const [rootFile, own] = [await file(), await file()];
        const { root } = await finishedRoot([rootFile]);
        const next = await followUp(root.id, [own]);
        await finish(await claimNext());

        const successor = await sql.begin((tx) =>
            insertWorkflowSuccessor(tx, {
                orgId: ORG,
                command: 'next',
                createdBy: ALICE.id,
                repo: null,
                executor: null,
                executorScope: 'user',
                parentJobId: next.id,
                sessionId: null,
                rootJobId: root.id,
                workflowId: null,
                workflowName: null,
                workflowNode: 'n',
            })
        );
        const claim = await claimNext();

        expect(claim.id).toBe(successor);
        expect(claim.attachments).toEqual([manifest(root.id, rootFile), manifest(next.id, own)]);
        await finish(claim);
    });

    it('does not let a later follow-up change a re-claim of the earlier row', async () => {
        const [rootFile, later] = [await file(), await file()];
        const { root } = await finishedRoot([rootFile]);
        await followUp(root.id, [later]);
        // The earlier row is back in line, as after a takeover.
        await withoutTransitionGuard(
            sql,
            (tx) => tx`update job set status = 'queued', lease_token = null, lease_expires_at = now()
                       where org_id = ${ORG} and id = ${root.id}`
        );

        const reclaim = await claimNext();

        expect(reclaim.id).toBe(root.id);
        expect(reclaim.attachments).toEqual([manifest(root.id, rootFile)]);
        await finish(reclaim);
        await finish(await claimNext());
    });

    it('drops the files of a removed thread, never answering for them', async () => {
        const f = await file();
        const { root } = await finishedRoot([f]);
        expect(await effectiveAttachments(sql, ORG, root.id)).toHaveLength(1);

        await sql`update input_attachment set state = 'deleting' where org_id = ${ORG} and id = ${f.id}`;

        expect(await effectiveAttachments(sql, ORG, root.id)).toEqual([]);
    });
});

describe.runIf(enabled)('the review claim attachment manifest', () => {
    /** The caller's review claim: the caller must be running, so it is claimed first. */
    const reviewOf = async (callerId: string, callerClaim: Claim, key: string) => {
        const asked = await store.requestReview(callerId, callerClaim.leaseToken, {
            key,
            profile: 'security',
            revision: 'h:2',
            ref: reviewRefOf(callerId, key),
        });
        if (!('claim' in asked) || !asked.claim) throw new Error('no live review claim');
        return asked.claim;
    };

    it('hands a review of a follow-up exactly the follow-up set', async () => {
        const [rootFile, own] = [await file(), await file()];
        const { root } = await finishedRoot([rootFile]);
        const next = await followUp(root.id, [own]);
        const caller = await claimNext();
        expect(caller.id).toBe(next.id);

        const review = await reviewOf(caller.id, caller, 'k1');

        expect(review.attachments).toEqual([manifest(root.id, rootFile), manifest(next.id, own)]);
        await store.complete(review.id, review.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
        await finish(caller);
    });

    it('hands a review of the root only the root files, whatever a later follow-up adds', async () => {
        const [rootFile, later] = [await file(), await file()];
        const created = unwrap(
            await store.create('do the work', ALICE.id, {
                repo: 'acme/web',
                executor: null,
                attachmentIds: [rootFile.id],
            })
        );
        const caller = await claimNext();
        const review = await reviewOf(caller.id, caller, 'k2');
        expect(review.attachments).toEqual([manifest(created.id, rootFile)]);
        await store.complete(review.id, review.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
        await finish(caller);

        await followUp(created.id, [later]);

        expect(await effectiveAttachments(sql, ORG, review.id)).toEqual([expect.objectContaining({ id: rootFile.id })]);
        await finish(await claimNext());
    });

    it('fails the read, rather than answering empty, when the reviewed row is missing', async () => {
        const f = await file();
        const created = unwrap(
            await store.create('do the work', ALICE.id, { repo: 'acme/web', executor: null, attachmentIds: [f.id] })
        );
        const caller = await claimNext();
        const review = await reviewOf(created.id, caller, 'k3');
        await sql`update job set review_of = ${randomUUID()} where org_id = ${ORG} and id = ${review.id}`;

        await expect(effectiveAttachments(sql, ORG, review.id)).rejects.toThrow();
        await expect(effectiveAttachments(sql, ORG, randomUUID())).rejects.toThrow();
        await sql`update job set review_of = ${created.id} where org_id = ${ORG} and id = ${review.id}`;
        await store.complete(review.id, review.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
        await finish(caller);
    });
});
