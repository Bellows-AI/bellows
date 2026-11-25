import { createHash, randomUUID } from 'node:crypto';
import { gitlabForgeOf } from '@factory-ai/core';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { createForgeConnectionStore, type ForgeConnectionStore } from '../src/db/forge-connections.js';
import { createGitlabApi, type GitlabApi } from '../src/gitlab/gitlab-api.js';
import { GITLAB_CALLBACK_PATH } from '../src/integrations/gitlab-link.js';
import { composeIntegrations } from '../src/integrations/compose.js';
import type { MemberForgeGrants } from '../src/integrations/member-forge-grant.js';
import { contextOfSession } from '../src/integrations/trusted-context.js';
import { createOrgRegistry } from '../src/orgs.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { type FakeGitlab, startFakeGitlab } from './fake-gitlab.js';
import { randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import type { LineageTiming } from '../src/integrations/grant-lineage.js';
import { recoverIntegrations } from '../src/integrations/integration-recovery.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { orgSql } from '../src/db/org-sql.js';
import { faultySecrets } from './env-secrets-harness.js';
import { faultyStore, lineageHarness, throwAfterActivate } from './integration-store-faults.js';

/**
 * A member's GitLab link and the admin's activation (docs/connections.md), through the real routes, link service,
 * runtime, lineage and secret store; the fake GitLab (`scripts/fake-forge/gitlab.mjs`) is the only boundary faked. A
 * `replica()` is one board process over the shared database: a fresh one holds nothing in memory, so a refresh through
 * it is a recovery after a restart. Two orgs on one host each register their own OAuth application at the fake.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();

const ORIGIN = 'http://board.test';
const REDIRECT_URI = `${ORIGIN}${GITLAB_CALLBACK_PATH}`;
const LINK_PATH = '/api/forge-grants/gitlab';
const OK = 200;
const CREATED = 201;
const CONFLICT = 409;
const FORBIDDEN = 403;
const SEE_OTHER = 303;
/** Any `*.gitlab.test` name reaches the fake: one instance stands for every host a test connects. */
const HOST = 'shared.gitlab.test';
const FORGE = gitlabForgeOf(HOST);

interface Org {
    id: string;
    admin: string;
    member: string;
    memberId: string;
    adminId: string;
    clientId: string;
    clientSecret: string;
    store: ForgeConnectionStore;
}

let sql: Sql;
let fake: FakeGitlab;
let fakeHost: string;
let keyring: ReturnType<typeof lineageHarness>;
let app: FastifyInstance;
let grants: MemberForgeGrants;
let orgA: Org;
let orgB: Org;

const baseUrl = (h: string) => `http://${h.endsWith('.gitlab.test') ? fakeHost : h}`;
const gitlabApi = (wrap?: (api: GitlabApi) => GitlabApi): GitlabApi => {
    const api = createGitlabApi({ baseUrl, probeTimeoutMs: 400 });
    return wrap ? wrap(api) : api;
};
const noLog = () => {};
const boardConfig = testConfig({
    auth: githubAuth(),
    integrations: { callbackOrigin: ORIGIN, jira: null, linear: null },
});

/** A store over the shared keyring, as every replica opens it: what an admin's connection create writes through. */
const storeOf = (orgId: string) =>
    createForgeConnectionStore({
        sql,
        orgId,
        secrets: keyring.openWith(keyring.realRepo),
        secretLog: noLog,
        gitlab: gitlabApi(),
    });

/**
 * One board replica, composed by the function `main.ts` boots with (`composeIntegrations`), over the shared database
 * and keyring: nothing in memory, so a refresh through a fresh one is a recovery after a restart. The org registry
 * reads each org's connection with its own secret store, as in production. `api` is the only boundary faked.
 */
function replica(
    options: { api?: GitlabApi; clock?: () => number; secrets?: SecretStore; timing?: Partial<LineageTiming> } = {}
) {
    const api = options.api ?? gitlabApi();
    const secrets = options.secrets ?? keyring.openWith(keyring.realRepo);
    const ready = Promise.resolve();
    const composed = composeIntegrations({
        config: boardConfig,
        sql,
        crossOrg: { sql },
        secrets,
        ready,
        gitlab: { api, originOf: baseUrl },
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.timing ? { timing: options.timing } : {}),
    });
    const orgs = createOrgRegistry({
        sql,
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
    return { ...composed, memberGrants: composed.memberGrants, orgs, links, ready };
}
/** Holds the identity lookup (`/user`) of the main replica until released: the window a removal can fall into. */
const userGate: { reached: Promise<void>; release: () => void; armed: boolean } = {
    reached: Promise.resolve(),
    release: () => undefined,
    armed: false,
};
const pausable = (api: GitlabApi): GitlabApi => ({
    ...api,
    request: async (req) => {
        if (userGate.armed && req.path === '/api/v4/user') {
            userGate.armed = false;
            await new Promise<void>((resume) => {
                userGate.release = resume;
                markReached();
            });
        }
        return api.request(req);
    },
});
let markReached: () => void = () => undefined;
/** Arms the gate: the next `/user` call parks until `release()`; `reached` resolves once one is parked. */
const pauseNextUser = () => {
    userGate.reached = new Promise<void>((resolve) => {
        markReached = resolve;
    });
    userGate.armed = true;
};

/** GitLab issues two-hour tokens; a code exchange is answered with a one-second one, so the grant is due a refresh. */
const shortLived = (api: GitlabApi): GitlabApi => ({
    ...api,
    request: async (req) => {
        const answer = await api.request(req);
        if (!answer.ok || req.path !== '/oauth/token' || !req.body?.includes('authorization_code')) return answer;
        return { ...answer, text: JSON.stringify({ ...JSON.parse(answer.text), expires_in: 1 }) };
    },
});
/** The board's clock three hours on: every stored GitLab token (two hours) is then due a refresh. */
const THREE_HOURS_MS = 3 * 3600 * 1000;
const later = () => Date.now() + THREE_HOURS_MS;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function newOrg(): Promise<Org> {
    const id = testOrg();
    await sql`insert into organization (id, name) values (${id}, ${`org-${id}`})`;
    const auth = createAuthStore({ sql });
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
        redirectUris: [REDIRECT_URI],
    });
    return {
        id,
        admin: admin.token,
        adminId: admin.id,
        member: member.token,
        memberId: member.id,
        clientId,
        clientSecret,
        store: storeOf(id),
    };
}

