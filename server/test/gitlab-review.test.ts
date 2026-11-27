import { type RepoRef, parseRepoRef } from '@factory-ai/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HELPER_TIMEOUT_MS } from '../../driver/src/helpers.js';
import { type GitlabCall, gitlabRequest } from '../src/forge/gitlab-call.js';
import {
    readReviewCollection,
    REVIEW_READ_DEADLINE_MS,
    REVIEW_WRITE_DEADLINE_MS,
    replyReview,
} from '../src/forge/gitlab-review.js';
import { addressedMarker, type ReviewPlan, type ReviewPlanTarget } from '../src/forge/review-collection.js';
import { createGitlabApi } from '../src/gitlab/gitlab-api.js';
import { type FakeGitlab, startFakeGitlab } from '../test-db/fake-gitlab.js';

/**
 * The board's reads and writes of one GitLab merge request's discussions (docs/workflows.md), against the in-process
 * fake for what GitLab does and over scripted answers for what it cannot be made to do.
 */
const PATH = 'grp/sub/web';
const ENCODED = 'grp%2Fsub%2Fweb';
const REF = parseRepoRef(`gitlab:board.gitlab.test/${PATH}`) as RepoRef;
const FAST = 400;

let gl: FakeGitlab;
let token: string;
let counter = 0;

beforeAll(async () => {
    gl = await startFakeGitlab();
    await gl.control('gitlab/projects', { path: PATH, files: { 'README.md': 'x\n' } });
    token = (await gl.signIn('dev-one')).access_token;
});
beforeEach(() => gl.control('gitlab/faults', { mode: 'none' }));
afterAll(() => gl.stop());

const api = createGitlabApi({ baseUrl: () => gl.base, probeTimeoutMs: 10_000 });
const callOn = (as = token): GitlabCall => gitlabRequest({ api, caBundle: undefined }, REF, as);
const base = (iid: number) => `/api/v4/projects/${ENCODED}/merge_requests/${iid}`;
const deadline = (ms = 10_000) => AbortSignal.timeout(ms);

const openMr = async () => {
    const name = `task/r${++counter}`;
    await gl.control('gitlab/commit', {
        project: PATH,
        branch: name,
        files: { [`${name}.txt`]: 'x' },
        message: 'work',
    });
    const made = await gl.send('POST', `/api/v4/projects/${ENCODED}/merge_requests`, {
        token,
        body: { source_branch: name, target_branch: 'main', title: 'Change' },
    });
    const mr = made.body as { iid: number; sha: string };
    return { iid: mr.iid, sha: mr.sha };
};
const discuss = async (iid: number, body: object) =>
    (await gl.control('gitlab/discussion', { project: PATH, iid, login: 'rev-one', ...body })).body as {
        id: string;
        noteId: number;
    };
const position = (sha: string, extra: object = {}) => ({
    position_type: 'text',
    new_path: 'src/a.ts',
    old_path: 'src/a.ts',
    new_line: 7,
    old_line: null,
    head_sha: sha,
    ...extra,
});
const discussionsOf = async (iid: number) =>
    (await gl.send('GET', `${base(iid)}/discussions`, { token })).body as {
        id: string;
        notes: { id: number; body: string; resolved: boolean; resolvable: boolean; author: { username: string } }[];
    }[];
const kindOf = (promise: Promise<unknown>) =>
    promise.then(
        () => 'resolved',
        (e: { kind?: string }) => e.kind ?? 'unclassified'
    );
const fault = (body: object) => gl.control('gitlab/faults', body);

