import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import {
    ArtifactObjectMissingError,
    type ArtifactStore,
    type Manifest,
    type StreamSummary,
} from '../src/artifacts/artifact-store.js';
import { STREAM_STATE } from '../src/artifacts/artifact-read.js';
import type { StreamRef } from '../src/artifacts/keys.js';
import type { JobReadStore } from '../src/db/jobs/job-store-reads.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { OrgRuntime } from '../src/orgs.js';
import { createStatsService } from '../src/stats-service.js';
import { trackApps } from './helpers-http.js';
import { githubAuth, memoryAuthStore, signedIn, stubTelemetryClient, testConfig, jobStoreSlice } from './helpers.js';

/**
 * The analysis reads over the artifact index (#768): pagination across chunks, attempts and
 * sessions; the partial, truncated and deleted states; and the org boundary. The store is an
 * in-memory twin of `ArtifactStore`'s read half; `server/test-db/artifact-read.test.ts` runs the
 * same reads against the real index.
 */
const track = trackApps();

const CALLER_ORG = 'test-org';
const OTHER_ORG = 'other-org';
const JOB = '11111111-1111-4111-8111-111111111111';
const MEMBER = 'member-1';
const ROOT = JOB;
const TRANSCRIPT = 'transcript';
const LOG = 'log';

interface FakeChunk {
    offset: number;
    text: string;
    /** The object is gone from the store; the index still lists it. */
    deleted?: boolean;
}
interface FakeStream {
    ref: StreamRef;
    chunks: FakeChunk[];
    manifest: Manifest | null;
}

const ref = (over: Partial<StreamRef> = {}): StreamRef => ({
    member: MEMBER,
    root: ROOT,
    job: JOB,
    claimSeq: 1,
    executor: 'claude-code',
    session: 'sess-a',
    stream: TRANSCRIPT,
    ...over,
});

const manifest = (state: Manifest['state'], terminalCause: string | null = null): Manifest => ({
    producer: 'exporter',
    schemaVersion: 1,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:05:00Z'),
    state,
    terminalCause,
});

/** Chunks laid end to end from offset 0, the way a producer cuts them. */
function stream(over: Partial<StreamRef>, texts: string[], m: Manifest | null = manifest('complete')): FakeStream {
    let offset = 0;
    const chunks = texts.map((text) => {
        const chunk = { offset, text };
        offset += text.length;
        return chunk;
    });
    return { ref: ref(over), chunks, manifest: m };
}

/** A real store keys on the seven coordinates only; the summaries the route passes back carry more. */
const same = (a: StreamRef, b: StreamRef) =>
    (['member', 'root', 'job', 'claimSeq', 'executor', 'session', 'stream'] as const).every((k) => a[k] === b[k]);

/** Records every chunk read so a test can prove another org's bytes were never fetched. */
function fakeArtifacts(streams: FakeStream[]) {
    const reads: string[] = [];
    const store = {
        async streamsOfJob(job: string): Promise<StreamSummary[]> {
            return streams
                .filter((s) => s.ref.job === job)
                .map((s) => ({
                    ...s.ref,
                    chunks: s.chunks.length,
                    bytes: s.chunks.reduce((n, c) => n + c.text.length, 0),
                    manifest: s.manifest,
                }))
                .sort((a, b) => a.claimSeq - b.claimSeq || a.session.localeCompare(b.session));
        },
        async listChunks(r: StreamRef) {
            const found = streams.find((s) => same(s.ref, r));
            return (found?.chunks ?? []).map((c) => ({
                offset: c.offset,
                length: c.text.length,
                sha256: '0'.repeat(64),
            }));
        },
        async readChunk(r: StreamRef, offset: number) {
            const chunk = streams.find((s) => same(s.ref, r))?.chunks.find((c) => c.offset === offset);
            if (!chunk) return null;
            reads.push(`${r.session}/${r.stream}/${offset}`);
            if (chunk.deleted) throw new ArtifactObjectMissingError('gone');
            return {
                offset,
                length: chunk.text.length,
                sha256: '0'.repeat(64),
                body: new TextEncoder().encode(chunk.text),
            };
        },
    } as unknown as ArtifactStore;
    return { store, reads };
}

const jobStoreOf = (present: boolean) =>
    jobStoreSlice<JobReadStore>({ get: async () => (present ? { id: JOB } : null) });

async function harness(boards: Record<string, { artifacts: ArtifactStore; jobPresent?: boolean }>) {
    const config = testConfig({ auth: githubAuth() });
    const auth = memoryAuthStore();
    const runtimes = new Map<string, OrgRuntime>(
        Object.entries(boards).map(([orgId, { artifacts, jobPresent = true }]): [string, OrgRuntime] => {
            const repos = staticRepoSource([]);
            const telemetry = stubTelemetryClient();
            return [
                orgId,
                {
                    orgId,
                    repos,
                    telemetry,
                    service: createStatsService({ config, repos, telemetry }),
                    jobs: jobStoreOf(jobPresent),
                    artifacts,
                },
            ];
        })
    );
    const app: FastifyInstance = track(
        await buildApp({
            config,
            auth,
            orgs: {
                for: async (orgId) => runtimes.get(orgId) ?? null,
                list: async () => [...runtimes.keys()].map((id) => ({ id, name: id, installationId: null })),
                warmAll: async () => {},
                reconcileBatches: async () => {},
                observeBatchPrs: async () => {},
            },
        })
    );
    const cookieIn = async (orgId: string) => signedIn(auth, auth.seedMember(orgId, `user-of-${orgId}`));
    const get = async (orgId: string, url: string) =>
        app.inject({ method: 'GET', url, headers: { cookie: await cookieIn(orgId) } });
    return { app, get };
}

