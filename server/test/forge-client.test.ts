import { githubRepo, parseRepoRef, READ_TRANSPORT, type RepoRef } from '@factory-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitHubConfig } from '../src/config.js';
import {
    FORGE_UNCONFIGURED,
    FORGE_UNSUPPORTED,
    INSTALLATION_CREDENTIAL,
    resolveForgeClient,
    type ForgeClient,
    type ForgeSource,
} from '../src/forge/forge-client.js';
import { createGitHubAppClient } from '../src/github/app-client.js';
import type { InstallationTokenProvider } from '../src/github/app-token.js';
import { GitHubMergeError } from '../src/github/pr-merge.js';
import { GitHubReadError } from '../src/github/pr-read.js';
import { createPrWriter, GitHubWriteError } from '../src/github/pr-write.js';
import { type FakeGithub, startFakeGithub } from '../test-db/fake-github.js';

const API = 'https://api.github.test';
const INSTALLATION_TOKEN = 'installation-token';
const MEMBER_TOKEN = 'member-token';
const DEADLINE_MS = 5_000;
const PATH = 'acme/widgets';
const REF = githubRepo(PATH);
const GITLAB_REF = parseRepoRef('gitlab:gitlab.example.test/acme/widgets')!;
const GITHUB_OTHER_HOST = parseRepoRef('github:ghe.example.test/acme/widgets')!;

const config = { mode: 'app', appId: '1', apiUrl: API, privateKey: 'k' } as unknown as Extract<
    GitHubConfig,
    { mode: 'app' }
>;
const tokens: InstallationTokenProvider = {
    get: async () => INSTALLATION_TOKEN,
    fresh: async () => ({
        token: INSTALLATION_TOKEN,
        expiresAt: '2030-01-01T00:00:00Z',
        permissions: {},
        repositories: [],
    }),
    revoke: async () => 'revoked',
    installationId: async () => '4242',
};

interface Request {
    method: string;
    path: string;
    authorization: string | null;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A fetch answering GitHub's read endpoints by path; every request is recorded with the credential it carried. */
function readFetch(requests: Request[], answer: (method: string, path: string) => Response | undefined): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const path = String(input).replace(API, '');
        const method = init?.method ?? 'GET';
        requests.push({ method, path, authorization: new Headers(init?.headers).get('authorization') });
        return answer(method, path) ?? json({ message: 'Not Found' }, 404);
    }) as typeof fetch;
}

const pull = {
    number: 7,
    state: 'open',
    merged: false,
    head: { sha: 'headsha' },
    base: { ref: 'main', repo: { full_name: PATH } },
};

const answers = (method: string, path: string): Response | undefined => {
    if (path.startsWith('/installation/repositories')) {
        return json({
            total_count: 1,
            repository_selection: 'all',
            repositories: [{ name: 'widgets', owner: { login: 'acme' }, private: true, default_branch: 'main' }],
        });
    }
    if (path.startsWith(`/repos/${PATH}/git/matching-refs`)) return json([{ ref: 'refs/heads/main' }]);
    if (path === `/repos/${PATH}/branches/main`) return json({ commit: { sha: 'tip' } });
    if (path === `/repos/${PATH}/commits/main`) return json({ sha: 'tip' });
    if (path.startsWith(`/repos/${PATH}/commits/tip`)) return json({ sha: 'tip' });
    if (path.startsWith(`/repos/${PATH}/contents/.bellows.yaml`)) {
        return json({ type: 'file', encoding: 'base64', size: 2, content: Buffer.from('hi').toString('base64') });
    }
    if (path.startsWith(`/repos/${PATH}/contents/.claude/skills`)) return json({ message: 'Not Found' }, 404);
    if (path === `/repos/${PATH}/pulls/7`) return json(pull);
    if (path.includes('/check-runs')) return json({ total_count: 0, check_runs: [] });
    if (path.includes('/status')) return json({ statuses: [] });
    if (method === 'PUT' && path === `/repos/${PATH}/pulls/7/merge`) return json({ merged: true, sha: 'mergesha' });
    return undefined;
};

const sourceOver = (fetchFn: typeof fetch, writer?: ReturnType<typeof createPrWriter>): ForgeSource => ({
    github: { reads: createGitHubAppClient(config, tokens, fetchFn), ...(writer ? { writer } : {}) },
});

