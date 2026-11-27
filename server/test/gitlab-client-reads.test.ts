import { assessPullRequest, parseRepoRef, type RepoRef } from '@factory-ai/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ForgeClient } from '../src/forge/forge-client.js';
import { createGitLabForgeClient } from '../src/forge/gitlab-client.js';
import { FORGE_READ_DEADLINE_MS } from '../src/forge/gitlab-reads.js';
import { OBSERVATION_LEASE_MS } from '../src/db/batches/batch-store-observation.js';
import { createGitlabApi, type GitlabApi, type GitlabRequest, type GitlabResponse } from '../src/gitlab/gitlab-api.js';
import { type FakeGitlab, startFakeGitlab } from '../test-db/fake-gitlab.js';

/**
 * What `GitLabClient` reads of a merge request, a branch and a branch state (docs/gitlab.md): against the in-process
 * fake for what GitLab does, and over a scripted `request` for the answers a real instance gives that the fake cannot.
 */
const PATH = 'grp/sub/web';
const ENCODED = 'grp%2Fsub%2Fweb';
const REF = parseRepoRef(`gitlab:board.gitlab.test/${PATH}`) as RepoRef;
const SHA = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const URL_OF = (iid: number) => `https://board.gitlab.test/${PATH}/-/merge_requests/${iid}`;

let gl: FakeGitlab;
let token: string;

beforeAll(async () => {
    gl = await startFakeGitlab();
    await gl.control('gitlab/projects', { path: PATH, files: { 'README.md': 'x\n' } });
    token = (await gl.signIn('dev')).access_token;
});
beforeEach(() => gl.control('gitlab/faults', { mode: 'none' }));
afterAll(() => gl.stop());

const clientWith = (api: GitlabApi, extra: { signal?: AbortSignal } = {}): ForgeClient =>
    createGitLabForgeClient({ api, caBundle: undefined, ...extra }, REF, { kind: 'token', token });
const onFake = (extra: { signal?: AbortSignal } = {}) =>
    clientWith(createGitlabApi({ baseUrl: () => gl.base, probeTimeoutMs: 10_000 }), extra);

let counter = 0;
/** A source branch no other test used, with a commit on it, and an MR from it. */
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
    const mr = made.body as { iid: number; sha: string; web_url: string };
    return { branch: name, iid: mr.iid, sha: mr.sha, url: mr.web_url };
};
const pipeline = (branch: string, body: object) =>
    gl.control('gitlab/pipelines', { project: PATH, ref: branch, ...body }).then((answer) => answer.body);
const mainTip = async () =>
    (
        (await gl.send('GET', `/api/v4/projects/${ENCODED}/repository/branches/main`, { token })).body as {
            commit: { id: string };
        }
    ).commit.id;
const kindOf = (promise: Promise<unknown>) =>
    promise.then(
        () => 'resolved',
        (e: { kind?: string }) => e.kind ?? 'unclassified'
    );

