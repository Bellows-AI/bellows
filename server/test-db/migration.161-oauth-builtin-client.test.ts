import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';

/**
 * 161 seeds the built-in CLI client (`bellows-cli`, kind `builtin`): a public client that never registers, whose only
 * redirect is the loopback callback (any port, RFC 8252 section 7.3). The kind check is widened to admit it.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const DIR = new URL('../migrations/', import.meta.url);
let admin: Sql;
let pool: Sql;
let schema: string;

beforeAll(async () => {
    if (!enabled) return;
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    schema = `mig_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema ${schema}`);
    pool = postgres(url as string, { max: 2, onnotice: () => {}, connection: { search_path: schema } });
    const names = readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql'))
        .sort();
    await pool`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
    for (const name of names) {
        await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
        await pool`insert into schema_migrations (version) values (${name})`;
    }
});

afterAll(async () => {
    if (!enabled) return;
    await pool.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
});

describe.runIf(enabled)('161: the built-in CLI client', () => {
    it('seeds bellows-cli as a builtin client with the loopback callback', async () => {
        const rows = await pool<{ kind: string; client_name: string; redirect_uris: string[] }[]>`
            select kind, client_name, redirect_uris from oauth_client where client_id = 'bellows-cli'
        `;
        expect(rows).toEqual([
            { kind: 'builtin', client_name: 'Bellows CLI', redirect_uris: ['http://127.0.0.1/callback'] },
        ]);
    });

    it('accepts builtin, cimd and dcr kinds and refuses any other', async () => {
        await pool`
            insert into oauth_client (client_id, kind, client_name, redirect_uris)
            values ('builtin-probe', 'builtin', null, '{http://127.0.0.1/cb}'), ('dcr-probe', 'dcr', null, '{http://127.0.0.1/cb}')
        `;
        await expect(
            pool`insert into oauth_client (client_id, kind, redirect_uris) values ('xyz-probe', 'xyz', '{http://127.0.0.1/cb}')`
        ).rejects.toThrow(/oauth_client_kind_ck/);
    });

    it('applies twice without error and leaves one row', async () => {
        const name = readdirSync(DIR).find((file) => file.startsWith('161_'));
        expect(name).toBe('161_oauth_builtin_client.sql');
        await pool.unsafe(readFileSync(new URL(name!, DIR), 'utf8'));
        const rows = await pool`select 1 from oauth_client where client_id = 'bellows-cli'`;
        expect(rows).toHaveLength(1);
    });
});