const resolved = (source: ForgeSource, ref: RepoRef, credential = INSTALLATION_CREDENTIAL): ForgeClient => {
    const resolution = resolveForgeClient(source, ref, credential);
    if (!resolution.ok) throw new Error(`not resolved: ${resolution.reason}`);
    return resolution.client;
};

describe('resolveForgeClient', () => {
    it('answers a named unsupported result for another forge or host, with no network call', async () => {
        const requests: Request[] = [];
        const source = sourceOver(readFetch(requests, answers), createPrWriter({ apiUrl: API, fetchFn: fetch }));
        expect(resolveForgeClient(source, GITLAB_REF, INSTALLATION_CREDENTIAL)).toEqual({
            ok: false,
            reason: FORGE_UNSUPPORTED,
            forge: 'gitlab',
            host: 'gitlab.example.test',
        });
        expect(resolveForgeClient(source, GITHUB_OTHER_HOST, { kind: 'token', token: MEMBER_TOKEN })).toMatchObject({
            ok: false,
            reason: FORGE_UNSUPPORTED,
        });
        expect(requests).toEqual([]);
    });

    it('is unconfigured when the board holds nothing to reach the forge with', () => {
        expect(resolveForgeClient({}, REF, INSTALLATION_CREDENTIAL)).toMatchObject({
            ok: false,
            reason: FORGE_UNCONFIGURED,
        });
        expect(resolveForgeClient({ github: {} }, REF, { kind: 'token', token: MEMBER_TOKEN })).toMatchObject({
            ok: false,
            reason: FORGE_UNCONFIGURED,
        });
        // Installation reads need the installation, which a writer alone is not.
        const writerOnly: ForgeSource = { github: { writer: createPrWriter({ apiUrl: API, fetchFn: fetch }) } };
        expect(resolveForgeClient(writerOnly, REF, INSTALLATION_CREDENTIAL)).toMatchObject({
            ok: false,
            reason: FORGE_UNCONFIGURED,
        });
        expect(resolveForgeClient(writerOnly, REF, { kind: 'token', token: MEMBER_TOKEN }).ok).toBe(true);
    });
});

describe('the GitHub client: reads', () => {
    it('reads repositories, branches, files, skills and change requests as the installation, whatever the acting credential', async () => {
        const requests: Request[] = [];
        const source = sourceOver(readFetch(requests, answers));
        const client = resolved(source, REF, { kind: 'token', token: MEMBER_TOKEN });

        expect(await client.listRepositories()).toEqual([
            { owner: 'acme', name: 'widgets', private: true, defaultBranch: 'main', pushedAt: null },
        ]);
        expect((await client.listBranches({ query: 'ma' })).names).toEqual(['main']);
        expect(await client.readBranchHead('main')).toBe('tip');
        expect(await client.readFile('main', '.bellows.yaml')).toEqual({ revision: 'tip', text: 'hi' });
        expect((await client.listSkills('main', ['.claude/skills'])).skills).toEqual([]);
        const facts = await client.readChangeRequest(7);
        expect(facts).toMatchObject({ repo: PATH, number: 7, state: 'open', headSha: 'headsha' });
        // The payload named no html_url: the URL is the one the change-request contract formats.
        expect(facts.url).toBe('https://github.com/acme/widgets/pull/7');

        expect(requests.length).toBeGreaterThan(6);
        expect(new Set(requests.map((r) => r.authorization))).toEqual(new Set([`Bearer ${INSTALLATION_TOKEN}`]));
    });

    it('reads the branch state: the tip, what it holds and its checks', async () => {
        const client = resolved(sourceOver(readFetch([], answers)), REF);
        expect(await client.readBranchState('main', [])).toMatchObject({ headSha: 'tip', contains: {} });
    });

    it('rejects an unconfirmed read, never answering a shorter or empty one', async () => {
        const down = readFetch([], () => json({ message: 'boom' }, 502));
        const client = resolved(sourceOver(down), REF);
        for (const read of [
            () => client.listBranches({}),
            () => client.readBranchHead('main'),
            () => client.readFile('main', '.bellows.yaml'),
            () => client.listSkills('main', ['.claude/skills']),
            () => client.readChangeRequest(7),
        ]) {
            await expect(read()).rejects.toMatchObject({ kind: READ_TRANSPORT });
            await expect(read()).rejects.toBeInstanceOf(GitHubReadError);
        }
    });

    it("stops a skills read on the caller's cancellation", async () => {
        const client = resolved(sourceOver(readFetch([], answers)), REF);
        await expect(client.listSkills('main', ['.claude/skills'], AbortSignal.abort())).rejects.toBeInstanceOf(
            GitHubReadError
        );
    });
});

