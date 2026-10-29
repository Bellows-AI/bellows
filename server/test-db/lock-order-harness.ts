import postgres from 'postgres';
import type { Sql } from 'postgres';
import { expect } from 'vitest';

/**
 * Shared by the lock-order suites (connection-lock-order, job-store.thread-lock-order): drive the REAL store to a
 * pause, queue a second transaction behind it, and require both to finish. A lock-order inversion is a 40P01
 * there, never a timing accident. Every wait is bounded by an absolute deadline, never a poll count.
 */
export const DEADLINE_MS = 10_000;

/** A pool whose backends carry `name`, so `waitForLockWait` can tell whose transaction is blocked. */
export const pool = (name: string) =>
    postgres(process.env.DATABASE_URL!, { max: 3, connection: { application_name: name } });

/** A plan reader that parks the first claim until `release()`; `entered` resolves once it is parked. */
export function parkedReader() {
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    return {
        entered,
        release,
        readFor: async () => {
            enter();
            await gate;
            return { config: null, services: [], revision: null, error: null };
        },
    };
}

/** Resolves once a backend of `application` waits on a lock; one absolute deadline, no polling count. */
export async function waitForLockWait(sql: Sql, application: string, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
        const [row] = await sql<{ n: string }[]>`
            select count(*)::text as n from pg_stat_activity
            where datname = current_database() and application_name = ${application} and wait_event_type = 'Lock'
        `;
        if (Number(row!.n) > 0) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`no ${application} backend waited on a lock before the deadline`);
}

/** A transaction held open on `statement` until `release()`. */
export async function holder(sql: Sql, statement: (tx: Sql) => Promise<unknown>) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let taken!: () => void;
    const takenP = new Promise<void>((resolve) => {
        taken = resolve;
    });
    const done = sql.begin(async (tx) => {
        await statement(tx as unknown as Sql);
        taken();
        await held;
    });
    await takenP;
    return { release, done };
}

export const settledWithin = async <T extends unknown[]>(
    work: readonly [...{ [K in keyof T]: Promise<T[K]> }]
): Promise<{ [K in keyof T]: PromiseSettledResult<T[K]> }> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the transactions did not settle before the deadline')), DEADLINE_MS);
    });
    try {
        const results = await Promise.race([Promise.allSettled(work), timeout]);
        const deadlocks = results.filter(
            (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === '40P01'
        );
        expect(deadlocks).toEqual([]);
        return results as { [K in keyof T]: PromiseSettledResult<T[K]> };
    } finally {
        clearTimeout(timer);
    }
};

export const value = <T>(result: PromiseSettledResult<T>): T => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
};
