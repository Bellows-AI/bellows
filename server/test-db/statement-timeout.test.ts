import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardPool, waitAdvisoryXactLock } from '../src/db/pool.js';
import { migrate, MIGRATION_LOCK_KEY } from '../src/db/migrate.js';
import { useTestDb } from './harness.js';

const db = useTestDb();
const TIMEOUT_MS = 200;
/** Past the pool's statement timeout, well under every test's own timeout. */
const HOLD_SECONDS = 0.6;
const QUERY_CANCELED = '57014';

/** Holds `key`'s transaction-scoped advisory lock on the suite's own pool for HOLD_SECONDS; resolves once taken. */
async function holdLock(key: string): Promise<{ released: Promise<unknown> }> {
    let taken!: () => void;
    const held = new Promise<void>((resolve) => (taken = resolve));
    const released = db.sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        taken();
        await tx`select pg_sleep(${HOLD_SECONDS})`;
    });
    await held;
    return { released };
}

describe.skipIf(!db.url)('the board pool statement timeout', () => {
    let timed: postgres.Sql;

    beforeAll(() => {
        timed = boardPool(db.url!, { max: 2, statementTimeoutMs: TIMEOUT_MS });
    });
    afterAll(async () => {
        await timed.end({ timeout: 5 });
    });

    it('cancels a statement that runs past it', async () => {
        await expect(timed`select pg_sleep(${HOLD_SECONDS})`).rejects.toMatchObject({ code: QUERY_CANCELED });
    });

    it('does not apply to migrations, which wait out a held migration lock', async () => {
        const { released } = await holdLock(MIGRATION_LOCK_KEY);
        await expect(migrate(timed, { attempts: 1 })).resolves.toBeUndefined();
        await released;
    });

    it('does not apply to an advisory-lock wait, and the caller keeps its own budget after it', async () => {
        const { released } = await holdLock('statement-timeout:probe');
        const after = await timed.begin(async (tx) => {
            await tx`select set_config('statement_timeout', '150ms', true)`;
            await waitAdvisoryXactLock(tx, 'statement-timeout:probe');
            const [row] = await tx<{ setting: string }[]>`select current_setting('statement_timeout') as setting`;
            return row?.setting;
        });
        expect(after).toBe('150ms');
        await released;
    });
});
