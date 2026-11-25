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
 * A running task whose starter's GitLab grant is revoked or needs reconnect (docs/gitlab.md): detected when the board
 * refreshes the grant for the attempt's credential request, the task enters the runtime wait `forge:gitlab:<host>`,
 * and a re-link resumes it in the same session. Everything is real but the fake GitLab; a second `board()` over the
 * same database is a board restart (nothing in memory), and a board whose clock runs three hours ahead finds every
 * stored token due a refresh.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const CONFLICT = 409;
const UNAVAILABLE = 503;
const LEASE_SECONDS = 60;
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

/** The member's GitLab authorization is gone at the instance: the member deauthorized the application. */
async function revokeAtGitlab(board: Board) {
    const token = await board.grants.accessToken(org.id, org.memberId, FORGE);
    if (!token.ok) throw new Error('no token to revoke');
    const revoked = await h.fake.send('POST', '/oauth/revoke', {
        body: { token: token.accessToken, client_id: org.clientId, client_secret: org.clientSecret },
    });
    expect(revoked.status).toBe(OK);
}

const waits = (id: string) =>
    sql<
        {
            provider: string;
            target: string | null;
            reason: string;
            source: string;
            asked_job_id: string | null;
            hand_back_pending: boolean;
            satisfied_at: Date | null;
            outcome: string | null;
        }[]
    >`select provider, target, reason, source, asked_job_id, hand_back_pending, satisfied_at, outcome
      from job_integration_requirement where root_job_id = ${id} order by created_at, id`;
const heartbeat = async (board: Board, id: string, leaseToken: string) =>
    (await board.jobs(org)).heartbeat(id, leaseToken, LEASE_SECONDS);
const handBack = async (board: Board, id: string, leaseToken: string) =>
    (await board.jobs(org)).interrupt(id, leaseToken, {
        reason: 'waiting for GitLab',
        release: true,
        requirement: true,
    });
const statusOf = async (id: string) =>
    (await sql<{ status: string }[]>`select status from job where id = ${id}`)[0]?.status;