const connect = async (org: Org, host = HOST) => {
    const made = await org.store.create({
        host,
        clientId: org.clientId,
        clientSecret: org.clientSecret,
        allowedGroups: ['platform'],
    });
    if (!made.ok) throw new Error('create refused');
    return made.connection.id;
};

/** The authorize round trip as `login` at GitLab, then the board's callback as the caller; the callback's redirect. */
async function roundTrip(
    org: Org,
    start: { path: string; token: string },
    login: string,
    options: { callbackToken?: string; challenge?: string } = {}
) {
    const started = await app.inject({ method: 'POST', url: start.path, headers: bearer(start.token), payload: {} });
    expect(started.statusCode).toBe(CREATED);
    const { authorizeUrl } = started.json<{ authorizeUrl: string }>();
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe(org.clientId);
    expect(url.searchParams.get('scope')).toBe('api');
    url.searchParams.set('login', login);
    // PKCE: the board sends the S256 challenge of a verifier it keeps with the link state.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (options.challenge) url.searchParams.set('code_challenge', options.challenge);
    const authorized = await fetch(url, { redirect: 'manual' });
    const back = new URL(authorized.headers.get('location') as string);
    return callback(back.search, options.callbackToken ?? start.token);
}
const callback = async (query: string, token: string) => {
    const done = await app.inject({
        method: 'GET',
        url: `${GITLAB_CALLBACK_PATH}${query}`,
        headers: bearer(token),
    });
    expect(done.statusCode).toBe(SEE_OTHER);
    const location = new URL(done.headers.location as string, ORIGIN);
    return { location, result: location.searchParams.get('result'), query };
};
const linkPath = (id: string) => `${LINK_PATH}/${id}/link`;
const activationPath = (id: string) => `/api/org/gitlab-connections/${id}/activation`;

const activate = (org: Org, id: string, login = 'admin-login') =>
    roundTrip(org, { path: activationPath(id), token: org.admin }, login);
const link = (org: Org, id: string, login: string, token = org.member) =>
    roundTrip(org, { path: linkPath(id), token }, login);

const tokenCalls = () => fake.forge.calls().filter((c) => c.method === 'POST' && c.path === '/oauth/token').length;
const grantRows = (orgId: string) =>
    sql<{ id: string; status: string; provider: string; external_account_id: string; secret_version: string }[]>`
        select id, status, provider, external_account_id, secret_version from integration_grant
        where org_id = ${orgId} and provider = ${FORGE}
    `;
const asUserOf = async (grantsOf: MemberForgeGrants, org: Org, userId: string) =>
    grantsOf.accessToken(org.id, userId, FORGE);

beforeAll(async () => {
    if (!enabled) return;
    fake = await startFakeGitlab({ client: false });
    fakeHost = new URL(fake.base).host;
});
beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    keyring = lineageHarness(sql);
    await fake.control('gitlab/version', { version: '17.4.0' });
    await fake.control('gitlab/faults', { mode: 'none' });
    [orgA, orgB] = [await newOrg(), await newOrg()];
    const main = replica({ api: gitlabApi((api) => pausable(shortLived(api))) });
    grants = main.memberGrants;
    app = await buildApp({
        config: boardConfig,
        orgs: main.orgs,
        auth: createAuthStore({ sql }),
        ready: main.ready,
        version: '0.0.0',
        memberGrants: main.memberGrants,
        gitlabLinks: main.links,
        integrations: { ...main.integrations, configured: main.registry.configured, ids: main.registry.ids },
    });
});
afterEach(async () => {
    if (enabled) await app?.close();
});
afterAll(async () => {
    await fake?.stop();
});

