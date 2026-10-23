import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { BASE_URL_ENV, templateUrl, testDatabaseNames, workerDatabaseName } from './database-names.js';
import { useTestDb } from './harness.js';

// Creating and dropping a database waits on the server's own I/O, which the other workers keep busy.
const DDL_TIMEOUT = 60_000;

const baseUrl = process.env[BASE_URL_ENV];
const db = useTestDb();

// Another worker's rows must survive this worker's per-test truncate. The sibling here is a scratch
// clone of the run's template, standing in for a concurrent worker's database.
describe.skipIf(!baseUrl)('worker database isolation', () => {
    const sibling = `${testDatabaseNames(baseUrl as string).template.replace(/_tpl_test$/, '')}_iso${randomUUID()
        .replaceAll('-', '')
        .slice(0, 8)}_test`;
    let admin: Sql;
    let other: Sql;

    beforeAll(async () => {
        admin = postgres(baseUrl as string, { max: 1, onnotice: () => {} });
        await admin.unsafe(`create database "${sibling}" template "${testDatabaseNames(baseUrl as string).template}"`);
        other = postgres(new URL(`/${sibling}`, templateUrl(baseUrl as string)).toString(), { max: 1 });
        await other`insert into organization (id, name) values ('survivor', 'survivor')`;
    }, DDL_TIMEOUT);

    afterAll(async () => {
        await other.end({ timeout: 5 });
        await admin.unsafe(`drop database if exists "${sibling}" with (force)`);
        await admin.end({ timeout: 5 });
    }, DDL_TIMEOUT);

    it('runs this file on the clone its pool id names, never the base database', async () => {
        const [row] = await db.sql<{ name: string }[]>`select current_database() as name`;
        expect(row?.name).toBe(workerDatabaseName(baseUrl as string, Number(process.env.VITEST_POOL_ID)));
        expect(row?.name).not.toBe(testDatabaseNames(baseUrl as string).base);
    });

    it('truncates only its own database before each test', async () => {
        const own = await db.sql<{ id: string }[]>`select id from organization where id = 'survivor'`;
        expect(own).toHaveLength(0);
        const theirs = await other<{ id: string }[]>`select id from organization where id = 'survivor'`;
        expect(theirs).toHaveLength(1);
    });
});
