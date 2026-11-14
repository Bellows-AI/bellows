import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORG_TABLES } from '../src/db/org-tables.js';
import { craftJob, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The org-table registry is the schema's own list: every table with an `org_id` is registered, and
 * every registered table is keyed to `organization` so deleting an org removes all of its rows.
 */
const org = testOrg();
const other = testOrg();
const author = testUser('org-tables');
const db = useTestDb({ orgs: [org, other], users: [author] });
const enabled = Boolean(db.url);

const MIGRATION = '141_org_foreign_keys.sql';
const DIR = new URL('../migrations/', import.meta.url);

describe.skipIf(!enabled)('org-owned tables', () => {
    it('registers every table that carries org_id, and nothing else', async () => {
        const rows = await db.sql<{ name: string }[]>`
            select c.relname as name
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
            where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
            order by c.relname
        `;
        expect(rows.map((r) => r.name)).toEqual([...ORG_TABLES].sort());
    });

    it('keys every registered table to organization with a validated, cascading foreign key on org_id', async () => {
        const rows = await db.sql<{ name: string }[]>`
            select c.relname as name
            from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
            join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id'
            where n.nspname = 'public'
              and con.contype = 'f'
              and con.confrelid = 'organization'::regclass
              and con.conkey = array[a.attnum]
              and con.confdeltype = 'c'
              and con.convalidated
        `;
        const keyed = new Set(rows.map((r) => r.name));
        expect(ORG_TABLES.filter((table) => !keyed.has(table))).toEqual([]);
    });

    it('forces row-level security on every table with an org_id, partitions included, under the org policy', async () => {
        const rows = await db.sql<{ name: string; enabled: boolean; forced: boolean; policies: string[] }[]>`
            select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
                   coalesce(array_agg(p.polname || ':' || p.polcmd::text || ':' || pg_get_expr(p.polqual, p.polrelid) || ':'
                                      || pg_get_expr(p.polwithcheck, p.polrelid))
                            filter (where p.oid is not null), '{}') as policies
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
            left join pg_policy p on p.polrelid = c.oid
            where n.nspname = 'public' and c.relkind in ('r', 'p')
            group by c.relname, c.relrowsecurity, c.relforcerowsecurity
        `;
        const policy = "(org_id = current_setting('app.org_id'::text, true))";
        const unbound = rows.filter(
            (r) =>
                !r.enabled ||
                !r.forced ||
                r.policies.length !== 1 ||
                r.policies[0] !== `org_isolation:*:${policy}:${policy}`
        );
        expect(unbound.map((r) => `${r.name} ${JSON.stringify(r)}`)).toEqual([]);
        expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining([...ORG_TABLES]));
    });

    it('runs every view in the schema as its invoker, so the policies bind a read through it', async () => {
        const rows = await db.sql<{ name: string; options: string[] | null }[]>`
            select c.relname as name, c.reloptions as options
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('v', 'm')
        `;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.filter((r) => !(r.options ?? []).includes('security_invoker=true')).map((r) => r.name)).toEqual([]);
    });

    it('deleting an organization leaves none of its rows in any registered table, and another org keeps its own', async () => {
        await craftJob({ sql: db.sql, org, author: author.id });
        const kept = await craftJob({ sql: db.sql, org: other, author: author.id });
        await db.sql`insert into org_plan (org_id, plan, version) values (${org}, 'pro', 1)`;

        await db.sql`delete from organization where id = ${org}`;

        const left: string[] = [];
        for (const table of ORG_TABLES) {
            const [row] = await db.sql<{ n: number }[]>`
                select count(*)::int as n from ${db.sql(table)} where org_id = ${org}
            `;
            if (row!.n > 0) left.push(table);
        }
        expect(left).toEqual([]);
        expect(await db.sql`select 1 from job where id = ${kept}`).toHaveLength(1);
    });
});

/** The migration on a database that already holds a row for an organization that does not exist. */
describe.skipIf(!enabled)(MIGRATION, () => {
    let admin: Sql;
    let pool: Sql;
    let schema: string;

    beforeAll(async () => {
        admin = postgres(db.url as string, { max: 1, onnotice: () => {} });
        schema = `mig_${randomUUID().replaceAll('-', '')}`;
        await admin.unsafe(`create schema ${schema}`);
        pool = postgres(db.url as string, { max: 1, onnotice: () => {}, connection: { search_path: schema } });
    });

    afterAll(async () => {
        await pool.end();
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end();
    });

    it('refuses an orphan row loudly, naming its table and organization, and deletes nothing', async () => {
        const earlier = readdirSync(DIR)
            .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql') && name < MIGRATION)
            .sort();
        for (const name of earlier) await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
        const ghost = `ghost-${randomUUID()}`;
        await pool`insert into organization (id, name) values ('present', 'present')`;
        await pool`insert into org_plan (org_id, plan, version) values ('present', 'free', 1), (${ghost}, 'pro', 1)`;

        const body = readFileSync(new URL(MIGRATION, DIR), 'utf8');
        const failure = await pool.unsafe(body).then(
            () => null,
            (err: Error) => err
        );

        expect(failure?.message).toContain('org_plan');
        expect(failure?.message).toContain(ghost);
        const rows = await pool<{ org_id: string }[]>`select org_id from org_plan order by org_id`;
        expect(rows.map((r) => r.org_id).sort()).toEqual([ghost, 'present'].sort());
    });
});