describe('the GitHub client: merge', () => {
    it('merges with the member token and reads with the installation', async () => {
        const requests: Request[] = [];
        const client = resolved(sourceOver(readFetch(requests, answers)), REF, { kind: 'token', token: MEMBER_TOKEN });
        await client.readChangeRequest(7);
        expect(await client.mergeChangeRequest(7, { sha: 'headsha', method: 'squash' })).toEqual({
            mergeCommitSha: 'mergesha',
        });
        const merge = requests.filter((r) => r.method === 'PUT');
        expect(merge.map((r) => r.authorization)).toEqual([`Bearer ${MEMBER_TOKEN}`]);
        expect(
            requests.filter((r) => r.method === 'GET').every((r) => r.authorization === `Bearer ${INSTALLATION_TOKEN}`)
        ).toBe(true);
    });

    it('says a merge whose answer never came may have happened', async () => {
        const dropped = (async (_input: unknown, init?: RequestInit) => {
            if (init?.method === 'PUT') throw new Error('socket hang up');
            return json({});
        }) as typeof fetch;
        const client = resolved(sourceOver(dropped), REF, { kind: 'token', token: MEMBER_TOKEN });
        const error = await client.mergeChangeRequest(7, { sha: 'headsha', method: 'squash' }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GitHubMergeError);
        expect(error).toMatchObject({ kind: 'uncertain' });
    });

    it('does not merge under the installation credential: there is no token to merge as', async () => {
        const requests: Request[] = [];
        const client = resolved(sourceOver(readFetch(requests, answers)), REF);
        await expect(client.mergeChangeRequest(7, { sha: 'headsha', method: 'squash' })).rejects.toBeInstanceOf(
            GitHubMergeError
        );
        expect(requests).toEqual([]);
    });
});

describe('the GitHub client: change-request writes', () => {
    let fake: FakeGithub;
    let member: string;
    let installation: string;
    let source: ForgeSource;
    const ASK = { branch: 'task/one', base: 'main', create: { title: 'T', body: 'B', draft: false } };
    const signal = () => AbortSignal.timeout(DEADLINE_MS);

    beforeEach(async () => {
        fake = await startFakeGithub();
        member = (await fake.signIn()).access_token;
        installation = await fake.installationToken();
        source = { github: { writer: createPrWriter({ apiUrl: fake.base, fetchFn: fetch }) } };
    });
    afterEach(() => fake.stop());

    it('finds, opens, edits and retargets as the member', async () => {
        const client = resolved(source, REF, { kind: 'token', token: member });
        expect(await client.findChangeRequest('task/one', signal())).toBeNull();
        const opened = await client.openChangeRequest(ASK, signal());
        expect(opened).toMatchObject({ operation: 'created', pr: { number: 1, base: 'main' } });
        expect(await client.findChangeRequest('task/one', signal())).toMatchObject({ number: 1 });
        expect((await client.editChangeRequest(1, { title: 'New' }, signal())).number).toBe(1);
        expect((await client.retargetChangeRequest(1, 'main', signal())).base).toBe('main');
        expect((await fake.pulls())[0]).toMatchObject({ number: 1 });
    });

    it('writes with the installation token when that is the token it was given (no member grants)', async () => {
        const client = resolved(source, REF, { kind: 'token', token: installation });
        expect(await client.openChangeRequest(ASK, signal())).toMatchObject({ operation: 'created' });
    });

    it('refuses a write under the read-only installation credential before any request', async () => {
        const both = sourceOver(readFetch([], answers), source.github!.writer);
        const client = resolved(both, REF);
        const error = await client.openChangeRequest(ASK, signal()).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GitHubWriteError);
        expect(error).toMatchObject({ kind: 'denied' });
        expect(await fake.pulls()).toEqual([]);
    });

    it('is uncertain, never a verdict, when the deadline passes', async () => {
        const client = resolved(source, REF, { kind: 'token', token: member });
        const error = await client.findChangeRequest('task/one', AbortSignal.abort()).catch((e: unknown) => e);
        expect(error).toMatchObject({ kind: 'uncertain' });
    });
});
