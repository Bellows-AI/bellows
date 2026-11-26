import { randomUUID } from 'node:crypto';
import { gitlabForgeOf } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { JOB_ID_HEADER, LEASE_TOKEN_HEADER } from '../src/auth/plugin.js';
import { faultySecrets, testSecretDeps } from './env-secrets-harness.js';
import { expireLease } from './fixtures.js';
import {
    type Board,
    bearer,
    type Harness,
    HOST,
    type Org,
    resetHarness,
    startHarness,
} from './gitlab-board-harness.js';
import { useTestDb } from './harness.js';

/**
 * The attempt's GitLab credential (docs/connections.md): the thread starter's access token and its expiry, behind the
 * attempt pair, refreshed single-flight, withheld from a pair that stops being the live attempt during the refresh.
 * Everything is real but the fake GitLab; a board whose clock runs three hours ahead finds every stored token due a
 * refresh. The wait a broken grant opens is pinned by gitlab-loss.test.ts.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const CONFLICT = 409;
const UNAVAILABLE = 503;
const LEASE_SECONDS = 60;
/** The board's clock three hours on: every stored GitLab token (two hours) is then due a refresh. */
const THREE_HOURS_MS = 3 * 3600 * 1000;
const later = () => Date.now() + THREE_HOURS_MS;
const FORGE = gitlabForgeOf(HOST);

let sql: Sql;
let h: Harness & { stop(): Promise<void> };
let org: Org;
let grp: string;
let connectionId: string;
let boards: Board[];

beforeAll(async () => {
    if (!enabled) return;
    h = await startHarness(() => db.sql);
});
beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    boards = [];
    await resetHarness(h, sql);
    org = await h.newOrg();
    grp = `g${randomUUID().slice(0, 8)}`;
    await createUserExecutorStore({ sql, orgId: org.id, ...testSecretDeps(sql) }).createOrg({
        name: 'main',
        type: 'claude-code',
        config: {},
        createdBy: org.adminId,
    });
    await h.fake.control('gitlab/projects', { path: `${grp}/web` });
    connectionId = await h.connect(org, { groups: [grp] });
});
afterEach(async () => {
    if (enabled) await Promise.all(boards.map((board) => board.close()));
});
afterAll(async () => {
    await h?.stop();
});

/** A board replica over the shared database: a restart of the board each time it is built. */
const boot = async (options: Parameters<Harness['board']>[0] = {}) => {
    const board = await h.board(options);
    boards.push(board);
    return board;
};

/**
 * A board whose clock runs three hours ahead until its first token refresh has been answered: the stored token is due,
 * and the refreshed one (stamped on the real clock) is read as live. `during` runs inside the refresh call.
 */
const dueOnce = (during: () => Promise<void> = async () => {}) => {
    let offset = THREE_HOURS_MS;
    return {
        clock: () => Date.now() + offset,
        api: h.gitlabApi((api) => ({
            ...api,
            request: async (req) => {
                if (req.path !== '/oauth/token') return api.request(req);
                await during();
                const answer = await api.request(req);
                offset = 0;
                return answer;
            },
        })),
    };
};
const repo = () => ({ forge: 'gitlab', host: HOST, path: `${grp}/web` });

/** The org's GitLab set up, the member linked and the repo tracked, on `board`. */
async function setUp(board: Board) {
    expect((await board.activate(org, connectionId)).result).toBe('activated');
    expect((await board.link(org, connectionId, 'dev-one')).result).toBe('linked');
    const picked = await board.app.inject({
        method: 'PUT',
        url: `/api/org/gitlab-connections/${connectionId}/tracked-repos`,
        headers: bearer(org.admin),
        payload: { paths: [`${grp}/web`] },
    });
    expect(picked.statusCode).toBe(OK);
}

/** The attempt's pair, as a runner presents it. */
const pair = (id: string, leaseToken: string) => ({ [JOB_ID_HEADER]: id, [LEASE_TOKEN_HEADER]: leaseToken });
const credential = (board: Board, id: string, leaseToken: string) =>
    board.app.inject({ method: 'POST', url: `/api/jobs/${id}/credentials/gitlab`, headers: pair(id, leaseToken) });
const tokenCalls = () => h.fake.forge.calls().filter((c) => c.method === 'POST' && c.path === '/oauth/token').length;
const statusOf = async (id: string) =>
    (await sql<{ status: string }[]>`select status from job where id = ${id}`)[0]?.status;
const heartbeat = async (board: Board, id: string, leaseToken: string) =>
    (await board.jobs(org)).heartbeat(id, leaseToken, LEASE_SECONDS);

