import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { finalizeLineage } from '../src/db/connection-grants.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';

/** BEL-164: 101 adds the marker of the last reconsent claim that finalized a grant, expand only. */
const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const ALICE = testUser('mig101-alice');
const db = useTestDb({ orgs: [ORG], users: [ALICE] });

const seedClaimed = async (kind: 'reconsent' | 'refresh'): Promise<{ grantId: string; token: string }> => {
    const token = randomUUID();
    const [row] = await db.sql<{ id: string }[]>`
        insert into integration_grant (org_id, principal_kind, principal_user_id, provider, external_account_id, authority,
                                       secret_ref, secret_version, lineage_claim, lineage_claim_kind, lineage_claim_expires_at)
        values (${ORG}, 'user', ${ALICE.id}, 'jira', ${`acct-${randomUUID()}`}, '{"scopes":["read"]}'::jsonb,
                ${`ref-${randomUUID()}`}, 'v1', ${token}, ${kind}, now() + interval '1 minute')
        returning id
    `;
    return { grantId: row!.id, token };
};

const markerOf = async (id: string): Promise<string | null> =>
    (
        await db.sql<
            { m: string | null }[]
        >`select lineage_finalized_claim as m from integration_grant where id = ${id}`
    )[0]!.m;

describe.skipIf(!enabled)('101_grant_finalized_claim', () => {
    it('adds a nullable uuid column', async () => {
        const columns = await db.sql<{ data_type: string; is_nullable: string }[]>`
            select data_type, is_nullable from information_schema.columns
            where table_schema = current_schema() and table_name = 'integration_grant'
              and column_name = 'lineage_finalized_claim'
        `;
        expect(columns).toEqual([{ data_type: 'uuid', is_nullable: 'YES' }]);
    });

    it('a reconsent finalize records its claim token; a refresh finalize leaves the marker alone', async () => {
        const reconsent = await seedClaimed('reconsent');
        expect(await markerOf(reconsent.grantId)).toBeNull();
        const done = await finalizeLineage(
            db.sql,
            { orgId: ORG, grantId: reconsent.grantId, token: reconsent.token },
            { kind: 'reconsent', secretVersion: 'v2' as never, authority: { scopes: ['read'] } as never }
        );
        expect(done.ok).toBe(true);
        expect(await markerOf(reconsent.grantId)).toBe(reconsent.token);

        const refresh = await seedClaimed('refresh');
        await finalizeLineage(
            db.sql,
            { orgId: ORG, grantId: refresh.grantId, token: refresh.token },
            { kind: 'refresh', secretVersion: 'v2' as never, authority: { scopes: ['read'] } as never }
        );
        expect(await markerOf(refresh.grantId)).toBeNull();
    });
});
