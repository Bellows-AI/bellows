import { describe, expect, it } from 'vitest';
import {
    BASE_URL_ENV,
    templateUrl,
    testDatabaseNames,
    workerDatabaseName,
    workerUrl,
} from '../test-db/database-names.js';
import { testDbWorkers } from '../test-db/workers.js';

const BASE = 'postgres://factory:factory@127.0.0.1:5432/factory_test';

describe('per-worker test databases', () => {
    it('derives a template and worker names that all end _test, so assertTestDatabase accepts them', () => {
        expect(testDatabaseNames(BASE)).toEqual({ base: 'factory_test', template: 'factory_tpl_test' });
        expect(workerDatabaseName(BASE, 2)).toBe('factory_w2_test');
        expect(new URL(templateUrl(BASE)).pathname).toBe('/factory_tpl_test');
        expect(workerUrl(BASE, 3)).toBe('postgres://factory:factory@127.0.0.1:5432/factory_w3_test');
    });

    it('keeps the credentials, host and query of the base URL', () => {
        const url = workerUrl('postgres://u:p%40ss@db.internal:6543/x_test?sslmode=disable', 1);
        expect(url).toBe('postgres://u:p%40ss@db.internal:6543/x_w1_test?sslmode=disable');
    });

    it('refuses a database that is not a _test one before deriving anything', () => {
        const dev = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
        expect(() => testDatabaseNames(dev)).toThrow(/factory_dev/);
        expect(() => workerDatabaseName(dev, 1)).toThrow(/factory_dev/);
        expect(() => templateUrl(dev)).toThrow(/factory_dev/);
        expect(() => workerUrl(dev, 1)).toThrow(/factory_dev/);
    });

    it('refuses a pool id that is not a positive integer', () => {
        for (const id of [0, -1, 1.5, Number.NaN]) expect(() => workerDatabaseName(BASE, id)).toThrow(/worker id/);
    });

    it('refuses a base that looks like a derived name, so two runs cannot drop each other', () => {
        for (const name of ['factory_tpl_test', 'factory_w2_test']) {
            const url = `postgres://factory:factory@127.0.0.1:5432/${name}`;
            expect(() => testDatabaseNames(url)).toThrow(/derived test database/);
            expect(() => workerDatabaseName(url, 1)).toThrow(/derived test database/);
        }
    });

    it('refuses a base whose derived names would pass the 63-byte identifier limit', () => {
        const at = (stem: number) => `postgres://u:p@h/${'a'.repeat(stem)}_test`;
        expect(testDatabaseNames(at(54)).template).toHaveLength(63);
        const long = at(55);
        expect(() => testDatabaseNames(long)).toThrow(/exceeds 63 bytes/);
        expect(() => workerDatabaseName(at(56), 1)).toThrow(/exceeds 63 bytes/);
    });

    it('names the environment variable that carries the base URL to the workers', () => {
        expect(BASE_URL_ENV).toBe('FACTORY_TEST_DB_BASE_URL');
    });

    it('reads the worker count from TEST_DB_WORKERS and refuses nonsense', () => {
        expect(testDbWorkers({ TEST_DB_WORKERS: '1' })).toBe(1);
        expect(testDbWorkers({ TEST_DB_WORKERS: '6' })).toBe(6);
        expect(testDbWorkers({})).toBeGreaterThanOrEqual(1);
        expect(testDbWorkers({})).toBeLessThanOrEqual(4);
        for (const bad of ['0', '-2', '1.5', 'many']) {
            expect(() => testDbWorkers({ TEST_DB_WORKERS: bad })).toThrow(/TEST_DB_WORKERS/);
        }
    });
});
