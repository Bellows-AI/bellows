import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { assertTestDatabase } from './harness.js';

/** Issue #845: 085 upgrades a database that stops at 084, and applying it again changes nothing. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '085_job_execution.sql';
let admin: Sql;
let pool: Sql;
let schema: string;

const run = () => migrate(pool, { attempts: 1, log: () => {} });
const tables = () =>
    pool<{ t: string }[]>`
        select table_name as t from information_schema.tables
        where table_schema = ${schema} and table_name like 'job\_execution%' order by 1`;

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

describe.skipIf(!enabled)('085_job_execution', () => {
    it('upgrades from 084, and a repeated application is a no-op', async () => {
        await run();
        // Put the schema back at 084.
        await pool.unsafe('drop table job_execution_session, job_execution');
        await pool`delete from schema_migrations where version = ${VERSION}`;
        expect(await tables()).toEqual([]);

        await run();
        expect(await tables()).toEqual([{ t: 'job_execution' }, { t: 'job_execution_session' }]);

        await pool`insert into job_execution (org_id, job_id, claim_seq, root_job_id) values ('o', ${randomUUID()}, 1, ${randomUUID()})`;
        await run();
        const [count] = await pool<{ n: number }[]>`select count(*)::int as n from job_execution`;
        expect(count!.n).toBe(1);
    });

    it('refuses a launch state outside the enum', async () => {
        await run();
        await expect(
            pool`insert into job_execution (org_id, job_id, claim_seq, root_job_id, launch) values ('o', ${randomUUID()}, 2, ${randomUUID()}, 'started')`
        ).rejects.toThrow(/check constraint|job_execution_launch_check/);
    });
});
