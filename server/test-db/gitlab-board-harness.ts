import { randomUUID } from 'node:crypto';
import { gitlabForgeOf } from '@factory-ai/core';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { createForgeConnectionStore, type ForgeConnectionStore } from '../src/db/forge-connections.js';
import { createGitlabApi, type GitlabApi } from '../src/gitlab/gitlab-api.js';
import { composeIntegrations } from '../src/integrations/compose.js';
import { GITLAB_CALLBACK_PATH } from '../src/integrations/gitlab-link.js';
import type { LineageTiming } from '../src/integrations/grant-lineage.js';
import type { MemberForgeGrants } from '../src/integrations/member-forge-grant.js';
import type { ForgeSource } from '../src/forge/forge-client.js';
import { createOrgRegistry, type OrgRegistry } from '../src/orgs.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import type { GithubMint } from '../src/routes/github-credential.js';
import { createAttemptOfLease, createPairMatches } from '../src/db/attempt-of-lease.js';
import { createOrgOfJob, createOrgOfLease, createOrgOfReclaim } from '../src/db/jobs/job-store-org-resolvers.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { githubAuth, TEST_DRIVER_CREDENTIAL, testConfig, testDriverCredentials } from '../test/helpers-config.js';
import { type FakeGitlab, startFakeGitlab } from './fake-gitlab.js';
import { randomGithubId, testOrg } from './fixtures.js';
import { lineageHarness } from './integration-store-faults.js';

/**
 * The board over the fake GitLab, for the suites that exercise tracking, the start gate and a mid-run loss
 * (docs/gitlab.md): the real routes, link service, lineage, secret store and job store; the fake GitLab
 * (`scripts/fake-forge/gitlab.mjs`) is the only boundary faked. A `replica()` is one board process over the shared
 * database and keyring: nothing in memory, so a fresh one is a board restart.
 */
export const ORIGIN = 'http://board.test';
export const OAUTH_REDIRECT_URI = `${ORIGIN}${GITLAB_CALLBACK_PATH}`;
const LINK_PATH = '/api/forge-grants/gitlab';
const CREATED = 201;
const SEE_OTHER = 303;
/** Any `*.gitlab.test` name reaches the fake: one instance stands for every host a test connects. */
export const HOST = 'board.gitlab.test';
export const FORGE = gitlabForgeOf(HOST);
export const ADMIN_LOGIN = 'admin-login';

export interface Org {
    id: string;
    admin: string;
    adminId: string;
    member: string;
    memberId: string;
    clientId: string;
    clientSecret: string;
    store: ForgeConnectionStore;
}

/** What a driver presents on a worker route. */
export const driverBearer = { authorization: `Bearer ${TEST_DRIVER_CREDENTIAL}` };
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const boardConfig = testConfig({
    auth: githubAuth(),
    integrations: { callbackOrigin: ORIGIN, jira: null, linear: null },
    batches: { enabled: true },
});

export interface Harness {
    sql: Sql;
    fake: FakeGitlab;
    fakeHost: string;
    keyring: ReturnType<typeof lineageHarness>;
    baseUrl(host: string): string;
    gitlabApi(wrap?: (api: GitlabApi) => GitlabApi, options?: { pageSize?: number }): GitlabApi;
    storeOf(orgId: string): ForgeConnectionStore;
    newOrg(): Promise<Org>;
    replica(options?: ReplicaOptions): ReturnType<typeof replicaOf>;
    /** A running app over a fresh replica. */
    board(options?: ReplicaOptions): Promise<Board>;
    connect(org: Org, options?: { host?: string; groups?: string[] }): Promise<string>;
    /** Connects, activates with the admin's link and links the member as `login`; the connection id. */
    linked(org: Org, memberLogin: string, options?: { groups?: string[] }): Promise<string>;
}

export interface ReplicaOptions {
    /** What the GitHub credential route mints with: a test hands the board a mint it can watch being asked. */
    githubMint?: GithubMint;
    /** Replaces every org runtime's forge source: a test hands the board a GitHub it can watch being reached. */
    forge?: ForgeSource;
    api?: GitlabApi;
    clock?: () => number;
    secrets?: SecretStore;
    timing?: Partial<LineageTiming>;
}

