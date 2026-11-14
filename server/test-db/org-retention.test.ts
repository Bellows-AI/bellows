import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createArtifactStore } from '../src/artifacts/artifact-store.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { type OrgRetentionDeps, orgRetentionView, runRetentionPass } from '../src/db/org-retention.js';
import { requestPools } from '../src/db/pool.js';
import { createSecretRef } from '../src/secrets/secret-input.js';
import type { SecretIdentity } from '../src/secrets/secret-store.js';
import { testSecretStore } from './env-secrets-harness.js';
import { craftJob, type CraftShape, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The retention pass (`org-retention.ts`, docs/retention.md): each active org's settled threads past its window are
 * deleted whole — secrets, objects, rows — while active and suspended work, audit and usage rows stay; a lower window
 * waits a 30-day notice and a higher one applies at once.
 */
const org = testOrg();
const other = testOrg();
const user = testUser('retention');
const db = useTestDb({ orgs: [org, other], users: [user], max: 6 });
const enabled = Boolean(db.url);

const PREFIX = 'factory/';
const DAY = 1440;
const HOUR = 60;
const bytes = (text: string) => new TextEncoder().encode(text);

let objects: ObjectStore;
let lines: string[];

beforeEach(async () => {
    if (!enabled) return;
    objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'factory-retention-')));
    lines = [];
});

const deps = (over: Partial<OrgRetentionDeps> = {}): OrgRetentionDeps => ({
    sql: db.sql,
    secrets: testSecretStore(db.sql),
    objects,
    prefix: PREFIX,
    planDefaults: { retentionDays: 7 },
    log: (line) => lines.push(line),
    // No writer is in flight here; the drain is pinned by org-retention.fence.test.ts.
    writeDrainMs: 0,
    ...over,
});

/** The org's window as if the pass had already applied it (no notice pending). */
const settle = (orgId: string, days: number) => db.sql`
    insert into org_retention (org_id, effective_days) values (${orgId}, ${days})
    on conflict (org_id) do update set effective_days = excluded.effective_days, pending_days = null, pending_from = null
`;
const push = (orgId: string, days: number) => db.sql`
    insert into org_plan (org_id, plan, version, max_retention_days) values (${orgId}, 'pro', 1, ${days})
    on conflict (org_id) do update set max_retention_days = excluded.max_retention_days
`;

/** A settled one-run thread that finished `finishedMinutesAgo` ago. */
const thread = (orgId: string, finishedMinutesAgo: number, shape: CraftShape = {}) =>
    craftJob(
        { sql: db.sql, org: orgId, author: user.id },
        { status: 'succeeded', createdMinutesAgo: finishedMinutesAgo + HOUR, finishedMinutesAgo, ...shape }
    );
const present = async (id: string) => (await db.sql`select 1 from job where id = ${id}`).length === 1;
const pass = (over: Partial<OrgRetentionDeps> = {}) => runRetentionPass(deps(over));
const ageNotice = (orgId: string, days: number) =>
    db.sql`update org_retention set pending_from = now() - make_interval(days => ${days}) where org_id = ${orgId}`;

async function chunkOf(orgId: string, root: string, job = root): Promise<string> {
    const artifacts = createArtifactStore({ sql: db.sql, orgId, ready: Promise.resolve(), objects, prefix: PREFIX });
    const ref = {
        member: 'member-1',
        root,
        job,
        claimSeq: 1,
        executor: 'claude-code',
        session: randomUUID(),
        stream: 'raw',
    };
    const put = await artifacts.putChunk(ref, 0, bytes('transcript'));
    if (put.result !== 'stored') throw new Error(`seed chunk not stored: ${put.result}`);
    return put.key;
}
const objectsUnder = (orgId: string) => objects.list(`${PREFIX}${orgId}/`);
/** Makes `review` a named-profile review of `of`. */
const reviewOf = (review: string, of: string) => db.sql`
    update job set review_of = ${of}, review_key = ${randomUUID()}, review_profile = 'reviewer', review_spec = '{}',
                   review_revision = 'abc', review_ref = 'refs/heads/main'
    where id = ${review}
`;