describe('GitLabClient.readChangeRequest', () => {
    it('reads a green pipeline as ready facts', async () => {
        const mr = await openMr();
        await pipeline(mr.branch, {
            headOf: mr.iid,
            jobs: [
                { name: 'build', status: 'success' },
                { name: 'test', status: 'success' },
            ],
        });
        await gl.control('gitlab/approvals', { project: PATH, iid: mr.iid, required: 1, approvedBy: ['dev-one'] });
        const facts = await onFake().readChangeRequest(mr.iid);
        expect(facts).toMatchObject({
            repo: PATH,
            number: mr.iid,
            url: mr.url,
            state: 'open',
            merged: false,
            headSha: mr.sha,
            baseBranch: 'main',
            targetSha: await mainTip(),
            mergeable: true,
            requiredContexts: [],
            requiredApprovals: 1,
            approvals: 1,
        });
        expect(facts.checks.map((check) => `${check.name}:${check.state}`).sort()).toEqual([
            'build:passing',
            'pipeline:passing',
            'test:passing',
        ]);
        expect(assessPullRequest(facts).outcome).toBe('ready');
    });

    it('reads a failing job as checks_failing and repairable, with that job as evidence', async () => {
        const mr = await openMr();
        await pipeline(mr.branch, {
            headOf: mr.iid,
            jobs: [
                { name: 'lint', status: 'failed', allowFailure: true },
                { name: 'test', status: 'failed', stage: 'verify' },
            ],
        });
        const facts = await onFake().readChangeRequest(mr.iid);
        expect(facts.checks.find((check) => check.name === 'lint')?.state).toBe('passing');
        const assessment = assessPullRequest(facts);
        expect(assessment).toMatchObject({ outcome: 'checks_failing', repairable: true });
        const evidence = assessment.evidence.find((item) => item.name === 'test');
        expect(evidence).toMatchObject({ state: 'failing', detail: 'stage verify: script_failure' });
        expect(evidence?.url).toContain('/-/jobs/');
        expect(assessment.evidence.some((item) => item.name === 'lint')).toBe(false);
    });

    it('reads a head pipeline of an older commit as pending, never passing', async () => {
        const mr = await openMr();
        await pipeline(mr.branch, { sha: '1'.repeat(40), status: 'success', headOf: mr.iid });
        const facts = await onFake().readChangeRequest(mr.iid);
        expect(facts.checks).toHaveLength(1);
        expect(facts.checks[0]).toMatchObject({ state: 'pending' });
        expect(assessPullRequest(facts).outcome).toBe('checks_pending');
    });

    it('counts a failed downstream pipeline whose jobs are all green as failing', async () => {
        const mr = await openMr();
        const made = await pipeline(mr.branch, { headOf: mr.iid, jobs: [{ name: 'trigger', status: 'success' }] });
        await gl.control(`gitlab/pipelines/${made.id}`, { status: 'failed' });
        const facts = await onFake().readChangeRequest(mr.iid);
        expect(assessPullRequest(facts).outcome).toBe('checks_failing');
    });

    it('reads a pipeline with no jobs (a bridge) as its own status, not as missing checks', async () => {
        const mr = await openMr();
        await pipeline(mr.branch, { headOf: mr.iid, status: 'success' });
        const facts = await onFake().readChangeRequest(mr.iid);
        expect(facts.checks.map((check) => check.name)).toEqual(['pipeline']);
        expect(assessPullRequest(facts).outcome).toBe('ready');
    });

    it('adds external commit statuses, the job winning a name clash and the newest of one name winning', async () => {
        const mr = await openMr();
        await pipeline(mr.branch, { headOf: mr.iid, jobs: [{ name: 'test', status: 'success' }] });
        const post = (name: string, state: string) =>
            gl.send('POST', `/api/v4/projects/${ENCODED}/statuses/${mr.sha}`, { token, body: { name, state } });
        await post('test', 'failed');
        await post('ci/ext', 'failed');
        await post('ci/ext', 'success');
        await post('ci/other', 'running');
        const facts = await onFake().readChangeRequest(mr.iid);
        const byName = Object.fromEntries(facts.checks.map((check) => [check.name, check.state]));
        expect(byName).toMatchObject({ test: 'passing', 'ci/ext': 'passing', 'ci/other': 'pending' });
        expect(facts.checks.filter((check) => check.name === 'test')).toHaveLength(1);
    });

    it('reads no head pipeline and no statuses as no checks', async () => {
        const mr = await openMr();
        const facts = await onFake().readChangeRequest(mr.iid);
        expect(facts.checks).toEqual([]);
        expect(assessPullRequest(facts).outcome).toBe('checks_missing');
    });

    it('reads a merged MR as closed and merged with its merge commit, a closed one as closed unmerged', async () => {
        const mr = await openMr();
        const merged = await gl.send('PUT', `/api/v4/projects/${ENCODED}/merge_requests/${mr.iid}/merge`, {
            token,
            body: { sha: mr.sha, squash: true },
        });
        const facts = await onFake().readChangeRequest(mr.iid);
        expect(facts).toMatchObject({
            state: 'closed',
            merged: true,
            mergeCommitSha: (merged.body as { squash_commit_sha: string }).squash_commit_sha,
        });
        expect(facts.mergedAt).toEqual(expect.any(String));
        const other = await openMr();
        await gl.send('PUT', `/api/v4/projects/${ENCODED}/merge_requests/${other.iid}`, {
            token,
            body: { state_event: 'close' },
        });
        expect(await onFake().readChangeRequest(other.iid)).toMatchObject({ state: 'closed', merged: false });
    });
});

/** A `request` answering from a script, recording what it was asked. */
const scripted = (answer: (request: GitlabRequest, path: string) => GitlabResponse | Promise<GitlabResponse>) => {
    const seen: GitlabRequest[] = [];
    const api = {
        request: async (request: GitlabRequest) => {
            seen.push(request);
            return answer(request, request.path.split('?')[0] as string);
        },
    } as unknown as GitlabApi;
    return { api, seen };
};
const json = (status: number, body: unknown): GitlabResponse => ({ ok: true, status, text: JSON.stringify(body) });
const mrBody = (over: Record<string, unknown> = {}) => ({
    iid: 7,
    project_id: 5,
    target_project_id: 5,
    state: 'opened',
    sha: SHA,
    target_branch: 'main',
    web_url: URL_OF(7),
    detailed_merge_status: 'mergeable',
    has_conflicts: false,
    head_pipeline: null,
    merge_commit_sha: null,
    squash_commit_sha: null,
    merged_at: null,
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
});
const MR_PATH = `/api/v4/projects/${ENCODED}/merge_requests/7`;
const job = (n: number, over: Record<string, unknown> = {}) => ({
    id: n,
    name: `job${n}`,
    stage: 'test',
    status: 'success',
    allow_failure: false,
    web_url: `https://board.gitlab.test/j/${n}`,
    failure_reason: null,
    ...over,
});
/** A scripted instance serving MR 7 with the given overrides, no pipeline, and every other path 404. */
const instance = (routes: Record<string, () => GitlabResponse | Promise<GitlabResponse>> = {}) =>
    scripted((_request, path) => {
        const route = routes[path];
        if (route) return route();
        if (path === MR_PATH) return json(200, mrBody());
        if (path.endsWith('/statuses')) return json(200, []);
        return json(404, { message: '404 Not found' });
    });
