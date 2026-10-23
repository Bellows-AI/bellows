import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { BASE_URL_ENV, templateUrl, testDatabaseNames, workerDatabaseName } from './database-names.js';
import { acquireRunLock } from './run-lock.js';
import { testDbWorkers } from './workers.js';

/** Names come from `database-names.ts` and end `_test`; quoted anyway because they reach DDL. */
function ident(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}

async function dropDatabase(admin: Sql, name: string): Promise<void> {
    await admin.unsafe(`drop database if exists ${ident(name)} with (force)`);
}

/**
 * Once per `npm run test:db`: refuse a non-`_test` URL and a second run on the same database,
 * migrate a fresh template, and clone one database per worker from it. The base database is only
 * the lock's home — nothing is migrated into or truncated in it. Clones are dropped and recreated
 * by name, so a killed run's leftovers are replaced by the next run, never accumulated.
 */
export default async function setup(): Promise<() => Promise<void>> {
    const baseUrl = process.env.DATABASE_URL;
    if (!baseUrl) return async () => {};
    const names = testDatabaseNames(baseUrl);
    const workers = Array.from({ length: testDbWorkers() }, (_, i) => workerDatabaseName(baseUrl, i + 1));

    const lock = await acquireRunLock(baseUrl, names.base);
    const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
    const dropAll = async () => {
        for (const name of workers) await dropDatabase(admin, name);
        await dropDatabase(admin, names.template);
    };
    try {
        await dropAll();
        await admin.unsafe(`create database ${ident(names.template)}`);
        const template = postgres(templateUrl(baseUrl), { max: 4, onnotice: () => {} });
        try {
            await migrate(template, { attempts: 3 });
        } finally {
            await template.end({ timeout: 5 });
        }
        for (const name of workers) {
            await admin.unsafe(`create database ${ident(name)} template ${ident(names.template)}`);
        }
    } catch (error) {
        await dropAll().catch(() => {});
        await admin.end({ timeout: 5 }).catch(() => {});
        await lock.release().catch(() => {});
        throw error;
    }
    process.env[BASE_URL_ENV] = baseUrl;

    return async () => {
        try {
            await dropAll();
        } finally {
            await admin.end({ timeout: 5 });
            await lock.release();
        }
    };
}