export interface Board {
    app: FastifyInstance;
    grants: MemberForgeGrants;
    replica: ReturnType<typeof replicaOf>;
    roundTrip(start: { path: string; token: string }, login: string): Promise<{ location: URL; result: string | null }>;
    /** The org's job store on this replica. */
    jobs(org: Org): Promise<JobStore>;
    /** The member queues a task on `repo` through the route, and a worker claims it: a running attempt. */
    running(org: Org, repo: { forge: string; host: string; path: string }): Promise<{ id: string; claim: Claim }>;
    activate(org: Org, id: string): Promise<{ result: string | null }>;
    link(org: Org, id: string, login: string, token?: string): Promise<{ result: string | null }>;
    close(): Promise<void>;
}

const noLog = () => {};

function replicaOf(h: Pick<Harness, 'sql' | 'keyring' | 'gitlabApi' | 'baseUrl'>, options: ReplicaOptions) {
    const api = options.api ?? h.gitlabApi();
    const secrets = options.secrets ?? h.keyring.openWith(h.keyring.realRepo);
    const ready = Promise.resolve();
    const composed = composeIntegrations({
        config: boardConfig,
        sql: h.sql,
        crossOrg: { sql: h.sql },
        secrets,
        ready,
        gitlab: { api, originOf: h.baseUrl },
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.timing ? { timing: options.timing } : {}),
    });
    const orgs = createOrgRegistry({
        sql: h.sql,
        ready,
        config: boardConfig,
        withStores: true,
        secrets,
        secretLog: noLog,
        gitlabApi: api,
        memberGrants: composed.memberGrants,
    });
    const links = composed.gitlab.bindOrgs(orgs, composed.memberGrants);
    if (!composed.memberGrants || !links) throw new Error('github mode composes the member grants');
    return { ...composed, memberGrants: composed.memberGrants, orgs, links, ready, api };
}