const pipelineOf = (over: Record<string, unknown> = {}) => ({
    id: 9,
    sha: SHA,
    status: 'success',
    web_url: 'https://board.gitlab.test/p/9',
    ...over,
});
const JOBS_PATH = `/api/v4/projects/${ENCODED}/pipelines/9/jobs`;
const withPipeline = (jobs: () => GitlabResponse | Promise<GitlabResponse>) =>
    instance({ [MR_PATH]: () => json(200, mrBody({ head_pipeline: pipelineOf() })), [JOBS_PATH]: jobs });

describe('an unconfirmed MR read', () => {
    it.each([
        ['a locked MR (a merge in progress)', { state: 'locked' }],
        ['an unknown state', { state: 'weird' }],
        ['another iid', { iid: 8 }],
        ['a fork MR', { target_project_id: 6 }],
        ['a short sha', { sha: 'abc' }],
        ['a non-hex sha', { sha: 'z'.repeat(40) }],
        ['no web_url', { web_url: undefined }],
        ['no target branch', { target_branch: undefined }],
    ])('throws transport for %s and never answers closed', async (_name, over) => {
        const { api } = instance({ [MR_PATH]: () => json(200, mrBody(over)) });
        expect(await kindOf(clientWith(api).readChangeRequest(7))).toBe('transport');
    });

    it('throws transport for an entry of a job page that is not a job', async () => {
        const { api } = withPipeline(() => json(200, [job(1), { name: 'x' }]));
        expect(await kindOf(clientWith(api).readChangeRequest(7))).toBe('transport');
    });

    it('throws transport for a status entry that is not one', async () => {
        const { api } = instance({
            [`/api/v4/projects/${ENCODED}/repository/commits/${SHA}/statuses`]: () => json(200, [{ name: 'x' }]),
        });
        expect(await kindOf(clientWith(api).readChangeRequest(7))).toBe('transport');
    });
});

describe('pagination of an MR read', () => {
    it('reads pages until a short page', async () => {
        const full = Array.from({ length: 100 }, (_, i) => job(i + 1));
        const { api, seen } = withPipeline(() =>
            json(200, seen.filter((r) => r.path.includes('/jobs')).length === 1 ? full : [job(101)])
        );
        const facts = await clientWith(api).readChangeRequest(7);
        expect(facts.checks.filter((check) => check.name.startsWith('job'))).toHaveLength(101);
        expect(seen.filter((request) => request.path.includes('/jobs'))).toHaveLength(2);
    });

    it('throws transport past the page cap, never a short list', async () => {
        const full = Array.from({ length: 100 }, (_, i) => job(i + 1));
        const { api } = withPipeline(() => json(200, full));
        expect(await kindOf(clientWith(api).readChangeRequest(7))).toBe('transport');
    });

    it.each([
        ['a 500', () => json(500, { message: 'boom' })],
        ['malformed json', (): GitlabResponse => ({ ok: true, status: 200, text: '{' })],
        ['a non-list', () => json(200, { jobs: [] })],
    ])('throws transport when a later page answers %s', async (_name, later) => {
        const full = Array.from({ length: 100 }, (_, i) => job(i + 1));
        let pages = 0;
        const { api } = withPipeline(() => (++pages === 1 ? json(200, full) : later()));
        expect(await kindOf(clientWith(api).readChangeRequest(7))).toBe('transport');
    });
});

describe('classification of an MR read', () => {
    it.each([
        [403, 'transport'],
        [401, 'transport'],
        [429, 'rate_limited'],
        [500, 'transport'],
        [502, 'transport'],
    ])('answers %i as %s', async (status, kind) => {
        const { api } = instance({ [MR_PATH]: () => json(status, { message: 'x' }) });
        expect(await kindOf(clientWith(api).readChangeRequest(7))).toBe(kind);
    });

    it('answers a 404 naming the MR as not_found', async () => {
        const { api } = instance({ [MR_PATH]: () => json(404, { message: '404 Merge Request Not Found' }) });
        expect(await kindOf(clientWith(api).readChangeRequest(7))).toBe('not_found');
    });

    it('answers a 404 of a nested read as transport: the MR was confirmed, the rest was not', async () => {
        const { api } = withPipeline(() => json(404, { message: '404 Not found' }));
        expect(await kindOf(clientWith(api).readChangeRequest(7))).toBe('transport');
    });

    it.each([
        ['no answer', (): GitlabResponse => ({ ok: false, reason: 'timeout', sent: true })],
        ['malformed json', (): GitlabResponse => ({ ok: true, status: 200, text: '<html>' })],
        ['an over-large body', (): GitlabResponse => ({ ok: false, reason: 'malformed', sent: true })],
    ])('answers %s as transport', async (_name, answer) => {
        const { api } = instance({ [MR_PATH]: answer });
        expect(await kindOf(clientWith(api).readChangeRequest(7))).toBe('transport');
    });

    it('puts the token in no error text', async () => {
        const { api } = instance({ [MR_PATH]: () => json(500, { message: 'x' }) });
        await expect(clientWith(api).readChangeRequest(7)).rejects.not.toThrow(token);
    });
});