describe.skipIf(!enabled)('the window', () => {
    it('expires a Free thread settled just past 7 days and keeps one just inside', async () => {
        await settle(org, 7);
        const past = await thread(org, 7 * DAY + HOUR);
        const inside = await thread(org, 7 * DAY - HOUR);
        await pass();
        expect(await present(past)).toBe(false);
        expect(await present(inside)).toBe(true);
    });

    it('keeps a Pro thread for 180 days', async () => {
        await push(org, 180);
        await settle(org, 180);
        const past = await thread(org, 180 * DAY + HOUR);
        const inside = await thread(org, 179 * DAY);
        await pass();
        expect(await present(past)).toBe(false);
        expect(await present(inside)).toBe(true);
    });

    it('reads the days an Enterprise plan pushed, and applies the longer window at once', async () => {
        await settle(org, 7);
        await push(org, 400);
        const month = await thread(org, 30 * DAY);
        await pass();
        expect(await present(month)).toBe(true);
        const [row] = await db.sql`select effective_days, pending_days from org_retention where org_id = ${org}`;
        expect(row).toEqual({ effective_days: 400, pending_days: null });
        expect(await orgRetentionView(db.sql, org, { retentionDays: 7 })).toEqual({ days: 400, pending: null });
    });

    it('gives an org with no window yet (every org at rollout) the 30-day notice before anything is deleted', async () => {
        const old = await thread(org, 365 * DAY);
        await pass();
        await pass();
        expect(await present(old)).toBe(true);
        const [row] = await db.sql`select effective_days, pending_days from org_retention where org_id = ${org}`;
        expect(row).toEqual({ effective_days: null, pending_days: 7 });
        const audit = await db.sql`
            select actor_kind, detail from audit_event where org_id = ${org} and action = 'org.retention_downgrade'
        `;
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actor_kind: 'system', detail: { fromDays: null, toDays: 7 } });
        const view = await orgRetentionView(db.sql, org, { retentionDays: 7 });
        expect(view.days).toBeNull();
        expect(view.pending?.days).toBe(7);

        await ageNotice(org, 30);
        await pass();
        expect(await present(old)).toBe(false);
    });

    it('applies a downgrade only once its 30-day notice has run', async () => {
        await settle(org, 180);
        const old = await thread(org, 100 * DAY);
        await pass();
        await ageNotice(org, 29);
        await pass();
        expect(await present(old)).toBe(true);
        await ageNotice(org, 30);
        await pass();
        expect(await present(old)).toBe(false);
        const [row] = await db.sql`select effective_days, pending_days from org_retention where org_id = ${org}`;
        expect(row).toEqual({ effective_days: 7, pending_days: null });
    });

    it('expires nothing where no window is set: a self-hosted board with no default', async () => {
        const old = await thread(org, 3650 * DAY);
        await pass({ planDefaults: {} });
        expect(await present(old)).toBe(true);
    });

    it("never applies one org's window to another org's threads", async () => {
        await settle(org, 7);
        await settle(other, 30);
        const mine = await thread(org, 10 * DAY);
        const theirs = await thread(other, 10 * DAY);
        await pass();
        expect(await present(mine)).toBe(false);
        expect(await present(theirs)).toBe(true);
    });
});

describe.skipIf(!enabled)('what never expires', () => {
    it('keeps a thread with an active member, however old its root', async () => {
        await settle(org, 7);
        for (const status of ['queued', 'running'] as const) {
            const root = await thread(org, 30 * DAY);
            await craftJob(
                { sql: db.sql, org, author: user.id },
                { parent: root, status, createdMinutesAgo: 20 * DAY }
            );
            await pass();
            expect(await present(root), status).toBe(true);
        }
    });

    it('deletes nothing of a suspended org, its interrupted runs queued again included', async () => {
        await settle(org, 7);
        const settled = await thread(org, 30 * DAY);
        const interrupted = await craftJob(
            { sql: db.sql, org, author: user.id },
            { status: 'queued', createdMinutesAgo: 30 * DAY }
        );
        await db.sql`update organization set status = 'suspended', operator_status = 'suspended' where id = ${org}`;
        await pass();
        expect(await present(settled)).toBe(true);
        expect(await present(interrupted)).toBe(true);
    });

    it('keeps an old review whose thread is active, and a thread whose review settled inside the window', async () => {
        await settle(org, 7);
        const active = await thread(org, 30 * DAY);
        await craftJob({ sql: db.sql, org, author: user.id }, { parent: active, status: 'running' });
        const oldReview = await thread(org, 30 * DAY);
        await reviewOf(oldReview, active);

        const settled = await thread(org, 30 * DAY);
        const freshReview = await thread(org, DAY);
        await reviewOf(freshReview, settled);
        await pass();
        for (const id of [active, oldReview, settled, freshReview]) expect(await present(id)).toBe(true);
    });

    it('takes a thread’s reviews with it', async () => {
        await settle(org, 7);
        const root = await thread(org, 30 * DAY);
        const review = await thread(org, 29 * DAY);
        await reviewOf(review, root);
        await chunkOf(org, review);
        await pass();
        expect(await present(root)).toBe(false);
        expect(await present(review)).toBe(false);
        expect(await objectsUnder(org)).toEqual([]);
    });
});

