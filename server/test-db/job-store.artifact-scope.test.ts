import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createArtifactStore, type ArtifactStore } from '../src/artifacts/artifact-store.js';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, JobStore } from '../src/db/job-store-types.js';
import { BACKENDS } from '../test/artifacts-backends.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * Artifact uploads are authorized by claim sequence (the artifact routes): a reclaimed attempt's
 * uploads land under its own claim prefix and the task's authoritative row does not move.
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

describe.skipIf(!enabled)('artifact scope — database', () => {
    it('reports the newest claim sequence and files a stale claim’s upload without touching the job row', async () => {
        const created = await jobs.create('do the thing', null, { repo: null, executor: null });
        if (typeof created === 'string') throw new Error(created);
        const id = created.id;
        const first = await claim();
        await sql`update job set lease_expires_at = now() where id = ${id}`;
        const second = await claim();
        expect([first.claimSeq, second.claimSeq]).toEqual([1, 2]);

        const scope = await jobs.artifactScope(id);
        expect(scope).toMatchObject({ claimSeq: 2 });
        expect(await jobs.artifactScope(randomUUID())).toBeNull();

        const before = await sql`select * from job where id = ${id}`;
        const ref = {
            member: scope!.member ?? 'unattributed',
            root: scope!.root,
            job: id,
            claimSeq: first.claimSeq,
            executor: 'claude-code',
            session: 'sess-1',
            stream: 'log',
        };
        const body = new TextEncoder().encode('from the superseded attempt\n');
        expect(await artifacts.putChunk(ref, 0, body)).toMatchObject({ result: 'stored' });
        // A retry after a lost response is the same chunk, stored once.
        expect(await artifacts.putChunk(ref, 0, body)).toMatchObject({ result: 'duplicate' });
        expect(
            await artifacts.finalize(ref, {
                producer: 'driver',
                schemaVersion: 1,
                startedAt: new Date('2026-01-01T00:00:00Z'),
                finishedAt: new Date('2026-01-01T00:00:01Z'),
                state: 'complete',
            })
        ).toEqual({ result: 'stored' });

        expect(await sql`select * from job where id = ${id}`).toEqual(before);
        expect(await artifacts.listChunks(ref)).toHaveLength(1);
        expect(await artifacts.listChunks({ ...ref, claimSeq: second.claimSeq })).toEqual([]);
    });
});
