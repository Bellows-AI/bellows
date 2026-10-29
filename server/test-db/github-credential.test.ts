import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { createAuthStore } from '../src/auth/store.js';
import {
    type AttemptOfLease,
    createAttemptOfLease,
    createPairMatches,
    type PairMatches,
} from '../src/db/attempt-of-lease.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import type { MintedToken, RevokeOutcome } from '../src/github/app-token.js';
import { createOrgRegistry } from '../src/orgs.js';
import type { GithubMint, GithubRevoke } from '../src/routes/github-credential.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { useTestDb } from './harness.js';
import { craftJob, expireLease, testOrg, testUser } from './fixtures.js';

/**
 * The runner GitHub credential (docs/connections.md) on a real database: the per-call check's
 * refusals, and the route's recheck after the GitHub exchange — a cancel landing while the mint is
 * blocked withholds the token. The route's offline contract is server/test/routes.github-credential.test.ts.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const LEASE_SECONDS = 300;
const AUTHOR = testUser('gh-author');
const OTHER_AUTHOR = testUser('gh-other-author');
const REPO = 'acme/widgets';
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const CEILING = { permissions: { contents: 'write' }, repositories: ['widgets'] };
const HTTP_FORBIDDEN = 403;

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [AUTHOR, OTHER_AUTHOR] });

let sql: Sql;
let jobs: JobStore;
let otherJobs: JobStore;
let check: AttemptOfLease;
let pairMatches: PairMatches;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    jobs = createJobStore({ sql, orgId: ORG });
    otherJobs = createJobStore({ sql, orgId: OTHER_ORG });
    check = createAttemptOfLease({ sql });
    pairMatches = createPairMatches({ sql });
});

const join = (org: string) =>
    sql`insert into org_membership (org_id, github_login, user_id) values (${org}, ${AUTHOR.login}, ${AUTHOR.id})
        on conflict do nothing`;

/** A running task of AUTHOR's in `org`, under a live lease. */
async function running(store: JobStore = jobs, org: string = ORG): Promise<{ id: string; claim: Claim }> {
    await join(org);
    const ref = await store.create('push the fix', AUTHOR.id, { repo: REPO, executor: null });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    const claim = (await store.claim('w1', LEASE_SECONDS)) as Claim;
    expect(claim.id).toBe(ref.id);
    return { id: ref.id, claim };
}

describe.skipIf(!enabled)('github credential of lease — the per-call check', () => {
    it("resolves a live attempt to its org and the task's repo", async () => {
        const { id, claim } = await running();
        expect(await check(id, claim.leaseToken)).toEqual({
            ok: true,
            orgId: ORG,
            jobId: id,
            rootJobId: id,
            repo: REPO,
            rootRepo: REPO,
            executionUserId: AUTHOR.id,
            claimSeq: 1,
        });
    });

    it("resolves another org's attempt to that org, never the caller's", async () => {
        const mine = await running();
        const theirs = await running(otherJobs, OTHER_ORG);
        expect(await check(theirs.id, theirs.claim.leaseToken)).toMatchObject({
            ok: true,
            orgId: OTHER_ORG,
            repo: REPO,
        });
        // A pair is the attempt's own: crossing the halves resolves nothing.
        expect(await check(theirs.id, mine.claim.leaseToken)).toEqual({ ok: false });
        expect(await check(mine.id, theirs.claim.leaseToken)).toEqual({ ok: false });
    });

    it('refuses a wrong token and an unknown job', async () => {
        const { id, claim } = await running();
        expect(await check(id, crypto.randomUUID())).toEqual({ ok: false });
        expect(await check(crypto.randomUUID(), claim.leaseToken)).toEqual({ ok: false });
    });

    it('refuses the superseded attempt once a reclaim rotates the lease token', async () => {
        const first = await running();
        await expireLease(sql, first.id);
        expect(await check(first.id, first.claim.leaseToken)).toEqual({ ok: false });

        const second = (await jobs.claim('w2', LEASE_SECONDS)) as Claim;
        expect(second.id).toBe(first.id);
        expect(await check(first.id, first.claim.leaseToken)).toEqual({ ok: false });
        expect((await check(second.id, second.leaseToken)).ok).toBe(true);
    });

    it.each<{ name: string; settle: (id: string) => Promise<unknown> }>([
        {
            name: 'refuses an attempt that was asked to stop',
            settle: (id) => sql`update job set cancel_requested_at = now() where id = ${id}`,
        },
        {
            name: 'refuses a finished attempt, with no tail grace',
            settle: (id) => sql`update job set status = 'succeeded', finished_at = now() where id = ${id}`,
        },
        {
            name: 'refuses an attempt whose task author is no longer a member',
            settle: () => sql`delete from org_membership where org_id = ${ORG} and user_id = ${AUTHOR.id}`,
        },
        {
            name: 'refuses a reviewer row, which never gets a GitHub token',
            settle: (id) => sql`
                update job set review_of = ${crypto.randomUUID()}, review_key = 'k', review_profile = 'security',
                               review_spec = ${sql.json({ name: 'security' })}, review_revision = 'abc',
                               review_ref = 'refs/factory/review/x'
                where id = ${id}`,
        },
    ])('$name', async ({ settle }) => {
        const attempt = await running();
        expect((await check(attempt.id, attempt.claim.leaseToken)).ok).toBe(true);
        await settle(attempt.id);
        expect(await check(attempt.id, attempt.claim.leaseToken)).toEqual({ ok: false });
    });
});