describe('readReviewCollection: the mapping', () => {
    it('maps a diff discussion to a thread with its path, line and non-system notes', async () => {
        const mr = await openMr();
        const thread = await discuss(mr.iid, { body: 'rename this', position: position(mr.sha) });
        await gl.send('POST', `${base(mr.iid)}/discussions/${thread.id}/notes`, { token, body: { body: 'why?' } });
        const collection = await readReviewCollection(callOn(), REF, mr.iid, deadline());
        expect(collection).toMatchObject({
            version: 1,
            schema: 'review-collect/v1',
            ref: { owner: 'grp/sub', repo: 'web', number: mr.iid },
            inline: [],
            reviews: [],
            error: null,
        });
        expect(collection.threads).toHaveLength(1);
        const [first, second] = collection.threads[0]!.comments;
        expect(collection.threads[0]).toMatchObject({
            id: thread.id,
            path: 'src/a.ts',
            line: 7,
            isResolved: false,
            isOutdated: false,
        });
        expect(first).toMatchObject({
            id: String(thread.noteId),
            databaseId: thread.noteId,
            author: 'rev-one',
            body: 'rename this',
        });
        expect(first?.createdAt).toEqual(expect.any(String));
        expect(second).toMatchObject({ author: 'dev-one', body: 'why?' });
    });

    it('falls back to the old path and line, and maps a non-diff discussion to a thread without either', async () => {
        const mr = await openMr();
        await discuss(mr.iid, {
            body: 'gone',
            position: position(mr.sha, { new_path: null, new_line: null, old_line: 3 }),
        });
        await discuss(mr.iid, { body: 'overall' });
        const { threads } = await readReviewCollection(callOn(), REF, mr.iid, deadline());
        expect(threads.map((t) => [t.path, t.line])).toEqual([
            ['src/a.ts', 3],
            [null, null],
        ]);
    });

    it('is resolved only when every resolvable note is, and outdated only on another head sha', async () => {
        const mr = await openMr();
        const open = await discuss(mr.iid, { body: 'open', position: position(mr.sha) });
        const done = await discuss(mr.iid, { body: 'done', position: position('b'.repeat(40)) });
        await gl.send('PUT', `${base(mr.iid)}/discussions/${done.id}?resolved=true`, { token });
        await gl.send('POST', `${base(mr.iid)}/discussions/${open.id}/notes`, { token, body: { body: 'reply' } });
        const { threads } = await readReviewCollection(callOn(), REF, mr.iid, deadline());
        const byId = Object.fromEntries(threads.map((t) => [t.id, t]));
        expect(byId[open.id]).toMatchObject({ isResolved: false, isOutdated: false });
        expect(byId[done.id]).toMatchObject({ isResolved: true, isOutdated: true });
    });

    it('maps an individual note to a general entry and shows no system note anywhere', async () => {
        const mr = await openMr();
        const plain = await discuss(mr.iid, { body: 'just a remark', individual: true });
        await discuss(mr.iid, { body: 'added 1 commit', system: true });
        const collection = await readReviewCollection(callOn(), REF, mr.iid, deadline());
        expect(collection.general).toMatchObject([{ id: plain.noteId, author: 'rev-one', body: 'just a remark' }]);
        expect(collection.threads).toEqual([]);
        expect(JSON.stringify(collection)).not.toContain('added 1 commit');
    });

    it('lists every addressed key found on any note, before the caps', async () => {
        const mr = await openMr();
        const thread = await discuss(mr.iid, { body: 'x', position: position(mr.sha) });
        await gl.send('POST', `${base(mr.iid)}/discussions/${thread.id}/notes`, {
            token,
            body: { body: `done\n\n${addressedMarker(`thread:${thread.id}`)}` },
        });
        await gl.send('POST', `${base(mr.iid)}/notes`, { token, body: { body: addressedMarker('general:9') } });
        const { addressed } = await readReviewCollection(callOn(), REF, mr.iid, deadline());
        expect(addressed).toEqual([`thread:${thread.id}`, 'general:9'].sort());
    });
});

describe('readReviewCollection: reviewers and checks', () => {
    const reviewers = (iid: number, list: { login: string; state: string }[]) =>
        gl.control('gitlab/reviewers', { project: PATH, iid, reviewers: list });

    it('reads requested reviewers, a requested change and pending checks', async () => {
        const mr = await openMr();
        await reviewers(mr.iid, [
            { login: 'rev-one', state: 'unreviewed' },
            { login: 'rev-two', state: 'review_started' },
            { login: 'rev-three', state: 'approved' },
        ]);
        await gl.control('gitlab/pipelines', {
            project: PATH,
            ref: `task/r${counter}`,
            headOf: mr.iid,
            jobs: [
                { name: 'build', status: 'running' },
                { name: 'test', status: 'success' },
            ],
        });
        const waiting = await readReviewCollection(callOn(), REF, mr.iid, deadline());
        expect(waiting.requestedReviewers).toEqual({ users: ['rev-one', 'rev-two'], teams: [] });
        expect(waiting.decision).toBeNull();
        expect(waiting.pendingChecks).toBeGreaterThan(0);
        await reviewers(mr.iid, [{ login: 'rev-one', state: 'requested_changes' }]);
        const changes = await readReviewCollection(callOn(), REF, mr.iid, deadline());
        expect(changes.decision).toBe('CHANGES_REQUESTED');
    });

    it('counts a head pipeline of an older commit as pending (the stale-pipeline rule)', async () => {
        const mr = await openMr();
        await gl.control('gitlab/pipelines', {
            project: PATH,
            ref: `task/r${counter}`,
            sha: '1'.repeat(40),
            status: 'success',
            headOf: mr.iid,
        });
        expect((await readReviewCollection(callOn(), REF, mr.iid, deadline())).pendingChecks).toBe(1);
    });

    it('counts a reviewer in a state it does not know as requested, never as clean', async () => {
        const mr = await openMr();
        await reviewers(mr.iid, [{ login: 'rev-one', state: 'brand_new_state' }]);
        const { requestedReviewers } = await readReviewCollection(callOn(), REF, mr.iid, deadline());
        expect(requestedReviewers.users).toEqual(['rev-one']);
    });
});

