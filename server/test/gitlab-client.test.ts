import { parseRepoRef, type RepoRef } from '@factory-ai/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChangeRequestReadUnsupportedError } from '../src/forge/change-request-read.js';
import { createGitLabForgeClient } from '../src/forge/gitlab-client.js';
import type { ForgeClient } from '../src/forge/forge-client.js';
import type { GitHubWriteError } from '../src/github/pr-write.js';
import { createGitlabApi, type GitlabApi, type GitlabRequest, type GitlabResponse } from '../src/gitlab/gitlab-api.js';
import { type FakeGitlab, startFakeGitlab } from '../test-db/fake-gitlab.js';

/**
 * The GitLab adapter's writes (docs/gitlab.md): against the in-process fake for what GitLab does, and over a scripted
 * `request` for the answers a real instance gives that the fake cannot (a fork, a malformed page, a status).
 */
const PATH = 'grp/sub/web';
const ENCODED = 'grp%2Fsub%2Fweb';
const REF = parseRepoRef(`gitlab:board.gitlab.test/${PATH}`) as RepoRef;
const SECRET = 'glpat-never-in-a-message';
const TOPIC = 'task/one';
const CREATE = { title: 'Add the thing', body: 'Why', draft: true };
const signal = () => new AbortController().signal;

let gl: FakeGitlab;
let token: string;

beforeAll(async () => {
    gl = await startFakeGitlab();
});
beforeEach(async () => {
    await gl.control('gitlab/faults', { mode: 'none' });
    await gl.control('gitlab/projects', { path: PATH, files: { 'README.md': 'x\n' } });
    // A fresh project path per test is not available: each test names its own source branch instead.
    token = (await gl.signIn('dev')).access_token;
});

afterAll(() => gl.stop());

const fakeApi = () => createGitlabApi({ baseUrl: () => gl.base, probeTimeoutMs: 400 });
const clientOn = (api: GitlabApi, credential = token): ForgeClient =>
    createGitLabForgeClient({ api, caBundle: undefined }, REF, { kind: 'token', token: credential });
const onFake = () => clientOn(fakeApi());
let counter = 0;
/** A source branch no other test used, with a commit on it. */
const branch = async () => {
    const name = `task/b${++counter}`;
    await gl.control('gitlab/commit', {
        project: PATH,
        branch: name,
        files: { [`${name}.txt`]: 'x' },
        message: 'work',
    });
    return name;
};
const mrs = async () =>
    (await gl.send('GET', `/api/v4/projects/${ENCODED}/merge_requests?state=all`, { token })).body as Array<{
        iid: number;
        title: string;
        draft: boolean;
        description: string;
        target_branch: string;
        source_branch: string;
    }>;
const mrCalls = () =>
    gl.forge.calls().filter((call) => call.path.startsWith(`/api/v4/projects/${ENCODED}/merge_requests`));

/** A `request` answering from a script, recording what it was asked. */
const scripted = (answer: (request: GitlabRequest) => GitlabResponse | Promise<GitlabResponse>) => {
    const seen: GitlabRequest[] = [];
    const api = {
        request: async (request: GitlabRequest) => {
            seen.push(request);
            return answer(request);
        },
    } as unknown as GitlabApi;
    return { api, seen };
};
const json = (status: number, body: unknown): GitlabResponse => ({ ok: true, status, text: JSON.stringify(body) });
const mr = (over: Record<string, unknown> = {}) => ({
    iid: 7,
    web_url: `https://board.gitlab.test/${PATH}/-/merge_requests/7`,
    source_branch: TOPIC,
    target_branch: 'main',
    source_project_id: 1,
    target_project_id: 1,
    state: 'opened',
    draft: false,
    title: 'T',
    ...over,
});

