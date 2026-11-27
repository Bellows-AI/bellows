import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLease, releaseLease } from '../src/db/background-lease.js';
import { ACCOUNT_RECHECK_LEASE, recheckAccounts, type RecheckOptions } from '../src/integrations/account-recheck.js';
import { type FakeAtlassian, fakeResource, startFakeAtlassian } from '../test/fake-atlassian.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { begin, cloudOf, connectionsOf, grantsOf, hostOf, jiraRuntime, newTag, script } from './jira-rig.js';

/**
 * The periodic re-check of what a Jira account still reaches, against the scripted Atlassian: a confirmed
 * loss revokes the connection, every fault answer leaves it alone, and the cycle runs behind one lease.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('recheck-alice');
const db = useTestDb({ orgs: [ORG], users: [ALICE], max: 10 });
const OPTIONS: RecheckOptions = { providers: ['jira'], recheckAfterMs: 0 };

let fake: FakeAtlassian;
beforeEach(async () => {
    if (enabled) fake = await startFakeAtlassian();
});
afterEach(async () => {
    if (enabled) await fake.close();
});

/** Connects a fresh account; `expiresIn` seconds is how long its first access token lives. */
async function connect(sites: string[], expiresIn?: number) {
    const tag = newTag();
    const runtime = jiraRuntime(db.sql, fake);
    script(fake, { tag, sites, ...(expiresIn === undefined ? {} : { expiresIn }) });
    await (await begin(runtime, ORG, ALICE.id)).complete();
    return { tag, runtime };
}

const statuses = async (tag: string) => (await connectionsOf(db.sql, tag)).map((c) => [c.site, c.status]);
const answer = (reply: Parameters<FakeAtlassian['on']>[2]) =>
    fake.on('GET', /^\/oauth\/token\/accessible-resources$/, reply);