/** Call from `beforeAll`: the fake instance. `stop()` from `afterAll`. */
export async function startHarness(sql: () => Sql): Promise<Harness & { stop(): Promise<void> }> {
    const fake = await startFakeGitlab({ client: false });
    const fakeHost = new URL(fake.base).host;
    const baseUrl = (host: string) => `http://${host.endsWith('.gitlab.test') ? fakeHost : host}`;
    const gitlabApi = (wrap?: (api: GitlabApi) => GitlabApi, options: { pageSize?: number } = {}) => {
        const api = createGitlabApi({ baseUrl, probeTimeoutMs: 400, ...options });
        return wrap ? wrap(api) : api;
    };
    const h: Harness & { stop(): Promise<void> } = {
        get sql() {
            return sql();
        },
        fake,
        fakeHost,
        keyring: undefined as never,
        baseUrl,
        gitlabApi,
        storeOf: (orgId) =>
            createForgeConnectionStore({
                sql: sql(),
                orgId,
                secrets: h.keyring.openWith(h.keyring.realRepo),
                secretLog: noLog,
                gitlab: gitlabApi(),
            }),
        async newOrg() {
            const id = testOrg();
            await sql()`insert into organization (id, name) values (${id}, ${`org-${id}`})`;
            const auth = createAuthStore({ sql: sql() });
            const person = async () => {
                const login = `u-${randomUUID().slice(0, 8)}`;
                const caller = await auth.signIn(
                    { githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null },
                    id,
                    [{ id, name: id }]
                );
                const token = `fat_${randomUUID()}`;
                await auth.createAccessToken({
                    kind: 'personal',
                    orgId: id,
                    userId: caller.user.id,
                    createdBy: caller.user.id,
                    label: 'gitlab',
                    tokenHash: hashToken(token),
                });
                return { token, id: caller.user.id };
            };
            // The first sign-in into an org is its admin; the next is a member.
            const admin = await person();
            const member = await person();
            const clientId = `app-${randomUUID()}`;
            const clientSecret = `secret-${randomUUID()}`;
            await fake.control('gitlab/oauth-clients', {
                clientId,
                clientSecret,
                scopes: ['api', 'read_user'],
                redirectUris: [OAUTH_REDIRECT_URI],
            });
            return {
                id,
                admin: admin.token,
                adminId: admin.id,
                member: member.token,
                memberId: member.id,
                clientId,
                clientSecret,
                store: h.storeOf(id),
            };
        },
        replica: (options = {}) => replicaOf(h, options),
        async board(options = {}) {
            const replica = replicaOf(h, options);
            const { forge } = options;
            const orgs: OrgRegistry = forge
                ? {
                      ...replica.orgs,
                      for: async (orgId) => {
                          const runtime = await replica.orgs.for(orgId);
                          return runtime && { ...runtime, forge };
                      },
                  }
                : replica.orgs;
            const app = await buildApp({
                config: boardConfig,
                orgs,
                auth: createAuthStore({ sql: sql() }),
                ready: replica.ready,
                version: '0.0.0',
                memberGrants: replica.memberGrants,
                gitlabLinks: replica.links,
                gitlabApi: replica.api,
                // The worker and runner routes: a driver's credential and an attempt's pair name the org.
                orgOfLease: createOrgOfLease({ sql: h.sql, ready: replica.ready }),
                orgOfJob: createOrgOfJob({ sql: h.sql, ready: replica.ready }),
                orgOfReclaim: createOrgOfReclaim({ sql: h.sql, ready: replica.ready }),
                driverCredentials: testDriverCredentials,
                attemptOfLease: createAttemptOfLease({ sql: h.sql, ready: replica.ready }),
                pairMatches: createPairMatches({ sql: h.sql, ready: replica.ready }),
                ...(options.githubMint ? { githubMint: options.githubMint } : {}),
                integrations: {
                    ...replica.integrations,
                    configured: replica.registry.configured,
                    ids: replica.registry.ids,
                },
            });
            const roundTrip: Board['roundTrip'] = async (start, login) => {
                const started = await app.inject({
                    method: 'POST',
                    url: start.path,
                    headers: bearer(start.token),
                    payload: {},
                });
                expect(started.statusCode).toBe(CREATED);
                const url = new URL(started.json<{ authorizeUrl: string }>().authorizeUrl);
                url.searchParams.set('login', login);
                const authorized = await fetch(url, { redirect: 'manual' });
                const back = new URL(authorized.headers.get('location') as string);
                const done = await app.inject({
                    method: 'GET',
                    url: `${GITLAB_CALLBACK_PATH}${back.search}`,
                    headers: bearer(start.token),
                });
                expect(done.statusCode).toBe(SEE_OTHER);
                const location = new URL(done.headers.location as string, ORIGIN);
                return { location, result: location.searchParams.get('result') };
            };
            const jobs = async (org: Org) => {
                const store = (await replica.orgs.for(org.id))?.jobs;
                if (!store) throw new Error('the org has no job store');
                return store;
            };
            return {
                app,
                grants: replica.memberGrants,
                replica,
                roundTrip,
                jobs,
                running: async (org, repo) => {
                    const created = await app.inject({
                        method: 'POST',
                        url: '/api/jobs',
                        headers: bearer(org.member),
                        payload: { repo, command: 'work' },
                    });
                    expect(created.statusCode, created.body).toBe(CREATED);
                    const claim = (await (await jobs(org)).claim('worker-1', 60)) as Claim | null;
                    expect(claim?.id).toBe(created.json<{ id: string }>().id);
                    return { id: claim!.id, claim: claim! };
                },
                activate: (org, id) =>
                    roundTrip({ path: `/api/org/gitlab-connections/${id}/activation`, token: org.admin }, ADMIN_LOGIN),
                link: (org, id, login, token = org.member) =>
                    roundTrip({ path: `${LINK_PATH}/${id}/link`, token }, login),
                close: () => app.close(),
            };
        },
        async connect(org, { host = HOST, groups = ['platform'] } = {}) {
            const made = await org.store.create({
                host,
                clientId: org.clientId,
                clientSecret: org.clientSecret,
                allowedGroups: groups,
            });
            if (!made.ok) throw new Error('create refused');
            return made.connection.id;
        },
        async linked(org, memberLogin, { groups } = {}) {
            const id = await h.connect(org, groups ? { groups } : {});
            const board = await h.board();
            try {
                expect((await board.activate(org, id)).result).toBe('activated');
                expect((await board.link(org, id, memberLogin)).result).toBe('linked');
            } finally {
                await board.close();
            }
            return id;
        },
        stop: () => fake.stop(),
    };
    return h;
}

/** Call from `beforeEach` once the database is clean: a fresh keyring over it, the instance reset. */
export async function resetHarness(h: Harness, sql: Sql): Promise<void> {
    (h as { keyring: Harness['keyring'] }).keyring = lineageHarness(sql);
    await h.fake.control('gitlab/version', { version: '17.4.0' });
    await h.fake.control('gitlab/faults', { mode: 'none' });
}