describe.skipIf(!enabled)('attempt of lease — whose membership decides', () => {
    // The stable execution principal (094) is the thread's identity, not `created_by`, which a later
    // writer could differ from.
    it('authorizes against the execution user, not created_by', async () => {
        const attempt = await running();
        await join(ORG);
        await sql`update job set created_by = ${OTHER_AUTHOR.id} where id = ${attempt.id}`;
        // created_by (OTHER_AUTHOR) is no member; the execution user (AUTHOR) is.
        expect((await check(attempt.id, attempt.claim.leaseToken)).ok).toBe(true);

        await sql`insert into org_membership (org_id, github_login, user_id) values (${ORG}, ${OTHER_AUTHOR.login}, ${OTHER_AUTHOR.id}) on conflict do nothing`;
        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${AUTHOR.id}`;
        // Now created_by is a member and the execution user is not: the execution user decides.
        expect(await check(attempt.id, attempt.claim.leaseToken)).toEqual({ ok: false });
        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${OTHER_AUTHOR.id}`;
    });

    it('refuses a thread root with no execution user', async () => {
        const attempt = await running();
        // Deleting the account nulls the column through its foreign key; the trigger allows that one change.
        await sql`update job set execution_user_id = null where id = ${attempt.id}`;
        expect(await check(attempt.id, attempt.claim.leaseToken)).toEqual({ ok: false });
    });
});

