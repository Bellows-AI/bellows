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

/** PostgreSQL silently truncates identifiers past this many bytes, so DDL and connections would disagree. */
const MAX_NAME_BYTES = 63;

/** Suffixes the run derives from the base: a base already shaped like one could collide with another run's. */
const DERIVED_SHAPE = /_(tpl|w\d+|iso[0-9a-f]{8})_test$/;

function baseStem(raw: string): string {
    assertTestDatabase(raw);
    const base = new URL(raw).pathname.replace(/^\//, '');
    if (DERIVED_SHAPE.test(base)) {
        throw new Error(
            `"${base}" looks like a derived test database (_tpl_test, _w<N>_test, _iso<hex>_test); name the base differently.`
        );
    }
    return base.replace(/_test$/, '');
}

function derived(raw: string, suffix: string): string {
    const name = `${baseStem(raw)}${suffix}_test`;
    if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
        throw new Error(
            `Derived test database name "${name}" exceeds ${MAX_NAME_BYTES} bytes; shorten the DATABASE_URL database name.`
        );
    }
    return name;
}

/** Refuses a non-`_test` URL before any caller has connected to anything. */
export function testDatabaseNames(raw: string): TestDatabaseNames {
    baseStem(raw);
    return { base: new URL(raw).pathname.replace(/^\//, ''), template: derived(raw, '_tpl') };
}

export function workerDatabaseName(raw: string, poolId: number): string {
    if (!Number.isInteger(poolId) || poolId < 1) throw new Error(`Invalid test worker id: ${poolId}`);
    return derived(raw, `_w${poolId}`);
}

/** A throwaway database a test creates beside the run's own, named so the run's cleanup never touches it. */
export function scratchDatabaseName(raw: string, tag: string): string {
    return derived(raw, `_${tag}`);
}

export function templateUrl(raw: string): string {
    return withDatabase(raw, testDatabaseNames(raw).template);
}

export function workerUrl(raw: string, poolId: number): string {
    return withDatabase(raw, workerDatabaseName(raw, poolId));
}

export function scratchUrl(raw: string, tag: string): string {
    return withDatabase(raw, scratchDatabaseName(raw, tag));
}