/** A call answering from a script: `answer(method, path)` is the JSON of a 200, or a full answer. */
const scripted =
    (answer: (method: string, path: string) => unknown, seen: string[] = []): GitlabCall =>
    async (method, path) => {
        seen.push(`${method} ${path}`);
        const body = answer(method, path);
        if (body && typeof body === 'object' && 'ok' in body) return body as Awaited<ReturnType<GitlabCall>>;
        return { ok: true, status: 200, json: body, text: JSON.stringify(body) };
    };
const MR = (iid: number) => ({
    iid,
    state: 'opened',
    sha: 'a'.repeat(40),
    project_id: 1,
    target_project_id: 1,
    target_branch: 'main',
    web_url: `https://board.gitlab.test/${PATH}/-/merge_requests/${iid}`,
    head_pipeline: null,
});
const goodNote = (id: number, extra: object = {}) => ({
    id,
    body: 'b',
    system: false,
    resolvable: true,
    resolved: false,
    author: { username: 'rev-one' },
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
});
const goodDiscussion = (id: string, extra: object = {}) => ({
    id,
    individual_note: false,
    notes: [goodNote(1)],
    ...extra,
});
/** A scripted board answering the MR, its reviewers, its statuses and these discussion pages. */
const board = (pages: (page: number) => unknown) => (_method: string, path: string) => {
    if (/\/discussions\?/.test(path)) return pages(Number(/[?&]page=(\d+)/.exec(path)?.[1]));
    if (/\/reviewers/.test(path) || /\/statuses/.test(path)) return [];
    return MR(4);
};