describe('GitLabClient views', () => {
    it('finds the open MR by source branch under the URL-encoded full path, or null for a validated []', async () => {
        const client = onFake();
        const name = await branch();
        expect(await client.findChangeRequest(name, signal())).toBeNull();
        const opened = await client.openChangeRequest({ branch: name, base: 'main', create: CREATE }, signal());
        const found = await client.findChangeRequest(name, signal());
        expect(found).toEqual({ ...opened.pr, state: 'open' });
        expect(found).toMatchObject({ base: 'main', url: expect.stringMatching(/\/-\/merge_requests\/\d+$/) });
        expect(mrCalls().every((call) => call.path.startsWith(`/api/v4/projects/${ENCODED}/`))).toBe(true);
    });

    it('asks only for open MRs of the branch', async () => {
        const { api, seen } = scripted(() => json(200, []));
        await clientOn(api).findChangeRequest(TOPIC, signal());
        expect(seen[0]?.path).toMatch(
            new RegExp(
                `^/api/v4/projects/${ENCODED}/merge_requests\\?.*source_branch=task%2Fone.*state=opened|state=opened.*source_branch`
            )
        );
        expect(seen[0]?.headers).toMatchObject({ authorization: `Bearer ${token}` });
    });

    it('ignores an open MR from a fork with the same source branch name', async () => {
        const { api } = scripted(() => json(200, [mr({ iid: 3, source_project_id: 99 })]));
        expect(await clientOn(api).findChangeRequest(TOPIC, signal())).toBeNull();
    });

    it('is uncertain when two same-project MRs are open on the branch, and when one entry is malformed', async () => {
        const two = scripted(() => json(200, [mr({ iid: 1 }), mr({ iid: 2, target_branch: 'next' })]));
        await expect(clientOn(two.api).findChangeRequest(TOPIC, signal())).rejects.toMatchObject({
            kind: 'uncertain',
        });
        const bad = scripted(() => json(200, [mr(), { iid: 'x' }]));
        await expect(clientOn(bad.api).findChangeRequest(TOPIC, signal())).rejects.toMatchObject({
            kind: 'uncertain',
        });
        const notList = scripted(() => json(200, { message: 'nope' }));
        await expect(clientOn(notList.api).findChangeRequest(TOPIC, signal())).rejects.toMatchObject({
            kind: 'uncertain',
        });
    });
});

