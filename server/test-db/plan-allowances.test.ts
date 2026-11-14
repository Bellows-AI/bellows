import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_CAUSE, createArtifactStore } from '../src/artifacts/artifact-store.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { createAttachmentRows } from '../src/attachments/attachment-rows.js';
import { createAttachmentStore } from '../src/attachments/attachment-store.js';
import { createBatchStore } from '../src/db/batches/batch-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { PlanLimitError, type PlanLimits } from '../src/db/plan-limits.js';
import type { MetricRow } from '../src/telemetry/otlp.js';
import { createPostgresStore } from '../src/telemetry/store.js';
import { batchPlan, prTask } from './batch-fixtures.js';
import { craftJob, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The spend and storage allowances a plan sets (docs/commerce.md): tokens an organization's runs reported this
 * period refuse its new tasks once they reach the allowance, naming `tokens`; stored files and run logs past the
 * storage allowance refuse an upload, naming `storage`. A plan with neither stays unlimited.
 */

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const OTHER_ORG = testOrg();
const MEMBER = testUser('allowance-member');
const LEASE_SECONDS = 300;

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [MEMBER] });
let sql: Sql;
let objects: ObjectStore;
beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'allowances-')));
});

const pushPlan = (
    org: string,
    limits: { tokens?: number; storageBytes?: number; periodStart?: Date | null; periodEnd?: Date | null }
) => sql`
    insert into org_plan (org_id, plan, version, max_tokens, max_storage_bytes, period_start, period_end)
    values (${org}, 'pro', 1, ${limits.tokens ?? null}, ${limits.storageBytes ?? null},
            ${limits.periodStart ?? null}, ${limits.periodEnd ?? null})
`;

const jobsOf = (org: string, planDefaults: PlanLimits = {}) => createJobStore({ sql, orgId: org, planDefaults });
const create = (org: string, planDefaults: PlanLimits = {}) =>
    jobsOf(org, planDefaults).create('work', null, { repo: null, executor: null });

const tokenRow = (over: Partial<MetricRow> = {}): MetricRow => ({
    agent: 'claude-code',
    metric: 'claude_code.token.usage',
    field: 'tokens_input',
    sessionId: randomUUID(),
    value: 100,
    temporality: 'delta',
    startTime: null,
    time: new Date().toISOString(),
    attrs: { type: 'input', series: randomUUID() },
    ...over,
});

const report = (org: string, rows: MetricRow[]) => createPostgresStore({ sql }).insertMetrics(rows, org);

const refusal = async (run: Promise<unknown>) => {
    const error = await run.then(
        () => null,
        (e: unknown) => e
    );
    expect(error).toBeInstanceOf(PlanLimitError);
    return error as PlanLimitError;
};

describe.skipIf(!enabled)('token allowance per organization', () => {
    it('refuses a new task once the tokens reported this period reach the allowance, naming `tokens`', async () => {
        await pushPlan(ORG, { tokens: 1000 });
        await report(ORG, [tokenRow({ value: 600 })]);
        await expect(create(ORG)).resolves.toMatchObject({ id: expect.any(String) });

        await report(ORG, [tokenRow({ value: 300, field: 'tokens_output', attrs: { type: 'output' } }), tokenRow()]);
        const refused = await refusal(create(ORG));
        expect(refused).toMatchObject({ limit: 'tokens', max: 1000 });
    });

    it('counts an at-least-once retry of the same export once', async () => {
        await pushPlan(ORG, { tokens: 1000 });
        const batch = [tokenRow({ value: 600 })];
        await report(ORG, batch);
        await report(ORG, batch);
        await expect(create(ORG)).resolves.toMatchObject({ id: expect.any(String) });
    });

    it("counts only the organization's own delta token points", async () => {
        await pushPlan(ORG, { tokens: 1000 });
        await report(OTHER_ORG, [tokenRow({ value: 5000 })]);
        await report(ORG, [
            tokenRow({ value: 5000, temporality: 'cumulative', startTime: new Date().toISOString() }),
            tokenRow({ value: 5000, metric: 'claude_code.active_time.total', field: 'activeTime_cli' as never }),
        ]);
        await expect(create(ORG)).resolves.toMatchObject({ id: expect.any(String) });
    });

    it("counts from the plan's period start, or else from the first of the calendar month", async () => {
        const today = new Date();
        const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
        const before = new Date(monthStart.getTime() - 86_400_000);
        await sql`insert into org_token_usage (org_id, day, tokens) values (${ORG}, ${before}, 5000)`;
        await pushPlan(ORG, { tokens: 1000 });
        await expect(create(ORG)).resolves.toMatchObject({ id: expect.any(String) });

        await sql`delete from org_plan where org_id = ${ORG}`;
        await pushPlan(ORG, { tokens: 1000, periodStart: before, periodEnd: new Date(Date.now() + 86_400_000) });
        expect(await refusal(create(ORG))).toMatchObject({ limit: 'tokens' });
    });

    it('refuses a new batch past the allowance too, naming `tokens`', async () => {
        await pushPlan(ORG, { tokens: 100 });
        const batches = createBatchStore({ sql, orgId: ORG });
        const plan = batchPlan('Allowance', [{ key: 's1', tasks: [prTask('a')] }]);
        await expect(batches.create(plan, MEMBER.id)).resolves.toMatchObject({ id: expect.any(String) });
        await report(ORG, [tokenRow({ value: 100 })]);
        expect(await refusal(batches.create(plan, MEMBER.id))).toMatchObject({ limit: 'tokens', max: 100 });
    });

    it('takes the allowance from the Free default when no plan was pushed', async () => {
        await report(ORG, [tokenRow({ value: 50 })]);
        expect(await refusal(create(ORG, { tokens: 50 }))).toMatchObject({ limit: 'tokens', max: 50 });
    });

    it('leaves a board with no allowance unlimited', async () => {
        await report(ORG, [tokenRow({ value: 1_000_000 })]);
        await expect(create(ORG)).resolves.toMatchObject({ id: expect.any(String) });
    });

    it('never stops a run already going when the allowance is reached', async () => {
        await pushPlan(ORG, { tokens: 100 });
        await craftJob({ sql, org: ORG, author: '' }, { author: null, repo: null });
        const store = jobsOf(ORG);
        const claim = (await store.claim('w1', LEASE_SECONDS))!;
        await report(ORG, [tokenRow({ value: 500 })]);
        expect(await store.heartbeat(claim.id, claim.leaseToken, LEASE_SECONDS)).toMatchObject({
            result: 'ok',
            cancelRequested: false,
        });
    });
});

