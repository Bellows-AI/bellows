import { describe, expect, it } from 'vitest';
import {
    type ExecutorProviderMigrationResult,
    startExecutorProviderMigration,
} from '../src/db/executor-provider-migration.js';

/**
 * The boot step's loop (docs/persistence.md): it keeps passing while a replica holds the lock or a row is still pending
 * (an unconfirmed read), and stops for good once none is pending.
 */
const INTERVAL_MS = 5;
const SETTLE_MS = 60;

const result = (over: Partial<ExecutorProviderMigrationResult>): ExecutorProviderMigrationResult => ({
    converted: 0,
    suspended: 0,
    inconclusive: 0,
    remaining: 0,
    busy: false,
    ...over,
});

const deps = { sql: {} as never, secrets: {} as never, secretLog: () => {}, subscriptionPolicy: {} as never };
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

describe('startExecutorProviderMigration', () => {
    it('keeps passing while busy or pending, and stops once nothing is pending', async () => {
        const answers = [result({ busy: true }), result({ inconclusive: 1, remaining: 1 }), result({ converted: 1 })];
        let passes = 0;
        const stop = startExecutorProviderMigration(deps, {
            intervalMs: INTERVAL_MS,
            pass: async () => answers[Math.min(passes++, answers.length - 1)]!,
        });
        await settle();
        expect(passes).toBe(answers.length);
        await stop();
    });

    it('never stops while a row stays pending', async () => {
        let passes = 0;
        const stop = startExecutorProviderMigration(deps, {
            intervalMs: INTERVAL_MS,
            pass: async () => {
                passes += 1;
                return result({ inconclusive: 1, remaining: 1 });
            },
        });
        await settle();
        expect(passes).toBeGreaterThan(3);
        await stop();
    });
});