describe('the optional reads of an MR read', () => {
    const TARGET = `/api/v4/projects/${ENCODED}/repository/branches/main`;
    const APPROVALS = `${MR_PATH}/approvals`;

    it.each([404, 403])('makes the target tip null on a %i', async (status) => {
        const { api } = instance({ [TARGET]: () => json(status, { message: 'x' }), [APPROVALS]: () => json(200, {}) });
        expect((await clientWith(api).readChangeRequest(7)).targetSha).toBeNull();
    });

    it.each([404, 403])('makes the approvals null on a %i', async (status) => {
        const { api } = instance({ [APPROVALS]: () => json(status, { message: 'x' }) });
        const facts = await clientWith(api).readChangeRequest(7);
        expect(facts).toMatchObject({ requiredApprovals: null, approvals: null });
    });

    it('throws on a 5xx of either', async () => {
        const target = instance({ [TARGET]: () => json(500, {}) });
        expect(await kindOf(clientWith(target.api).readChangeRequest(7))).toBe('transport');
        const approvals = instance({ [APPROVALS]: () => json(503, {}) });
        expect(await kindOf(clientWith(approvals.api).readChangeRequest(7))).toBe('transport');
    });

    it('reads approvals without the two integers (GitLab CE) as null, never 0', async () => {
        const { api } = instance({ [APPROVALS]: () => json(200, { approved_by: [] }) });
        const facts = await clientWith(api).readChangeRequest(7);
        expect(facts).toMatchObject({ requiredApprovals: null, approvals: null });
    });
});

describe('the deadline of a read', () => {
    it('carries the caller’s signal on every request', async () => {
        const controller = new AbortController();
        const { api, seen } = withPipeline(() => json(200, [job(1)]));
        await clientWith(api, { signal: controller.signal }).readChangeRequest(7);
        expect(seen.length).toBeGreaterThan(3);
        expect(seen.every((request) => request.signal === controller.signal)).toBe(true);
    });

    it('makes one deadline of its own, the same on every request, without a caller’s signal', async () => {
        const { api, seen } = withPipeline(() => json(200, [job(1)]));
        await clientWith(api).readChangeRequest(7);
        const [first] = seen;
        expect(first?.signal).toBeInstanceOf(AbortSignal);
        expect(seen.every((request) => request.signal === first?.signal)).toBe(true);
    });

    it('rejects promptly when the signal aborts mid-read', async () => {
        const controller = new AbortController();
        const { api } = scripted(
            (request) =>
                new Promise<GitlabResponse>((resolve) => {
                    request.signal?.addEventListener('abort', () =>
                        resolve({ ok: false, reason: 'timeout', sent: true })
                    );
                })
        );
        const read = clientWith(api, { signal: controller.signal }).readChangeRequest(7);
        controller.abort();
        expect(await kindOf(read)).toBe('transport');
    });

    it('stays under the lease an observation is claimed with', () => {
        expect(FORGE_READ_DEADLINE_MS).toBeLessThan(OBSERVATION_LEASE_MS);
    });
});

describe('GitLabClient.readBranchHead', () => {
    const BRANCH = `/api/v4/projects/${ENCODED}/repository/branches/main`;

    it('reads the tip of a branch on the fake and a 404 as null', async () => {
        expect(await onFake().readBranchHead('main')).toBe(await mainTip());
        expect(await onFake().readBranchHead('no-such-branch')).toBeNull();
    });

    it.each([
        ['a 403', () => json(403, {})],
        ['a 500', () => json(500, {})],
        ['a 401', () => json(401, {})],
        ['a body without commit.id', () => json(200, { name: 'main' })],
        ['a non-string commit.id', () => json(200, { commit: { id: 5 } })],
        ['no answer', (): GitlabResponse => ({ ok: false, reason: 'unreachable', sent: false })],
    ])('throws for %s, never null', async (_name, answer) => {
        const { api } = scripted((_request, path) => (path === BRANCH ? answer() : json(404, {})));
        await expect(clientWith(api).readBranchHead('main')).rejects.toBeInstanceOf(Error);
    });
});