describe('GitLabClient.openChangeRequest', () => {
    it('creates a draft with the `Draft: ` title prefix and no draft field', async () => {
        const name = await branch();
        const { api, seen } = scripted((request) =>
            request.method === 'POST'
                ? json(201, mr({ source_branch: name, title: 'Draft: Add the thing' }))
                : json(200, [])
        );
        const opened = await clientOn(api).openChangeRequest({ branch: name, base: 'main', create: CREATE }, signal());
        expect(opened.operation).toBe('created');
        const post = JSON.parse(seen.find((request) => request.method === 'POST')?.body as string);
        expect(post).toEqual({
            source_branch: name,
            target_branch: 'main',
            title: 'Draft: Add the thing',
            description: 'Why',
        });
        expect(post).not.toHaveProperty('draft');

        const name2 = await branch();
        await onFake().openChangeRequest({ branch: name2, base: 'main', create: CREATE }, signal());
        const made = (await mrs()).find((one) => one.source_branch === name2);
        expect(made).toMatchObject({ draft: true, title: 'Draft: Add the thing', description: 'Why' });
    });

    it('creates a ready MR with the title as given, and clips a title past GitLab’s 255 with the prefix', async () => {
        const name = await branch();
        const long = 'x'.repeat(250);
        await onFake().openChangeRequest(
            { branch: name, base: 'main', create: { title: long, body: '', draft: true } },
            signal()
        );
        const made = (await mrs()).find((one) => one.source_branch === name);
        expect(made?.title.length).toBe(255);
        expect(made?.title.startsWith('Draft: x')).toBe(true);
        const ready = await branch();
        await onFake().openChangeRequest(
            { branch: ready, base: 'main', create: { title: 'Ready', body: '', draft: false } },
            signal()
        );
        expect((await mrs()).find((one) => one.source_branch === ready)).toMatchObject({
            title: 'Ready',
            draft: false,
        });
    });

    it('views first and answers reused with no POST when an MR exists', async () => {
        const name = await branch();
        const client = onFake();
        const first = await client.openChangeRequest({ branch: name, base: 'main', create: CREATE }, signal());
        const posts = () => mrCalls().filter((call) => call.method === 'POST').length;
        const before = posts();
        const again = await client.openChangeRequest({ branch: name, base: 'main', create: CREATE }, signal());
        expect(again).toMatchObject({ operation: 'reused', pr: { number: first.pr.number } });
        expect(posts()).toBe(before);
    });

    it('reuses the MR on the asked base when two are open, and is uncertain when none of two is', async () => {
        const both = scripted(() => json(200, [mr({ iid: 1, target_branch: 'next' }), mr({ iid: 2 })]));
        const reused = await clientOn(both.api).openChangeRequest(
            { branch: TOPIC, base: 'main', create: CREATE },
            signal()
        );
        expect(reused).toMatchObject({ operation: 'reused', pr: { number: 2 } });
        const none = scripted(() =>
            json(200, [mr({ iid: 1, target_branch: 'a' }), mr({ iid: 2, target_branch: 'b' })])
        );
        await expect(
            clientOn(none.api).openChangeRequest({ branch: TOPIC, base: 'main', create: CREATE }, signal())
        ).rejects.toMatchObject({ kind: 'uncertain' });
        expect(none.seen.every((request) => request.method !== 'POST')).toBe(true);
    });

    it('reconciles a create whose answer was lost by view: reused, and exactly one MR on the fake', async () => {
        const name = await branch();
        await gl.control('gitlab/faults', {
            mode: 'lost',
            pathIncludes: 'merge_requests',
            after: 1,
            count: 1,
        });
        const opened = await onFake().openChangeRequest({ branch: name, base: 'main', create: CREATE }, signal());
        expect(opened.operation).toBe('reused');
        expect((await mrs()).filter((one) => one.source_branch === name)).toHaveLength(1);
    });

    it('is uncertain, with no second POST, when the create is lost and the reconcile view finds nothing', async () => {
        let posts = 0;
        const { api } = scripted((request) => {
            if (request.method === 'POST') {
                posts += 1;
                return { ok: false, reason: 'timeout', sent: true };
            }
            return json(200, []);
        });
        await expect(
            clientOn(api).openChangeRequest({ branch: TOPIC, base: 'main', create: CREATE }, signal())
        ).rejects.toMatchObject({ kind: 'uncertain' });
        expect(posts).toBe(1);
    });

    it('reconciles a 409 “already exists” by view to reused, never an error', async () => {
        let listed = 0;
        const { api } = scripted((request) => {
            if (request.method === 'POST') {
                return json(409, { message: ['Another open merge request already exists for this source branch: !7'] });
            }
            listed += 1;
            return json(200, listed === 1 ? [] : [mr()]);
        });
        const opened = await clientOn(api).openChangeRequest({ branch: TOPIC, base: 'main', create: CREATE }, signal());
        expect(opened).toMatchObject({ operation: 'reused', pr: { number: 7 } });
    });

    it('answers a 409 whose reconcile finds nothing as uncertain', async () => {
        const { api } = scripted((request) =>
            request.method === 'POST'
                ? json(409, { message: 'Another open merge request already exists' })
                : json(200, [])
        );
        await expect(
            clientOn(api).openChangeRequest({ branch: TOPIC, base: 'main', create: CREATE }, signal())
        ).rejects.toMatchObject({ kind: 'uncertain' });
    });

    it('does not reconcile a denied create', async () => {
        const { api, seen } = scripted((request) => (request.method === 'POST' ? json(403, {}) : json(200, [])));
        await expect(
            clientOn(api).openChangeRequest({ branch: TOPIC, base: 'main', create: CREATE }, signal())
        ).rejects.toMatchObject({ kind: 'denied', status: 403 });
        expect(seen.filter((request) => request.method === 'GET')).toHaveLength(1);
    });
});

