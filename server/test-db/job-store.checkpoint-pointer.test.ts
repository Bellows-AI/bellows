import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createArtifactStore, type ArtifactStore } from '../src/artifacts/artifact-store.js';
import type { StreamRef } from '../src/artifacts/keys.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { BACKENDS } from '../test/artifacts-backends.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * Issue #775: the root row's checkpoint pointer advances in the manifest-finalize transaction, and
 * only for the claim sequence the job row holds now — a superseded claim's manifest is stored
 * and leaves the pointer alone.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const WORKER = 'worker-1';
const db = useTestDb({ orgs: [ORG] });

let sql: Sql;
let jobs: JobStore;
let artifacts: ArtifactStore;
const filesystem = BACKENDS.find((backend) => backend.name === 'filesystem')!;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    jobs = createJobStore({ sql, orgId: ORG });
    artifacts = createArtifactStore({
        sql,
        orgId: ORG,
        ready: Promise.resolve(),
        objects: await filesystem.make(),
        prefix: filesystem.prefix,
    });
});

const claim = async (): Promise<Claim> => {
    const c = await jobs.claim(WORKER, 60);
    if (!c) throw new Error('nothing was claimable');
    return c;
};

const MANIFEST = {
    producer: 'supervisor',
    schemaVersion: 1,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:05:00Z'),
};
const COMPLETE = { ...MANIFEST, state: 'complete' as const };

interface Pointer {
    checkpoint_job_id: string | null;
    checkpoint_claim_seq: string | null;
    checkpoint_session: string | null;
    checkpoint_truncated: boolean | null;
    checkpoint_cause: string | null;
    checkpoint_finalized_at: Date | null;
}
const pointerOf = async (id: string) =>
    (
        await sql<Pointer[]>`
            select checkpoint_job_id, checkpoint_claim_seq, checkpoint_session, checkpoint_truncated, checkpoint_cause,
                   checkpoint_finalized_at
            from job where id = ${id}
        `
    )[0]!;

/** A task with its first claim; `refOf(claim)` files a stream under it. */
async function task() {
    const created = await jobs.create('checkpoint me', null, { repo: null, executor: null });
    if (typeof created === 'string') throw new Error(created);
    const first = await claim();
    const scope = (await jobs.artifactScope(created.id))!;
    const refOf = (claimSeq: number, over: Partial<StreamRef> = {}): StreamRef => ({
        member: scope.member ?? 'unattributed',
        root: scope.root,
        job: created.id,
        claimSeq,
        executor: 'claude-code',
        session: 'none',
        stream: 'checkpoint',
        ...over,
    });
    return { id: created.id, root: scope.root, first, refOf };
}

describe.skipIf(!enabled)('checkpoint pointer — database', () => {
    it('advances the root row when a checkpoint manifest finalizes under the current claim', async () => {
        const t = await task();
        expect(await pointerOf(t.root)).toMatchObject({ checkpoint_job_id: null, checkpoint_finalized_at: null });
        const ref = t.refOf(t.first.claimSeq);
        await artifacts.putChunk(ref, 0, new Uint8Array([0, 255, 128]));
        expect(await artifacts.finalize(ref, COMPLETE)).toEqual({ result: 'stored' });
        expect(await pointerOf(t.root)).toMatchObject({
            checkpoint_job_id: t.id,
            checkpoint_claim_seq: String(t.first.claimSeq),
            checkpoint_session: 'none',
            checkpoint_truncated: false,
            checkpoint_cause: null,
        });
        expect((await pointerOf(t.root)).checkpoint_finalized_at).toBeInstanceOf(Date);
    });

    it('records a checkpoint_cap manifest as a truncated pointer', async () => {
        const t = await task();
        await artifacts.finalize(t.refOf(t.first.claimSeq), {
            ...MANIFEST,
            state: 'truncated',
            terminalCause: 'checkpoint_cap',
        });
        expect(await pointerOf(t.root)).toMatchObject({
            checkpoint_truncated: true,
            checkpoint_cause: 'checkpoint_cap',
        });
    });

    it('tells the producer’s cap from a board 413 after partial bytes: both truncated, each with its own cause', async () => {
        const t = await task();
        await artifacts.finalize(t.refOf(t.first.claimSeq), {
            ...MANIFEST,
            state: 'truncated',
            terminalCause: 'stream_cap',
        });
        expect(await pointerOf(t.root)).toMatchObject({
            checkpoint_truncated: true,
            checkpoint_cause: 'stream_cap',
        });
    });

    it('advances the thread root’s pointer from a follow-up’s manifest, under the child’s current claim only', async () => {
        const t = await task();
        await jobs.complete(t.id, t.first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const child = await jobs.createFollowUp(t.id, 'adjust', null);
        if (typeof child === 'string' || !('id' in child))
            throw new Error(`follow-up refused: ${JSON.stringify(child)}`);
        const first = await claim();
        expect(first.id).toBe(child.id);
        await sql`update job set lease_expires_at = now() where id = ${child.id}`;
        const second = await claim();
        expect(second.claimSeq).toBe(first.claimSeq + 1);

        await artifacts.finalize(t.refOf(first.claimSeq, { job: child.id }), COMPLETE);
        expect(await pointerOf(t.root)).toMatchObject({ checkpoint_job_id: null });

        await artifacts.finalize(t.refOf(second.claimSeq, { job: child.id }), COMPLETE);
        expect(await pointerOf(t.root)).toMatchObject({
            checkpoint_job_id: child.id,
            checkpoint_claim_seq: String(second.claimSeq),
        });
        expect(await pointerOf(child.id)).toMatchObject({ checkpoint_job_id: null });
    });

    it('stores a superseded claim’s manifest and leaves the pointer alone', async () => {
        const t = await task();
        await sql`update job set lease_expires_at = now() where id = ${t.id}`;
        const second = await claim();
        expect(second.claimSeq).toBe(t.first.claimSeq + 1);
        const stale = t.refOf(t.first.claimSeq);
        expect(await artifacts.finalize(stale, COMPLETE)).toEqual({ result: 'stored' });
        expect(await artifacts.readManifest(stale)).toMatchObject({ state: 'complete' });
        expect(await pointerOf(t.root)).toMatchObject({ checkpoint_job_id: null, checkpoint_claim_seq: null });
        await artifacts.finalize(t.refOf(second.claimSeq), COMPLETE);
        expect(await pointerOf(t.root)).toMatchObject({ checkpoint_claim_seq: String(second.claimSeq) });
    });

    it('leaves the pointer alone for a partial checkpoint, another stream, and a repeated manifest', async () => {
        const t = await task();
        await artifacts.finalize(t.refOf(t.first.claimSeq), { ...MANIFEST, state: 'partial', terminalCause: 'lost' });
        await artifacts.finalize(t.refOf(t.first.claimSeq, { stream: 'raw' }), COMPLETE);
        expect(await pointerOf(t.root)).toMatchObject({ checkpoint_job_id: null });
        const ref = t.refOf(t.first.claimSeq, { session: 'later' });
        await artifacts.finalize(ref, COMPLETE);
        const before = await pointerOf(t.root);
        expect(await artifacts.finalize(ref, COMPLETE)).toEqual({ result: 'duplicate' });
        expect(await pointerOf(t.root)).toEqual(before);
    });
});