describe('GitLabClient.readBranchState', () => {
    const base = `/api/v4/projects/${ENCODED}`;
    const state = (tip: unknown, over: Record<string, () => GitlabResponse> = {}) =>
        scripted((request, path) => {
            const route = over[path];
            if (route) return route();
            if (path === `${base}/repository/branches/main`)
                return tip ? json(200, { commit: { id: tip } }) : json(404, { message: '404 Branch Not Found' });
            if (path === `${base}/repository/merge_base`) {
                const refs = new URL(`https://x${request.path}`).searchParams.getAll('refs[]');
                return json(200, { id: refs[0] });
            }
            if (path === `${base}/pipelines` || path.endsWith('/statuses')) return json(200, []);
            return json(404, {});
        });

    it('reads the tip, what it holds and the checks of its newest pipeline on the fake', async () => {
        const mr = await openMr();
        await gl.send('PUT', `${base}/merge_requests/${mr.iid}/merge`, {
            token,
            body: { sha: mr.sha, squash: false },
        });
        const tip = await mainTip();
        await pipeline('main', { jobs: [{ name: 'test', status: 'running' }] });
        const newest = await pipeline('main', { jobs: [{ name: 'test', status: 'success' }] });
        expect(newest.sha).toBe(tip);
        const answer = await onFake().readBranchState('main', [mr.sha, tip, '9'.repeat(40)]);
        expect(answer.headSha).toBe(tip);
        expect(answer.contains).toEqual({ [mr.sha]: true, [tip]: true, ['9'.repeat(40)]: false });
        expect(answer.requiredContexts).toEqual([]);
        expect(answer.checks.map((check) => `${check.name}:${check.state}`).sort()).toEqual([
            'pipeline:passing',
            'test:passing',
        ]);
    });

    it('answers contains by merge_base: equal means held, 400 and 404 mean not held, a 5xx throws', async () => {
        const mergeBase = `${base}/repository/merge_base`;
        const held = state(TIP, { [mergeBase]: () => json(200, { id: SHA }) });
        expect((await clientWith(held.api).readBranchState('main', [SHA])).contains).toEqual({ [SHA]: true });
        const other = state(TIP, { [mergeBase]: () => json(200, { id: 'c'.repeat(40) }) });
        expect((await clientWith(other.api).readBranchState('main', [SHA])).contains).toEqual({ [SHA]: false });
        for (const status of [400, 404]) {
            const bad = state(TIP, { [mergeBase]: () => json(status, { message: '404 Commit Not Found' }) });
            expect((await clientWith(bad.api).readBranchState('main', [SHA])).contains).toEqual({ [SHA]: false });
        }
        const down = state(TIP, { [mergeBase]: () => json(500, {}) });
        expect(await kindOf(clientWith(down.api).readBranchState('main', [SHA]))).toBe('transport');
    });

    it('throws not_found for a branch that answers 404', async () => {
        expect(await kindOf(clientWith(state(null).api).readBranchState('main', []))).toBe('not_found');
    });

    it('throws transport for a tip that is not a commit id', async () => {
        expect(await kindOf(clientWith(state(5).api).readBranchState('main', []))).toBe('transport');
    });
});

describe('a member who lost access to the project', () => {
    // GitLab answers a project the member can no longer see with `404 Project Not Found`, not 403: no verdict.
    const LOST = 'lost/access';
    const lostRef = parseRepoRef(`gitlab:board.gitlab.test/${LOST}`) as RepoRef;
    let lostClient: ForgeClient;
    let iid: number;
    beforeAll(async () => {
        await gl.control('gitlab/projects', { path: LOST, files: { 'README.md': 'x\n' } });
        await gl.control('gitlab/commit', { project: LOST, branch: 'topic', files: { 'a.txt': 'x' }, message: 'w' });
        const made = await gl.send('POST', `/api/v4/projects/${encodeURIComponent(LOST)}/merge_requests`, {
            token,
            body: { source_branch: 'topic', target_branch: 'main', title: 'T' },
        });
        iid = (made.body as { iid: number }).iid;
        await gl.control('gitlab/members', { project: LOST, login: 'dev' });
        const api = createGitlabApi({ baseUrl: () => gl.base, probeTimeoutMs: 10_000 });
        lostClient = createGitLabForgeClient({ api, caBundle: undefined }, lostRef, { kind: 'token', token });
    });

    it('reads an MR as transport, never not_found', async () => {
        expect(await kindOf(lostClient.readChangeRequest(iid))).toBe('transport');
    });
    it('throws on a branch head, never null', async () => {
        expect(await kindOf(lostClient.readBranchHead('main'))).toBe('transport');
    });
    it('reads a branch state as transport, never not_found', async () => {
        expect(await kindOf(lostClient.readBranchState('main', []))).toBe('transport');
    });
    it('still reads a missing branch of a readable project as absent', async () => {
        expect(await onFake().readBranchHead('no-such-branch')).toBeNull();
    });
});

describe('statuses of a pipeline that is not the head', () => {
    it('leave the MR ready when a push pipeline beside the MR pipeline fails', async () => {
        const mr = await openMr();
        await pipeline(mr.branch, { headOf: mr.iid, jobs: [{ name: 'test', status: 'success' }] });
        await pipeline(mr.branch, {
            jobs: [
                { name: 'push-build', status: 'failed' },
                { name: 'push-deploy', status: 'manual' },
            ],
        });
        await gl.send('POST', `/api/v4/projects/${ENCODED}/statuses/${mr.sha}`, {
            token,
            body: { name: 'ci/ext', state: 'success' },
        });
        const facts = await onFake().readChangeRequest(mr.iid);
        expect(facts.checks.map((check) => check.name).sort()).toEqual(['ci/ext', 'pipeline', 'test']);
        expect(assessPullRequest(facts).outcome).toBe('ready');
    });

    it('still counts a failing external status', async () => {
        const mr = await openMr();
        await pipeline(mr.branch, { headOf: mr.iid, jobs: [{ name: 'test', status: 'success' }] });
        await gl.send('POST', `/api/v4/projects/${ENCODED}/statuses/${mr.sha}`, {
            token,
            body: { name: 'ci/ext', state: 'failed' },
        });
        expect(assessPullRequest(await onFake().readChangeRequest(mr.iid)).outcome).toBe('checks_failing');
    });

    it('applies the same rule to a branch state: only the newest pipeline’s jobs count', async () => {
        const tip = await mainTip();
        await pipeline('main', { jobs: [{ name: 'test', status: 'success' }] });
        await pipeline('main', { jobs: [{ name: 'other-run', status: 'failed' }] });
        const answer = await onFake().readBranchState('main', []);
        expect(answer.headSha).toBe(tip);
        expect(answer.checks.some((check) => check.name === 'other-run' && check.state === 'failing')).toBe(true);
        expect(answer.checks.some((check) => check.name === 'test')).toBe(false);
    });
});

