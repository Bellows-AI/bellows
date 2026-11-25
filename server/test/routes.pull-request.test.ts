import { githubRepo, parseRepoRef, type RepoRef } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { MemberForgeGrants } from '../src/integrations/member-forge-grant.js';
import type { GithubMint } from '../src/routes/github-credential.js';
import type { PrWriteStore } from '../src/db/jobs/job-store-pr-write.js';
import { createPrWriter, type PrWriter } from '../src/github/pr-write.js';
import { trackApps } from './helpers-http.js';
import { jobStoreSlice, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

/**
 * `POST /api/jobs/:id/pull-request` at the route (docs/connections.md): the worker class, the shape of an ask, and what
 * the route answers before and without GitHub. The member-token path is server/test-db/pr-as-member.test.ts.
 */
const track = trackApps();
const ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const ORG = 'org-1';
const ASK = {
    leaseToken: LEASE,
    branch: 'task/one',
    base: 'main',
    create: { title: 'T', body: 'B', draft: false, base: 'main' },
};

const context = (executionUserId: string | null = 'user-1', repo: RepoRef = githubRepo('acme/widgets')) => ({
    result: 'ok' as const,
    orgId: ORG,
    rootJobId: ID,
    repo,
    rootRepo: repo,
    executionUserId,
});

async function harness(
    options: {
        writer?: boolean | PrWriter;
        mint?: boolean | GithubMint;
        repo?: RepoRef;
        memberGrants?: MemberForgeGrants;
        store?: Partial<PrWriteStore>;
    } = {}
) {
    const config = testConfig();
    const store = jobStoreSlice<PrWriteStore>({
        prWriteContext: async () => context('user-1', options.repo),
        openPrForgeWait: async () => ({ result: 'ok' }),
        closePrForgeWait: async () => {},
        ...options.store,
    });
    const instance: FastifyInstance = await buildApp({
        config,
        orgs: staticRegistry({ config, jobs: store, telemetry: stubTelemetryClient() }),
        ...(options.writer
            ? { prWriter: options.writer === true ? createPrWriter({ apiUrl: 'http://127.0.0.1:9' }) : options.writer }
            : {}),
        ...(options.memberGrants ? { memberGrants: options.memberGrants } : {}),
        ...(typeof options.mint === 'function' ? { githubMint: options.mint } : {}),
        ...(options.mint === true
            ? {
                  githubMint: async () => ({
                      token: 'ghs_x',
                      expiresAt: '2099-01-01T00:00:00Z',
                      permissions: {},
                      repositories: [],
                  }),
              }
            : {}),
    });
    track(instance);
    return instance;
}

const post = (instance: FastifyInstance, payload: unknown) =>
    instance.inject({ method: 'POST', url: `/api/jobs/${ID}/pull-request`, payload: payload as object });

describe('POST /api/jobs/:id/pull-request', () => {
    it('answers 409 GITHUB_UNAVAILABLE when the board has no GitHub API to write through', async () => {
        const res = await post(await harness(), ASK);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'GITHUB_UNAVAILABLE' });
        expect(res.headers['cache-control']).toBe('no-store');
    });

    it('answers 409 GITHUB_UNAVAILABLE when the org has no installation to mint from', async () => {
        const instance = await harness({ writer: true });
        const res = await post(instance, ASK);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'GITHUB_UNAVAILABLE' });
    });

    // The base branch's order: the missing writer is the 409 before any credential is read, whatever the credential says.
    it('answers 409 before the installation mint or a grant read when the board has no writer', async () => {
        const reads: string[] = [];
        const mint: GithubMint = async () => {
            reads.push('mint');
            throw new Error('the mint is down');
        };
        const grants = {
            accessToken: async () => {
                reads.push('grant');
                throw new Error('the grant store is down');
            },
        } as unknown as MemberForgeGrants;
        for (const options of [{ mint }, { memberGrants: grants }]) {
            const res = await post(await harness(options), ASK);
            expect(res.statusCode).toBe(409);
            expect(res.json()).toMatchObject({ code: 'GITHUB_UNAVAILABLE' });
        }
        expect(reads).toEqual([]);
    });

    describe('a task on a forge no client answers for (GitLab)', () => {
        const GITLAB = parseRepoRef('gitlab:gl.example/acme/widgets')!;

        it('is unconfirmed (503): no mint, no grant read, no wait opened, no GitHub request', async () => {
            const reads: string[] = [];
            const waits: unknown[] = [];
            const requests: string[] = [];
            const writer = new Proxy({} as PrWriter, {
                get: (_target, name) => async () => {
                    requests.push(String(name));
                    return null;
                },
            });
            const mint: GithubMint = async (_org, path) => {
                reads.push(`mint ${path}`);
                return null;
            };
            const grants = {
                accessToken: async () => {
                    reads.push('grant');
                    return { ok: false, outcome: { outcome: 'integration_required', reason: 'missing' } };
                },
            } as unknown as MemberForgeGrants;
            for (const options of [{ mint }, { memberGrants: grants }]) {
                const res = await post(
                    await harness({
                        ...options,
                        writer,
                        repo: GITLAB,
                        store: {
                            openPrForgeWait: async (...args) => {
                                waits.push(args);
                                return { result: 'ok' };
                            },
                        },
                    }),
                    ASK
                );
                expect(res.statusCode).toBe(503);
                expect(res.json()).toMatchObject({ code: 'UNAVAILABLE' });
            }
            expect({ reads, waits, requests }).toEqual({ reads: [], waits: [], requests: [] });
        });
    });

    it.each([
        ['no lease token', { ...ASK, leaseToken: undefined }],
        ['a branch that is not a branch', { ...ASK, branch: 'has space' }],
        ['a base that is not a branch', { ...ASK, base: 'has space' }],
        ['a create with no base', { ...ASK, create: { ...ASK.create, base: undefined } }],
        ['an empty title', { ...ASK, create: { ...ASK.create, title: '' } }],
        ['a title over GitHub’s limit', { ...ASK, create: { ...ASK.create, title: 't'.repeat(257) } }],
        ['a body over GitHub’s limit', { ...ASK, create: { ...ASK.create, body: 'b'.repeat(65_537) } }],
        ['a draft that is not a boolean', { ...ASK, create: { ...ASK.create, draft: 'yes' } }],
        ['an edit with a non-string title', { ...ASK, edit: { title: 7 } }],
    ])('refuses %s with 400', async (_name, payload) => {
        const res = await post(await harness({ writer: true, mint: true }), payload);
        expect(res.statusCode).toBe(400);
    });

    it('maps a lost lease to 409 and an unknown job to 404', async () => {
        const lost = await harness({ store: { prWriteContext: async () => ({ result: 'lost' }) } });
        expect((await post(lost, ASK)).statusCode).toBe(409);
        expect((await post(lost, ASK)).json()).toMatchObject({ code: 'LEASE_LOST' });
        const missing = await harness({ store: { prWriteContext: async () => ({ result: 'missing' }) } });
        expect((await post(missing, ASK)).statusCode).toBe(404);
    });

    it('answers 503, never a verdict, when the attempt cannot be read', async () => {
        const down = await harness({
            writer: true,
            mint: true,
            store: {
                prWriteContext: async () => {
                    throw new Error('database down');
                },
            },
        });
        const res = await post(down, ASK);
        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('refuses an attempt whose task is not on its thread root’s repository', async () => {
        const other = await harness({
            writer: true,
            mint: true,
            store: { prWriteContext: async () => ({ ...context(), rootRepo: githubRepo('acme/other') }) },
        });
        expect((await post(other, ASK)).statusCode).toBe(403);
    });

    it('refuses an attempt whose root names the same path on another host', async () => {
        const other = await harness({
            writer: true,
            mint: true,
            store: {
                prWriteContext: async () => ({
                    ...context(),
                    rootRepo: { forge: 'gitlab', host: 'gl.example', path: 'acme/widgets' },
                }),
            },
        });
        expect((await post(other, ASK)).statusCode).toBe(403);
    });

    // A task with no claim base sends `base: null` (nothing to retarget) and the branch to open against in `create.base`.
    it('creates against create.base when the top-level base is null, and answers created', async () => {
        const opened: { branch: string; base: string }[] = [];
        const writer = {
            findPullRequest: async () => null,
            openPullRequest: async (_repo: string, ask: { branch: string; base: string }) => {
                opened.push({ branch: ask.branch, base: ask.base });
                return {
                    operation: 'created',
                    pr: { url: 'https://github.com/acme/widgets/pull/1', number: 1, base: ask.base, state: 'open' },
                };
            },
        } as unknown as PrWriter;
        const res = await post(await harness({ writer, mint: true }), { ...ASK, base: null });
        expect(res.json()).toEqual({
            answer: 'pr',
            operation: 'created',
            url: 'https://github.com/acme/widgets/pull/1',
            number: 1,
        });
        expect(opened).toEqual([{ branch: 'task/one', base: 'main' }]);
    });
});