describe('GitLabClient edits', () => {
    it('keeps a draft MR a draft when its title is edited, and changes the description', async () => {
        const name = await branch();
        const client = onFake();
        const { pr } = await client.openChangeRequest({ branch: name, base: 'main', create: CREATE }, signal());
        await client.editChangeRequest(pr.number, { title: 'Better title', body: 'New body' }, signal());
        expect((await mrs()).find((one) => one.iid === pr.number)).toMatchObject({
            title: 'Draft: Better title',
            draft: true,
            description: 'New body',
        });
    });

    it('does not draft a ready MR, and does not double a prefix the title already has', async () => {
        const name = await branch();
        const client = onFake();
        const { pr } = await client.openChangeRequest(
            { branch: name, base: 'main', create: { ...CREATE, draft: false } },
            signal()
        );
        await client.editChangeRequest(pr.number, { title: 'Plain' }, signal());
        expect((await mrs()).find((one) => one.iid === pr.number)).toMatchObject({ title: 'Plain', draft: false });
        const drafted = scripted((request) =>
            request.method === 'GET' ? json(200, mr({ draft: true })) : json(200, mr())
        );
        await clientOn(drafted.api).editChangeRequest(7, { title: 'Draft: Already' }, signal());
        expect(JSON.parse(drafted.seen[1]?.body as string)).toEqual({ title: 'Draft: Already' });
    });

    it('is uncertain, and sends no PUT, when the read of the MR before the edit fails', async () => {
        const { api, seen } = scripted(() => ({ ok: false, reason: 'unreachable', sent: true }));
        await expect(clientOn(api).editChangeRequest(7, { title: 'T' }, signal())).rejects.toMatchObject({
            kind: 'uncertain',
        });
        expect(seen.every((request) => request.method === 'GET')).toBe(true);
    });

    it('retargets in the same PUT when the edit carries a base, and retarget sends target_branch only', async () => {
        const name = await branch();
        await gl.control('gitlab/commit', { project: PATH, branch: 'next', files: { 'n.txt': 'n' }, message: 'n' });
        const client = onFake();
        const { pr } = await client.openChangeRequest({ branch: name, base: 'main', create: CREATE }, signal());
        const edited = await client.editChangeRequest(pr.number, { base: 'next', body: 'moved' }, signal());
        expect(edited.base).toBe('next');
        expect((await mrs()).find((one) => one.iid === pr.number)).toMatchObject({
            target_branch: 'next',
            description: 'moved',
        });
        const spy = scripted(() => json(200, mr({ target_branch: 'main' })));
        await clientOn(spy.api).retargetChangeRequest(7, 'main', signal());
        expect(spy.seen).toHaveLength(1);
        expect(spy.seen[0]).toMatchObject({ method: 'PUT' });
        expect(JSON.parse(spy.seen[0]?.body as string)).toEqual({ target_branch: 'main' });
        expect(spy.seen[0]?.path).toBe(`/api/v4/projects/${ENCODED}/merge_requests/7`);
    });
});