describe('a 404 that does not name the object', () => {
    const base = `/api/v4/projects/${ENCODED}`;
    const BODIES: Array<[string, GitlabResponse]> = [
        ['no body', { ok: true, status: 404, text: '' }],
        ['an html body', { ok: true, status: 404, text: '<html>nope</html>' }],
        ['an unknown message', json(404, { message: '404 Something Else' })],
        ['the project’s message', json(404, { message: '404 Project Not Found' })],
        ['a generic message', json(404, { message: '404 Not found' })],
    ];

    it.each(BODIES)('reads an MR as transport for %s', async (_name, answer) => {
        const { api } = instance({ [MR_PATH]: () => answer });
        expect(await kindOf(clientWith(api).readChangeRequest(7))).toBe('transport');
    });
    it.each(BODIES)('throws on a branch head for %s, never null', async (_name, answer) => {
        const { api } = scripted(() => answer);
        expect(await kindOf(clientWith(api).readBranchHead('main'))).toBe('transport');
    });
    it.each(BODIES)('reads a branch state as transport for %s', async (_name, answer) => {
        const { api } = scripted(() => answer);
        expect(await kindOf(clientWith(api).readBranchState('main', []))).toBe('transport');
    });
    it.each(BODIES)('throws on a merge base for %s, never “not held”', async (_name, answer) => {
        const { api } = scripted((_request, path) =>
            path === `${base}/repository/branches/main` ? json(200, { commit: { id: TIP } }) : answer
        );
        expect(await kindOf(clientWith(api).readBranchState('main', [SHA]))).toBe('transport');
    });

    it('still names the object: the MR, the branch and the commit messages are confirmed absences', async () => {
        const mr = instance({ [MR_PATH]: () => json(404, { message: '404 Merge Request Not Found' }) });
        expect(await kindOf(clientWith(mr.api).readChangeRequest(7))).toBe('not_found');
        const branch = scripted(() => json(404, { message: '404 Branch Not Found' }));
        expect(await clientWith(branch.api).readBranchHead('main')).toBeNull();
        expect(await kindOf(clientWith(branch.api).readBranchState('main', []))).toBe('not_found');
        const commit = scripted((_request, path) => {
            if (path.endsWith('/branches/main')) return json(200, { commit: { id: TIP } });
            if (path.endsWith('/pipelines') || path.endsWith('/statuses')) return json(200, []);
            return json(404, { message: '404 Commit Not Found' });
        });
        expect((await clientWith(commit.api).readBranchState('main', [SHA])).contains).toEqual({ [SHA]: false });
    });
});

describe('the pipelines-by-sha lookup of the statuses', () => {
    const base = `/api/v4/projects/${ENCODED}`;
    const CI_STATUS = { id: 3, name: 'build', status: 'success', pipeline_id: 11, stage: 'test' };
    const FAULTS: Array<[string, () => GitlabResponse]> = [
        ['a 500', () => json(500, { message: 'boom' })],
        ['no answer', () => ({ ok: false, reason: 'timeout', sent: true })],
        ['malformed json', () => ({ ok: true, status: 200, text: '{' })],
        ['a non-list', () => json(200, { pipelines: [] })],
        [
            'a page past the cap',
            () =>
                json(
                    200,
                    Array.from({ length: 100 }, (_, i) => ({ id: i + 1, status: 'success' }))
                ),
        ],
    ];
    /** An open MR 7 and a branch whose tip carries a CI job status; `lookup` answers the `?sha=` pipelines request. */
    const world = (lookup: () => GitlabResponse) =>
        scripted((request, path) => {
            if (path === MR_PATH) return json(200, mrBody());
            if (path === `${base}/repository/branches/main`) return json(200, { commit: { id: TIP } });
            if (path.endsWith('/statuses')) return json(200, [CI_STATUS]);
            if (path === `${base}/pipelines`) return request.path.includes('ref=') ? json(200, []) : lookup();
            return json(404, {});
        });

    it.each(FAULTS)('reads an MR as transport on %s, never with no external statuses', async (_name, fault) => {
        const { api } = world(fault);
        expect(await kindOf(clientWith(api).readChangeRequest(7))).toBe('transport');
    });
    it.each(FAULTS)('reads a branch state as transport on %s', async (_name, fault) => {
        const { api } = world(fault);
        expect(await kindOf(clientWith(api).readBranchState('main', []))).toBe('transport');
    });

    it('counts a failing status of a pipeline made by external statuses though its stage is not external', async () => {
        const mr = await openMr();
        await pipeline(mr.branch, { headOf: mr.iid, jobs: [{ name: 'test', status: 'success' }] });
        await gl.send('POST', `/api/v4/projects/${ENCODED}/statuses/${mr.sha}`, {
            token,
            body: { name: 'ci/seed', state: 'success' },
        });
        const made = (await gl.send('GET', `/api/v4/projects/${ENCODED}/pipelines?sha=${mr.sha}`, { token }))
            .body as Array<{ id: number; source: string }>;
        const external = made.find((entry) => entry.source === 'external');
        await gl.control('gitlab/ci-status', {
            project: PATH,
            sha: mr.sha,
            name: 'ci/staged',
            status: 'failed',
            pipelineId: external?.id,
            stage: 'deploy',
        });
        const facts = await onFake().readChangeRequest(mr.iid);
        expect(facts.checks.find((check) => check.name === 'ci/staged')?.state).toBe('failing');
        expect(assessPullRequest(facts).outcome).toBe('checks_failing');
    });
});

