import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { requirementsOf } from '../src/db/connection-bindings.js';
import { readGrantStanding } from '../src/db/forge-grant-standing.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createIntegrationRuntime } from '../src/integrations/integration-recovery.js';
import { createMemberForgeGrants, type MemberForgeGrants } from '../src/integrations/member-forge-grant.js';
import { createGitHubUserHooks, GITHUB_FORGE } from '../src/integrations/providers/github-user.js';
import { expireLease, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { lineageHarness } from './integration-store-faults.js';

/**
 * The claim's forge hold (docs/connections.md): a queued continuation whose starter holds no live grant for the repo's
 * forge is never claimed and spends no attempt; the hold is the open `forge` requirement, opened and healed by the
 * claim itself from the grant's own row, so a crash between a re-link and its bookkeeping leaves nothing stuck. The
 * real store runs over a real grant lineage; the standing is read from SQL inside the claim's transaction.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('fh-alice');
const BOB = testUser('fh-bob');
const REPO = 'acme/web';
const WORKER = 'worker-1';
const LEASE_SECONDS = 60;
const db = useTestDb({ orgs: [ORG], users: [ALICE, BOB], max: 10 });

let sql: Sql;
let store: JobStore;
let grants: MemberForgeGrants;

beforeEach(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG, forgeStanding: readGrantStanding });
    const keyring = lineageHarness(sql);
    const secrets = keyring.openWith(keyring.realRepo);
    const hooks = createGitHubUserHooks({
        clientId: 'client-1',
        clientSecret: 'client-secret-1',
        authorizeUrl: 'http://127.0.0.1:1/authorize',
        tokenUrl: 'http://127.0.0.1:1/token',
        userUrl: 'http://127.0.0.1:1/user',
    });
    const runtime = createIntegrationRuntime({
        sql,
        crossOrgSql: sql,
        secrets,
        providers: (provider) => (provider === GITHUB_FORGE ? hooks : undefined),
        clients: () => undefined,
        callbackOrigin: null,
        timing: { retryDelayMs: 0 },
    });
    grants = createMemberForgeGrants({ sql, crossOrgSql: sql, secrets, lineageOf: runtime.lineageOf });
});

const link = async (user: typeof ALICE) => {
    const stored = await grants.store({
        orgId: ORG,
        userId: user.id,
        forge: GITHUB_FORGE,
        externalAccountId: String(user.githubUserId),
        tokens: { accessToken: `ghu_${randomUUID()}`, refreshToken: `ghr_${randomUUID()}`, expiresIn: 28_800 },
    });
    expect(stored).toEqual({ ok: true });
};

const revoke = (user: typeof ALICE) => grants.revokeAuthorization(GITHUB_FORGE, String(user.githubUserId));

const claimNext = async (target: JobStore = store): Promise<Claim | null> =>
    (await target.claim(WORKER, LEASE_SECONDS)) as Claim | null;

const must = <T extends { id: string }>(ref: T | string): T => {
    if (typeof ref === 'string') throw new Error(`refused: ${ref}`);
    return ref;
};

/** A thread of `owner`'s that ran to a verdict while their grant was live: the root, finished with a session. */
async function finishedRoot(owner: typeof ALICE, target: JobStore = store): Promise<string> {
    await link(owner);
    const root = must(await target.create('first run', owner.id, { repo: REPO, executor: null }));
    const claim = await claimNext(target);
    expect(claim?.id).toBe(root.id);
    await target.session(claim!.id, claim!.leaseToken, randomUUID());
    await target.complete(claim!.id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });
    return root.id;
}

const followUp = async (root: string, by: typeof ALICE, admin = false): Promise<string> =>
    must(await store.createFollowUp(root, 'adjust', by.id, undefined, undefined, admin)).id;

const jobRow = async (id: string) =>
    (
        await sql<{ status: string; attempts: number }[]>`
            select status, attempts from job where org_id = ${ORG} and id = ${id}
        `
    )[0]!;

const openForgeRows = (root: string) =>
    sql<{ target: string; reason: string; source: string }[]>`
        select target, reason, source from job_integration_requirement
        where org_id = ${ORG} and root_job_id = ${root} and provider = 'forge' and satisfied_at is null
    `;

const closedForgeRows = (root: string) =>
    sql<{ outcome: string | null; closed_by: string | null }[]>`
        select outcome, closed_by from job_integration_requirement
        where org_id = ${ORG} and root_job_id = ${root} and provider = 'forge' and satisfied_at is not null
    `;

