import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { MIGRATION_LOCK_KEY, migrate } from '../src/db/migrate.js';
import { LOCAL_ORG_ID } from '../src/identifiers.js';
import { assertTestDatabase } from './harness.js';

// Two API processes booting at once. Each test migrates its own fresh schema (search_path), so
// the shared `public` schema the other suites use is never touched, and the lock it contends for
// is the same database-wide key every boot takes. The schemas are dropped afterwards: left behind,
// their views and constraints answer the other suites' catalog queries.
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSIONED = readdirSync(new URL('../migrations/', import.meta.url)).filter(
    (name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql')
).length;

let admin: Sql;
const pools: Sql[] = [];
const schemas: string[] = [];

/** A pool that acts as one process, migrating `schema`, tagged so pg_stat_activity can find it. */
function processPool(schema: string, tag: string): Sql {
    const pool = postgres(url as string, {
        max: 2,
        onnotice: () => {},
        connection: { search_path: schema, application_name: tag },
    });
    pools.push(pool);
    return pool;
}

async function freshSchema(): Promise<string> {
    const schema = `mig_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema ${schema}`);
    schemas.push(schema);
    return schema;
}

async function holdLock(): Promise<{ pool: Sql; pid: number; release: () => Promise<void> }> {
    const pool = postgres(url as string, { max: 1, onnotice: () => {} });
    pools.push(pool);
    const reserved = await pool.reserve();
    const [row] = await reserved<{ pid: number }[]>`
        select pg_backend_pid() as pid, pg_advisory_lock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))
    `;
    const pid = (row as { pid: number }).pid;
    return {
        pool,
        pid,
        release: async () => {
            await reserved`select pg_advisory_unlock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`;
            reserved.release();
        },
    };
}

