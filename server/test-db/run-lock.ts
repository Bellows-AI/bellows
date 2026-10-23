import postgres from 'postgres';
import type { Sql } from 'postgres';

/**
 * A second `test:db` process on one base database truncates the first one's rows mid-test and
 * fails it with foreign-key errors and deadlocks that read as product regressions. The run holds
 * a session-level advisory lock on the base database for its whole life, so a second run refuses
 * up front, and a killed run frees the lock with its connection.
 */
export interface RunLock {
    release(): Promise<void>;
}

/** The one connection that holds the lock; `max: 1` keeps the lock on a session nothing else reuses. */
export async function acquireRunLock(baseUrl: string, name: string): Promise<RunLock> {
    const sql: Sql = postgres(baseUrl, { max: 1, onnotice: () => {} });
    try {
        const [row] = await sql<{ locked: boolean }[]>`
            select pg_try_advisory_lock(hashtextextended(${`factory-test-db:${name}`}, 0)) as locked
        `;
        if (!row?.locked) throw new Error(`test database ${name} is in use by another run`);
    } catch (error) {
        await sql.end({ timeout: 5 }).catch(() => {});
        throw error;
    }
    return { release: () => sql.end({ timeout: 5 }) };
}