describe.skipIf(!enabled)('GitLab activation by the admin', () => {
    it('activates a pending connection with the admin’s authenticated /version and keeps the admin’s grant', async () => {
        const id = await connect(orgA);
        expect((await orgA.store.get(id))?.active).toBe(false);
        const done = await activate(orgA, id);
        expect(done.result).toBe('activated');
        expect(await orgA.store.get(id)).toMatchObject({ active: true, version: '17.4.0', activationRefusal: null });
        expect(await grants.standing(orgA.id, orgA.adminId, FORGE)).toBe('live');
    });

    it('refuses a member: only an admin starts an activation', async () => {
        const id = await connect(orgA);
        const started = await app.inject({
            method: 'POST',
            url: activationPath(id),
            headers: bearer(orgA.member),
            payload: {},
        });
        expect(started.statusCode).toBe(FORBIDDEN);
        expect((await orgA.store.get(id))?.active).toBe(false);
    });

    it('refuses GitLab 16.x with its reason, stores no grant, and keeps the connection pending', async () => {
        const id = await connect(orgA);
        await fake.control('gitlab/version', { version: '16.11.2' });
        const done = await activate(orgA, id);
        expect(done.result).toBe('version-too-old');
        expect(await orgA.store.get(id)).toMatchObject({ active: false, activationRefusal: 'version-too-old' });
        expect(await grantRows(orgA.id)).toHaveLength(0);
        // The instance upgrades: the same connection activates and the refusal clears.
        await fake.control('gitlab/version', { version: '17.0.1' });
        expect((await activate(orgA, id)).result).toBe('activated');
        expect(await orgA.store.get(id)).toMatchObject({ active: true, version: '17.0.1', activationRefusal: null });
    });

    it.each([
        { name: '5xx', fault: { mode: 'status', status: 503 } },
        { name: 'a malformed body', fault: { mode: 'malformed' } },
        { name: 'no answer', fault: { mode: 'timeout' } },
    ])('leaves the connection pending, and stores nothing, when /version answers with $name', async ({ fault }) => {
        const id = await connect(orgA);
        await fake.control('gitlab/faults', { ...fault, pathIncludes: '/version', count: 1 });
        const done = await activate(orgA, id);
        expect(done.result).toBe('unconfirmed');
        expect(await orgA.store.get(id)).toMatchObject({ active: false, activationRefusal: null });
        expect(await grantRows(orgA.id)).toHaveLength(0);
        // Nothing was decided: the next attempt, with the instance answering, activates the same row.
        expect((await activate(orgA, id)).result).toBe('activated');
    });
});