describe.skipIf(!enabled)('the attempt’s GitLab credential', () => {
    it('answers the starter’s own access token with its expiry, never cached', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        const res = await credential(board, id, claim.leaseToken);
        expect(res.statusCode).toBe(OK);
        expect(res.headers['cache-control']).toBe('no-store');
        const body = res.json<{ token: string; expiresAt: string | null; standing: string }>();
        expect(body).toMatchObject({ standing: 'live' });
        const own = await board.grants.accessToken(org.id, org.memberId, FORGE);
        if (!own.ok) throw new Error('the starter holds no token');
        // The starter's (the member's), not the admin's who activated the connection.
        expect(body.token).toBe(own.accessToken);
        expect(Date.parse(body.expiresAt ?? '')).toBe(own.expiresAt);
        const admin = await board.grants.accessToken(org.id, org.adminId, FORGE);
        expect(admin.ok && admin.accessToken).not.toBe(body.token);
    });

    it('refreshes an expired token once for concurrent requests and answers the new one', async () => {
        const first = await boot();
        await setUp(first);
        const { id, claim } = await first.running(org, repo());
        const board = await boot(dueOnce());
        const calls = tokenCalls();
        const answers = await Promise.all([1, 2, 3].map(() => credential(board, id, claim.leaseToken)));
        // The refresh rotates the refresh token: one call, never one per request; a loser asks again.
        expect(tokenCalls()).toBe(calls + 1);
        for (const a of answers) expect([OK, UNAVAILABLE]).toContain(a.statusCode);
        const after = await credential(board, id, claim.leaseToken);
        expect(after.statusCode, after.body).toBe(OK);
        const fresh = after.json<{ token: string; expiresAt: string }>();
        expect(Date.parse(fresh.expiresAt)).toBeGreaterThan(Date.now() + 3600 * 1000);
        expect(tokenCalls()).toBe(calls + 1);
    });

    it('serves no token once the connection is gone: the grant is fenced to its connection', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        const removed = await board.app.inject({
            method: 'DELETE',
            url: `/api/org/gitlab-connections/${connectionId}`,
            headers: bearer(org.admin),
        });
        expect(removed.statusCode).toBe(OK);
        const res = await credential(board, id, claim.leaseToken);
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', waiting: true });
        expect(res.body).not.toContain('"token"');
    });

    it('keeps two orgs apart: a pair answers its own org’s starter, never the other’s', async () => {
        const board = await boot();
        await setUp(board);
        const other = await h.newOrg();
        const otherGroup = `g${randomUUID().slice(0, 8)}`;
        await h.fake.control('gitlab/projects', { path: `${otherGroup}/web` });
        const otherConnection = await h.connect(other, { groups: [otherGroup] });
        expect((await board.activate(other, otherConnection)).result).toBe('activated');
        expect((await board.link(other, otherConnection, 'dev-one')).result).toBe('linked');
        const mine = await board.running(org, repo());
        const first = (await credential(board, mine.id, mine.claim.leaseToken)).json<{ token: string }>().token;
        const theirs = await board.grants.accessToken(other.id, other.memberId, FORGE);
        expect(theirs.ok && theirs.accessToken).not.toBe(first);
        // The pair of one org's job does not open the other's route.
        const crossed = await credential(board, mine.id, randomUUID());
        expect([403, 503]).toContain(crossed.statusCode);
        expect(crossed.body).not.toContain(first);
    });

    it('withholds the token from an attempt cancelled while the refresh is in flight', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let blocked = () => {};
        const reached = new Promise<void>((resolve) => {
            blocked = resolve;
        });
        const slow = await boot(
            dueOnce(async () => {
                blocked();
                await gate;
            })
        );
        const pending = credential(slow, id, claim.leaseToken);
        await reached;
        await sql`update job set cancel_requested_at = now() where id = ${id}`;
        release();
        const res = await pending;
        expect(res.statusCode, res.body).toBe(403);
        expect(res.body).not.toContain('"token"');
    });

    it('adoption: the superseded pair is told to wait (503 LEASE_PENDING), the current pair gets the token', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        await expireLease(sql, id);
        const store = await board.jobs(org);
        const takeover = (await store.claim('worker-2', LEASE_SECONDS)) as typeof claim | null;
        expect(takeover).toMatchObject({ id, claimSeq: claim.claimSeq + 1 });
        const old = await credential(board, id, claim.leaseToken);
        expect(old.statusCode).toBe(UNAVAILABLE);
        expect(old.json()).toMatchObject({ code: 'LEASE_PENDING' });
        expect(old.body).not.toContain('"token"');
        const current = await credential(board, id, takeover!.leaseToken);
        expect(current.statusCode).toBe(OK);
        expect(current.json()).toMatchObject({ standing: 'live', token: expect.any(String) });
        expect(await statusOf(id)).toBe('running');
    });

    it('refuses an unknown pair and answers unavailable, never a denial, when the secret store is unreadable', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        expect((await credential(board, id, randomUUID())).statusCode).not.toBe(OK);
        const down = faultySecrets(h.keyring.openWith(h.keyring.realRepo), {
            readActive: async () => {
                throw new Error('the secret store is down');
            },
        });
        const blind = await boot({ secrets: down, clock: later });
        const res = await credential(blind, id, claim.leaseToken);
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
        expect(res.body).not.toContain('"token"');
        expect(await heartbeat(board, id, claim.leaseToken)).toMatchObject({ requirementWait: false });
    });

    it('a revocation during a credential request is the wait, and a re-link serves the token again', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        const own = await board.grants.accessToken(org.id, org.memberId, FORGE);
        if (!own.ok) throw new Error('no token to revoke');
        await h.fake.send('POST', '/oauth/revoke', {
            body: { token: own.accessToken, client_id: org.clientId, client_secret: org.clientSecret },
        });
        const lost = await boot({ clock: later });
        const res = await credential(lost, id, claim.leaseToken);
        expect(res.statusCode).toBe(CONFLICT);
        expect(res.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', waiting: true });
        expect(res.body).not.toContain(own.accessToken);
        expect(await heartbeat(lost, id, claim.leaseToken)).toMatchObject({ requirementWait: true });
        expect((await lost.link(org, connectionId, 'dev-one')).result).toBe('linked');
        const back = await credential(await boot(), id, claim.leaseToken);
        expect(back.statusCode).toBe(OK);
        expect(back.json()).toMatchObject({ token: expect.any(String) });
    });
});