describe.skipIf(!enabled)('what is deleted and what is kept', () => {
    it('deletes the thread’s objects, index rows and PR links, queues its volume reclaim, and keeps audit and usage', async () => {
        await settle(org, 7);
        const root = await thread(org, 30 * DAY);
        const follow = await thread(org, 20 * DAY, { parent: root });
        await chunkOf(org, root);
        await chunkOf(org, root, follow);
        await db.sql`
            insert into job_execution (org_id, job_id, claim_seq, root_job_id, created_at)
            values (${org}, ${root}, 1, ${root}, now() - interval '30 days')
        `;
        await db.sql`
            insert into audit_event (org_id, actor_kind, actor_id, action, target, detail)
            values (${org}, 'system', null, 'org.activate', ${org}, '{}')
        `;
        await pass();

        expect(await present(root)).toBe(false);
        expect(await present(follow)).toBe(false);
        expect(await objectsUnder(org)).toEqual([]);
        expect(await db.sql`select 1 from artifact_chunk where org_id = ${org}`).toHaveLength(0);
        expect(await db.sql`select 1 from task_reclaim where org_id = ${org} and root_job_id = ${root}`).toHaveLength(
            1
        );
        const [execution] =
            await db.sql`select removed_at from job_execution where org_id = ${org} and job_id = ${root}`;
        expect(execution?.removed_at).not.toBeNull();
        expect(await db.sql`select 1 from audit_event where org_id = ${org} and action = 'org.activate'`).toHaveLength(
            1
        );
    });

    it('retries a failed object delete, and never reads an unconfirmed list as empty', async () => {
        await settle(org, 7);
        const root = await thread(org, 30 * DAY);
        await chunkOf(org, root);
        const failing: Record<string, Partial<ObjectStore>> = {
            'object-delete-failed': { delete: () => Promise.reject(new Error('store down')) },
            'object-list-failed': { list: () => Promise.resolve(undefined as unknown as string[]) },
        };
        for (const [code, fault] of Object.entries(failing)) {
            await pass({ objects: { ...objects, ...fault } });
            expect(await present(root), code).toBe(true);
            const [stamp] = await db.sql`select last_error from thread_expiry where root_job_id = ${root}`;
            expect(stamp?.last_error).toBe(code);
            expect(lines.at(-1)).toContain(code);
        }
        expect(await objectsUnder(org)).toHaveLength(1);
        await pass();
        expect(await present(root)).toBe(false);
        expect(await objectsUnder(org)).toEqual([]);
    });

    it('retries a failed secret collect, and deletes the thread only once its secret is collected', async () => {
        await settle(org, 7);
        const root = await thread(org, 30 * DAY);
        const store = testSecretStore(db.sql);
        const identity: SecretIdentity = {
            owner: { kind: 'organization', orgId: org },
            scope: { type: 'organization', id: org },
            purpose: 'environment-secret',
            owningRecord: { type: 'job', id: root },
        };
        const ref = createSecretRef();
        const made = await store.create({
            identity,
            ref,
            operationId: await store.issueOperationId(),
            payload: bytes('v'),
        });
        expect(made.ok).toBe(true);

        const down = { ...store, collect: () => Promise.reject(new Error('collector down')) };
        await pass({ secrets: down });
        expect(await present(root)).toBe(true);
        const [stamp] = await db.sql`select last_error from thread_expiry where root_job_id = ${root}`;
        expect(stamp?.last_error).toBe('secret-collect-failed');

        await pass({ secrets: store });
        expect(await present(root)).toBe(false);
        expect(await db.sql`select 1 from secret where ref = ${ref}`).toHaveLength(0);
        expect(await db.sql`select 1 from secret_version where ref = ${ref}`).toHaveLength(0);
    });

    it("expires the org's telemetry older than the window, and no other org's", async () => {
        await settle(org, 7);
        await settle(other, 7);
        const session = randomUUID();
        const foreign = randomUUID();
        await db.sql`insert into telemetry_session_owner (session_id, org_id, created_at)
                     values (${session}, ${org}, now() - interval '30 days')`;
        for (const [id, owner, ageDays] of [
            [session, org, 30],
            [session, org, 1],
            [foreign, null, 30],
        ] as const) {
            await db.sql`
                insert into metric_point (metric, session_id, value, temporality, time, org_id)
                values ('m', ${id}, 1, 'delta', now() - make_interval(days => ${ageDays}), ${owner})
            `;
        }
        await db.sql`
            insert into session_branch (session_id, repo, branch, first_seen, last_seen, org_id)
            values (${session}, 'acme/widgets', 'old', now() - interval '30 days', now() - interval '30 days', ${org}),
                   (${session}, 'acme/widgets', 'new', now() - interval '30 days', now(), ${org})
        `;
        await pass();
        const points = await db.sql<{ session_id: string; days: number }[]>`
            select session_id, extract(day from now() - time)::int as days from metric_point order by days
        `;
        expect(points).toEqual([
            { session_id: session, days: 1 },
            { session_id: foreign, days: 30 },
        ]);
        expect(await db.sql`select branch from session_branch where session_id = ${session}`).toEqual([
            { branch: 'new' },
        ]);
    });
});