describe.skipIf(!enabled)('a member’s GitLab link', () => {
    it('refuses a link while the connection is pending, naming the admin step', async () => {
        const id = await connect(orgA);
        const started = await app.inject({
            method: 'POST',
            url: linkPath(id),
            headers: bearer(orgA.member),
            payload: {},
        });
        expect(started.statusCode).toBe(CONFLICT);
        expect(started.json()).toMatchObject({ code: 'GITLAB_CONNECTION_PENDING' });
    });

    it('links the member: an active grant keyed gitlab:<host> whose token works at GitLab, nobody else’s', async () => {
        const id = await connect(orgA);
        await activate(orgA, id);
        const done = await link(orgA, id, 'dev-one');
        expect(done.result).toBe('linked');
        expect(done.location.pathname).toBe('/settings/integrations');
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('live');
        expect(await grants.standing(orgA.id, orgA.adminId, FORGE)).toBe('live');
        const rows = await grantRows(orgA.id);
        expect(rows.map((r) => r.provider)).toEqual([FORGE, FORGE]);
        const token = await asUserOf(grants, orgA, orgA.memberId);
        if (!token.ok) throw new Error('no token');
        const me = await fake.send('GET', '/api/v4/user', { token: token.accessToken });
        expect(me.body.username).toBe('dev-one');
        expect(await grants.standing(orgB.id, orgA.memberId, FORGE)).toBe('missing');
    });

    it('lists the active connections with the caller’s standing', async () => {
        const id = await connect(orgA);
        const before = await app.inject({ method: 'GET', url: LINK_PATH, headers: bearer(orgA.member) });
        expect(before.json()).toEqual({ connections: [] });
        await activate(orgA, id);
        const unlinked = await app.inject({ method: 'GET', url: LINK_PATH, headers: bearer(orgA.member) });
        expect(unlinked.json()).toEqual({ connections: [{ id, host: HOST, standing: 'missing' }] });
        await link(orgA, id, 'dev-one');
        const linked = await app.inject({ method: 'GET', url: LINK_PATH, headers: bearer(orgA.member) });
        expect(linked.statusCode).toBe(OK);
        expect(linked.json()).toEqual({ connections: [{ id, host: HOST, standing: 'live' }] });
    });

    it('consumes the state once: a replayed callback exchanges nothing and changes nothing', async () => {
        const id = await connect(orgA);
        await activate(orgA, id);
        const first = await link(orgA, id, 'dev-one');
        expect(first.result).toBe('linked');
        const before = (await grantRows(orgA.id)).map((r) => r.secret_version).sort();
        const calls = tokenCalls();
        const replayed = await callback(first.query, orgA.member);
        expect(replayed.result).toBe('replayed');
        expect(tokenCalls()).toBe(calls);
        expect((await grantRows(orgA.id)).map((r) => r.secret_version).sort()).toEqual(before);
    });

    it('answers another person’s callback, and an unknown state, as a mismatch that links nothing', async () => {
        const id = await connect(orgA);
        await activate(orgA, id);
        const calls = tokenCalls();
        const started = await app.inject({
            method: 'POST',
            url: linkPath(id),
            headers: bearer(orgA.member),
            payload: {},
        });
        const url = new URL(started.json<{ authorizeUrl: string }>().authorizeUrl);
        url.searchParams.set('login', 'dev-two');
        const authorized = await fetch(url, { redirect: 'manual' });
        const back = new URL(authorized.headers.get('location') as string);
        const stolen = await callback(back.search, orgA.admin);
        expect(stolen.result).toBe('state-mismatch');
        expect((await callback('?state=nope&code=x', orgA.member)).result).toBe('state-mismatch');
        // Only the one legitimate exchange happened.
        expect(tokenCalls()).toBe(calls);
    });

    it('proves possession with PKCE: a code issued for another challenge is refused at the exchange, and nothing is linked', async () => {
        const id = await connect(orgA);
        await activate(orgA, id);
        const forged = createHash('sha256').update('not-the-boards-verifier').digest('base64url');
        const refused = await roundTrip(orgA, { path: linkPath(id), token: orgA.member }, 'dev-one', {
            challenge: forged,
        });
        expect(refused.result).toBe('exchange-failed');
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('missing');
        const [row] = await sql`select pkce_verifier from forge_link where org_id = ${orgA.id} and purpose = 'link'`;
        expect(row?.pkce_verifier).toBeNull();
    });

    it('resolves the org’s own GitLab client through the runtime, so the generic flow is configured, per org', async () => {
        const [idA, idB] = [await connect(orgA), await connect(orgB)];
        await Promise.all([activate(orgA, idA), activate(orgB, idB)]);
        const main = replica();
        const start = async (org: Org) => {
            const result = await main.integrations
                .flowOf(org.id)
                .startAuthorization(contextOfSession({ user: { id: org.memberId } }, org.id), { provider: FORGE });
            if (!result.ok) throw new Error(`start refused: ${result.reason}`);
            return new URL(result.authorizeUrl);
        };
        const [a, b] = [await start(orgA), await start(orgB)];
        expect(a.searchParams.get('client_id')).toBe(orgA.clientId);
        expect(b.searchParams.get('client_id')).toBe(orgB.clientId);
        expect(a.searchParams.get('code_challenge_method')).toBe('S256');
        // An org with no connection to the host has no client: not configured, never another org's.
        const stranger = await newOrg();
        const none = await main.integrations
            .flowOf(stranger.id)
            .startAuthorization(contextOfSession({ user: { id: stranger.memberId } }, stranger.id), {
                provider: FORGE,
            });
        expect(none).toEqual({ ok: false, reason: 'not-configured' });
    });

    it('answers a denied authorization as denied and links nothing', async () => {
        const id = await connect(orgA);
        await activate(orgA, id);
        const started = await app.inject({
            method: 'POST',
            url: linkPath(id),
            headers: bearer(orgA.member),
            payload: {},
        });
        const state = new URL(started.json<{ authorizeUrl: string }>().authorizeUrl).searchParams.get('state');
        const done = await callback(`?error=access_denied&state=${state}`, orgA.member);
        expect(done.result).toBe('denied');
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('missing');
    });

    it('refuses a GitLab account another member of the org already linked', async () => {
        const id = await connect(orgA);
        await activate(orgA, id);
        expect((await link(orgA, id, 'shared-dev')).result).toBe('linked');
        expect((await link(orgA, id, 'shared-dev', orgA.admin)).result).toBe('grant-conflict');
    });
});

