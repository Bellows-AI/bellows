import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockMembership } from '../src/auth/member-removal.js';
import { createConnectionStore } from '../src/db/connection-store.js';
import { type FakeAtlassian, startFakeAtlassian } from '../test/fake-atlassian.js';
import { oauthConnection, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { begin, connectionsOf, grantsOf, hostOf, jiraRuntime, newTag, script } from './jira-rig.js';

/**
 * A member's connections end with the membership (BEL-620): the secret retired, the label blanked, one audit row,
 * in the removal's own transaction. An org-owned or another member's connection is untouched, and a Jira
 * connection stores the site host as its label, never the account's email or name.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const ADMIN = testUser('revoke-admin');
const LEAVER = testUser('revoke-leaver');
const STAYER = testUser('revoke-stayer');
const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ADMIN, LEAVER, STAYER], max: 10 });

let fake: FakeAtlassian;
beforeEach(async () => {
    if (!enabled) return;
    fake = await startFakeAtlassian();
    for (const org of [ORG, OTHER_ORG]) {
        for (const user of [ADMIN, LEAVER, STAYER]) {
            await db.sql`
                insert into org_membership (org_id, github_login, user_id, role)
                values (${org}, ${user.login}, ${user.id}, ${user === ADMIN ? 'admin' : 'member'})
            `;
        }
    }
});
afterEach(async () => {
    if (enabled) await fake.close();
});

const auditOf = (target: string) =>
    db.sql<{ actor_kind: string; detail: { reason: string } }[]>`
        select actor_kind, detail from audit_event where action = 'connection.revoke' and target = ${target}
    `;

describe.skipIf(!enabled)('connection revocation', () => {
    it('removing a member revokes their connections in that org only, and no one else’s', async () => {
        const mine = await oauthConnection(db.sql, ORG, LEAVER.id);
        const elsewhere = await oauthConnection(db.sql, OTHER_ORG, LEAVER.id);
        const theirs = await oauthConnection(db.sql, ORG, STAYER.id);

        expect(await blockMembership(db.sql, ORG, LEAVER.id, ADMIN.id)).toBe('removed');

        const [row] = await db.sql<{ status: string; email: string; api_token: string | null }[]>`
            select status, email, api_token from connector_connection where id = ${mine.id}
        `;
        expect(row).toEqual({ status: 'disconnected', email: '', api_token: null });
        const [grant] = await db.sql<
            { status: string }[]
        >`select status from integration_grant where id = ${mine.grantId}`;
        expect(grant?.status).toBe('revoked');
        expect(await auditOf(mine.id)).toEqual([
            { actor_kind: 'user', detail: expect.objectContaining({ reason: 'member-removed' }) },
        ]);

        for (const kept of [elsewhere, theirs]) {
            const [alive] = await db.sql<
                { status: string }[]
            >`select status from connector_connection where id = ${kept.id}`;
            expect(alive?.status).toBe('active');
            expect(await auditOf(kept.id)).toEqual([]);
        }
    });

    it('a revoked connection is gone from the member’s list, and the destroy pass can retire its secret', async () => {
        const tag = newTag();
        const runtime = jiraRuntime(db.sql, fake);
        script(fake, { tag });
        await (await begin(runtime, ORG, LEAVER.id)).complete();
        const store = createConnectionStore({ sql: db.sql, orgId: ORG });
        expect(await store.list(LEAVER.id)).toHaveLength(1);

        await blockMembership(db.sql, ORG, LEAVER.id, ADMIN.id);

        expect(await store.list(LEAVER.id)).toEqual([]);
        const [grant] = await grantsOf(db.sql, tag);
        expect(grant?.status).toBe('revoked');
        expect(await runtime.destroyRevokedSecret(ORG, grant!.id)).toMatchObject({ ok: true });
        expect((await grantsOf(db.sql, tag))[0]?.secret_version).toBeNull();
    });

    it('a Jira connection stores the site host as its label, never the account’s email or name', async () => {
        const tag = newTag();
        script(fake, { tag, sites: ['one', 'two'] });
        await (await begin(jiraRuntime(db.sql, fake), ORG, LEAVER.id)).complete();

        const rows = await connectionsOf(db.sql, tag);
        expect(rows.map((r) => r.email)).toEqual([hostOf(tag, 'one'), hostOf(tag, 'two')]);
        const store = createConnectionStore({ sql: db.sql, orgId: ORG });
        const listed = (await store.list(LEAVER.id)).map((c) => [c.site, c.account]);
        expect(listed.sort()).toEqual([hostOf(tag, 'one'), hostOf(tag, 'two')].map((host) => [host, host]));
        expect(
            JSON.stringify(await db.sql`select * from connector_connection where external_account_id like ${`%${tag}`}`)
        ).not.toContain('@example.com');
    });
});