describe('GitLabClient classification', () => {
    const outcome = async (answer: GitlabResponse) => {
        const { api } = scripted(() => answer);
        return clientOn(api, SECRET)
            .retargetChangeRequest(7, 'main', signal())
            .then(
                () => 'ok',
                (e: unknown) => e as GitHubWriteError
            );
    };
    const kindOf = async (answer: GitlabResponse) => {
        const result = await outcome(answer);
        return typeof result === 'string' ? result : `${result.kind}:${result.status}`;
    };

    it('403 and 404 are denied; 400 and 422 are refused', async () => {
        expect(await kindOf(json(403, {}))).toBe('denied:403');
        expect(await kindOf(json(404, {}))).toBe('denied:404');
        expect(await kindOf(json(400, {}))).toBe('refused:400');
        expect(await kindOf(json(422, {}))).toBe('refused:422');
    });

    it('5xx, 401, 409, transport, timeout, malformed JSON and a 2xx without the facts are uncertain', async () => {
        expect(await kindOf(json(500, {}))).toBe('uncertain:500');
        expect(await kindOf(json(503, {}))).toBe('uncertain:503');
        expect(await kindOf(json(401, {}))).toBe('uncertain:401');
        expect(await kindOf(json(409, {}))).toBe('uncertain:409');
        expect(await kindOf({ ok: false, reason: 'unreachable', sent: false })).toBe('uncertain:null');
        expect(await kindOf({ ok: false, reason: 'timeout', sent: true })).toBe('uncertain:null');
        expect(await kindOf({ ok: true, status: 200, text: '<html>' })).toBe('uncertain:null');
        expect(await kindOf(json(200, { iid: 7 }))).toBe('uncertain:null');
        expect(await kindOf(json(200, mr({ web_url: 3 })))).toBe('uncertain:null');
        expect(await kindOf(json(200, mr({ target_branch: undefined })))).toBe('uncertain:null');
    });

    it('puts the token in no error message', async () => {
        for (const answer of [
            json(403, { message: 'no' }),
            json(500, { message: 'boom' }),
            { ok: true, status: 200, text: 'x' } as GitlabResponse,
        ]) {
            const result = await outcome(answer);
            expect(String((result as Error).message)).not.toContain(SECRET);
        }
    });

    it('refuses a write with no token credential as denied, with no request', async () => {
        const { api, seen } = scripted(() => json(200, []));
        const client = createGitLabForgeClient({ api, caBundle: undefined }, REF, { kind: 'installation' });
        await expect(client.findChangeRequest(TOPIC, signal())).rejects.toMatchObject({ kind: 'denied' });
        expect(seen).toEqual([]);
    });

    it('sends the connection’s CA bundle and the caller’s signal with every call', async () => {
        const { api, seen } = scripted(() => json(200, []));
        const controller = new AbortController();
        const client = createGitLabForgeClient({ api, caBundle: 'PEM' }, REF, { kind: 'token', token });
        await client.findChangeRequest(TOPIC, controller.signal);
        expect(seen[0]).toMatchObject({ host: 'board.gitlab.test', caBundle: 'PEM', signal: controller.signal });
    });
});

describe('GitLabClient reads the board does not make yet', () => {
    it('rejects every one as unconfirmed; none answers null or an empty value', async () => {
        const { api, seen } = scripted(() => json(200, []));
        const c = clientOn(api);
        const calls: Array<() => Promise<unknown>> = [
            () => c.readChangeRequest(1),
            () => c.mergeChangeRequest(1, { sha: 'a', method: 'merge' }),
            () => c.listBranches({}),
            () => c.readBranchHead('main'),
            () => c.readBranchState('main', []),
            () => c.readFile('main', 'a'),
            () => c.listSkills('main', []),
            () => c.listRepositories(),
        ];
        for (const call of calls) await expect(call()).rejects.toBeInstanceOf(Error);
        expect(seen).toEqual([]);
    });
});