describe.skipIf(!enabled)('removing a connection while a callback is in flight', () => {
    /** Starts a round trip and runs it to the identity lookup, where it parks; resolves with the pending callback. */
    async function parkedAt(start: { path: string; token: string }, login: string) {
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
        pauseNextUser();
        const pending = callback(back.search, start.token);
        await userGate.reached;
        return { pending };
    }
    const rowsOf = (userId: string) =>
        sql`select id from integration_grant where org_id = ${orgA.id} and principal_user_id = ${userId} and provider = ${FORGE}`;
    const removeAndRecreate = async (org: Org, id: string) => {
        expect(await org.store.remove(id)).toBe(true);
        return connect(org);
    };

    it('a member’s link finished after the connection was removed and re-created stores no live grant and is not linked', async () => {
        const id = await connect(orgA);
        await activate(orgA, id);
        const { pending } = await parkedAt({ path: linkPath(id), token: orgA.member }, 'dev-one');
        const recreated = await removeAndRecreate(orgA, id);
        userGate.release();
        const done = await pending;
        expect(done.result).toBe('connection-gone');
        expect((await grantRows(orgA.id)).filter((r) => r.status !== 'revoked')).toHaveLength(0);
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('missing');
        // Nothing was written for the callback that lost the race: not even a grant row.
        expect(await rowsOf(orgA.memberId)).toHaveLength(0);
        expect(await orgA.store.get(recreated)).toMatchObject({ active: false });
    });

    it('an admin’s activation finished after the connection was removed and re-created leaves the new connection pending and stores no live grant', async () => {
        const id = await connect(orgA);
        const { pending } = await parkedAt({ path: activationPath(id), token: orgA.admin }, 'admin-login');
        const recreated = await removeAndRecreate(orgA, id);
        userGate.release();
        const done = await pending;
        expect(done.result).toBe('connection-gone');
        expect(await orgA.store.get(recreated)).toMatchObject({ active: false, version: null });
        expect(await grants.standing(orgA.id, orgA.adminId, FORGE)).toBe('missing');
        expect(await rowsOf(orgA.adminId)).toHaveLength(0);
    });

    /** One callback through a replica's own link service, as the caller; its result. */
    async function prepareVia(rep: ReturnType<typeof replica>, who: { userId: string; admin: boolean }, id: string) {
        const started = await rep.links.start({
            orgId: orgA.id,
            userId: who.userId,
            connectionId: id,
            purpose: who.admin ? 'activate' : 'link',
        });
        if (!started.ok) throw new Error(`start refused: ${started.reason}`);
        const url = new URL(started.authorizeUrl);
        url.searchParams.set('login', who.admin ? 'admin-login' : 'dev-one');
        const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location') as string);
        return () =>
            rep.links.complete({
                orgId: orgA.id,
                userId: who.userId,
                admin: who.admin,
                state: back.searchParams.get('state') ?? undefined,
                code: back.searchParams.get('code') ?? undefined,
                error: undefined,
            });
    }
    const viaReplica = async (rep: ReturnType<typeof replica>, who: { userId: string; admin: boolean }, id: string) =>
        (await prepareVia(rep, who, id))();
    /** Resolves once some backend waits on a row lock: the deterministic signal that a statement is queued behind one. */
    async function untilBlockedOnALock() {
        for (let tries = 0; tries < 500; tries += 1) {
            const [row] = await sql<{ n: number }[]>`
                select count(*)::int as n from pg_stat_activity
                where wait_event_type = 'Lock' and datname = current_database()
            `;
            if (row && row.n > 0) return;
            await new Promise((resume) => setTimeout(resume, 20));
        }
        throw new Error('nothing ever waited on a lock');
    }
    const expireClaims = () =>
        sql`update integration_grant set lineage_claim_expires_at = now() - interval '1 second' where org_id = ${orgA.id} and lineage_claim is not null`;
    const liveGrantsOf = (userId: string) =>
        sql`select id from integration_grant where org_id = ${orgA.id} and principal_user_id = ${userId} and provider = ${FORGE} and status <> 'revoked'`;

    it.each([
        ['a member’s link', false],
        ['an admin’s activation', true],
    ])('%s waits behind a removal holding the connection lock, then writes nothing', async (_name, admin) => {
        const id = await connect(orgA);
        if (!admin) await activate(orgA, id);
        const who = admin ? { userId: orgA.adminId, admin } : { userId: orgA.memberId, admin };
        const callback = await prepareVia(replica(), who, id);
        const queued = await orgSql(sql, orgA.id).begin(async (tx) => {
            // What removal does first: the connection row, then the tombstone and the revocation, uncommitted.
            await tx`select 1 from forge_connection where org_id = ${orgA.id} and id = ${id} for update`;
            await tx`update forge_connection set removed_at = now(), active = false where org_id = ${orgA.id} and id = ${id}`;
            await tx`update integration_grant set status = 'revoked' where org_id = ${orgA.id} and forge_connection_id = ${id} and status <> 'revoked'`;
            const publishing = callback();
            await untilBlockedOnALock();
            // The publication is parked on the lock: it has written nothing a reader can see.
            expect(await rowsOf(who.userId)).toHaveLength(0);
            return { publishing };
        });
        expect((await queued.publishing).ok).toBe(false);
        expect(await rowsOf(who.userId)).toHaveLength(0);
        expect(await liveGrantsOf(who.userId)).toHaveLength(0);
    });

    it('removal that commits and then fails its secret cleanup leaves no live grant, and token reads refuse', async () => {
        const id = await connect(orgA);
        await activate(orgA, id);
        expect((await link(orgA, id, 'dev-one')).result).toBe('linked');
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('live');
        const crashing = createForgeConnectionStore({
            sql,
            orgId: orgA.id,
            secrets: faultySecrets(keyring.openWith(keyring.realRepo), {
                delete: async () => {
                    throw new Error('the process died during cleanup');
                },
            }),
            secretLog: noLog,
            gitlab: gitlabApi(),
        });
        await expect(crashing.remove(id)).rejects.toThrow();
        // The tombstone and the revocations committed before cleanup began.
        const [row] =
            await sql`select removed_at, active from forge_connection where org_id = ${orgA.id} and id = ${id}`;
        expect(row?.removed_at).not.toBeNull();
        expect(await liveGrantsOf(orgA.memberId)).toHaveLength(0);
        expect(await liveGrantsOf(orgA.adminId)).toHaveLength(0);
        expect(await asUserOf(grants, orgA, orgA.memberId)).toMatchObject({
            ok: false,
            outcome: { outcome: 'integration_required', reason: 'missing' },
        });
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('missing');
    });

    it('refuses the token of a grant whose connection is inactive, even one written by SQL that revoked nothing', async () => {
        const id = await connect(orgA);
        await sql`
            insert into integration_grant
                (org_id, principal_kind, principal_user_id, provider, external_account_id, authority, status,
                 forge_connection_id)
            values (${orgA.id}, 'user', ${orgA.memberId}, ${FORGE}, 'sql-made', '{"scopes":[]}'::jsonb, 'active', ${id})
        `;
        expect(await asUserOf(grants, orgA, orgA.memberId)).toMatchObject({
            ok: false,
            outcome: { outcome: 'integration_required', reason: 'missing' },
        });
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('missing');
        // Only the connection stood in the way: once it is active the same row is found (and has no credential yet).
        await sql`update forge_connection set active = true where org_id = ${orgA.id} and id = ${id}`;
        expect(await asUserOf(grants, orgA, orgA.memberId)).toMatchObject({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'credential-pending' },
        });
    });

    it.each([
        ['a member’s link', false],
        ['an admin’s activation', true],
    ])(
        '%s whose holder crashed after the secret was stored never goes live on a removed connection',
        async (_name, admin) => {
            const id = await connect(orgA);
            if (!admin) await activate(orgA, id);
            const who = admin ? { userId: orgA.adminId, admin } : { userId: orgA.memberId, admin };
            // The holder stores the secret, loses the answer and dies: claim and operation stay recorded.
            const crashing = replica({
                secrets: faultyStore(keyring, { activate: throwAfterActivate }).store,
                timing: { persistBudgetMs: 0, retryDelayMs: 0 },
            });
            expect((await viaReplica(crashing, who, id)).ok).toBe(false);
            const [pending] =
                await sql`select lineage_claim, lineage_operation_id, status from integration_grant where principal_user_id = ${who.userId} and provider = ${FORGE}`;
            expect(pending?.lineage_claim).not.toBeNull();
            expect(pending?.status).not.toBe('active');
            // The connection is tombstoned, without the revocation removal does, as if the process died in between.
            await sql`update forge_connection set removed_at = now() where org_id = ${orgA.id} and id = ${id}`;
            await expireClaims();
            // A restarted board recovers the lineage: the finalize is guarded by the connection, so the grant ends revoked.
            await recoverIntegrations(replica().integrations);
            expect(await liveGrantsOf(who.userId)).toHaveLength(0);
            expect(await grants.standing(orgA.id, who.userId, FORGE)).toBe('missing');
            // And once the removal completes, the row can go: nothing live references it.
            expect(await orgA.store.remove(id)).toBe(true);
            expect(await liveGrantsOf(who.userId)).toHaveLength(0);
        }
    );

    it('removing a connection revokes the grants made through it', async () => {
        const id = await connect(orgA);
        await activate(orgA, id);
        expect((await link(orgA, id, 'dev-one')).result).toBe('linked');
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('live');
        await orgA.store.remove(id);
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('missing');
        expect(await grants.standing(orgA.id, orgA.adminId, FORGE)).toBe('missing');
        expect((await grantRows(orgA.id)).every((r) => r.status === 'revoked')).toBe(true);
    });
});

