import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore, type AuthStore } from '../src/auth/store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: AuthStore;

const ORG = '911001';
const SECOND_ORG = '911002';
/** Every account this file creates is numbered from here, so the cleanup can be precise. */
const ID_BASE = 90000;

const db = useTestDb({ orgs: [ORG, SECOND_ORG] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createAuthStore({ sql });
});

const identity = (n: number, login: string) => ({
    githubUserId: ID_BASE + n,
    login,
    displayName: login,
    avatarUrl: null,
});

/** Signs in as this identity, with ORG as the only installation GitHub reports. */
const member = (n = 0, login = 'octocat', installations = [{ id: ORG, name: ORG }]) =>
    store.signIn(identity(n, login), installations[0]!.id, installations);

const createPersonal = (caller: { user: { id: string } }, token: string, label: string) =>
    store.createAccessToken({
        kind: 'personal',
        orgId: ORG,
        userId: caller.user.id,
        createdBy: caller.user.id,
        label,
        tokenHash: hashToken(token),
    });

const createOrgToken = (caller: { user: { id: string } }, token: string, label: string) =>
    store.createAccessToken({
        kind: 'org',
        orgId: ORG,
        userId: null,
        createdBy: caller.user.id,
        label,
        tokenHash: hashToken(token),
    });

describe.skipIf(!enabled)('access tokens', () => {
    it('resolves a personal token to its caller in the org the token was minted for', async () => {
        const caller = await member(1, 'token-user');
        await createPersonal(caller, 'fat_a', 'laptop');

        const resolved = await store.findPersonalToken(hashToken('fat_a'));
        expect(resolved).toMatchObject({
            user: { id: caller.user.id, login: 'token-user' },
            // This account is the org's FIRST member, so its membership lands `admin` (#410);
            // the token acts as its user, through the same join.
            role: 'admin',
            org: { id: ORG, name: ORG },
        });
    });

    it('refuses a personal token whose membership is gone', async () => {
        const caller = await member(2, 'leaver');
        await createPersonal(caller, 'fat_b', 'laptop');

        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${caller.user.id}`;

        expect(await store.findPersonalToken(hashToken('fat_b'))).toBeNull();
    });

    it('resolves each token into its OWN org, whatever else the account belongs to', async () => {
        // Since #99 the lookup is by the globally-unique hash and the org comes FROM the row —
        // the mint-time binding. A token minted into one org acts there and nowhere else.
        const ACCOUNT_SEQ = 4;
        const caller = await member(ACCOUNT_SEQ, 'everywhere', [
            { id: ORG, name: ORG },
            { id: SECOND_ORG, name: SECOND_ORG },
        ]);
        await store.createAccessToken({
            kind: 'personal',
            orgId: SECOND_ORG,
            userId: caller.user.id,
            createdBy: caller.user.id,
            label: 'laptop',
            tokenHash: hashToken('fat_d'),
        });

        const resolved = await store.findPersonalToken(hashToken('fat_d'));
        expect(resolved?.org.id).toBe(SECOND_ORG);
    });

    it('stores the hash of the token, never the token', async () => {
        const ACCOUNT_SEQ = 7;
        const caller = await member(ACCOUNT_SEQ, 'at-rest');
        const token = 'fat_secret-value-shown-once';
        await createPersonal(caller, token, 'laptop');

        const [row] = await sql<{ token_hash: Buffer }[]>`
            select token_hash from access_token where org_id = ${ORG} and label = 'laptop'
        `;
        expect(row!.token_hash.equals(hashToken(token))).toBe(true);
        expect(row!.token_hash.toString('utf8')).not.toContain(token);
    });

    it('rejects a personal row with no user, at the row', async () => {
        // access_token_owner_ck says what the hook assumes: a personal token has an owner.
        await expect(
            store.createAccessToken({
                kind: 'personal',
                orgId: ORG,
                userId: null,
                // The route's types forbid an ownerless token; the row must refuse it anyway, so
                // the shape is produced past the types on purpose.
                createdBy: null as unknown as string,
                label: 'ownerless',
                tokenHash: hashToken('fat_ownerless'),
            })
        ).rejects.toThrow();
    });
});

describe.skipIf(!enabled)('access tokens: org-scoped', () => {
    it('refuses a revoked token, of either kind', async () => {
        const ACCOUNT_SEQ = 3;
        const caller = await member(ACCOUNT_SEQ, 'revoker');
        const personal = await createPersonal(caller, 'fat_c', 'laptop');
        const org = await createOrgToken(caller, 'oat_c', 'ci');

        expect(await store.revokePersonalToken(ORG, caller.user.id, personal.id)).toBe('revoked');
        expect(await store.revokeOrgToken(ORG, org.id)).toBe('revoked');
        expect(await store.findPersonalToken(hashToken('fat_c'))).toBeNull();
        expect(await store.findOrgToken(hashToken('oat_c'))).toBeNull();
        // Revoking again changes nothing.
        expect(await store.revokePersonalToken(ORG, caller.user.id, personal.id)).toBe('missing');
        expect(await store.revokeOrgToken(ORG, org.id)).toBe('missing');
    });

    it('answers an org token with its identity AND its org', async () => {
        const ACCOUNT_SEQ = 9;
        const caller = await member(ACCOUNT_SEQ, 'org-minter');
        const org = await createOrgToken(caller, 'oat_h', 'ci');

        expect(await store.findOrgToken(hashToken('oat_h'))).toEqual({ orgId: ORG, id: org.id, label: 'ci' });
    });

    it('resolves an org token only while its minter is still a member', async () => {
        // The issuer's membership is the org token's authority, the same join a session and a
        // personal token run: sign-in propagation deleting the membership kills the token's reach
        // on the next request, while the row itself survives unrevoked — history with no reach,
        // the same contract the personal kind states.
        const ACCOUNT_SEQ = 12;
        const minter = await member(ACCOUNT_SEQ, 'org-leaver');
        const org = await createOrgToken(minter, 'oat_i', 'ci');
        expect(await store.findOrgToken(hashToken('oat_i'))).toEqual({ orgId: ORG, id: org.id, label: 'ci' });

        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${minter.user.id}`;

        expect(await store.findOrgToken(hashToken('oat_i'))).toBeNull();
        const [row] = await sql<{ revoked_at: Date | null }[]>`
            select revoked_at from access_token where org_id = ${ORG} and id = ${org.id}
        `;
        expect(row?.revoked_at).toBeNull();
    });

    it('does not resolve an org token whose minter is a member of a DIFFERENT org', async () => {
        // The join is on (org, creator) together: membership elsewhere is not authority here, so
        // a row minted into ORG by someone whose membership is only in SECOND_ORG is dead.
        const ACCOUNT_SEQ = 13;
        const minter = await member(ACCOUNT_SEQ, 'org-outsider', [{ id: SECOND_ORG, name: SECOND_ORG }]);
        await createOrgToken(minter, 'oat_j', 'ci');

        expect(await store.findOrgToken(hashToken('oat_j'))).toBeNull();
    });
});

