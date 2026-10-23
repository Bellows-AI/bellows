import { assertTestDatabase } from './database-guard.js';

/**
 * The databases one `npm run test:db` run uses, all derived from the `DATABASE_URL` database
 * (the "base"): a template migrated once, and one clone per vitest worker. Every derived name
 * ends `_test`, so `assertTestDatabase` accepts it and stays the only refusal point.
 */
export interface TestDatabaseNames {
    /** The database `DATABASE_URL` names: holds the run lock, is never migrated or truncated. */
    base: string;
    /** Migrated once per run, then cloned for every worker. */
    template: string;
}

/** Where the worker setup finds the `DATABASE_URL` the run started with, after it rewrites its own. */
export const BASE_URL_ENV = 'FACTORY_TEST_DB_BASE_URL';

function withDatabase(raw: string, name: string): string {
    const url = new URL(raw);
    url.pathname = `/${name}`;
    return url.toString();
}

/** Refuses a non-`_test` URL before any caller has connected to anything. */
export function testDatabaseNames(raw: string): TestDatabaseNames {
    assertTestDatabase(raw);
    const base = new URL(raw).pathname.replace(/^\//, '');
    return { base, template: `${base.replace(/_test$/, '')}_tpl_test` };
}

export function workerDatabaseName(raw: string, poolId: number): string {
    if (!Number.isInteger(poolId) || poolId < 1) throw new Error(`Invalid test worker id: ${poolId}`);
    assertTestDatabase(raw);
    const stem = new URL(raw).pathname.replace(/^\//, '').replace(/_test$/, '');
    return `${stem}_w${poolId}_test`;
}

export function templateUrl(raw: string): string {
    return withDatabase(raw, testDatabaseNames(raw).template);
}

export function workerUrl(raw: string, poolId: number): string {
    return withDatabase(raw, workerDatabaseName(raw, poolId));
}