describe('readReviewCollection: never a shorter list', () => {
    it('reads page after page until a short page ends the listing', async () => {
        const full = Array.from({ length: 100 }, (_, i) => goodDiscussion(`d${i}`, { notes: [goodNote(i + 1)] }));
        const seen: string[] = [];
        const call = scripted(
            board((page) => (page === 1 ? full : [goodDiscussion('last', { notes: [goodNote(500)] })])),
            seen
        );
        const { threads } = await readReviewCollection(call, REF, 4, deadline());
        expect(threads.length).toBeGreaterThan(0);
        expect(seen.filter((s) => /discussions\?/.test(s))).toHaveLength(2);
    });

    it('throws transport for a listing past the page cap', async () => {
        const full = Array.from({ length: 100 }, (_, i) => goodDiscussion(`d${i}`, { notes: [goodNote(i + 1)] }));
        expect(await kindOf(readReviewCollection(scripted(board(() => full)), REF, 4, deadline()))).toBe('transport');
    });

    it('throws transport when a later page fails or is not a list', async () => {
        const full = Array.from({ length: 100 }, (_, i) => goodDiscussion(`d${i}`, { notes: [goodNote(i + 1)] }));
        const failing = scripted((m, p) =>
            /page=2/.test(p) ? { ok: true, status: 500, json: null, text: '' } : board(() => full)(m, p)
        );
        expect(await kindOf(readReviewCollection(failing, REF, 4, deadline()))).toBe('transport');
        const odd = scripted(board((page) => (page === 1 ? full : { not: 'a list' })));
        expect(await kindOf(readReviewCollection(odd, REF, 4, deadline()))).toBe('transport');
    });

    it.each([
        ['a discussion without a string id', { id: 7 }],
        ['an individual_note that is not a boolean', { individual_note: 'no' }],
        ['notes that are empty', { notes: [] }],
        ['notes that are not a list', { notes: {} }],
        ['a note without an integer id', { notes: [goodNote(1, { id: '1' })] }],
        ['a note without a string body', { notes: [goodNote(1, { body: null })] }],
        ['a note without a boolean system', { notes: [goodNote(1, { system: undefined })] }],
        ['a note without a boolean resolvable', { notes: [goodNote(1, { resolvable: 1 })] }],
        ['a resolvable note without a boolean resolved', { notes: [goodNote(1, { resolved: undefined })] }],
        [
            'a position whose path is not a string',
            { notes: [goodNote(1, { position: position('a'.repeat(40), { new_path: 4, old_path: 4 }) })] },
        ],
        [
            'a position whose line is not an integer',
            { notes: [goodNote(1, { position: position('a'.repeat(40), { new_line: '7' }) })] },
        ],
    ])('throws transport for %s', async (_what, patch) => {
        const call = scripted(board(() => [goodDiscussion('d1', patch)]));
        expect(await kindOf(readReviewCollection(call, REF, 4, deadline()))).toBe('transport');
    });

    it.each([
        ['a reviewer without a username', [{ user: {}, state: 'unreviewed' }]],
        ['a reviewer without a string state', [{ user: { username: 'rev-one' }, state: 3 }]],
        ['reviewers that are not a list', { users: [] }],
    ])('throws transport for %s', async (_what, reviewers) => {
        const call = scripted((m, p) => (/\/reviewers/.test(p) ? reviewers : board(() => [])(m, p)));
        expect(await kindOf(readReviewCollection(call, REF, 4, deadline()))).toBe('transport');
    });
});

describe('readReviewCollection: classification and the deadline', () => {
    it.each([
        [401, 'transport'],
        [403, 'transport'],
        [500, 'transport'],
        [429, 'rate_limited'],
    ])('answers %i as %s', async (status, kind) => {
        const mr = await openMr();
        await fault({ pathIncludes: '/discussions', mode: 'status', status, count: 1 });
        expect(await kindOf(readReviewCollection(callOn(), REF, mr.iid, deadline()))).toBe(kind);
    });

    it('answers a malformed 2xx as transport', async () => {
        const mr = await openMr();
        await fault({ pathIncludes: '/discussions', mode: 'malformed', count: 1 });
        expect(await kindOf(readReviewCollection(callOn(), REF, mr.iid, deadline()))).toBe('transport');
    });

    it('answers a 404 that names the merge request as not_found, any other 404 as transport', async () => {
        expect(await kindOf(readReviewCollection(callOn(), REF, 9999, deadline()))).toBe('not_found');
        const nameless = scripted((_m, p) =>
            /discussions/.test(p) ? { ok: true, status: 404, json: { message: '404 Not Found' }, text: '' } : MR(4)
        );
        expect(await kindOf(readReviewCollection(nameless, REF, 4, deadline()))).toBe('transport');
    });

    it('rejects promptly when the signal aborts mid-listing, whichever request is in flight', async () => {
        const mr = await openMr();
        await fault({ pathIncludes: '/discussions', mode: 'timeout' });
        const started = Date.now();
        expect(await kindOf(readReviewCollection(callOn(), REF, mr.iid, deadline(FAST)))).toBe('transport');
        expect(Date.now() - started).toBeLessThan(FAST * 5);
        await fault({ mode: 'none' });
        await fault({ pathIncludes: '/reviewers', mode: 'timeout' });
        expect(await kindOf(readReviewCollection(callOn(), REF, mr.iid, deadline(FAST)))).toBe('transport');
    });

    it('keeps the call deadlines under the helper timeout, the read under the write', () => {
        expect(REVIEW_READ_DEADLINE_MS).toBeLessThan(REVIEW_WRITE_DEADLINE_MS);
        expect(REVIEW_WRITE_DEADLINE_MS).toBeLessThan(HELPER_TIMEOUT_MS);
    });
});