describe.skipIf(!enabled)('the refresh of a GitLab grant', () => {
    async function linked(org: Org, login: string) {
        const id = await connect(org);
        await activate(org, id);
        expect((await link(org, id, login)).result).toBe('linked');
        return id;
    }

    it('rotates the refresh token on every use, across two replicas, with one refresh for two concurrent callers', async () => {
        await linked(orgA, 'dev-one');
        const [one, two] = [replica(), replica()];
        const calls = tokenCalls();
        const [a, b] = await Promise.all([
            asUserOf(one.memberGrants, orgA, orgA.memberId),
            asUserOf(two.memberGrants, orgA, orgA.memberId),
        ]);
        // The one that lost the claim is told to retry; it never refreshes a second time.
        expect(tokenCalls()).toBe(calls + 1);
        expect([a, b].some((answer) => answer.ok)).toBe(true);
        const [c, d] = await Promise.all([
            asUserOf(one.memberGrants, orgA, orgA.memberId),
            asUserOf(two.memberGrants, orgA, orgA.memberId),
        ]);
        if (!c.ok || !d.ok) throw new Error('the settled refresh was not readable');
        expect(c.accessToken).toBe(d.accessToken);
        expect(tokenCalls()).toBe(calls + 1);
        // The next refresh spends the rotated token, never the first one, and works from another replica.
        const before = (await grantRows(orgA.id)).map((r) => r.secret_version);
        await asUserOf(replica({ clock: later }).memberGrants, orgA, orgA.memberId);
        expect(tokenCalls()).toBe(calls + 2);
        expect((await grantRows(orgA.id)).map((r) => r.secret_version)).not.toEqual(before);
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('live');
    });

    it('recovers after a restart: a replica built fresh refreshes a grant it never saw', async () => {
        await linked(orgA, 'dev-one');
        const fresh = replica();
        const token = await asUserOf(fresh.memberGrants, orgA, orgA.memberId);
        expect(token.ok).toBe(true);
    });

    it('keeps two orgs on one host apart: each refreshes with its own application, and the same account is two grants', async () => {
        await linked(orgA, 'same-dev');
        await linked(orgB, 'same-dev');
        const both = replica();
        const [a, b] = await Promise.all([
            asUserOf(both.memberGrants, orgA, orgA.memberId),
            asUserOf(both.memberGrants, orgB, orgB.memberId),
        ]);
        if (!a.ok || !b.ok) throw new Error('a refresh failed');
        expect(a.accessToken).not.toBe(b.accessToken);
        const [rowsA, rowsB] = [await grantRows(orgA.id), await grantRows(orgB.id)];
        expect(rowsA.map((r) => r.id).filter((id) => rowsB.some((r) => r.id === id))).toEqual([]);
        // The fake refuses a refresh token under any client but the one it was issued to, so success is the proof;
        // an org whose application is gone cannot refresh at all rather than borrow the other's.
        const connection = (await orgB.store.list())[0];
        if (!connection) throw new Error('no connection');
        await orgB.store.remove(connection.id);
        const orphaned = await asUserOf(replica({ clock: later }).memberGrants, orgB, orgB.memberId);
        expect(orphaned.ok).toBe(false);
        const stillA = await asUserOf(replica().memberGrants, orgA, orgA.memberId);
        expect(stillA.ok).toBe(true);
    });

    /** A fake whose token endpoint is wrapped: `mode` decides what a refresh call sees. */
    const wrapped = (mode: () => 'pass' | 'refused' | 'lost' | 'bad-gateway' | 'gateway-timeout') =>
        replica({
            clock: later,
            api: gitlabApi((api) => ({
                ...api,
                request: async (req) => {
                    const what = req.path === '/oauth/token' ? mode() : 'pass';
                    if (what === 'refused') return { ok: false, reason: 'unreachable', sent: false };
                    const answer = await api.request(req);
                    // The instance processed the call (the refresh token is spent); a proxy or the network
                    // replaces the answer.
                    if (what === 'bad-gateway') return { ok: true, status: 502, text: '<html>Bad Gateway</html>' };
                    if (what === 'gateway-timeout') return { ok: true, status: 504, text: '' };
                    return what === 'lost' ? { ok: false, reason: 'timeout', sent: true } : answer;
                },
            })),
        });

    it('retries a refresh that never reached GitLab (connection refused): the grant stays live', async () => {
        await linked(orgA, 'dev-one');
        let down = true;
        const flaky = wrapped(() => (down ? 'refused' : 'pass'));
        const calls = tokenCalls();
        expect((await asUserOf(flaky.memberGrants, orgA, orgA.memberId)).ok).toBe(false);
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('live');
        expect(tokenCalls()).toBe(calls);
        down = false;
        const before = (await grantRows(orgA.id)).map((r) => r.secret_version);
        await asUserOf(flaky.memberGrants, orgA, orgA.memberId);
        // The clock runs three hours ahead, so the new token still reads as due; the stored credential moved.
        expect((await grantRows(orgA.id)).map((r) => r.secret_version)).not.toEqual(before);
        expect(tokenCalls()).toBe(calls + 1);
    });

    it.each(['bad-gateway', 'gateway-timeout'] as const)(
        'never replays a token after a %s: GitLab processed the refresh, so the grant needs reconnect and nobody resends',
        async (gateway) => {
            await linked(orgA, 'dev-one');
            const calls = tokenCalls();
            const first = await asUserOf(wrapped(() => gateway).memberGrants, orgA, orgA.memberId);
            expect(first).toMatchObject({
                ok: false,
                outcome: { outcome: 'integration_required', reason: 'reconnect' },
            });
            expect(tokenCalls()).toBe(calls + 1);
            const second = await asUserOf(replica({ clock: later }).memberGrants, orgA, orgA.memberId);
            expect(second).toMatchObject({
                ok: false,
                outcome: { outcome: 'integration_required', reason: 'reconnect' },
            });
            expect(tokenCalls()).toBe(calls + 1);
            expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('broken');
        }
    );

    it.each([
        ['a warmed connection', true],
        ['a fresh connection', false],
    ])(
        'never replays a token whose answer was lost on %s: the real client times out after GitLab spent it',
        async (_name, warmed) => {
            await linked(orgA, 'dev-one');
            let boardCalls = 0;
            const api = gitlabApi((real) => ({
                ...real,
                request: (req) => {
                    if (req.path === '/oauth/token') boardCalls += 1;
                    return real.request(req);
                },
            }));
            if (warmed) {
                // An earlier call to the same host, as a pooled client would have kept the socket for.
                expect(await api.checkVersion({ host: HOST, token: 'any' })).toBeDefined();
            }
            const held = await asUserOf(grants, orgA, orgA.memberId);
            if (!held.ok) throw new Error('no token to spend');
            await fake.control('gitlab/faults', { mode: 'lost', pathIncludes: '/oauth/token', count: 1 });
            const first = await asUserOf(replica({ clock: later, api }).memberGrants, orgA, orgA.memberId);
            expect(first).toMatchObject({
                ok: false,
                outcome: { outcome: 'integration_required', reason: 'reconnect' },
            });
            // GitLab did process it (the old pair is dead) and the board sent it exactly once.
            expect((await fake.send('GET', '/api/v4/user', { token: held.accessToken })).status).toBe(401);
            expect(boardCalls).toBe(1);
            const second = await asUserOf(replica({ clock: later, api }).memberGrants, orgA, orgA.memberId);
            expect(second).toMatchObject({
                ok: false,
                outcome: { outcome: 'integration_required', reason: 'reconnect' },
            });
            expect(boardCalls).toBe(1);
            expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('broken');
        }
    );

    it('never replays a refresh token whose consumption is unknown: the lost answer ends in reconnect, once', async () => {
        await linked(orgA, 'dev-one');
        const calls = tokenCalls();
        // GitLab rotates the token and the answer is lost on its way back.
        const first = await asUserOf(wrapped(() => 'lost').memberGrants, orgA, orgA.memberId);
        expect(first).toMatchObject({ ok: false, outcome: { outcome: 'integration_required', reason: 'reconnect' } });
        expect(tokenCalls()).toBe(calls + 1);
        // A caller on another replica finds the grant needing reconnect and sends nothing: the spent token is not reused.
        const second = await asUserOf(replica({ clock: later }).memberGrants, orgA, orgA.memberId);
        expect(second).toMatchObject({ ok: false, outcome: { outcome: 'integration_required', reason: 'reconnect' } });
        expect(tokenCalls()).toBe(calls + 1);
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('broken');
        expect((await grantRows(orgA.id)).filter((r) => r.status === 'revoked')).toHaveLength(0);
    });

    it('breaks the grant when GitLab revokes it, and a new link makes it live again', async () => {
        const id = await linked(orgA, 'dev-one');
        const token = await asUserOf(grants, orgA, orgA.memberId);
        if (!token.ok) throw new Error('no token');
        // GitLab no longer knows the refresh token: the member deauthorized the application.
        const revoked = await fake.send('POST', '/oauth/revoke', {
            body: { token: token.accessToken, client_id: orgA.clientId, client_secret: orgA.clientSecret },
        });
        expect(revoked.status).toBe(OK);
        const refreshing = replica({ clock: later });
        const broken = await asUserOf(refreshing.memberGrants, orgA, orgA.memberId);
        expect(broken).toMatchObject({ ok: false, outcome: { outcome: 'integration_required', reason: 'reconnect' } });
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('broken');
        expect((await link(orgA, id, 'dev-one')).result).toBe('linked');
        expect(await grants.standing(orgA.id, orgA.memberId, FORGE)).toBe('live');
    });
});