const readUrl = (query = '') => `/api/jobs/${JOB}/artifacts/read${query}`;

describe('GET /api/jobs/:id/artifacts/read', () => {
    it('reads a transcript of any length across attempts and sessions, page by page, in order', async () => {
        const { store } = fakeArtifacts([
            stream({ claimSeq: 2, session: 'sess-b' }, ['d1\n', 'd2\n']),
            stream({ claimSeq: 1, session: 'sess-a' }, ['a1\n', 'a2\n', 'a3\n']),
            stream({ claimSeq: 1, session: 'sess-a', stream: LOG }, ['log\n']),
            stream({ claimSeq: 1, session: 'sess-c' }, ['c1\n']),
        ]);
        const { get } = await harness({ [CALLER_ORG]: { artifacts: store } });

        const texts: string[] = [];
        const pages: number[] = [];
        let cursor: string | null = null;
        do {
            const query: string = `?stream=${TRANSCRIPT}&limit=4${cursor ? `&cursor=${cursor}` : ''}`;
            const response = await get(CALLER_ORG, readUrl(query));
            expect(response.statusCode).toBe(200);
            const page = response.json();
            pages.push(page.segments.length);
            texts.push(...page.segments.map((s: { text: string }) => s.text));
            cursor = page.nextCursor;
        } while (cursor);

        // Attempt 1 (sessions in order), then attempt 2; the log stream is filtered out.
        expect(texts).toEqual(['a1\n', 'a2\n', 'a3\n', 'c1\n', 'd1\n', 'd2\n']);
        // Pages hold whole chunks within the byte budget: four bytes fits one three-byte chunk.
        expect(pages.every((n) => n === 1)).toBe(true);
        expect(pages).toHaveLength(6);
    });

    it('reads every stream when none is named, and narrows by attempt, session and executor', async () => {
        const { store } = fakeArtifacts([
            stream({ claimSeq: 1, session: 'sess-a' }, ['a\n']),
            stream({ claimSeq: 1, session: 'sess-a', stream: LOG }, ['l\n']),
            stream({ claimSeq: 2, session: 'sess-b' }, ['b\n']),
            stream({ claimSeq: 2, session: 'sess-b', executor: 'opencode' }, ['o\n']),
        ]);
        const { get } = await harness({ [CALLER_ORG]: { artifacts: store } });
        const textsOf = async (query: string) =>
            (await get(CALLER_ORG, readUrl(query))).json().segments.map((s: { text: string }) => s.text);

        expect(await textsOf('')).toEqual(['a\n', 'l\n', 'b\n', 'o\n']);
        expect(await textsOf('?attempt=2')).toEqual(['b\n', 'o\n']);
        expect(await textsOf('?attempt=2&executor=opencode')).toEqual(['o\n']);
        expect(await textsOf('?session=sess-a&stream=log')).toEqual(['l\n']);
    });

    it('serves a chunk larger than the page budget rather than an empty page', async () => {
        const { store } = fakeArtifacts([stream({}, ['0123456789', 'abc'])]);
        const { get } = await harness({ [CALLER_ORG]: { artifacts: store } });
        const page = (await get(CALLER_ORG, readUrl('?limit=2'))).json();
        expect(page.segments.map((s: { text: string }) => s.text)).toEqual(['0123456789']);
        expect(page.nextCursor).toEqual(expect.any(String));
    });

    it('says plainly which streams are partial, truncated or deleted', async () => {
        const { store } = fakeArtifacts([
            stream({ session: 'complete' }, ['ok\n']),
            stream({ session: 'cut' }, ['x\n'], manifest('truncated', 'stream_cap')),
            stream({ session: 'short' }, ['y\n'], manifest('partial', 'lost_unacknowledged')),
            stream({ session: 'open' }, ['z\n'], null),
        ]);
        const { get } = await harness({ [CALLER_ORG]: { artifacts: store } });

        const page = (await get(CALLER_ORG, readUrl())).json();
        const stateOf = (session: string) => {
            const s = page.streams.find((v: { session: string }) => v.session === session);
            return [s.state, s.terminalCause];
        };
        expect(stateOf('complete')).toEqual([STREAM_STATE.complete, null]);
        expect(stateOf('cut')).toEqual([STREAM_STATE.truncated, 'stream_cap']);
        expect(stateOf('short')).toEqual([STREAM_STATE.partial, 'lost_unacknowledged']);
        // Chunks with no manifest: the runner has not finalized the stream (or died first).
        expect(stateOf('open')).toEqual([STREAM_STATE.partial, 'not_finalized']);

        const listing = (await get(CALLER_ORG, `/api/jobs/${JOB}/artifacts`)).json();
        // Sessions in name order: complete, cut, open, short.
        expect(listing.streams.map((s: { state: string }) => s.state)).toEqual([
            'complete',
            'truncated',
            'partial',
            'partial',
        ]);
    });

    it('marks a chunk whose object is gone as deleted, keeps reading past it, and shows the gap', async () => {
        const gone = stream({}, ['aaa', 'bbb', 'ccc']);
        gone.chunks[1]!.deleted = true;
        const missing = stream({ session: 'sess-z' }, ['q', 'r']);
        missing.chunks.splice(0, 1);
        const { store } = fakeArtifacts([gone, missing]);
        const { get } = await harness({ [CALLER_ORG]: { artifacts: store } });

        const page = (await get(CALLER_ORG, readUrl())).json();
        const [first, second, third, lost] = page.segments;
        expect([first.state, first.text]).toEqual(['ok', 'aaa']);
        expect([second.state, second.text, second.length]).toEqual(['deleted', null, 3]);
        expect([third.state, third.text]).toEqual(['ok', 'ccc']);
        // The index lacks the stream's first chunk: bytes 0..0 are missing before offset 1.
        expect([lost.text, lost.gapBefore, lost.offset]).toEqual(['r', 1, 1]);
        const view = page.streams.find((s: { session: string }) => s.session === 'sess-a');
        expect([view.state, view.terminalCause]).toEqual(['deleted', 'object_missing']);
    });

    it('answers a removed job from the index as deleted, without fetching any object', async () => {
        const { store, reads } = fakeArtifacts([stream({}, ['secret\n'])]);
        const { get } = await harness({ [CALLER_ORG]: { artifacts: store, jobPresent: false } });

        const page = (await get(CALLER_ORG, readUrl())).json();
        expect(page.streams[0]).toMatchObject({ state: 'deleted', terminalCause: 'job_removed' });
        expect(page.segments).toEqual([expect.objectContaining({ state: 'deleted', text: null, length: 7 })]);
        expect(reads).toEqual([]);
    });

    it('is 404 for a job neither the board nor the index knows', async () => {
        const { store } = fakeArtifacts([]);
        const { get } = await harness({ [CALLER_ORG]: { artifacts: store, jobPresent: false } });
        expect((await get(CALLER_ORG, readUrl())).statusCode).toBe(404);
    });

    it('refuses malformed attempt, limit and cursor', async () => {
        const { store } = fakeArtifacts([stream({}, ['a'])]);
        const { get } = await harness({ [CALLER_ORG]: { artifacts: store } });
        const codeOf = async (query: string) => {
            const response = await get(CALLER_ORG, readUrl(query));
            return [response.statusCode, response.json().code];
        };
        expect(await codeOf('?attempt=-1')).toEqual([400, 'BAD_ATTEMPT']);
        expect(await codeOf('?limit=0')).toEqual([400, 'BAD_LIMIT']);
        expect(await codeOf('?limit=99999999999')).toEqual([400, 'BAD_LIMIT']);
        expect(await codeOf('?cursor=not-a-cursor')).toEqual([400, 'BAD_CURSOR']);
        // A cursor minted for other streams does not point into this selection.
        const minted = (await get(CALLER_ORG, readUrl('?limit=1'))).json();
        expect(minted.nextCursor).toBeNull();
        const elsewhere = Buffer.from(JSON.stringify({ s: 'nope', o: 0 })).toString('base64url');
        expect(await codeOf(`?cursor=${elsewhere}`)).toEqual([400, 'BAD_CURSOR']);
    });
});