describe.skipIf(!enabled)('storage allowance per organization', () => {
    const attachmentsOf = (org: string, planDefaults: PlanLimits = {}) =>
        createAttachmentStore({
            rows: createAttachmentRows({ sql, orgId: org, ready: Promise.resolve(), planDefaults }),
            objects,
            orgId: org,
            prefix: 'test/',
        });
    const artifactsOf = (org: string, planDefaults: PlanLimits = {}) =>
        createArtifactStore({ sql, orgId: org, ready: Promise.resolve(), objects, prefix: 'test/', planDefaults });
    const file = (size: number) => ({
        uploaderId: MEMBER.id,
        name: 'note.txt',
        mediaType: 'text/plain',
        bytes: new TextEncoder().encode('x'.repeat(size)),
    });
    const streamRef = () => ({
        member: randomUUID(),
        root: randomUUID(),
        job: randomUUID(),
        claimSeq: 1,
        executor: 'claude-code',
        session: randomUUID(),
        stream: 'raw',
    });

    it('refuses an upload that would pass the storage allowance, naming `storage`', async () => {
        await pushPlan(ORG, { storageBytes: 100 });
        await expect(attachmentsOf(ORG).upload(file(60))).resolves.toMatchObject({ replayed: false });
        expect(await refusal(attachmentsOf(ORG).upload(file(41)))).toMatchObject({ limit: 'storage', max: 100 });
        await expect(attachmentsOf(ORG).upload(file(40))).resolves.toMatchObject({ replayed: false });
    });

    it("counts the org's run logs, frees a removed file, and ignores another organization", async () => {
        await pushPlan(ORG, { storageBytes: 100 });
        await attachmentsOf(OTHER_ORG).upload(file(500));
        expect(await artifactsOf(ORG).putChunk(streamRef(), 0, new TextEncoder().encode('y'.repeat(50)))).toMatchObject(
            { result: 'stored' }
        );
        const { meta } = await attachmentsOf(ORG).upload(file(50));
        expect(await refusal(attachmentsOf(ORG).upload(file(1)))).toMatchObject({ limit: 'storage' });
        await attachmentsOf(ORG).remove(meta.id, MEMBER.id);
        await expect(attachmentsOf(ORG).upload(file(1))).resolves.toMatchObject({ replayed: false });
    });

    it('never lets concurrent uploads take the allowance past its cap', async () => {
        await pushPlan(ORG, { storageBytes: 100 });
        const results = await Promise.allSettled(Array.from({ length: 6 }, () => attachmentsOf(ORG).upload(file(30))));
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
        for (const r of results.filter((r) => r.status === 'rejected')) {
            expect((r as PromiseRejectedResult).reason).toBeInstanceOf(PlanLimitError);
        }
    });

    it('refuses a log chunk past the allowance as the org quota, so the stream ends truncated', async () => {
        await pushPlan(ORG, { storageBytes: 100 });
        await attachmentsOf(ORG).upload(file(90));
        expect(await artifactsOf(ORG).putChunk(streamRef(), 0, new TextEncoder().encode('z'.repeat(20)))).toEqual({
            result: 'refused',
            cause: ARTIFACT_CAUSE.orgQuota,
        });
    });

    it('takes the allowance from the Free default, and a board with none stays unlimited', async () => {
        expect(await refusal(attachmentsOf(ORG, { storageBytes: 10 }).upload(file(11)))).toMatchObject({
            limit: 'storage',
            max: 10,
        });
        await expect(attachmentsOf(ORG).upload(file(5000))).resolves.toMatchObject({ replayed: false });
        expect(
            await artifactsOf(ORG).putChunk(streamRef(), 0, new TextEncoder().encode('w'.repeat(5000)))
        ).toMatchObject({ result: 'stored' });
    });
});
