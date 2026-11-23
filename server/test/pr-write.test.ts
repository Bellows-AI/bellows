import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubWriteError, createPrWriter, type PrWriter } from '../src/github/pr-write.js';
import { type FakeGithub, startFakeGithub } from '../test-db/fake-github.js';

const REPO = 'acme/widgets';
const ASK = { branch: 'task/one', base: 'main', create: { title: 'T', body: 'B', draft: false } };
const DEADLINE_MS = 5_000;

let fake: FakeGithub;
let user: string;
let installation: string;
let writer: PrWriter;

const auth = (token: string, signal: AbortSignal = AbortSignal.timeout(DEADLINE_MS)) => ({ token, signal });
const failure = async (run: Promise<unknown>): Promise<GitHubWriteError> => {
    const error = await run.then(
        () => null,
        (e: unknown) => e
    );
    expect(error).toBeInstanceOf(GitHubWriteError);
    return error as GitHubWriteError;
};
const hasFile = (dir: string, name: string) => existsSync(join(dir, name));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await done()); i += 1) await sleep(50);
};

beforeEach(async () => {
    fake = await startFakeGithub();
    user = (await fake.signIn()).access_token;
    installation = await fake.installationToken();
    writer = createPrWriter({ apiUrl: fake.base, fetchFn: fetch });
});
afterEach(() => fake.stop());

describe('findPullRequest', () => {
    it('answers null for a validated empty list and the facts of an open PR by head', async () => {
        expect(await writer.findPullRequest(REPO, 'task/one', auth(user))).toBeNull();
        await writer.openPullRequest(REPO, ASK, auth(user));
        expect(await writer.findPullRequest(REPO, 'task/one', auth(user))).toEqual({
            url: 'https://github.com/acme/widgets/pull/1',
            number: 1,
            base: 'main',
            state: 'open',
        });
        expect(await writer.findPullRequest(REPO, 'task/other', auth(user))).toBeNull();
    });

    it.each([
        ['a non-array body', { message: 'nope' }],
        ['an entry with no number', [{ html_url: 'https://github.com/acme/widgets/pull/1', base: { ref: 'main' } }]],
        ['an entry with no html_url', [{ number: 1, base: { ref: 'main' } }]],
        ['an entry with no base.ref', [{ number: 1, html_url: 'https://github.com/acme/widgets/pull/1' }]],
    ])('is uncertain, never "no PR", for %s', async (_name, payload) => {
        const stub = createPrWriter({
            apiUrl: fake.base,
            fetchFn: async () => new Response(JSON.stringify(payload), { status: 200 }),
        });
        expect((await failure(stub.findPullRequest(REPO, 'task/one', auth(user)))).kind).toBe('uncertain');
    });
});

describe('openPullRequest', () => {
    it('creates with the token it was given', async () => {
        const opened = await writer.openPullRequest(REPO, ASK, auth(user));
        expect(opened).toMatchObject({
            operation: 'created',
            pr: { number: 1, url: 'https://github.com/acme/widgets/pull/1', base: 'main' },
        });
        const posts = fake.calls().filter((c) => c.method === 'POST' && c.path === `/repos/${REPO}/pulls`);
        expect(posts.map((c) => c.tokenKind)).toEqual(['user']);
        expect((await fake.pulls()).map((p) => p.createdBy)).toEqual(['user']);
    });

    it('creates as the installation when handed the installation token', async () => {
        await writer.openPullRequest(REPO, ASK, auth(installation));
        expect((await fake.pulls()).map((p) => p.createdBy)).toEqual(['installation']);
    });

    it('reuses the PR a replayed ask finds by head', async () => {
        await writer.openPullRequest(REPO, ASK, auth(user));
        const again = await writer.openPullRequest(REPO, ASK, auth(user));
        expect(again).toMatchObject({ operation: 'reused', pr: { number: 1 } });
        expect(await fake.pulls()).toHaveLength(1);
    });

    it('views again when the create is refused as a duplicate, and reuses the PR', async () => {
        await writer.openPullRequest(REPO, ASK, auth(user));
        // a stale first view: it saw nothing, the create then meets the PR another attempt opened
        let listed = 0;
        const stale = createPrWriter({
            apiUrl: fake.base,
            fetchFn: async (input, init) => {
                const isList = init?.method === undefined && String(input).includes('/pulls?');
                listed += isList ? 1 : 0;
                if (isList && listed === 1) return new Response('[]', { status: 200 });
                return fetch(input, init);
            },
        });
        const opened = await stale.openPullRequest(REPO, ASK, auth(user));
        expect(opened).toMatchObject({ operation: 'reused', pr: { number: 1 } });
        expect(await fake.pulls()).toHaveLength(1);
    });

    it('opens no second PR when the answer to a create was lost', async () => {
        writeFileSync(join(fake.stateDir, 'hold'), '');
        const lost = new AbortController();
        const first = failure(writer.openPullRequest(REPO, ASK, auth(user, lost.signal)));
        await until(async () => hasFile(fake.stateDir, 'hold.ready'));
        lost.abort();
        expect((await first).kind).toBe('uncertain');
        writeFileSync(join(fake.stateDir, 'hold.go'), '');
        await until(async () => (await fake.pulls()).length === 1);
        const replay = await writer.openPullRequest(REPO, ASK, auth(user));
        expect(replay).toMatchObject({ operation: 'reused', pr: { number: 1 } });
        expect(await fake.pulls()).toHaveLength(1);
    });
});

