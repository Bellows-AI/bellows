import { randomUUID } from 'node:crypto';
import { githubRepo } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim } from '../src/db/jobs/job-store-types.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { faultySecrets, testSecretDeps } from './env-secrets-harness.js';
import { expireLease, lapseDeferral, mustCreate } from './fixtures.js';
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
 * A self-managed GitLab's CA bundle reaches the runner with the claim (docs/gitlab.md): `forgeCa` is the stored PEM of
 * the claiming org's live connection on the repo's host, read on every claim, takeover included; a connection without
 * one, another org's connection and a GitHub repo carry none, and an unconfirmed read fails the claim, never omits it.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const CREATED = 201;
const LEASE_SECONDS = 60;
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIBclaimca\n-----END CERTIFICATE-----\n';
const OTHER_CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIBotherorg\n-----END CERTIFICATE-----\n';

let sql: Sql;
let h: Harness & { stop(): Promise<void> };
let org: Org;
let grp: string;
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
});
afterEach(async () => {
    if (enabled) await Promise.all(boards.map((board) => board.close()));
});
afterAll(async () => {
    await h?.stop();
});

const boot = async (options: Parameters<Harness['board']>[0] = {}) => {
    const board = await h.board(options);
    boards.push(board);
    return board;
};

const repo = () => ({ forge: 'gitlab', host: HOST, path: `${grp}/web` });

/** The org's GitLab connected (with `caBundle` when given), the member linked and the repo tracked. */
async function setUp(board: Board, caBundle?: string) {
    const connectionId = await h.connect(org, { groups: [grp], ...(caBundle ? { caBundle } : {}) });
    expect((await board.activate(org, connectionId)).result).toBe('activated');
    expect((await board.link(org, connectionId, 'dev-one')).result).toBe('linked');
    const picked = await board.app.inject({
        method: 'PUT',
        url: `/api/org/gitlab-connections/${connectionId}/tracked-repos`,
        headers: bearer(org.admin),
        payload: { paths: [`${grp}/web`] },
    });
    expect(picked.statusCode).toBe(OK);
    return connectionId;
}

const statusOf = async (id: string) =>
    (await sql<{ status: string; attempts: number }[]>`select status, attempts from job where id = ${id}`)[0];

describe.skipIf(!enabled)('the claim of a GitLab task carries its connection’s CA bundle', () => {
    it('carries the stored PEM on the first claim and again on a takeover', async () => {
        const board = await boot();
        await setUp(board, CA_PEM);
        const { id, claim } = await board.running(org, repo());
        expect(claim.forgeCa).toBe(CA_PEM);

        // The runner's node is reclaimed: the takeover's runner needs the same trust.
        await expireLease(sql, id);
        const takeover = (await (await board.jobs(org)).claim('worker-2', LEASE_SECONDS)) as Claim | null;
        expect(takeover).toMatchObject({ id, claimSeq: claim.claimSeq + 1, forgeCa: CA_PEM });
    });

    it('omits it for a connection without a CA bundle, whatever another org stored for the same host', async () => {
        const other = await h.newOrg();
        await h.connect(other, { groups: [grp], caBundle: OTHER_CA_PEM });
        const board = await boot();
        await setUp(board);
        const { claim } = await board.running(org, repo());
        expect(claim).not.toHaveProperty('forgeCa');
    });

    it('fails the claim when the CA bundle cannot be read, leaving the task claimable', async () => {
        let down = false;
        const secrets = faultySecrets(h.keyring.openWith(h.keyring.realRepo), {});
        const real = secrets.readActive;
        secrets.readActive = async (input) => {
            const ca = input.identity.owningRecord.id.endsWith('/ca-bundle');
            if (down && ca) throw new Error('the secret store is down');
            return real(input);
        };
        const board = await boot({ secrets });
        await setUp(board, CA_PEM);
        const created = await board.app.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: bearer(org.member),
            payload: { repo: repo(), command: 'work' },
        });
        expect(created.statusCode, created.body).toBe(CREATED);
        const { id } = created.json<{ id: string }>();
        const store = await board.jobs(org);

        down = true;
        await expect(store.claim('worker-1', LEASE_SECONDS)).rejects.toThrow();
        expect(await statusOf(id)).toEqual({ status: 'queued', attempts: 0 });

        down = false;
        await lapseDeferral(sql, id);
        expect(await store.claim('worker-1', LEASE_SECONDS)).toMatchObject({ id, attempts: 1, forgeCa: CA_PEM });
    });

    it('never asks for a CA for a GitHub task or a task without a repo', async () => {
        const hosts: string[] = [];
        const jobs = createJobStore({
            sql,
            orgId: org.id,
            forgeCa: async (host) => {
                hosts.push(host);
                return CA_PEM;
            },
        });
        for (const target of [githubRepo('octo-org/web'), null]) {
            const { id } = await mustCreate(jobs.create('echo hi', org.memberId, { repo: target, executor: null }));
            const claim = await jobs.claim(`worker-${id}`, LEASE_SECONDS);
            expect(claim?.id).toBe(id);
            expect(claim).not.toHaveProperty('forgeCa');
        }
        expect(hosts).toEqual([]);
    });
});
