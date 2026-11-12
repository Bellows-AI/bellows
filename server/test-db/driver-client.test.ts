import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createBoard, type Board } from '../../driver/src/board/board.js';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import { createOrgOfJob, createOrgOfLease, createOrgOfReclaim } from '../src/db/jobs/job-store-org-resolvers.js';
import { createOrgRegistry } from '../src/orgs.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { testSecretStore } from './env-secrets-harness.js';
import { githubAuth, testConfig, TEST_JOB_BOARD_TOKEN } from '../test/helpers-config.js';
import { useTestDb } from './harness.js';
import { randomGithubId, testOrg } from './fixtures.js';

/**
 * The driver's real board client (`driver/src/board/board.ts`) against the real app and store on a
 * migrated `_test` database: claim, heartbeat, phase checkpoint and verdict, and claim then
 * interrupt, each asserted on the rows. Coverage of the wire contract, not a regression for a defect.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();
const LEASE_S = 300;

let app: FastifyInstance;
let boardUrl: string;
let token: string;
let repo: string;
let board: Board;

beforeEach(async () => {
    if (!enabled) return;
    const sql = db.sql;
    const orgId = testOrg();
    await sql`insert into organization (id, name) values (${orgId}, ${`cli-org-${orgId}`})`;
    const auth = createAuthStore({ sql });
    const login = `cli-${randomUUID().slice(0, 8)}`;
    const caller = await auth.signIn(
        { githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null },
        orgId,
        [{ id: orgId, name: orgId }]
    );
    token = `fat_${randomUUID()}`;
    await auth.createAccessToken({
        kind: 'personal',
        orgId,
        userId: caller.user.id,
        createdBy: caller.user.id,
        label: 'cli scripting',
        tokenHash: hashToken(token),
    });
    // A task naming no executor runs on the caller's default; the org's one profile is it.
    await createUserExecutorStore({ sql, orgId }).createOrg({
        name: 'main',
        type: 'claude-code',
        config: {},
        createdBy: caller.user.id,
    });
    // The board refuses a create whose repo it does not track; offline the tracked list is the stored sessions' repos.
    const name = `repo-${randomUUID().slice(0, 8)}`;
    repo = `cli-owner/${name}`;
    await sql`insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
              values (${orgId}, 'claude-code', ${`cli-${randomUUID()}`}, ${repo}, 'main', now(), now())`;

    const ready = Promise.resolve();
    const config = testConfig({ auth: githubAuth() });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({
            sql,
            ready,
            config,
            withStores: true,
            secrets: testSecretStore(sql),
            secretLog: () => {},
            artifacts: {
                objects: createFilesystemStore(mkdtempSync(join(tmpdir(), 'cli-attach-store-'))),
                prefix: '',
                prepare: async () => '',
            },
        }),
        auth,
        orgOfLease: createOrgOfLease({ sql, ready }),
        orgOfJob: createOrgOfJob({ sql, ready }),
        orgOfReclaim: createOrgOfReclaim({ sql, ready }),
        ready,
        version: '0.0.0',
    });
    boardUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    board = createBoard({ url: boardUrl, leaseSeconds: LEASE_S, token: TEST_JOB_BOARD_TOKEN });
});

afterEach(async () => {
    if (enabled) await app?.close();
});

async function enqueue(): Promise<string> {
    const response = await fetch(`${boardUrl}/api/jobs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repo, command: `wire ${randomUUID()}` }),
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return ((await response.json()) as { id: string }).id;
}

const rowOf = async (id: string) => {
    const [row] = await db.sql<{ status: string; attempts: number; lease_token: string | null }[]>`
        select status, attempts, lease_token from job where id = ${id}`;
    return row!;
};

describe.skipIf(!enabled)('the driver board client against the real store', () => {
    it('claims, heartbeats, records a phase checkpoint and reports a verdict', async () => {
        const id = await enqueue();
        const job = await board.claim('wire-driver');
        expect(job?.id).toBe(id);
        expect(job?.leaseToken).toBeTruthy();
        expect(await rowOf(id)).toMatchObject({ status: 'running', attempts: 1, lease_token: job!.leaseToken });

        expect(await board.heartbeat(job!)).toMatchObject({ result: 'held' });
        expect(
            await board.phaseCheckpoint(job!, {
                runClaimSeq: job!.claimSeq,
                phase: 'setup',
                tree: 'abc',
                result: { ok: true },
            })
        ).toBe('ok');
        const checkpoints = await board.phaseCheckpoints(job!, job!.claimSeq);
        expect(checkpoints).toEqual([{ phase: 'setup', claimSeq: job!.claimSeq, tree: 'abc', result: { ok: true } }]);

        const verdict = await board.complete(job!, { status: 'succeeded', exitCode: 0, output: 'done' });
        expect(verdict.state).toBe('held');
        expect((await rowOf(id)).status).toBe('succeeded');
        expect(await board.heartbeat(job!)).toBe('lost');
    });

    it('claims, then interrupts and releases the claim back to the queue', async () => {
        const id = await enqueue();
        const job = await board.claim('wire-driver');
        expect(job?.id).toBe(id);

        expect(await board.interrupt(job!, { reason: 'wire test', release: true, claimSeq: job!.claimSeq })).toBe(
            'held'
        );
        const row = await rowOf(id);
        expect(row.status).toBe('queued');
        expect(row.lease_token).toBeNull();
        expect(await board.heartbeat(job!)).toBe('lost');
    });
});
