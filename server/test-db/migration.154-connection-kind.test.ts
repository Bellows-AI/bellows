import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';

/**
 * 154 widens `connector_connection.kind` from Jira alone to the providers the board registers: a `linear` row
 * inserts, any other kind is still refused by the same named check.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '154_connection_kind_linear.sql';
const DIR = new URL('../migrations/', import.meta.url);
const CHECK_VIOLATION = '23514';
let admin: Sql;
let pool: Sql;
let schema: string;

beforeAll(async () => {
    if (!enabled) return;
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    schema = `mig_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema ${schema}`);
    pool = postgres(url as string, { max: 2, onnotice: () => {}, connection: { search_path: schema } });
});

afterAll(async () => {
    if (!enabled) return;
    await pool.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
});

const versioned = (below: string): string[] =>
    readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql') && name < below)
        .sort();

describe.skipIf(!enabled)('154_connection_kind_linear', () => {
    it('lets a linear connection in and still refuses any other kind', async () => {
        for (const name of versioned(VERSION)) await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
        const org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
        await pool`insert into organization (id, name) values (${org}, ${org})`;
        const insert = (kind: string) => pool`
            insert into connector_connection (org_id, kind, site, cloud_id, email, api_token, access)
            values (${org}, ${kind}, 'lane-workspace', ${`ws-${randomUUID()}`}, 'agent@example.com', 'tok', 'read')
        `;
        const refusal = async (kind: string) => {
            const caught = await insert(kind).then(
                () => null,
                (error: { code?: string; constraint_name?: string }) => error
            );
            return caught && { code: caught.code, constraint: caught.constraint_name };
        };
        const named = { code: CHECK_VIOLATION, constraint: 'connector_connection_kind_check' };
        expect(await refusal('linear')).toEqual(named);

        await pool.unsafe(readFileSync(new URL(VERSION, DIR), 'utf8'));

        expect(await refusal('linear')).toBeNull();
        expect(await refusal('jira')).toBeNull();
        expect(await refusal('other')).toEqual(named);
    });
});