describe.skipIf(!enabled)('the claim holds a continuation whose starter has no live grant', () => {
    it('holds a follow-up of a member whose grant needs reconnecting: no claim, no attempt, one open requirement', async () => {
        const root = await finishedRoot(ALICE);
        const next = await followUp(root, ALICE);
        const before = await jobRow(next);
        await revoke(ALICE);

        expect(await claimNext()).toBeNull();

        expect(await openForgeRows(root)).toEqual([{ target: 'github', reason: 'reconnect', source: 'create' }]);
        expect(await jobRow(next)).toEqual({ status: 'queued', attempts: before.attempts });
        expect((await requirementsOf(sql, ORG, root)).map((r) => [r.provider, r.label, r.reason])).toEqual([
            ['forge', 'GitHub', 'reconnect'],
        ]);
    });

    it('records `missing` when the member has no grant at all', async () => {
        const root = await finishedRoot(ALICE);
        await followUp(root, ALICE);
        await sql`delete from integration_grant where org_id = ${ORG} and principal_user_id = ${ALICE.id}`;

        expect(await claimNext()).toBeNull();

        expect(await openForgeRows(root)).toEqual([{ target: 'github', reason: 'missing', source: 'create' }]);
    });

    it('a re-link satisfies the requirement and the next claim returns the row', async () => {
        const root = await finishedRoot(ALICE);
        const next = await followUp(root, ALICE);
        await revoke(ALICE);
        expect(await claimNext()).toBeNull();
        expect(await openForgeRows(root)).toHaveLength(1);

        await link(ALICE);

        expect(await openForgeRows(root)).toEqual([]);
        expect(await closedForgeRows(root)).toEqual([{ outcome: 'bound', closed_by: ALICE.id }]);
        expect((await claimNext())?.id).toBe(next);
    });

    it('heals without the re-link’s bookkeeping: an active grant by SQL alone releases the hold at the next claim', async () => {
        const root = await finishedRoot(ALICE);
        const next = await followUp(root, ALICE);
        await revoke(ALICE);
        expect(await claimNext()).toBeNull();
        expect(await openForgeRows(root)).toHaveLength(1);

        await sql`
            update integration_grant set status = 'active'
            where org_id = ${ORG} and principal_user_id = ${ALICE.id} and provider = ${GITHUB_FORGE}
        `;

        expect((await claimNext())?.id).toBe(next);
        expect(await openForgeRows(root)).toEqual([]);
        expect(await closedForgeRows(root)).toHaveLength(1);
    });

    it('never holds a running row: the takeover of an expired lease is claimed with no requirement', async () => {
        await link(ALICE);
        const root = must(await store.create('long run', ALICE.id, { repo: REPO, executor: null }));
        const first = await claimNext();
        expect(first?.id).toBe(root.id);
        await revoke(ALICE);
        await expireLease(sql, root.id);

        const again = await claimNext();

        expect(again?.id).toBe(root.id);
        expect(await openForgeRows(root.id)).toEqual([]);
    });

    it('holds a thread whose starter was removed, never claims it and never ends it dead; a stop ends it', async () => {
        const root = await finishedRoot(BOB);
        const next = await followUp(root, BOB);
        await sql`delete from app_user where id = ${BOB.id}`;

        expect(await claimNext()).toBeNull();

        expect(await openForgeRows(root)).toEqual([{ target: 'github', reason: 'starter-removed', source: 'create' }]);
        expect(await jobRow(next)).toMatchObject({ status: 'queued' });

        const stopped = await store.stop(next, ALICE.id);
        expect(stopped).not.toBe('missing');
        expect((await jobRow(next)).status).toBe('stopped');
    });

    it('is off without a standing reader (AUTH_MODE=none): a leftover forge requirement does not hold the claim', async () => {
        const off = createJobStore({ sql, orgId: ORG });
        const root = must(await off.create('local', ALICE.id, { repo: REPO, executor: null }));
        await sql`
            insert into job_integration_requirement (org_id, root_job_id, provider, reason, target)
            values (${ORG}, ${root.id}, 'forge', 'reconnect', 'github')
        `;

        expect((await claimNext(off))?.id).toBe(root.id);
    });

    it('an unconfirmed standing read rolls the claim back: no requirement, the row still queued', async () => {
        const root = await finishedRoot(ALICE);
        const next = await followUp(root, ALICE);
        const blip = createJobStore({
            sql,
            orgId: ORG,
            forgeStanding: async () => {
                throw new Error('database blip');
            },
        });

        const outcome = await claimNext(blip).catch((error: unknown) => error);

        expect(outcome === null || outcome instanceof Error).toBe(true);
        expect(await openForgeRows(root)).toEqual([]);
        expect(await closedForgeRows(root)).toEqual([]);
        expect((await jobRow(next)).status).toBe('queued');
    });

    it('continuations inherit the starter: an admin’s follow-up waits on the member’s grant, not the admin’s', async () => {
        const root = await finishedRoot(ALICE);
        await link(BOB);
        const next = await followUp(root, BOB, true);
        await revoke(ALICE);

        expect(await claimNext()).toBeNull();

        expect(await openForgeRows(root)).toEqual([{ target: 'github', reason: 'reconnect', source: 'create' }]);
        expect((await jobRow(next)).status).toBe('queued');
    });

    it('a forge requirement cannot be dismissed', async () => {
        const root = await finishedRoot(ALICE);
        await followUp(root, ALICE);
        await revoke(ALICE);
        expect(await claimNext()).toBeNull();

        expect(await store.dismissRequirement(root, 'forge', ALICE.id)).toEqual({ ok: false, reason: 'none-open' });

        expect(await openForgeRows(root)).toHaveLength(1);
    });
});
