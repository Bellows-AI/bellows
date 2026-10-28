import type { Sql } from 'postgres';

/**
 * Deterministic interleaving for concurrency tests: resolves `'blocked'` once `count` other backends wait on a
 * lock, or `'settled'` when `settled()` turns true first (the racer finished without waiting, i.e. nothing
 * serialized it). No sleeps: every turn is a round trip to the database.
 */
export async function waitForLockWaiters(
    sql: Sql,
    count: number,
    settled: () => boolean,
    maxTurns = 5000
): Promise<'blocked' | 'settled'> {
    for (let turn = 0; turn < maxTurns; turn += 1) {
        if (settled()) return 'settled';
        const [row] = await sql<{ n: string }[]>`
            select count(*)::text as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
        `;
        if (Number(row!.n) >= count) return 'blocked';
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`no ${count} lock waiter(s) after ${maxTurns} turns`);
}