describe.skipIf(!enabled)('the pass', () => {
    it('is bounded per org per pass, and the next pass continues', async () => {
        await settle(org, 7);
        const ids = [await thread(org, 30 * DAY), await thread(org, 31 * DAY), await thread(org, 32 * DAY)];
        await pass({ threadsPerPass: 2 });
        expect((await Promise.all(ids.map(present))).filter(Boolean)).toHaveLength(1);
        await pass({ threadsPerPass: 2 });
        expect((await Promise.all(ids.map(present))).filter(Boolean)).toHaveLength(0);
    });

    it('logs one line per org with counts only: no thread id, command or repository', async () => {
        await settle(org, 7);
        const root = await thread(org, 30 * DAY, { command: 'rotate the payroll key', repo: 'acme/payroll' });
        await pass();
        expect(await present(root)).toBe(false);
        const mine = lines.filter((line) => line.includes(org));
        expect(mine).toHaveLength(1);
        for (const secret of [root, 'payroll', 'rotate']) expect(lines.join('\n')).not.toContain(secret);
        const record = JSON.parse(mine[0]!.replace(/^\[retention\] /, ''));
        expect(record).toMatchObject({
            event: 'retention.pass',
            orgId: org,
            days: 7,
            stamped: 1,
            expired: 1,
            errors: [],
        });
    });

    it('never runs under the request role, where a missing org setting reads no rows', async () => {
        await settle(org, 7);
        const old = await thread(org, 30 * DAY);
        const pools = requestPools(
            { databaseUrl: db.url as string, databaseRequestUrl: null },
            { max: 2, statementTimeoutMs: 10_000 }
        );
        try {
            await pass({ sql: pools.request });
        } finally {
            await Promise.all([pools.request, pools.secrets, pools.owner].map((p) => p.end({ timeout: 5 })));
        }
        expect(await present(old)).toBe(true);
        expect(lines).toEqual([expect.stringContaining('retention.refused')]);
    });

    it('deletes a draft batch left untouched past the window', async () => {
        await settle(org, 7);
        const [draft] = await db.sql<{ id: string }[]>`
            insert into batch (org_id, plan_version, title, policy, concurrency, updated_at)
            values (${org}, 1, 'draft', 'human', 1, now() - interval '30 days') returning id
        `;
        await pass();
        expect(await db.sql`select 1 from batch where id = ${draft!.id}`).toHaveLength(0);
    });
});