/** Resolves once a backend tagged `tag` is blocked on an advisory lock; throws past the deadline. */
async function waiterVisible(tag: string, withinMs = 10_000): Promise<void> {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
        const rows = await admin`
            select 1 from pg_stat_activity
            where application_name = ${tag} and wait_event_type = 'Lock' and wait_event = 'advisory'
        `;
        if (rows.length) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no backend tagged ${tag} waited on the migration lock within ${withinMs}ms`);
}

const migrationsTable = async (schema: string) => {
    const [row] = await admin<{ t: string | null }[]>`select to_regclass(${`${schema}.schema_migrations`})::text as t`;
    return row?.t ?? null;
};

const versions = async (schema: string) => {
    const [row] = await admin.unsafe<{ n: number }[]>(`select count(*)::int as n from ${schema}.schema_migrations`);
    return row?.n;
};

beforeAll(() => {
    if (enabled) admin = postgres(url as string, { max: 2, onnotice: () => {} });
});

afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end({ timeout: 5 })));
    for (const schema of schemas) await admin.unsafe(`drop schema ${schema} cascade`);
    await admin?.end({ timeout: 5 });
});

describe.skipIf(!enabled)('migrations across processes', () => {
    it('waits while another process holds the migration lock, then applies every version', async () => {
        const schema = await freshSchema();
        const tag = `mig-wait-${randomUUID()}`;
        const holder = await holdLock();

        const run = migrate(processPool(schema, tag), { attempts: 1 });
        await waiterVisible(tag);
        expect(await migrationsTable(schema)).toBeNull();

        await holder.release();
        await run;
        expect(await versions(schema)).toBe(VERSIONED);
    });

    it('two processes starting together each apply every version exactly once', async () => {
        const schema = await freshSchema();
        await Promise.all([
            migrate(processPool(schema, `mig-a-${randomUUID()}`), { attempts: 1 }),
            migrate(processPool(schema, `mig-b-${randomUUID()}`), { attempts: 1 }),
        ]);
        const rows = await admin.unsafe(
            `select version from ${schema}.schema_migrations group by version having count(*) > 1`
        );
        expect(rows).toEqual([]);
        expect(await versions(schema)).toBe(VERSIONED);
    });

    it('fails the attempt when the lock is not released in time, and applies nothing', async () => {
        const schema = await freshSchema();
        const holder = await holdLock();

        await expect(
            migrate(processPool(schema, `mig-timeout-${randomUUID()}`), { attempts: 1, lockWaitMs: 200 })
        ).rejects.toMatchObject({ code: 'MIGRATION', message: expect.stringMatching(/lock timeout/) });
        expect(await migrationsTable(schema)).toBeNull();

        await holder.release();
        await migrate(processPool(schema, `mig-after-${randomUUID()}`), { attempts: 1 });
        expect(await migrationsTable(schema)).not.toBeNull();
    });

    it('keeps the configured lock_timeout for migration statements once the migration lock is held', async () => {
        const schema = await freshSchema();
        await admin.unsafe(
            `create table ${schema}.schema_migrations (version text primary key, applied_at timestamptz not null default now())`
        );
        const blocker = await admin.reserve();
        await blocker.unsafe(`begin; lock table ${schema}.schema_migrations in access exclusive mode`);
        const pool = postgres(url as string, {
            max: 2,
            onnotice: () => {},
            connection: { search_path: schema, lock_timeout: 500 },
        });
        pools.push(pool);

        try {
            await expect(
                Promise.race([
                    migrate(pool, { attempts: 1 }),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('migration body waited forever')), 5000)
                    ),
                ])
            ).rejects.toMatchObject({ code: 'MIGRATION', message: expect.stringMatching(/lock timeout/) });
        } finally {
            await blocker.unsafe('rollback');
            blocker.release();
        }
    });

    it('a holder that dies releases the lock to the waiting process', async () => {
        const schema = await freshSchema();
        const tag = `mig-loss-${randomUUID()}`;
        const holder = await holdLock();

        const run = migrate(processPool(schema, tag), { attempts: 1 });
        await waiterVisible(tag);
        await admin`select pg_terminate_backend(${holder.pid})`;

        await run;
        expect(await migrationsTable(schema)).not.toBeNull();
    });
});

const viewExists = async (schema: string, view: string) => {
    const rows = await admin`select 1 from pg_views where schemaname = ${schema} and viewname = ${view}`;
    return rows.length > 0;
};

// An older build booting against a newer schema (a crash restart mid-rollout, or a rollback) must
// not rewrite the newer views: it knows only its own repeatable files.
describe.skipIf(!enabled)('a database ahead of this build', () => {
    it('skips the repeatable views when the ledger holds a version this build does not ship', async () => {
        const schema = await freshSchema();
        const pool = processPool(schema, `mig-ahead-${randomUUID()}`);
        await migrate(pool, { attempts: 1 });
        await admin.unsafe(`insert into ${schema}.schema_migrations (version) values ('999_from_a_newer_build.sql')`);
        await admin.unsafe(`drop view ${schema}.session_summary`);

        const logged: string[] = [];
        await migrate(pool, { attempts: 1, localUser: true, log: (line) => logged.push(line) });

        expect(await viewExists(schema, 'session_summary')).toBe(false);
        expect(logged.some((line) => line.includes('999_from_a_newer_build.sql'))).toBe(true);
        expect(logged.some((line) => line.includes('applying repeatable'))).toBe(false);
        // Seeding still ran on the skipping path.
        const org = await admin.unsafe(`select 1 from ${schema}.organization where id = $1`, [LOCAL_ORG_ID]);
        expect(org.length).toBe(1);
        expect(await versions(schema)).toBe(VERSIONED + 1);
    });

    it('a normal re-run still re-applies the repeatable views', async () => {
        const schema = await freshSchema();
        const pool = processPool(schema, `mig-rerun-${randomUUID()}`);
        await migrate(pool, { attempts: 1 });
        await admin.unsafe(`drop view ${schema}.session_summary`);

        await migrate(pool, { attempts: 1 });

        expect(await viewExists(schema, 'session_summary')).toBe(true);
    });

    it('a leftover repeatable ledger row does not count as ahead', async () => {
        const schema = await freshSchema();
        const pool = processPool(schema, `mig-leftover-${randomUUID()}`);
        await migrate(pool, { attempts: 1 });
        await admin.unsafe(`insert into ${schema}.schema_migrations (version) values ('999_x.repeatable.sql')`);
        await admin.unsafe(`drop view ${schema}.session_summary`);

        await migrate(pool, { attempts: 1 });

        expect(await viewExists(schema, 'session_summary')).toBe(true);
        expect(await versions(schema)).toBe(VERSIONED);
    });
});
