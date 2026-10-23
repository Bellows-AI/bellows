import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createArtifactStore, type ArtifactStore } from '../src/artifacts/artifact-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { BACKENDS } from '../test/artifacts-backends.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * Issue #775, slice 3: what a live lease may read of its thread when the driver restores — the root
 * row's checkpoint pointer and the thread's job rows, and nothing for a lost, unknown or foreign lease.
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

const COMPLETE = {
    producer: 'supervisor',
    schemaVersion: 1,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:05:00Z'),
    state: 'complete' as const,
};

async function task(command: string) {
    const created = await jobs.create(command, null, { repo: null, executor: null });
    if (typeof created === 'string') throw new Error(created);
    const first = await claim();
    expect(first.id).toBe(created.id);
    return { id: created.id, first };
}

describe.skipIf(!enabled)('restoreScope — database', () => {
    it('answers none for a thread with no checkpoint, naming the root and the thread rows', async () => {
        const t = await task('first');
        const answer = await jobs.restoreScope(t.id, t.first.leaseToken);
        expect(answer).toMatchObject({
            result: 'ok',
            scope: { root: t.id, checkpoint: null, jobs: [{ id: t.id, claimSeq: t.first.claimSeq }] },
        });
    });

    it('returns the pointer the root row holds, as the manifest finalize wrote it', async () => {
        const t = await task('with a checkpoint');
        const scope = (await jobs.artifactScope(t.id))!;
        const ref = {
            member: scope.member ?? 'unattributed',
            root: scope.root,
            job: t.id,
            claimSeq: t.first.claimSeq,
            executor: 'claude-code',
            session: 'sess-1',
            stream: 'checkpoint',
        };
        await artifacts.putChunk(ref, 0, new Uint8Array([1, 2, 3]));
        await artifacts.finalize(ref, COMPLETE);
        const answer = await jobs.restoreScope(t.id, t.first.leaseToken);
        if (answer.result !== 'ok') throw new Error(`expected ok, got ${answer.result}`);
        expect(answer.scope.checkpoint).toMatchObject({
            jobId: t.id,
            claimSeq: t.first.claimSeq,
            executor: 'claude-code',
            session: 'sess-1',
            truncated: false,
            cause: null,
        });
        expect(answer.scope.checkpoint!.finalizedAt).toBeInstanceOf(Date);
    });

    it('lists every row of the thread and none of another thread', async () => {
        const a = await task('thread a');
        const other = await task('thread b');
        await sql`update job set status = 'succeeded', lease_token = null where id = ${a.id}`;
        const follow = await jobs.createFollowUp(a.id, 'more', null);
        if (typeof follow === 'string') throw new Error(follow);
        const second = await claim();
        expect(second.id).toBe(follow.id);
        const answer = await jobs.restoreScope(follow.id, second.leaseToken);
        if (answer.result !== 'ok') throw new Error(`expected ok, got ${answer.result}`);
        expect(answer.scope.root).toBe(a.id);
        expect(answer.scope.jobs.map((j) => j.id).sort()).toEqual([a.id, follow.id].sort());
        expect(answer.scope.jobs.map((j) => j.id)).not.toContain(other.id);
    });

    it('refuses a wrong lease token, a released lease and an unknown job', async () => {
        const t = await task('lease');
        const wrong = randomUUID();
        expect(await jobs.restoreScope(t.id, wrong)).toEqual({ result: 'lost' });
        expect(await jobs.restoreScope(wrong, t.first.leaseToken)).toEqual({ result: 'missing' });
        await sql`update job set status = 'succeeded', lease_token = null where id = ${t.id}`;
        expect(await jobs.restoreScope(t.id, t.first.leaseToken)).toEqual({ result: 'lost' });
    });
});
