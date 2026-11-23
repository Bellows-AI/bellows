import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { assertTestDatabase } from './harness.js';

/**
 * An index on a large table is built `concurrently`, after the schema transaction commits, so the boot lock never
 * holds a table scan: `migrations/concurrent/*.sql`, run on every boot, resumable and idempotent.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

let admin: Sql;
let pool: Sql;
let schema: string;
let dir: URL;

const INDEX = 't_a_uk';

beforeAll(async () => {
    if (!enabled) return;
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    schema = `mig_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema ${schema}`);
    pool = postgres(url as string, { max: 2, onnotice: () => {}, connection: { search_path: schema } });
    const root = mkdtempSync(join(tmpdir(), 'concurrent-'));
    mkdirSync(join(root, 'concurrent'));
    writeFileSync(
        join(root, '001_t.sql'),
        'create table t (a int not null);\n' +
            // The boot's reaps read these two tables whatever the directory holds.
            'create table session (expires_at timestamptz);\ncreate table pending_sign_in (expires_at timestamptz);\n'
    );
    writeFileSync(
        join(root, 'concurrent', '001_t_index.sql'),
        `-- built after the schema transaction commits\ncreate unique index concurrently if not exists ${INDEX} on t (a);\n`
    );
    dir = new URL(`${pathToFileURL(root).href}/`);
});

afterAll(async () => {
    if (!enabled) return;
    await pool.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
});

const indexState = async () => {
    const [row] = await pool<{ oid: number; valid: boolean }[]>`
        select c.oid::int as oid, i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid
        where c.relname = ${INDEX} and c.relnamespace = current_schema()::regnamespace`;
    return row;
};

describe.skipIf(!enabled)('concurrent index builds', () => {
    it('builds the index after the schema is migrated', async () => {
        await migrate(pool, { dir, attempts: 1 });
        expect(await indexState()).toMatchObject({ valid: true });
    });

    it('is a no-op on a rerun', async () => {
        const before = await indexState();
        expect(before).toMatchObject({ valid: true });
        await migrate(pool, { dir, attempts: 1 });
        expect(await indexState()).toEqual(before);
    });

    it('drops an invalid leftover of a crashed build and rebuilds it', async () => {
        await pool.unsafe(`drop index ${INDEX}`);
        await pool`insert into t (a) values (1), (1)`;
        await expect(pool.unsafe(`create unique index concurrently ${INDEX} on t (a)`)).rejects.toThrow();
        expect(await indexState()).toMatchObject({ valid: false });

        await pool`delete from t`;
        await migrate(pool, { dir, attempts: 1 });
        expect(await indexState()).toMatchObject({ valid: true });
    });
});
