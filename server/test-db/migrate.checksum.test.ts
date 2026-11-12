import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { MigrationChecksumError, migrate } from '../src/db/migrate.js';
import { assertTestDatabase } from './harness.js';

// Each test migrates its own schema from a private copy of the migration directory, so a body can be
// altered without touching the shipped files. Schemas are dropped afterwards (see migrate.concurrency).
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const SHIPPED = new URL('../migrations/', import.meta.url);
const OPTIONS = { attempts: 3, backoffMs: 1 };

let admin: Sql;
const pools: Sql[] = [];
const schemas: string[] = [];

function copyOfMigrations(): { dir: URL; path: (name: string) => string } {
    const root = mkdtempSync(join(tmpdir(), 'mig-'));
    cpSync(SHIPPED, root, { recursive: true });
    return { dir: pathToFileURL(`${root}/`), path: (name) => join(root, name) };
}

async function freshPool(): Promise<{ pool: Sql; schema: string }> {
    const schema = `mig_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema ${schema}`);
    schemas.push(schema);
    const pool = postgres(url as string, { max: 2, onnotice: () => {}, connection: { search_path: schema } });
    pools.push(pool);
    return { pool, schema };
}

beforeAll(() => {
    if (enabled) admin = postgres(url as string, { max: 2, onnotice: () => {} });
});

afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end({ timeout: 5 })));
    for (const schema of schemas) await admin.unsafe(`drop schema ${schema} cascade`);
    await admin?.end({ timeout: 5 });
});

const VERSION = '070_artifact_index.sql';

describe.skipIf(!enabled)('the ledger checksum', () => {
    it('refuses a boot whose applied file changed, naming the version and never the body', async () => {
        const { pool } = await freshPool();
        const copy = copyOfMigrations();
        await migrate(pool, { ...OPTIONS, dir: copy.dir });

        writeFileSync(copy.path(VERSION), `-- SECRET-BODY-MARKER\n${readSource(copy.path(VERSION))}`);
        const error = await migrate(pool, { ...OPTIONS, dir: copy.dir }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(MigrationChecksumError);
        expect((error as Error).message).toContain(VERSION);
        expect((error as Error).message).not.toContain('SECRET-BODY-MARKER');
    });

    it('back-fills a null checksum with the shipped hash, even when the body differs from what ran', async () => {
        const { pool, schema } = await freshPool();
        const copy = copyOfMigrations();
        await migrate(pool, { ...OPTIONS, dir: copy.dir });
        // A database migrated before the column existed, from older comment text.
        await admin.unsafe(`update ${schema}.schema_migrations set checksum = null`);
        writeFileSync(
            copy.path(VERSION),
            `-- reworded since this database applied it\n${readSource(copy.path(VERSION))}`
        );

        await migrate(pool, { ...OPTIONS, dir: copy.dir });

        const rows = await admin.unsafe<{ checksum: string | null }[]>(
            `select checksum from ${schema}.schema_migrations`
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.checksum !== null)).toBe(true);
        // And the adopted hash now guards the file: a further edit is refused.
        writeFileSync(copy.path(VERSION), '-- edited again\nselect 1;\n');
        await expect(migrate(pool, { ...OPTIONS, dir: copy.dir })).rejects.toBeInstanceOf(MigrationChecksumError);
    });

    it('does not checksum repeatable files', async () => {
        const { pool, schema } = await freshPool();
        const copy = copyOfMigrations();
        await migrate(pool, { ...OPTIONS, dir: copy.dir });
        const repeatable = readdirSync(copy.dir).find((n) => n.endsWith('.repeatable.sql'));
        expect(repeatable).toBeDefined();

        writeFileSync(copy.path(repeatable as string), `-- touched\n${readSource(copy.path(repeatable as string))}`);
        await migrate(pool, { ...OPTIONS, dir: copy.dir });

        const rows = await admin.unsafe(
            `select 1 from ${schema}.schema_migrations where version like '%.repeatable.sql'`
        );
        expect(rows).toHaveLength(0);
    });
});

function readSource(path: string): string {
    return readFileSync(path, 'utf8');
}