describe('edit and retarget', () => {
    it('PATCHes the base of an open PR on another base, with the member token', async () => {
        await writer.openPullRequest(REPO, ASK, auth(user));
        const moved = await writer.retarget(REPO, 1, 'release', auth(user));
        expect(moved.base).toBe('release');
        const patches = fake.calls().filter((c) => c.method === 'PATCH');
        expect(patches.map((c) => c.tokenKind)).toEqual(['user']);
        expect((await fake.pulls())[0]?.base.ref).toBe('release');
    });

    it('edits title and body in one PATCH', async () => {
        await writer.openPullRequest(REPO, ASK, auth(user));
        await writer.edit(REPO, 1, { title: 'New', body: 'Text' }, auth(user));
        expect((await fake.pulls())[0]).toMatchObject({ title: 'New', body: 'Text', base: { ref: 'main' } });
        expect(fake.calls().filter((c) => c.method === 'PATCH')).toHaveLength(1);
    });
});

describe('classification', () => {
    const answering = (status: number, body: unknown = { message: 'x' }, headers: Record<string, string> = {}) =>
        createPrWriter({
            apiUrl: fake.base,
            fetchFn: async () => new Response(JSON.stringify(body), { status, headers }),
        });

    it.each([401, 403, 404])('%i is denied', async (status) => {
        const error = await failure(answering(status).retarget(REPO, 1, 'main', auth(user)));
        expect(error.kind).toBe('denied');
    });

    it('a rate limit is uncertain, not a denial', async () => {
        const limited = answering(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
        expect((await failure(limited.retarget(REPO, 1, 'main', auth(user)))).kind).toBe('uncertain');
    });

    it('a 5xx is uncertain', async () => {
        expect((await failure(answering(502).retarget(REPO, 1, 'main', auth(user)))).kind).toBe('uncertain');
    });

    it('another 422 is refused, once the re-view still finds nothing', async () => {
        const refusing = createPrWriter({
            apiUrl: fake.base,
            fetchFn: async (input, init) =>
                init?.method === 'POST'
                    ? new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 })
                    : fetch(input, init),
        });
        expect((await failure(refusing.openPullRequest(REPO, ASK, auth(user)))).kind).toBe('refused');
    });

    it('a transport failure is uncertain', async () => {
        const down = createPrWriter({
            apiUrl: fake.base,
            fetchFn: async () => {
                throw new TypeError('fetch failed');
            },
        });
        expect((await failure(down.findPullRequest(REPO, 'task/one', auth(user)))).kind).toBe('uncertain');
    });

    it('an aborted signal is uncertain', async () => {
        expect((await failure(writer.findPullRequest(REPO, 'task/one', auth(user, AbortSignal.abort())))).kind).toBe(
            'uncertain'
        );
    });

    it('never puts the token in an error', async () => {
        const error = await failure(answering(403).retarget(REPO, 1, 'main', auth('ghu_secret')));
        expect(error.message).not.toContain('ghu_secret');
    });
});

describe('stream settlement', () => {
    it('rejects uncertain when the body stream errors after the first chunk', async () => {
        const cut = createPrWriter({
            apiUrl: fake.base,
            fetchFn: async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode('[{"num'));
                            controller.error(new Error('socket closed'));
                        },
                    }),
                    { status: 200 }
                ),
        });
        expect((await failure(cut.findPullRequest(REPO, 'task/one', auth(user)))).kind).toBe('uncertain');
    });

    it('settles on the deadline when the body never ends', async () => {
        const hung = createPrWriter({
            apiUrl: fake.base,
            fetchFn: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
        });
        const started = Date.now();
        const error = await failure(hung.findPullRequest(REPO, 'task/one', auth(user, AbortSignal.timeout(200))));
        expect(error.kind).toBe('uncertain');
        expect(Date.now() - started).toBeLessThan(DEADLINE_MS);
    });
});