describe('GitLabClient.mergeChangeRequest', () => {
    const SQUASH = { sha: SHA, method: 'squash' };
    const PROJECT_PATH = `/api/v4/projects/${ENCODED}`;
    const MERGE_PATH = `${MR_PATH}/merge`;
    let projects = 0;

    /** An MR on a project of its own with `squashOption`, so each case merges into a target it owns. */
    async function mergeable(squashOption: string) {
        const path = `grp/merge${++projects}`;
        await gl.control('gitlab/projects', { path, squashOption, files: { 'README.md': 'x\n' } });
        await gl.control('gitlab/commit', { project: path, branch: 'work', files: { 'w.txt': 'x' }, message: 'work' });
        const encoded = encodeURIComponent(path);
        const made = await gl.send('POST', `/api/v4/projects/${encoded}/merge_requests`, {
            token,
            body: { source_branch: 'work', target_branch: 'main', title: 'Change' },
        });
        const mr = made.body as { iid: number; sha: string };
        const ref = parseRepoRef(`gitlab:board.gitlab.test/${path}`) as RepoRef;
        const client = createGitLabForgeClient(
            { api: createGitlabApi({ baseUrl: () => gl.base, probeTimeoutMs: 10_000 }), caBundle: undefined },
            ref,
            { kind: 'token', token }
        );
        const stateOf = async () =>
            (await gl.send('GET', `/api/v4/projects/${encoded}/merge_requests/${mr.iid}`, { token })).body as {
                state: string;
                merged_by: { username: string } | null;
            };
        const puts = () =>
            gl.forge.calls().filter((call) => call.method === 'PUT' && call.path.includes(`${encoded}/merge_requests`));
        return { path, encoded, iid: mr.iid, sha: mr.sha, client, stateOf, puts };
    }

    it('sends the observed sha as the acting member and answers the merge commit', async () => {
        const mr = await mergeable('default_off');
        const result = await mr.client.mergeChangeRequest(mr.iid, { sha: mr.sha, method: 'squash' });
        expect(mr.puts()).toHaveLength(1);
        const body = await mr.stateOf();
        expect(body.state).toBe('merged');
        expect(body.merged_by?.username).toBe('dev');
        const merged = (await gl.send('GET', `/api/v4/projects/${mr.encoded}/merge_requests/${mr.iid}`, { token }))
            .body as { merge_commit_sha: string | null; squash_commit_sha: string | null; squash: boolean };
        expect(merged.squash).toBe(true);
        expect(result.mergeCommitSha).toBe(merged.merge_commit_sha ?? merged.squash_commit_sha);
        expect(result.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('sends sha, squash and a kept source branch, and nothing else of the board’s method', async () => {
        const { api, seen } = scripted((_request, path) =>
            path === PROJECT_PATH
                ? json(200, { squash_option: 'default_off' })
                : json(200, mrBody({ state: 'merged', merge_commit_sha: TIP }))
        );
        const result = await clientWith(api).mergeChangeRequest(7, SQUASH);
        const put = seen.find((request) => request.method === 'PUT');
        expect(put?.path).toBe(MERGE_PATH);
        expect(JSON.parse(put?.body as string)).toEqual({ sha: SHA, squash: true, should_remove_source_branch: false });
        expect(result).toEqual({ mergeCommitSha: TIP });
    });

    it('takes the squash commit when the merge has no merge commit', async () => {
        const { api } = scripted((_request, path) =>
            path === PROJECT_PATH
                ? json(200, { squash_option: 'always' })
                : json(200, mrBody({ state: 'merged', squash_commit_sha: TIP }))
        );
        expect(await clientWith(api).mergeChangeRequest(7, SQUASH)).toEqual({ mergeCommitSha: TIP });
    });

    it('refuses with nothing sent when the project forbids squash merges', async () => {
        const mr = await mergeable('never');
        const error = await mr.client.mergeChangeRequest(mr.iid, { sha: mr.sha, method: 'squash' }).catch((e) => e);
        expect(error).toMatchObject({ kind: 'refused' });
        expect(error.message).toContain('the project forbids squash merges; the board merges by squash');
        expect(mr.puts()).toEqual([]);
        expect((await mr.stateOf()).state).toBe('opened');
    });

    it.each(['always', 'default_on', 'default_off'])('merges by squash where the project says %s', async (option) => {
        const mr = await mergeable(option);
        await mr.client.mergeChangeRequest(mr.iid, { sha: mr.sha, method: 'squash' });
        expect(mr.puts()).toHaveLength(1);
        expect((await mr.stateOf()).state).toBe('merged');
    });

    it.each([
        ['a missing squash_option', () => json(200, {})],
        ['an unknown squash_option', () => json(200, { squash_option: 'sometimes' })],
        ['a 500', () => json(500, {})],
        ['a 401', () => json(401, {})],
        ['no answer', (): GitlabResponse => ({ ok: false, reason: 'timeout', sent: true })],
    ])('sends nothing and is not_sent on %s of the project read', async (_name, answer) => {
        const { api, seen } = scripted((_request, path) => (path === PROJECT_PATH ? answer() : json(200, mrBody())));
        expect(await kindOf(clientWith(api).mergeChangeRequest(7, SQUASH))).toBe('not_sent');
        expect(seen.filter((request) => request.method === 'PUT')).toEqual([]);
    });

    it('refuses a head that moved, and the MR stays open', async () => {
        const mr = await mergeable('default_off');
        await gl.control('gitlab/commit', {
            project: mr.path,
            branch: 'work',
            files: { 'later.txt': 'y' },
            message: 'later',
        });
        const error = await mr.client.mergeChangeRequest(mr.iid, { sha: mr.sha, method: 'squash' }).catch((e) => e);
        expect(error).toMatchObject({ kind: 'refused' });
        expect((await mr.stateOf()).state).toBe('opened');
    });

    describe('classification of the merge answer', () => {
        const afterProject = (answer: () => GitlabResponse) =>
            scripted((request, path) =>
                request.method === 'GET' && path === PROJECT_PATH
                    ? json(200, { squash_option: 'default_on' })
                    : answer()
            );
        it.each([
            [405, 'refused'],
            [406, 'refused'],
            [422, 'refused'],
            [403, 'forbidden'],
            [404, 'forbidden'],
            [429, 'rate_limited'],
            [401, 'uncertain'],
            [500, 'uncertain'],
            [502, 'uncertain'],
        ])('answers %i as %s', async (status, kind) => {
            const { api } = afterProject(() => json(status, { message: 'x' }));
            expect(await kindOf(clientWith(api).mergeChangeRequest(7, SQUASH))).toBe(kind);
        });

        it('answers a timeout after the send as uncertain', async () => {
            const { api } = afterProject(() => ({ ok: false, reason: 'timeout', sent: true }));
            expect(await kindOf(clientWith(api).mergeChangeRequest(7, SQUASH))).toBe('uncertain');
        });

        it('answers a refused connection as not_sent', async () => {
            const { api } = afterProject(() => ({ ok: false, reason: 'unreachable', sent: false }));
            expect(await kindOf(clientWith(api).mergeChangeRequest(7, SQUASH))).toBe('not_sent');
        });

        it.each([
            ['not a merged MR', () => json(200, mrBody({ state: 'opened' }))],
            ['an unreadable body', (): GitlabResponse => ({ ok: true, status: 200, text: '<html>' })],
            ['a list', () => json(200, [])],
            ['a cut answer', (): GitlabResponse => ({ ok: false, reason: 'malformed', sent: true })],
        ])('answers a 2xx with %s as uncertain, never merged', async (_name, answer) => {
            const { api } = afterProject(answer);
            expect(await kindOf(clientWith(api).mergeChangeRequest(7, SQUASH))).toBe('uncertain');
        });

        it('puts the token in no error text', async () => {
            const { api } = afterProject(() => json(500, { message: 'x' }));
            await expect(clientWith(api).mergeChangeRequest(7, SQUASH)).rejects.not.toThrow(token);
        });
    });

    it('is forbidden with no request when no token was given', async () => {
        const { api, seen } = scripted(() => json(200, {}));
        const client = createGitLabForgeClient({ api, caBundle: undefined }, REF, { kind: 'installation' });
        expect(await kindOf(client.mergeChangeRequest(7, SQUASH))).toBe('forbidden');
        expect(seen).toEqual([]);
    });

    it('carries the caller’s signal on both requests', async () => {
        const controller = new AbortController();
        const { api, seen } = scripted((_request, path) =>
            path === PROJECT_PATH
                ? json(200, { squash_option: 'default_on' })
                : json(200, mrBody({ state: 'merged', merge_commit_sha: TIP }))
        );
        await clientWith(api, { signal: controller.signal }).mergeChangeRequest(7, SQUASH);
        expect(seen).toHaveLength(2);
        expect(seen.every((request) => request.signal === controller.signal)).toBe(true);
    });
});
