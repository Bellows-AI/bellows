import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { BASE_URL_ENV, scratchDatabaseName, testDatabaseNames, workerDatabaseName } from './database-names.js';
import { runDatabaseNames } from './run-databases.js';
import { testDbWorkers } from './workers.js';

// Creating a database waits on the server's own I/O, which the other workers keep busy.
const DDL_TIMEOUT = 60_000;

const baseUrl = process.env[BASE_URL_ENV];

// The teardown drops what this lists, so it must find the scratch databases tests leave behind.
// Nothing is dropped here: a forced DROP DATABASE checkpoints, and the run's own teardown drops them.
describe.skipIf(!baseUrl)('the databases a run drops at the end', () => {
    const scratch = [1, 2].map(() =>
        scratchDatabaseName(baseUrl as string, `iso${randomUUID().replaceAll('-', '').slice(0, 8)}`)
    );
    let admin: Sql;

    beforeAll(async () => {
        admin = postgres(baseUrl as string, { max: 1, onnotice: () => {} });
        for (const name of scratch) await admin.unsafe(`create database "${name}"`);
    }, DDL_TIMEOUT);

    afterAll(async () => {
        await admin.end({ timeout: 5 });
    });

    it('lists every worker clone, every scratch database of its base, and the template last', async () => {
        const poolIds = Array.from({ length: testDbWorkers() }, (_, i) => i + 1);
        const names = await runDatabaseNames(admin, baseUrl as string, poolIds);
        expect(names.slice(0, poolIds.length)).toEqual(poolIds.map((id) => workerDatabaseName(baseUrl as string, id)));
        expect(names.at(-1)).toBe(testDatabaseNames(baseUrl as string).template);
        expect(names).toEqual(expect.arrayContaining(scratch));
    });
});