describe('artifact reads are scoped to the caller org', () => {
    it('refuses another org’s job on both routes, fetching none of its bytes', async () => {
        const mine = fakeArtifacts([]);
        const theirs = fakeArtifacts([stream({}, ['other tenant secret\n'])]);
        const { get } = await harness({
            [CALLER_ORG]: { artifacts: mine.store, jobPresent: false },
            [OTHER_ORG]: { artifacts: theirs.store },
        });

        for (const url of [readUrl(), `/api/jobs/${JOB}/artifacts`]) {
            const refused = await get(CALLER_ORG, url);
            expect(refused.statusCode).toBe(404);
            expect(refused.body).not.toContain('secret');
        }
        expect(theirs.reads).toEqual([]);

        // The owner reads the very same id: the refusal is the org boundary, not a missing route.
        const owner = await get(OTHER_ORG, readUrl());
        expect(owner.statusCode).toBe(200);
        expect(owner.json().segments[0].text).toBe('other tenant secret\n');
    });

    it('needs a signed-in caller', async () => {
        const { store } = fakeArtifacts([stream({}, ['a'])]);
        const { app } = await harness({ [CALLER_ORG]: { artifacts: store } });
        expect((await app.inject({ method: 'GET', url: readUrl() })).statusCode).toBe(401);
    });
});
