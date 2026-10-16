import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { readPage } from '../src/artifacts/artifact-read.js';
import { createArtifactStore } from '../src/artifacts/artifact-store.js';
import { chunkKey, type StreamRef } from '../src/artifacts/keys.js';
import { BACKENDS } from '../test/artifacts-backends.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The analysis reads (#768) over the real index and each object store, and the rule that keeps a
 * transcript out of token metrics: the exports are artifacts, never `metric_point` rows, and where
 * a session has both, `session_source` keeps OTEL.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();

const db = useTestDb({ orgs: [ORG, OTHER_ORG] });
let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});

const bytes = (text: string) => new TextEncoder().encode(text);
const MANIFEST = {
    producer: 'exporter',
    schemaVersion: 1,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:05:00Z'),
};

describe.skipIf(!enabled).each(BACKENDS)('artifact reads over $name', ({ make, prefix, skip }) => {
    async function setup() {
        const objects = await make();
        const build = (orgId: string) => createArtifactStore({ sql, orgId, ready: Promise.resolve(), objects, prefix });
        return { objects, store: build(ORG), other: build(OTHER_ORG) };
    }
    const stream = (job: string, over: Partial<StreamRef> = {}): StreamRef => ({
        member: randomUUID(),
        root: job,
        job,
        claimSeq: 1,
        executor: 'claude-code',
        session: randomUUID(),
        stream: 'transcript',
        ...over,
    });

    it.skipIf(skip)('lists a job’s streams across attempts, finalized or not, and pages through them', async () => {
        const { store } = await setup();
        const job = randomUUID();
        const first = stream(job, { session: 'aaa' });
        const second = stream(job, { session: 'bbb', claimSeq: 2 });
        await store.putChunk(first, 0, bytes('one\n'));
        await store.putChunk(first, 4, bytes('two\n'));
        await store.putChunk(first, 8, bytes('three\n'));
        await store.putChunk(second, 0, bytes('retry\n'));
        await store.finalize(first, { ...MANIFEST, state: 'truncated', terminalCause: 'stream_cap' });

        const streams = await store.streamsOfJob(job);
        expect(streams.map((s) => [s.claimSeq, s.session, s.chunks, s.manifest?.state ?? null])).toEqual([
            [1, 'aaa', 3, 'truncated'],
            [2, 'bbb', 1, null],
        ]);

        const pages: string[][] = [];
        let cursor: string | undefined;
        do {
            const page = await readPage(store, streams, { cursor, maxBytes: 9, jobRemoved: false });
            if (page === 'bad_cursor') throw new Error('cursor refused');
            pages.push(page.segments.map((s) => s.text ?? ''));
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(pages.flat().join('')).toBe('one\ntwo\nthree\nretry\n');
        expect(pages.length).toBeGreaterThan(1);
    });

    it.skipIf(skip)('reads a deleted object as deleted, and another org’s job as nothing at all', async () => {
        const { store, other, objects } = await setup();
        const job = randomUUID();
        const ref = stream(job);
        await store.putChunk(ref, 0, bytes('abc'));
        await store.putChunk(ref, 3, bytes('def'));
        await objects.delete(chunkKey(prefix, ORG, ref, 0));

        const [summary] = await store.streamsOfJob(job);
        const page = await readPage(store, [summary!], { cursor: undefined, maxBytes: 100, jobRemoved: false });
        if (page === 'bad_cursor') throw new Error('cursor refused');
        expect(page.segments.map((s) => [s.state, s.text])).toEqual([
            ['deleted', null],
            ['ok', 'def'],
        ]);
        expect(page.streams[0]).toMatchObject({ state: 'deleted', terminalCause: 'object_missing' });

        // The index is bound to the org: the same job id is empty from the other tenant's store, and
        // a read by this org's exact key through it is refused.
        expect(await other.streamsOfJob(job)).toEqual([]);
        expect(await other.readByKey(chunkKey(prefix, ORG, ref, 3))).toEqual({ result: 'refused' });
    });
});

describe.skipIf(!enabled)('transcript exports and token metrics', () => {
    const point = (session: string, source: string, value: number) => sql`
        insert into metric_point ${sql({
            agent: 'claude-code',
            metric: 'claude_code.token.usage',
            field: 'tokens_input',
            session_id: session,
            value,
            temporality: 'delta',
            time: new Date('2026-01-01T00:00:00Z'),
            attrs: {},
            source,
        })}
    `;
    const sources = async (...sessions: string[]) =>
        sql<{ session_id: string; source: string }[]>`
            select session_id, source from session_source where session_id in ${sql(sessions)}
        `;

    it('keeps OTEL as the one source of a session that also has transcript rows, per session', async () => {
        const both = randomUUID();
        const transcriptOnly = randomUUID();
        await point(both, 'transcript', 900);
        await point(both, 'otel', 100);
        await point(transcriptOnly, 'transcript', 50);

        const rows = await sources(both, transcriptOnly);
        expect(Object.fromEntries(rows.map((r) => [r.session_id, r.source]))).toEqual({
            [both]: 'otel',
            [transcriptOnly]: 'transcript',
        });
        const [used] = await sql<{ total: number }[]>`
            select sum(value)::float as total from metric_point_used where session_id = ${both}
        `;
        expect(used?.total).toBe(100);
    });

    it('is untouched by storing and finalizing a transcript artifact', async () => {
        const session = randomUUID();
        await point(session, 'otel', 100);
        const [before] = await sql<
            { n: number }[]
        >`select count(*)::int as n from metric_point where session_id = ${session}`;

        const { objects } = { objects: await BACKENDS[0]!.make() };
        const store = createArtifactStore({ sql, orgId: ORG, ready: Promise.resolve(), objects, prefix: '' });
        const ref: StreamRef = {
            member: randomUUID(),
            root: randomUUID(),
            job: randomUUID(),
            claimSeq: 1,
            executor: 'claude-code',
            session,
            stream: 'transcript',
        };
        await store.putChunk(ref, 0, bytes('{"usage":{"input_tokens":999}}\n'));
        await store.finalize(ref, { ...MANIFEST, state: 'complete' });

        const [after] = await sql<
            { n: number }[]
        >`select count(*)::int as n from metric_point where session_id = ${session}`;
        expect(after?.n).toBe(before?.n);
        expect((await sources(session))[0]?.source).toBe('otel');
    });
});