describe.skipIf(!enabled)('account re-check', () => {
    it('a site confirmed absent revokes that connection and only it; a grant left empty is revoked', async () => {
        const { tag, runtime } = await connect(['one', 'two']);
        answer(() => ({
            status: 200,
            json: [fakeResource({ id: cloudOf(tag, 'one'), url: `https://${hostOf(tag, 'one')}`, name: 'one' })],
        }));

        const first = await recheckAccounts(runtime, OPTIONS);
        expect(first?.site).toMatchObject({ checked: 1, revoked: 1 });
        expect(await statuses(tag)).toEqual([
            [hostOf(tag, 'one'), 'active'],
            [hostOf(tag, 'two'), 'disconnected'],
        ]);
        const [gone] = (await connectionsOf(db.sql, tag)).filter((c) => c.status === 'disconnected');
        expect(gone?.email).toBe('');
        expect((await grantsOf(db.sql, tag))[0]?.status).toBe('active');
        const audit = await db.sql<{ actor_kind: string; detail: { reason: string } }[]>`
            select actor_kind, detail from audit_event where action = 'connection.revoke' and target = ${gone!.id}
        `;
        expect(audit).toEqual([
            { actor_kind: 'system', detail: expect.objectContaining({ reason: 'site-access-lost' }) },
        ]);

        answer(() => ({
            status: 200,
            json: [fakeResource({ id: 'cloud-elsewhere', url: 'https://elsewhere.atlassian.net', name: 'x' })],
        }));
        await recheckAccounts(runtime, OPTIONS);
        expect((await statuses(tag)).map(([, status]) => status)).toEqual(['disconnected', 'disconnected']);
        expect((await grantsOf(db.sql, tag))[0]?.status).toBe('revoked');
    });

    it.each([
        ['a refusal', () => ({ status: 403, json: { message: 'no' } })],
        ['a server error', () => ({ status: 500, text: 'boom' })],
        ['an empty list', () => ({ status: 200, json: [] })],
        ['a malformed list', () => ({ status: 200, json: [{ id: 'x' }] })],
        ['a body that is not a list', () => ({ status: 200, json: { sites: [] } })],
        ['a body that is not JSON', () => ({ status: 200, text: '<html>' })],
        ['a dropped connection', () => ({ drop: true as const })],
        ['a cut-short body', () => ({ truncate: true as const })],
    ])('%s is inconclusive: nothing changes, and the next cycle confirms', async (_name, fault) => {
        const { tag, runtime } = await connect(['one']);
        answer(fault);
        const before = await db.sql`select * from connector_connection where external_account_id = ${`acct-${tag}`}`;

        const summary = await recheckAccounts(runtime, OPTIONS);
        expect(summary?.site).toMatchObject({ checked: 0, revoked: 0, inconclusive: 1 });
        expect(await db.sql`select * from connector_connection where external_account_id = ${`acct-${tag}`}`).toEqual(
            before
        );
        expect((await grantsOf(db.sql, tag))[0]?.status).toBe('active');

        script(fake, { tag, sites: ['one'] });
        expect((await recheckAccounts(runtime, OPTIONS))?.site).toMatchObject({ checked: 1, revoked: 0 });
        expect(await statuses(tag)).toEqual([[hostOf(tag, 'one'), 'active']]);
    });

    it('an unreadable secret is inconclusive, never a loss', async () => {
        const { tag, runtime } = await connect(['one']);
        await db.sql`update integration_grant set secret_version = 'not-the-stored-version' where external_account_id = ${`acct-${tag}`}`;
        answer(() => ({
            status: 200,
            json: [fakeResource({ id: 'cloud-elsewhere', url: 'https://elsewhere.atlassian.net' })],
        }));
        expect((await recheckAccounts(runtime, OPTIONS))?.site).toMatchObject({ revoked: 0, inconclusive: 1 });
        expect(await statuses(tag)).toEqual([[hostOf(tag, 'one'), 'active']]);
    });

    it('a recently confirmed connection is not asked again', async () => {
        const { runtime } = await connect(['one']);
        const options = { providers: ['jira'] };
        expect((await recheckAccounts(runtime, options))?.site.checked).toBe(1);
        const asked = fake.count('GET', /accessible-resources$/);
        expect((await recheckAccounts(runtime, options))?.site.checked).toBe(0);
        expect(fake.count('GET', /accessible-resources$/)).toBe(asked);
    });

    it('a definitive refresh refusal revokes the grant’s connections; an unanswered one does not', async () => {
        const refused = await connect(['one', 'two'], 1);
        fake.on('POST', /^\/oauth\/token$/, () => ({ status: 400, json: { error: 'invalid_grant' } }));
        await recheckAccounts(refused.runtime, OPTIONS);
        expect((await statuses(refused.tag)).map(([, status]) => status)).toEqual(['disconnected', 'disconnected']);
        expect((await grantsOf(db.sql, refused.tag))[0]).toMatchObject({ status: 'revoked', lineage_claim: null });
        const audit = await db.sql<{ detail: { reason: string } }[]>`
            select detail from audit_event where action = 'connection.revoke' and target = any(
                select id::text from connector_connection where external_account_id = ${`acct-${refused.tag}`})
        `;
        expect(audit.map((row) => row.detail.reason)).toEqual(['grant-refused', 'grant-refused']);

        const unanswered = await connect(['one'], 1);
        fake.on('POST', /^\/oauth\/token$/, () => ({ status: 500, text: 'boom' }));
        await recheckAccounts(unanswered.runtime, OPTIONS);
        expect(await statuses(unanswered.tag)).toEqual([[hostOf(unanswered.tag, 'one'), 'active']]);
    });

    it('one replica runs the cycle at a time: a held lease skips it, a released one does not', async () => {
        const { tag, runtime } = await connect(['one']);
        const holder = await acquireLease(db.sql, ACCOUNT_RECHECK_LEASE, 60_000);
        expect(holder).not.toBeNull();
        expect(await acquireLease(db.sql, ACCOUNT_RECHECK_LEASE, 60_000)).toBeNull();
        expect(await recheckAccounts(runtime, OPTIONS)).toBeUndefined();
        expect(fake.count('GET', /accessible-resources$/)).toBe(1);

        await releaseLease(db.sql, ACCOUNT_RECHECK_LEASE, holder!);
        expect((await recheckAccounts(runtime, OPTIONS))?.site.checked).toBe(1);
        expect(await statuses(tag)).toEqual([[hostOf(tag, 'one'), 'active']]);
    });

    it('a lapsed lease is taken over', async () => {
        const holder = await acquireLease(db.sql, ACCOUNT_RECHECK_LEASE, 60_000);
        await db.sql`update background_lease set expires_at = now() - interval '1 second' where name = ${ACCOUNT_RECHECK_LEASE}`;
        const next = await acquireLease(db.sql, ACCOUNT_RECHECK_LEASE, 60_000);
        expect(next).not.toBeNull();
        expect(next).not.toBe(holder);
    });
});
