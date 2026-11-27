import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';

/**
 * A named lease on the cross-org pool (`171_connection_revocation.sql`): at most one replica runs a pass of that name
 * at a time. A holder that dies leaves the row until `expires_at`, so the next pass waits one lease, never forever.
 * `server/test-db/background-lease.test.ts`.
 */

/** Takes `name` for `ttlMs` when it is free or its lease has run out; the holder id on success, null when held. */
export async function acquireLease(sql: Sql, name: string, ttlMs: number): Promise<string | null> {
    const holder = randomUUID();
    const rows = await sql<{ holder: string }[]>`
        insert into background_lease (name, holder, expires_at)
        values (${name}, ${holder}, now() + ${ttlMs} * interval '1 millisecond')
        on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at
            where background_lease.expires_at < now()
        returning holder
    `;
    return rows[0] ? holder : null;
}

/** Gives `name` up early; a no-op once another holder took it. */
export async function releaseLease(sql: Sql, name: string, holder: string): Promise<void> {
    await sql`delete from background_lease where name = ${name} and holder = ${holder}`;
}

/**
 * Runs `pass` only while holding the lease `name`; `undefined` when another replica holds it. `ttlMs` must outlast
 * the pass: a pass that overruns it may overlap the next replica's, which every pass is written to tolerate.
 */
export async function withLease<T>(
    sql: Sql,
    name: string,
    ttlMs: number,
    pass: () => Promise<T>
): Promise<T | undefined> {
    const holder = await acquireLease(sql, name, ttlMs);
    if (holder === null) return undefined;
    try {
        return await pass();
    } finally {
        await releaseLease(sql, name, holder).catch(() => undefined);
    }
}