describe('GitLabClient.readChangeRequestPart', () => {
    const opened = async () => {
        const source = await branch();
        const made = await onFake().openChangeRequest({ branch: source, base: 'main', create: CREATE }, signal());
        return { source, number: made.pr.number };
    };
    const readsOf = () => mrCalls().map((call) => call.path);

    it('reads every changed file with its diff, page by page', async () => {
        const { number } = await opened();
        const read = await onFake().readChangeRequestPart(number, 'diff', signal());
        expect(read).toMatchObject({
            part: 'diff',
            files: [{ newPath: expect.stringMatching(/^task\/b\d+\.txt$/), newFile: true }],
        });
        expect(readsOf().some((path) => path.includes(`/merge_requests/${number}/diffs`))).toBe(true);
    });

    it('reads the notes oldest first', async () => {
        const { number } = await opened();
        for (const body of ['first', 'second']) {
            await gl.send('POST', `/api/v4/projects/${ENCODED}/merge_requests/${number}/notes`, {
                token,
                body: { body },
            });
        }
        const read = await onFake().readChangeRequestPart(number, 'notes', signal());
        expect(read).toMatchObject({ part: 'notes', notes: [{ body: 'first' }, { body: 'second' }] });
    });

    it('reads the head pipeline and the head commit’s statuses', async () => {
        const { source, number } = await opened();
        const sha = (
            await gl.send('GET', `/api/v4/projects/${ENCODED}/repository/branches/${encodeURIComponent(source)}`, {
                token,
            })
        ).body.commit.id as string;
        await gl.send('POST', `/api/v4/projects/${ENCODED}/statuses/${sha}`, {
            token,
            body: { state: 'success', name: 'lint', ref: source },
        });
        const read = await onFake().readChangeRequestPart(number, 'pipeline', signal());
        expect(read).toMatchObject({
            part: 'pipeline',
            sha,
            pipeline: { status: 'success' },
            statuses: [{ name: 'lint', status: 'success' }],
        });
    });

    it('answers a null pipeline for an MR with none', async () => {
        const { number } = await opened();
        expect(await onFake().readChangeRequestPart(number, 'pipeline', signal())).toMatchObject({
            pipeline: null,
            statuses: [],
        });
    });

    it('rejects, never answers a shorter list, for a 5xx, a malformed page, a non-list and a page past the cap', async () => {
        const failures: GitlabResponse[] = [
            json(500, {}),
            json(401, {}),
            json(404, {}),
            { ok: false, reason: 'timeout', sent: true },
            { ok: true, status: 200, text: '{' },
            json(200, { not: 'a list' }),
            json(200, [{ new_path: 1 }]),
        ];
        for (const answer of failures) {
            const { api } = scripted(() => answer);
            await expect(clientOn(api).readChangeRequestPart(7, 'diff', signal())).rejects.toBeInstanceOf(Error);
        }
        const endless = scripted(() => json(200, [{ id: 1, body: 'b', author: null, created_at: 'x', system: false }]));
        await expect(clientOn(endless.api).readChangeRequestPart(7, 'notes', signal())).rejects.toThrow(/cap/);
        const big = scripted(() =>
            json(200, [
                {
                    old_path: 'a',
                    new_path: 'a',
                    new_file: false,
                    deleted_file: false,
                    renamed_file: false,
                    diff: 'x'.repeat(1024 * 1024),
                },
            ])
        );
        await expect(clientOn(big.api).readChangeRequestPart(7, 'diff', signal())).rejects.toThrow(/cap/);
    });

    it('says a file the forge withheld is omitted', async () => {
        const entry = {
            old_path: 'a',
            new_path: 'a',
            new_file: false,
            deleted_file: false,
            renamed_file: false,
            too_large: true,
            diff: '',
        };
        const { api } = scripted((request) => json(200, request.path.endsWith('&page=1') ? [entry] : []));
        expect(await clientOn(api).readChangeRequestPart(7, 'diff', signal())).toMatchObject({
            files: [{ omitted: true, diff: '' }],
        });
    });

    it('sends the starter’s token and the CA bundle, and the token is in no error', async () => {
        const { api, seen } = scripted(() => json(500, {}));
        const error = await clientOn(api, SECRET)
            .readChangeRequestPart(7, 'notes', signal())
            .catch((e: Error) => e);
        expect((error as Error).message).not.toContain(SECRET);
        expect(seen[0]?.headers?.authorization).toBe(`Bearer ${SECRET}`);
    });

    it('rejects as unsupported on GitHub, with no request', async () => {
        const { createGitHubForgeClient } = await import('../src/forge/github-client.js');
        const github = createGitHubForgeClient(
            { reads: undefined, writer: undefined },
            { forge: 'github', host: 'github.com', path: 'o/r' },
            { kind: 'installation' }
        );
        await expect(github.readChangeRequestPart(1, 'diff', signal())).rejects.toBeInstanceOf(
            ChangeRequestReadUnsupportedError
        );
    });
});
