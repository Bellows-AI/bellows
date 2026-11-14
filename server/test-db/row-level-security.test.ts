import type { TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { ORG_TABLES } from '../src/db/org-tables.js';
import { REQUEST_ROLE } from '../src/db/org-sql.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The policies bind every org-owned table and every view for the request role: with no organization setting a read
 * returns nothing, and with one organization's setting it returns that organization's rows alone. Each table gets
 * a synthetic row for each of two organizations inside one transaction that is rolled back: foreign keys and triggers are off
 * (`session_replication_role = replica`) and check constraints are dropped for its length, so a row of every table can
 * be written without the fixtures of its whole chain.
 */
const orgA = testOrg();
const orgB = testOrg();
const db = useTestDb({ orgs: [orgA, orgB] });
const enabled = Boolean(db.url);

interface Column {
    name: string;
    type: string;
    typtype: string;
    category: string;
    label: string | null;
    base: string | null;
}

class Rollback extends Error {}

/** A literal of `column`'s type, distinct per `n` wherever the type allows. */
function literal(column: Column, n: number, org: string): string {
    if (column.name === 'org_id') return `'${org}'`;
    if (column.typtype === 'e') return `'${column.label}'::${column.type}`;
    if (column.category === 'A') return `'{}'::${column.type}`;
    const type = column.typtype === 'd' ? (column.base ?? column.type) : column.type;
    if (type === 'uuid') return 'gen_random_uuid()';
    if (/^(text|character varying|citext|character)/.test(type)) return `'v${n}'`;
    if (/^(integer|bigint|smallint|numeric|real|double precision)/.test(type)) return `${n}`;
    if (type === 'boolean') return 'false';
    if (/^timestamp|^date/.test(type)) return `now() + interval '${n} seconds'`;
    if (/^jsonb?$/.test(type)) return `'{}'::${type}`;
    if (type === 'bytea') return `'\\x0${n % 10}'::bytea`;
    if (type === 'inet') return `'127.0.0.${n % 250}'::inet`;
    if (type === 'interval') return `interval '${n} seconds'`;
    throw new Error(`no synthetic value for ${column.name} of type ${type}`);
}

async function columnsOf(tx: TransactionSql, table: string): Promise<Column[]> {
    return tx<Column[]>`
        select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, t.typtype, t.typcategory as category,
               (select e.enumlabel from pg_enum e where e.enumtypid = a.atttypid order by e.enumsortorder limit 1) as label,
               format_type(t.typbasetype, t.typtypmod) as base
        from pg_attribute a
        join pg_type t on t.oid = a.atttypid
        where a.attrelid = ${table}::regclass and a.attnum > 0 and not a.attisdropped
          and a.attgenerated = '' and a.attidentity <> 'a'
          and (a.attname = 'org_id' or (a.attnotnull and not a.atthasdef))
        order by a.attnum
    `;
}

/** Writes one row of `org` into `table`, its values numbered `n`. */
async function plant(tx: TransactionSql, table: string, org: string, n: number): Promise<void> {
    const columns = await columnsOf(tx, table);
    const names = columns.map((c) => `"${c.name}"`).join(', ');
    const values = columns.map((c) => literal(c, n, org)).join(', ');
    await tx.unsafe(`insert into "${table}" (${names}) values (${values})`);
}

async function dropChecks(tx: TransactionSql, table: string): Promise<void> {
    const checks = await tx<{ name: string }[]>`
        select conname as name from pg_constraint where conrelid = ${table}::regclass and contype = 'c'
    `;
    for (const { name } of checks) await tx.unsafe(`alter table "${table}" drop constraint if exists "${name}"`);
}

const VIEWS_SQL = `
    select c.relname as name from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm') order by c.relname
`;

/** Every row a relation returns, as sorted JSON: comparable across roles. */
async function rowsOf(tx: TransactionSql, relation: string): Promise<string[]> {
    const rows = await tx.unsafe<{ row: string }[]>(`select to_jsonb(r)::text as row from "${relation}" r`);
    return rows.map((r) => r.row).sort();
}

async function asOrg(tx: TransactionSql, org: string | null): Promise<void> {
    await tx`select set_config('app.org_id', ${org ?? ''}, true)`;
}

/** Runs `fn` in a transaction holding two orgs' synthetic rows in every org table, then rolls all of it back. */
async function withPlantedRows(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
    const rolledBack = await db.sql
        .begin(async (tx) => {
            await tx`set local session_replication_role = replica`;
            for (const table of ORG_TABLES) await dropChecks(tx, table);
            for (const table of ORG_TABLES) {
                await plant(tx, table, orgA, 1);
                await plant(tx, table, orgB, 2);
            }
            await fn(tx);
            throw new Rollback();
        })
        .catch((e: unknown) => e);
    if (!(rolledBack instanceof Rollback)) throw rolledBack;
}

describe.skipIf(!enabled)('row-level security for the request role', () => {
    it('reads no row of any org table without the organization setting, and only its own with it', async () => {
        const leaks: string[] = [];
        await withPlantedRows(async (tx) => {
            await tx.unsafe(`set local role ${REQUEST_ROLE}`);
            for (const table of ORG_TABLES) {
                await asOrg(tx, null);
                const [none] = await tx.unsafe<{ n: number }[]>(`select count(*)::int as n from "${table}"`);
                if (none!.n !== 0) leaks.push(`${table}: ${none!.n} rows with no setting`);
                await asOrg(tx, orgA);
                const own = await tx.unsafe<{ org_id: string }[]>(`select org_id from "${table}"`);
                if (own.length !== 1 || own[0]!.org_id !== orgA) {
                    leaks.push(`${table}: ${JSON.stringify(own.map((r) => r.org_id))} with org A's setting`);
                }
            }
        });
        expect(leaks).toEqual([]);
    });

    it("refuses a write of another organization's row", async () => {
        await withPlantedRows(async (tx) => {
            await tx.unsafe(`set local role ${REQUEST_ROLE}`);
            await asOrg(tx, orgA);
            const failure = await tx
                .savepoint((sp) => sp`update org_plan set org_id = ${orgB} where org_id = ${orgA}`)
                .catch((e: Error) => e);
            expect(String(failure)).toContain('row-level security');
        });
    });

    it('reads no row of any view without the setting, and with one org the rows that org alone would yield', async () => {
        const leaks: string[] = [];
        let seen = 0;
        await withPlantedRows(async (tx) => {
            const views = (await tx.unsafe<{ name: string }[]>(VIEWS_SQL)).map((v) => v.name);
            expect(views.length).toBeGreaterThan(0);
            await tx.unsafe(`set local role ${REQUEST_ROLE}`);
            const scoped = new Map<string, string[]>();
            for (const view of views) {
                await asOrg(tx, null);
                const none = await rowsOf(tx, view);
                if (none.length !== 0) leaks.push(`${view}: ${none.length} rows with no setting`);
                await asOrg(tx, orgA);
                scoped.set(view, await rowsOf(tx, view));
            }
            // What the views yield when org A's rows are all there is, read as the owner.
            await tx`reset role`;
            for (const table of ORG_TABLES) await tx.unsafe(`delete from "${table}" where org_id = '${orgB}'`);
            for (const view of views) {
                const alone = await rowsOf(tx, view);
                seen += alone.length;
                if (JSON.stringify(alone) !== JSON.stringify(scoped.get(view))) {
                    leaks.push(
                        `${view}: org A's setting read ${scoped.get(view)?.length} rows, org A alone yields ${alone.length}`
                    );
                }
            }
        });
        expect(leaks).toEqual([]);
        expect(seen).toBeGreaterThan(0);
    });
});