const plan = (mr: number, targets: Partial<ReviewPlanTarget>[]): ReviewPlan => ({
    version: 1,
    schema: 'review-reply/plan/v1',
    ref: { owner: 'grp/sub', repo: 'web', number: mr },
    targets: targets.map((t) => ({
        id: 'x',
        kind: 'thread',
        reply: null,
        resolve: false,
        firstCommentId: null,
        status: 'planned',
        reason: null,
        ...t,
    })),
});
const marked = (key: string, text = 'fixed') => `${text}\n\n${addressedMarker(key)}`;
const writesOn = () => gl.forge.calls().filter((c) => c.method !== 'GET' && c.path.includes('/merge_requests/'));

describe('replyReview', () => {
    it('replies in a thread, resolves it and replies in general, as the token holder', async () => {
        const mr = await openMr();
        const thread = await discuss(mr.iid, { body: 'fix', position: position(mr.sha) });
        const general = await discuss(mr.iid, { body: 'remark', individual: true });
        const key = `general:${general.noteId}`;
        const result = await replyReview(
            callOn(),
            { ref: REF, iid: mr.iid },
            plan(mr.iid, [
                { id: thread.id, kind: 'thread', reply: marked(`thread:${thread.id}`), firstCommentId: thread.noteId },
                { id: thread.id, kind: 'resolve', resolve: true },
                { id: key, kind: 'general', reply: marked(key, 'noted') },
            ]),
            { signal: deadline() }
        );
        expect(result).toMatchObject({ version: 1, schema: 'review-reply/v1', error: null });
        expect(result.ref).toEqual({ owner: 'grp/sub', repo: 'web', number: mr.iid });
        expect(result.results.map((r) => [r.kind, r.status, r.reason])).toEqual([
            ['thread', 'done', null],
            ['resolve', 'done', null],
            ['general', 'done', null],
        ]);
        const after = await discussionsOf(mr.iid);
        const mine = after.find((d) => d.id === thread.id)!;
        expect(mine.notes.at(-1)).toMatchObject({ author: { username: 'dev-one' } });
        expect(mine.notes.every((n) => n.resolved)).toBe(true);
        expect(
            after.flatMap((d) => d.notes).some((n) => n.author.username === 'dev-one' && n.body.includes('noted'))
        ).toBe(true);
    });

    it('refuses nothing it already did: a second run is all noop and writes nothing', async () => {
        const mr = await openMr();
        const thread = await discuss(mr.iid, { body: 'fix', position: position(mr.sha) });
        const targets = [
            {
                id: thread.id,
                kind: 'thread' as const,
                reply: marked(`thread:${thread.id}`),
                firstCommentId: thread.noteId,
            },
            { id: thread.id, kind: 'resolve' as const, resolve: true },
        ];
        await replyReview(callOn(), { ref: REF, iid: mr.iid }, plan(mr.iid, targets), { signal: deadline() });
        const before = writesOn().length;
        const again = await replyReview(callOn(), { ref: REF, iid: mr.iid }, plan(mr.iid, targets), {
            signal: deadline(),
        });
        expect(again.results.map((r) => [r.status, r.reason])).toEqual([
            ['noop', 'already_replied'],
            ['noop', 'already_resolved'],
        ]);
        expect(writesOn()).toHaveLength(before);
    });

    it('answers a discussion that is not on this merge request as a noop, sending nothing', async () => {
        const mr = await openMr();
        const other = await openMr();
        const elsewhere = await discuss(other.iid, { body: 'other', position: position(other.sha) });
        const before = writesOn().length;
        const result = await replyReview(
            callOn(),
            { ref: REF, iid: mr.iid },
            plan(mr.iid, [
                { id: elsewhere.id, kind: 'thread', reply: marked(`thread:${elsewhere.id}`) },
                { id: elsewhere.id, kind: 'resolve', resolve: true },
            ]),
            { signal: deadline() }
        );
        expect(result.results.map((r) => [r.status, r.reason])).toEqual([
            ['noop', 'not_found'],
            ['noop', 'not_found'],
        ]);
        expect(writesOn()).toHaveLength(before);
    });

    it('refuses a reply without its own marker as unmarked, sending nothing', async () => {
        const mr = await openMr();
        const thread = await discuss(mr.iid, { body: 'fix', position: position(mr.sha) });
        const before = writesOn().length;
        const result = await replyReview(
            callOn(),
            { ref: REF, iid: mr.iid },
            plan(mr.iid, [
                { id: thread.id, kind: 'thread', reply: 'no marker here' },
                { id: thread.id, kind: 'thread', reply: marked('thread:someone-else') },
                { id: 'general:1', kind: 'general', reply: 'plain' },
            ]),
            { signal: deadline() }
        );
        expect(result.results.map((r) => [r.status, r.reason])).toEqual([
            ['refused', 'unmarked'],
            ['refused', 'unmarked'],
            ['refused', 'unmarked'],
        ]);
        expect(writesOn()).toHaveLength(before);
    });

    it('echoes a target the plan refused, and refuses an inline target as unsupported', async () => {
        const mr = await openMr();
        const before = writesOn().length;
        const result = await replyReview(
            callOn(),
            { ref: REF, iid: mr.iid },
            plan(mr.iid, [
                { id: 'a', kind: 'thread', status: 'refused', reason: 'unknown_target' },
                { id: '5', kind: 'inline', reply: marked('inline:5') },
            ]),
            { signal: deadline() }
        );
        expect(result.results.map((r) => [r.status, r.reason])).toEqual([
            ['refused', 'unknown_target'],
            ['refused', 'unsupported'],
        ]);
        expect(writesOn()).toHaveLength(before);
    });

    it('sends one reply once when the plan names its key twice', async () => {
        const mr = await openMr();
        const thread = await discuss(mr.iid, { body: 'fix', position: position(mr.sha) });
        const twice = { id: thread.id, kind: 'thread' as const, reply: marked(`thread:${thread.id}`) };
        const result = await replyReview(callOn(), { ref: REF, iid: mr.iid }, plan(mr.iid, [twice, twice]), {
            signal: deadline(),
        });
        expect(result.results.map((r) => r.status)).toEqual(['done', 'noop']);
        expect((await discussionsOf(mr.iid)).find((d) => d.id === thread.id)?.notes).toHaveLength(2);
    });

    describe('a write whose answer is lost', () => {
        it('is read back and is done when the note landed, and was sent once', async () => {
            const mr = await openMr();
            const thread = await discuss(mr.iid, { body: 'fix', position: position(mr.sha) });
            await fault({ pathIncludes: `/discussions/${thread.id}/notes`, mode: 'lost', count: 5 });
            const result = await replyReview(
                callOn(),
                { ref: REF, iid: mr.iid },
                plan(mr.iid, [{ id: thread.id, kind: 'thread', reply: marked(`thread:${thread.id}`) }]),
                { signal: deadline(), attemptMs: FAST }
            );
            expect(result.results.map((r) => [r.status, r.reason])).toEqual([['done', null]]);
            expect((await discussionsOf(mr.iid)).find((d) => d.id === thread.id)?.notes).toHaveLength(2);
        });

        it('is refused unconfirmed when the note did not land, and still sent once', async () => {
            const mr = await openMr();
            const thread = await discuss(mr.iid, { body: 'fix', position: position(mr.sha) });
            await fault({ pathIncludes: `/discussions/${thread.id}/notes`, mode: 'status', status: 502, count: 5 });
            const result = await replyReview(
                callOn(),
                { ref: REF, iid: mr.iid },
                plan(mr.iid, [{ id: thread.id, kind: 'thread', reply: marked(`thread:${thread.id}`) }]),
                { signal: deadline(), attemptMs: FAST }
            );
            expect(result.results.map((r) => [r.status, r.reason])).toEqual([['refused', 'unconfirmed']]);
            const posts = gl.forge.calls().filter((c) => c.method === 'POST' && c.path.endsWith(`${thread.id}/notes`));
            expect(posts).toHaveLength(1);
            expect((await discussionsOf(mr.iid)).find((d) => d.id === thread.id)?.notes).toHaveLength(1);
        });

        it('reads a lost resolve back: done when resolved, refused unconfirmed otherwise', async () => {
            const mr = await openMr();
            const thread = await discuss(mr.iid, { body: 'fix', position: position(mr.sha) });
            const resolve = plan(mr.iid, [{ id: thread.id, kind: 'resolve', resolve: true }]);
            await fault({ pathIncludes: `/discussions/${thread.id}`, mode: 'status', status: 500, count: 1 });
            const failed = await replyReview(callOn(), { ref: REF, iid: mr.iid }, resolve, {
                signal: deadline(),
                attemptMs: FAST,
            });
            expect(failed.results.map((r) => [r.status, r.reason])).toEqual([['refused', 'unconfirmed']]);
            await fault({ mode: 'none' });
            await fault({ pathIncludes: `/discussions/${thread.id}`, mode: 'lost', count: 1 });
            const lost = await replyReview(callOn(), { ref: REF, iid: mr.iid }, resolve, {
                signal: deadline(),
                attemptMs: FAST,
            });
            expect(lost.results.map((r) => [r.status, r.reason])).toEqual([['done', null]]);
        });

        it('is refused unconfirmed when the read-back itself fails', async () => {
            const mr = await openMr();
            const thread = await discuss(mr.iid, { body: 'fix', position: position(mr.sha) });
            await fault({ pathIncludes: `/discussions/${thread.id}`, mode: 'status', status: 500, count: 1 });
            const result = await replyReview(
                callOn(),
                { ref: REF, iid: mr.iid },
                plan(mr.iid, [{ id: thread.id, kind: 'thread', reply: marked(`thread:${thread.id}`) }]),
                { signal: deadline(), attemptMs: FAST }
            );
            expect(result.results[0]).toMatchObject({ status: 'refused', reason: 'unconfirmed' });
        });
    });

    it.each([
        [401, 'refused', 'auth'],
        [403, 'refused', 'permission'],
        [429, 'refused', 'rate'],
    ])('answers a %i on the write as %s %s', async (status, outcome, reason) => {
        const mr = await openMr();
        const thread = await discuss(mr.iid, { body: 'fix', position: position(mr.sha) });
        await fault({ pathIncludes: `/discussions/${thread.id}/notes`, mode: 'status', status, count: 1 });
        const result = await replyReview(
            callOn(),
            { ref: REF, iid: mr.iid },
            plan(mr.iid, [{ id: thread.id, kind: 'thread', reply: marked(`thread:${thread.id}`) }]),
            { signal: deadline() }
        );
        expect(result.results[0]).toMatchObject({ status: outcome, reason });
    });

    it('answers a 404 naming the discussion as noop, any other 404 as refused', async () => {
        const mr = await openMr();
        const target = { id: 'd1', kind: 'thread' as const, reply: marked('thread:d1') };
        const calls = (write: object) =>
            scripted((m, p) => {
                if (m === 'POST') return write;
                if (/\/discussions\?/.test(p)) return [goodDiscussion('d1')];
                if (/\/reviewers/.test(p)) return [];
                return MR(mr.iid);
            });
        const named = calls({ ok: true, status: 404, json: { message: '404 Discussion Not Found' }, text: '' });
        expect(
            (await replyReview(named, { ref: REF, iid: mr.iid }, plan(mr.iid, [target]), { signal: deadline() }))
                .results[0]
        ).toMatchObject({
            status: 'noop',
            reason: 'not_found',
        });
        const nameless = calls({ ok: true, status: 404, json: { message: '404 Not Found' }, text: '' });
        expect(
            (await replyReview(nameless, { ref: REF, iid: mr.iid }, plan(mr.iid, [target]), { signal: deadline() }))
                .results[0]?.status
        ).toBe('refused');
    });

    it('refuses as not_sent when the request never reached GitLab', async () => {
        const target = { id: 'd1', kind: 'thread' as const, reply: marked('thread:d1') };
        const call = scripted((m, p) => {
            if (m === 'POST') return { ok: false, reason: 'unreachable', sent: false };
            if (/\/discussions\?/.test(p)) return [goodDiscussion('d1')];
            return MR(4);
        });
        const result = await replyReview(call, { ref: REF, iid: 4 }, plan(4, [target]), { signal: deadline() });
        expect(result.results[0]).toMatchObject({ status: 'refused', reason: 'not_sent' });
    });

    it('throws transport, and writes nothing, when the first discussion read fails', async () => {
        const mr = await openMr();
        const thread = await discuss(mr.iid, { body: 'fix', position: position(mr.sha) });
        await fault({ pathIncludes: '/discussions', mode: 'status', status: 500, count: 1 });
        const before = writesOn().length;
        const run = replyReview(
            callOn(),
            { ref: REF, iid: mr.iid },
            plan(mr.iid, [{ id: thread.id, kind: 'thread', reply: marked(`thread:${thread.id}`) }]),
            { signal: deadline() }
        );
        expect(await kindOf(run)).toBe('transport');
        expect(writesOn()).toHaveLength(before);
    });
});