describe.skipIf(!enabled)('a running task whose starter’s GitLab grant is lost', () => {
    it('answers a credential request while the grant is live, and opens no wait', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        const res = await credential(board, id, claim.leaseToken);
        expect(res.statusCode).toBe(OK);
        expect(res.json()).toMatchObject({ forge: FORGE, standing: 'live' });
        expect(await waits(id)).toEqual([]);
        expect(await heartbeat(board, id, claim.leaseToken)).toMatchObject({ requirementWait: false });
    });

    it('detects a revoked grant at the token refresh, opens the runtime wait forge:gitlab:<host> and keeps the task running', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        await revokeAtGitlab(board);
        const lost = await boot({ clock: later });
        const res = await credential(lost, id, claim.leaseToken);
        expect(res.statusCode).toBe(CONFLICT);
        const body = res.json<{
            code: string;
            forge: string;
            standing: string;
            waiting: boolean;
            connectUrl: string;
        }>();
        expect(body).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', forge: FORGE, standing: 'broken', waiting: true });
        expect(new URL(body.connectUrl).pathname).toBe('/settings/integrations/gitlab');
        expect(await waits(id)).toMatchObject([
            {
                provider: 'forge',
                target: FORGE,
                reason: 'reconnect',
                source: 'runtime',
                asked_job_id: id,
                hand_back_pending: true,
                satisfied_at: null,
            },
        ]);
        // The attempt is told to stop and hand the task back; nothing has failed.
        expect(await statusOf(id)).toBe('running');
        expect(await heartbeat(lost, id, claim.leaseToken)).toMatchObject({ result: 'ok', requirementWait: true });
        // Asked again, it is the one wait.
        expect((await credential(lost, id, claim.leaseToken)).statusCode).toBe(CONFLICT);
        expect(await waits(id)).toHaveLength(1);
    });

    it('opens the wait for a grant already marked reconnect-required, without any refresh', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        await sql`update integration_grant set status = 'reconnect_required' where org_id = ${org.id}
                  and principal_user_id = ${org.memberId}`;
        const res = await credential(board, id, claim.leaseToken);
        expect(res.statusCode).toBe(CONFLICT);
        expect(await waits(id)).toMatchObject([{ reason: 'reconnect', source: 'runtime' }]);
    });

    it('hands back, stays held while the grant is lost, and resumes in the same session after a re-link', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        const session = randomUUID();
        await (await board.jobs(org)).session(id, claim.leaseToken, session);
        await revokeAtGitlab(board);
        const lost = await boot({ clock: later });
        expect((await credential(lost, id, claim.leaseToken)).statusCode).toBe(CONFLICT);

        expect(await handBack(lost, id, claim.leaseToken)).toEqual({ result: 'ok', status: 'queued' });
        const store = await lost.jobs(org);
        expect(await store.get(id)).toMatchObject({ status: 'queued', attempts: 0, failureKind: null });
        // Held: the starter's grant is not live, so no claim is offered.
        expect(await store.claim('worker-2', LEASE_SECONDS)).toBeNull();
        expect((await waits(id))[0]).toMatchObject({ satisfied_at: null });

        // The member links again: the wait closes bound, and the next claim continues the session with the outcome.
        expect((await lost.link(org, connectionId, 'dev-one')).result).toBe('linked');
        expect(await waits(id)).toMatchObject([{ outcome: 'bound', hand_back_pending: false }]);
        const resumed = (await store.claim('worker-2', LEASE_SECONDS)) as typeof claim | null;
        expect(resumed).toMatchObject({
            id,
            resumeSessionId: session,
            continuesInterrupted: true,
            connectionOutcomes: [{ provider: 'forge', label: `GitLab (${HOST})`, outcome: 'bound', target: FORGE }],
        });
        expect(await heartbeat(lost, id, resumed!.leaseToken)).toMatchObject({ requirementWait: false });
        expect((await credential(lost, id, resumed!.leaseToken)).statusCode).toBe(OK);
    });

    it('survives a board restart during the wait: the wait is rows, and a re-link through a fresh board resumes it', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        await revokeAtGitlab(board);
        const lost = await boot({ clock: later });
        expect((await credential(lost, id, claim.leaseToken)).statusCode).toBe(CONFLICT);
        await lost.close();

        const restarted = await boot();
        expect(await heartbeat(restarted, id, claim.leaseToken)).toMatchObject({ result: 'ok', requirementWait: true });
        expect(await handBack(restarted, id, claim.leaseToken)).toEqual({ result: 'ok', status: 'queued' });
        const another = await boot();
        expect(await (await another.jobs(org)).claim('worker-2', LEASE_SECONDS)).toBeNull();
        expect((await another.link(org, connectionId, 'dev-one')).result).toBe('linked');
        const resumed = await (await another.jobs(org)).claim('worker-2', LEASE_SECONDS);
        expect(resumed).toMatchObject({ id });
    });

    it('an infrastructure takeover during the wait keeps the task: still running, still told to hand back, never dead', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        const session = randomUUID();
        await (await board.jobs(org)).session(id, claim.leaseToken, session);
        await revokeAtGitlab(board);
        const lost = await boot({ clock: later });
        expect((await credential(lost, id, claim.leaseToken)).statusCode).toBe(CONFLICT);

        // The runner's node is reclaimed before it handed the task back.
        await expireLease(sql, id);
        const store = await lost.jobs(org);
        const takeover = (await store.claim('worker-2', LEASE_SECONDS)) as typeof claim | null;
        expect(takeover).toMatchObject({ id, claimSeq: claim.claimSeq + 1 });
        expect(await statusOf(id)).toBe('running');
        expect(await heartbeat(lost, id, takeover!.leaseToken)).toMatchObject({ result: 'ok', requirementWait: true });

        // The takeover hands it back, the member re-links, and the same session resumes.
        expect(await handBack(lost, id, takeover!.leaseToken)).toEqual({ result: 'ok', status: 'queued' });
        expect(await store.claim('worker-3', LEASE_SECONDS)).toBeNull();
        expect((await lost.link(org, connectionId, 'dev-one')).result).toBe('linked');
        expect(await store.claim('worker-3', LEASE_SECONDS)).toMatchObject({ id, resumeSessionId: session });
        expect(await statusOf(id)).toBe('running');
    });

    it('a takeover after the member re-linked, before any hand-back, is still told to hand back and gets the outcome', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        await revokeAtGitlab(board);
        const lost = await boot({ clock: later });
        expect((await credential(lost, id, claim.leaseToken)).statusCode).toBe(CONFLICT);
        expect((await lost.link(org, connectionId, 'dev-one')).result).toBe('linked');
        await expireLease(sql, id);
        const store = await lost.jobs(org);
        const takeover = (await store.claim('worker-2', LEASE_SECONDS)) as typeof claim | null;
        expect(await heartbeat(lost, id, takeover!.leaseToken)).toMatchObject({ requirementWait: true });
        expect(await handBack(lost, id, takeover!.leaseToken)).toEqual({ result: 'ok', status: 'queued' });
        expect(await store.claim('worker-3', LEASE_SECONDS)).toMatchObject({
            id,
            connectionOutcomes: [{ provider: 'forge', outcome: 'bound' }],
        });
    });

    it('answers 503, opens no wait and concludes nothing when the grant cannot be read', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        const down = faultySecrets(h.keyring.openWith(h.keyring.realRepo), {
            readActive: async () => {
                throw new Error('the secret store is down');
            },
        });
        const blind = await boot({ secrets: down });
        const res = await credential(blind, id, claim.leaseToken);
        expect(res.statusCode).toBe(UNAVAILABLE);
        expect(res.json()).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
        expect(await waits(id)).toEqual([]);
        expect(await blind.grants.standing(org.id, org.memberId, FORGE)).toBe('live');
    });

    it('refuses a pair that is not the live attempt’s, and a GitHub task', async () => {
        const board = await boot();
        await setUp(board);
        const { id, claim } = await board.running(org, repo());
        const stranger = await credential(board, id, randomUUID());
        expect([403, 503]).toContain(stranger.statusCode);
        expect(await waits(id)).toEqual([]);
        await sql`update job set forge = 'github', host = 'github.com' where id = ${id}`;
        const github = await credential(board, id, claim.leaseToken);
        expect(github.statusCode).toBe(403);
    });
});
