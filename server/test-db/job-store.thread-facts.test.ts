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
 * Issue #775: the lease lookup answers a thread's ROOT row with the facts the reaper decides its task
 * volume on — live, when the newest attempt finalized, whether that attempt's artifacts are all
 * terminal, and whether the root's checkpoint pointer names it whole.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
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
    const c = await jobs.claim('worker-1', 60);
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

async function task() {
    const created = await jobs.create('thread facts', null, { repo: null, executor: null });
    if (typeof created === 'string') throw new Error(created);
    const first = await claim();
    const scope = (await jobs.artifactScope(created.id))!;
    const refOf = (job: string, claimSeq: number, stream = 'checkpoint'): StreamRef => ({
        member: scope.member ?? 'unattributed',
        root: scope.root,
        job,
        claimSeq,
        executor: 'claude-code',
        session: 'none',
        stream,
    });
    const threadOf = async (root = created.id) => (await jobs.leases([root], true))[0]!.thread;
    const succeed = (id: string, leaseToken: string) =>
        jobs.complete(id, leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
    return { id: created.id, first, refOf, threadOf, succeed };
}

describe.skipIf(!enabled)('lease lookup thread facts — database', () => {
    it('answers a live thread as live, with nothing finalized', async () => {
        const t = await task();
        expect(await t.threadOf()).toEqual({
            live: true,
            lastFinalizedAt: null,
            artifactsComplete: true,
            checkpoint: 'none',
            checkpointFinalizedAt: null,
        });
    });

    it('answers a finalized attempt with a complete checkpoint as complete', async () => {
        const t = await task();
        const ref = t.refOf(t.id, t.first.claimSeq);
        await artifacts.putChunk(ref, 0, new Uint8Array([1]));
        await artifacts.finalize(ref, COMPLETE);
        await t.succeed(t.id, t.first.leaseToken);
        const thread = (await t.threadOf())!;
        expect(thread).toMatchObject({ live: false, artifactsComplete: true, checkpoint: 'complete' });
        expect(Date.parse(thread.lastFinalizedAt!)).not.toBeNaN();
        expect(Date.parse(thread.checkpointFinalizedAt!)).not.toBeNaN();
    });

    it('answers a truncated checkpoint as truncated', async () => {
        const t = await task();
        const ref = t.refOf(t.id, t.first.claimSeq);
        await artifacts.finalize(ref, { ...MANIFEST, state: 'truncated', terminalCause: 'checkpoint_cap' });
        await t.succeed(t.id, t.first.leaseToken);
        expect(await t.threadOf()).toMatchObject({ live: false, artifactsComplete: true, checkpoint: 'truncated' });
    });

    it('measures idle from the newest finalize: a manifest that lands after the attempt moves it', async () => {
        const t = await task();
        await artifacts.finalize(t.refOf(t.id, t.first.claimSeq), COMPLETE);
        await t.succeed(t.id, t.first.leaseToken);
        const before = Date.parse((await t.threadOf())!.lastFinalizedAt!);
        await new Promise((resolve) => setTimeout(resolve, 25));
        await artifacts.finalize(t.refOf(t.id, t.first.claimSeq, 'transcript'), COMPLETE);
        expect(Date.parse((await t.threadOf())!.lastFinalizedAt!)).toBeGreaterThan(before);
    });

    it('answers no thread facts unless the caller asks for them', async () => {
        const t = await task();
        const [row] = await jobs.leases([t.id]);
        expect(row).toBeDefined();
        expect(row).not.toHaveProperty('thread');
    });

    it('holds artifacts pending while a stream of the last attempt has chunks and no manifest', async () => {
        const t = await task();
        const ref = t.refOf(t.id, t.first.claimSeq);
        await artifacts.finalize(ref, COMPLETE);
        await artifacts.putChunk(t.refOf(t.id, t.first.claimSeq, 'transcript'), 0, new Uint8Array([1]));
        await t.succeed(t.id, t.first.leaseToken);
        expect(await t.threadOf()).toMatchObject({ artifactsComplete: false, checkpoint: 'complete' });
        await artifacts.finalize(t.refOf(t.id, t.first.claimSeq, 'transcript'), COMPLETE);
        expect(await t.threadOf()).toMatchObject({ artifactsComplete: true });
    });

    it('holds artifacts pending on a partial manifest', async () => {
        const t = await task();
        await artifacts.finalize(t.refOf(t.id, t.first.claimSeq, 'transcript'), {
            ...MANIFEST,
            state: 'partial',
            terminalCause: 'lost_unacknowledged',
        });
        await t.succeed(t.id, t.first.leaseToken);
        expect(await t.threadOf()).toMatchObject({ artifactsComplete: false });
    });

    it('reads the newest attempt: a follow-up with no checkpoint of its own is not complete', async () => {
        const t = await task();
        await artifacts.finalize(t.refOf(t.id, t.first.claimSeq), COMPLETE);
        await t.succeed(t.id, t.first.leaseToken);
        const child = await jobs.createFollowUp(t.id, 'adjust', null);
        if (typeof child === 'string' || !('id' in child)) throw new Error(`refused: ${JSON.stringify(child)}`);
        expect(await t.threadOf()).toMatchObject({ live: true, lastFinalizedAt: null });
        const second = await claim();
        await t.succeed(child.id, second.leaseToken);
        expect(await t.threadOf()).toMatchObject({ live: false, checkpoint: 'none' });
        await artifacts.finalize(t.refOf(child.id, second.claimSeq), COMPLETE);
        expect(await t.threadOf()).toMatchObject({ checkpoint: 'complete' });
    });

    it('answers no thread for a row that is not a root', async () => {
        const t = await task();
        await t.succeed(t.id, t.first.leaseToken);
        const child = await jobs.createFollowUp(t.id, 'adjust', null);
        if (typeof child === 'string' || !('id' in child)) throw new Error(`refused: ${JSON.stringify(child)}`);
        const [row] = await jobs.leases([child.id], true);
        expect(row).toBeDefined();
        expect(row).not.toHaveProperty('thread');
        await claim();
    });
});
