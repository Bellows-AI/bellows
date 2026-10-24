import type { Sql } from 'postgres';
import { isScratchDatabase, testDatabaseNames, workerDatabaseName } from './database-names.js';

/** Names come from `database-names.ts` and end `_test`; quoted anyway because they reach DDL. */
function ident(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}

async function dropDatabase(admin: Sql, name: string): Promise<void> {
    await admin.unsafe(`drop database if exists ${ident(name)} with (force)`);
}

/** Every scratch database of this run's base that exists now (a killed run's leftovers included). */
async function scratchDatabases(admin: Sql, baseUrl: string): Promise<string[]> {
    const rows = await admin<{ datname: string }[]>`select datname from pg_database`;
    return rows.map((row) => row.datname).filter((name) => isScratchDatabase(baseUrl, name));
}

/**
 * What one `test:db` run derives from its base, in drop order: the worker clones, the scratch
 * databases tests create beside them, then the template.
 */
export async function runDatabaseNames(admin: Sql, baseUrl: string, workers: number[]): Promise<string[]> {
    return [
        ...workers.map((poolId) => workerDatabaseName(baseUrl, poolId)),
        ...(await scratchDatabases(admin, baseUrl)),
        testDatabaseNames(baseUrl).template,
    ];
}

/**
 * Drops them all. Each force-drop makes the server checkpoint, so a test never drops its own
 * scratch database under load — it leaves it here, once, outside any test or hook timeout.
 */
export async function dropRunDatabases(admin: Sql, baseUrl: string, workers: number[]): Promise<void> {
    for (const name of await runDatabaseNames(admin, baseUrl, workers)) await dropDatabase(admin, name);
}