describe.skipIf(!enabled)('the runner GitHub credential route — on a real attempt', () => {
    let app: FastifyInstance | undefined;
    afterEach(async () => {
        await app?.close();
        app = undefined;
    });

    async function boot(
        mint: GithubMint,
        revoke: GithubRevoke = async () => 'revoked'
    ): Promise<{ app: FastifyInstance; lines: string[] }> {
        const lines: string[] = [];
        const ready = Promise.resolve();
        const config = testConfig({ auth: githubAuth() });
        app = await buildApp({
            config,
            orgs: createOrgRegistry({ sql, ready, config, withStores: false }),
            auth: createAuthStore({ sql, ready }),
            attemptOfLease: check,
            pairMatches,
            githubMint: mint,
            githubRevoke: revoke,
            ready,
            version: '0.0.0',
            logger: { level: 'trace', stream: { write: (line: string) => lines.push(line) } },
        });
        return { app, lines };
    }

    const ask = (instance: FastifyInstance, id: string, leaseToken: string) =>
        instance.inject({
            method: 'POST',
            url: `/api/jobs/${id}/credentials/github`,
            headers: { 'x-factory-job-id': id, 'x-factory-job-lease-token': leaseToken },
        });

    it("mints from the attempt's own org, a distinct token per attempt", async () => {
        const asked: [string, string | null][] = [];
        let serial = 0;
        const { app: instance, lines } = await boot(async (orgId, repo) => {
            asked.push([orgId, repo]);
            return { token: `ghs_db_route_${++serial}_secret`, expiresAt: '2026-10-16T13:00:00.000Z', ...CEILING };
        });
        const mine = await running();
        const theirs = await running(otherJobs, OTHER_ORG);

        const first = await ask(instance, mine.id, mine.claim.leaseToken);
        const second = await ask(instance, theirs.id, theirs.claim.leaseToken);
        expect(first.statusCode).toBe(HTTP_OK);
        expect(first.headers['cache-control']).toBe('no-store');
        expect(second.json().token).not.toBe(first.json().token);
        expect(asked).toEqual([
            [ORG, REPO],
            [OTHER_ORG, REPO],
        ]);
        expect(lines.join('\n')).not.toContain('_secret');
    });

    it('refuses an attempt not working its thread root’s repository, and mints nothing', async () => {
        const minted: string[] = [];
        const { app: instance } = await boot(async (orgId) => {
            minted.push(orgId);
            return { token: 'ghs_never', expiresAt: '2026-10-16T13:00:00.000Z', ...CEILING };
        });
        const attempt = await running();
        const root = await craftJob({ sql, org: ORG, author: AUTHOR.id }, { repo: 'acme/elsewhere' });
        await sql`update job set root_job_id = ${root} where id = ${attempt.id}`;
        const res = await ask(instance, attempt.id, attempt.claim.leaseToken);
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(minted).toEqual([]);
    });

    // F1 (docs/connections.md): post-agent phases ask under the running lease, with no grace after settle.
    // Already green on the previous check: a pin, not a RED case.
    it('honours a publish ask while the attempt runs and refuses it the moment it settles', async () => {
        const { app: instance } = await boot(async () => ({
            token: 'ghs_db_publish_secret',
            expiresAt: '2026-10-16T13:00:00.000Z',
            ...CEILING,
        }));
        const attempt = await running();
        expect((await ask(instance, attempt.id, attempt.claim.leaseToken)).statusCode).toBe(HTTP_OK);
        await sql`update job set status = 'succeeded', finished_at = now() where id = ${attempt.id}`;
        const after = await ask(instance, attempt.id, attempt.claim.leaseToken);
        expect(after.statusCode).toBe(HTTP_FORBIDDEN);
        expect(after.body).not.toContain('ghs_db_publish_secret');
    });

    it('withholds the token when the attempt is cancelled while the GitHub exchange is blocked', async () => {
        let release: (minted: MintedToken) => void = () => {};
        let entered: () => void = () => {};
        const inMint = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const { app: instance, lines } = await boot(
            () =>
                new Promise<MintedToken>((resolve) => {
                    release = resolve;
                    entered();
                })
        );
        const attempt = await running();

        const pending = ask(instance, attempt.id, attempt.claim.leaseToken);
        await inMint;
        await sql`update job set cancel_requested_at = now() where id = ${attempt.id}`;
        release({ token: 'ghs_blocked_secret_token', expiresAt: '2026-10-16T13:00:00.000Z', ...CEILING });

        const res = await pending;
        expect(res.statusCode).toBe(HTTP_FORBIDDEN);
        expect(res.body).not.toContain('ghs_blocked_secret_token');
        expect(lines.join('\n')).not.toContain('ghs_blocked_secret_token');
    });

    // BEL-60: Stop revokes the stopped attempt's token only. Possession of a token is the authority to revoke it
    // (the pair names the attempt, GitHub's own check says whether the token is real), so the route never
    // revokes anything it was not handed, and never needs the lease to be live.
    it('revokes the token an attempt hands it even after Stop, and nobody else’s', async () => {
        const revoked: [string, string][] = [];
        let serial = 0;
        const { app: instance } = await boot(
            async () => ({
                token: `ghs_db_revoke_${++serial}_secret`,
                expiresAt: '2026-10-16T13:00:00.000Z',
                ...CEILING,
            }),
            async (orgId, token): Promise<RevokeOutcome> => {
                revoked.push([orgId, token]);
                return 'revoked';
            }
        );
        const a = await running();
        const b = await running();
        const tokenA = (await ask(instance, a.id, a.claim.leaseToken)).json().token as string;
        await sql`update job set cancel_requested_at = now() where id = ${a.id}`;

        const stopped = await instance.inject({
            method: 'POST',
            url: `/api/jobs/${a.id}/credentials/github/revoke`,
            headers: { 'x-factory-job-id': a.id, 'x-factory-job-lease-token': a.claim.leaseToken },
            payload: { token: tokenA },
        });
        expect(stopped.statusCode).toBe(HTTP_NO_CONTENT);
        expect(revoked).toEqual([[ORG, tokenA]]);
        // The other attempt is untouched and still asks.
        expect((await ask(instance, b.id, b.claim.leaseToken)).statusCode).toBe(HTTP_OK);
        expect(revoked).toHaveLength(1);
    });

    it('refuses a revoke from a superseded pair and calls GitHub for it', async () => {
        const revoked: string[] = [];
        const { app: instance } = await boot(
            async () => ({ token: 'ghs_never', expiresAt: '2026-10-16T13:00:00.000Z', ...CEILING }),
            async (_org, token) => {
                revoked.push(token);
                return 'revoked';
            }
        );
        const first = await running();
        await expireLease(sql, first.id);
        const second = (await jobs.claim('w2', LEASE_SECONDS)) as Claim;
        expect(second.id).toBe(first.id);
        const revokeWith = (id: string, leaseToken: string) =>
            instance.inject({
                method: 'POST',
                url: `/api/jobs/${id}/credentials/github/revoke`,
                headers: { 'x-factory-job-id': id, 'x-factory-job-lease-token': leaseToken },
                payload: { token: 'ghs_x' },
            });
        expect((await revokeWith(first.id, first.claim.leaseToken)).statusCode).toBe(HTTP_FORBIDDEN);
        expect(revoked).toEqual([]);
        expect((await revokeWith(second.id, second.leaseToken)).statusCode).toBe(HTTP_NO_CONTENT);
        expect(revoked).toEqual(['ghs_x']);
    });
});