describe.skipIf(!enabled)('access tokens: lifecycle', () => {
    it('stamps last_used_at, then holds it within the throttle window', async () => {
        // The dashboard polls every two seconds, so the touch is throttled to one rewrite a
        // minute — minute-granular "last used" in exchange for a read path that is not a write.
        const ACCOUNT_SEQ = 5;
        const caller = await member(ACCOUNT_SEQ, 'throttle');
        await createPersonal(caller, 'fat_e', 'laptop');

        await store.findPersonalToken(hashToken('fat_e'));
        const [first] = await sql<{ last_used_at: Date }[]>`
            select last_used_at from access_token where org_id = ${ORG} and label = 'laptop'
        `;
        expect(first?.last_used_at).not.toBeNull();

        await store.findPersonalToken(hashToken('fat_e'));
        const [second] = await sql<{ last_used_at: Date }[]>`
            select last_used_at from access_token where org_id = ${ORG} and label = 'laptop'
        `;
        expect(second?.last_used_at?.getTime()).toBe(first?.last_used_at?.getTime());
    });

    it('leaves a memberless personal token unrevoked but dead — the join is the enforcement', async () => {
        // The old removeMember marked tokens; the sign-in propagation that replaced it does not.
        // It does not need to: findPersonalToken joins the membership, so the row survives as
        // history with no reach at all.
        const ACCOUNT_SEQ = 6;
        const caller = await member(ACCOUNT_SEQ, 'removed');
        await createPersonal(caller, 'fat_f', 'laptop');
        await sql`update organization set installation_id = id::bigint where id in (${ORG}, ${SECOND_ORG})`;

        await store.signIn(identity(ACCOUNT_SEQ, 'removed'), SECOND_ORG, [{ id: SECOND_ORG, name: SECOND_ORG }]);

        const [row] = await sql<{ revoked_at: Date | null }[]>`
            select revoked_at from access_token where org_id = ${ORG} and label = 'laptop'
        `;
        expect(row?.revoked_at).toBeNull();
        expect(await store.findPersonalToken(hashToken('fat_f'))).toBeNull();
    });

    it('lists each scope without ever selecting a hash', async () => {
        const ACCOUNT_SEQ = 8;
        const caller = await member(ACCOUNT_SEQ, 'lister');
        await createPersonal(caller, 'fat_g', 'laptop');
        await createOrgToken(caller, 'oat_g', 'ci');

        const personal = await store.listPersonalTokens(ORG, caller.user.id);
        expect(personal).toMatchObject([{ label: 'laptop', revokedAt: null }]);
        const org = await store.listOrgTokens(ORG);
        expect(org).toMatchObject([{ label: 'ci' }]);
        for (const view of [...personal, ...org]) {
            expect(JSON.stringify(view)).not.toContain('hash');
        }
    });
});
