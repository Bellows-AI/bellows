import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CROSS_ORG_ROLE, orgSql, REQUEST_ROLE } from '../src/db/org-sql.js';
import { boardPool, crossOrgPool, requestPools } from '../src/db/pool.js';
import { craftJob, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * A store's handle on the request pool: every statement runs in a transaction that sets its organization first, so the
 * policies return that organization's rows, and the setting dies with the transaction.
 */
const orgA = testOrg();
const orgB = testOrg();
const author = testUser('org-sql');
const db = useTestDb({ orgs: [orgA, orgB], users: [author] });
const enabled = Boolean(db.url);

describe.skipIf(!enabled)('orgSql', () => {
    let pool: Sql;

    beforeAll(() => {
        pool = boardPool(db.url as string, { max: 1, statementTimeoutMs: 10_000, role: REQUEST_ROLE });
    });
    afterAll(async () => {
        await pool.end({ timeout: 5 });
    });

    const seed = async () => {
        await craftJob({ sql: db.sql, org: orgA, author: author.id }, { command: 'a1' });
        await craftJob({ sql: db.sql, org: orgA, author: author.id }, { command: 'a2' });
        await craftJob({ sql: db.sql, org: orgB, author: author.id }, { command: 'b1' });
    };

    it("reads the organization's own rows through a statement, a fragment, unsafe and begin", async () => {
        await seed();
        const a = orgSql(pool, orgA);
        const plain = await a<{ command: string }[]>`select command from job order by command`;
        expect(plain.map((r) => r.command)).toEqual(['a1', 'a2']);
        const filtered = await a<{ command: string }[]>`select command from job where ${a`command = ${'a2'}`}`;
        expect(filtered.map((r) => r.command)).toEqual(['a2']);
        const unsafe = await a.unsafe<{ n: number }[]>('select count(*)::int as n from job');
        expect(unsafe[0]!.n).toBe(2);
        const inTx = await a.begin(async (tx) => {
            const [row] = await tx<{ n: number }[]>`select count(*)::int as n from job`;
            return row!.n;
        });
        expect(inTx).toBe(2);
        const b = await orgSql(pool, orgB)<{ command: string }[]>`select command from job`;
        expect(b.map((r) => r.command)).toEqual(['b1']);
    });

    it('leaves no organization on the pooled connection for the next borrower', async () => {
        await orgSql(pool, orgA)`select 1`;
        const [row] = await pool<{ org: string | null }[]>`select current_setting('app.org_id', true) as org`;
        expect(row!.org ?? '').toBe('');
        const [jobs] = await pool<{ n: number }[]>`select count(*)::int as n from job`;
        expect(jobs!.n).toBe(0);
    });

    it('iterates a cursor inside its transaction and releases the connection after it', async () => {
        await seed();
        const seen: string[] = [];
        for await (const rows of orgSql(pool, orgA)<
            { command: string }[]
        >`select command from job order by command`.cursor(1)) {
            seen.push(...rows.map((r) => r.command));
        }
        expect(seen).toEqual(['a1', 'a2']);
        for await (const rows of orgSql(pool, orgA)<
            { command: string }[]
        >`select command from job order by command`.cursor(1)) {
            expect(rows).toHaveLength(1);
            break;
        }
        const [row] = await pool<{ ok: number }[]>`select 1 as ok`;
        expect(row!.ok).toBe(1);
    });

    it('answers a write only once its transaction has committed, so the next read anywhere sees it', async () => {
        const a = orgSql(pool, orgA);
        for (let version = 1; version <= 20; version++) {
            await a`insert into org_plan (org_id, plan, version) values (${orgA}, 'pro', ${version})
                    on conflict (org_id) do update set version = excluded.version`;
            const [row] = await db.sql<{ version: number }[]>`select version from org_plan where org_id = ${orgA}`;
            expect(Number(row?.version)).toBe(version);
        }
    });

    it('rejects a failed statement and rolls its transaction back', async () => {
        const a = orgSql(pool, orgA);
        await expect(a`select 1 / 0`).rejects.toThrow('division by zero');
        const [row] = await a<{ ok: number }[]>`select 1 as ok`;
        expect(row!.ok).toBe(1);
    });

    it("refuses a write of another organization's row", async () => {
        await expect(
            orgSql(pool, orgA)`insert into org_plan (org_id, plan, version) values (${orgB}, 'pro', 1)`
        ).rejects.toThrow('row-level security');
    });

    it('refuses an empty organization', () => {
        expect(() => orgSql(pool, '')).toThrow();
    });
});

/**
 * The policies exempt the owner (151 enables, a later release forces), so no request may run as it: the board's request
 * and secrets pools take the request role, the cross-org pool its own, and only the migration connection is the owner.
 */
describe.skipIf(!enabled)("the board's pools", () => {
    it('run requests and secrets as the request role, the cross-org paths as the cross-org role', async () => {
        const options = { max: 1, statementTimeoutMs: 10_000 };
        const pools = requestPools({ databaseUrl: db.url as string, databaseRequestUrl: null }, options);
        const crossOrg = crossOrgPool(db.url as string, options);
        try {
            const roleOf = async (sql: Sql) => (await sql<{ role: string }[]>`select current_user as role`)[0]!.role;
            expect(await roleOf(pools.request)).toBe(REQUEST_ROLE);
            expect(await roleOf(pools.secrets)).toBe(REQUEST_ROLE);
            expect(await roleOf(crossOrg)).toBe(CROSS_ORG_ROLE);
            const [owner] = await db.sql<{ role: string }[]>`select current_user as role`;
            expect(await roleOf(pools.owner)).toBe(owner!.role);
        } finally {
            await Promise.all([pools.request, pools.secrets, pools.owner, crossOrg].map((p) => p.end({ timeout: 5 })));
        }
    });
});
