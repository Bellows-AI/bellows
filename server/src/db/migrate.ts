import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { Sql, TransactionSql } from 'postgres';
import { LOCAL_ORG_ID } from '../identifiers.js';
import { liftStatementTimeout } from './pool.js';
import { TelemetryError } from '../telemetry/errors.js';
import { ADMIN_ROLE } from '@factory-ai/core';

/**
 * The .sql files are not compiled by tsc, so the Dockerfile has to copy them explicitly.
 * That failure only appears in the container, never in dev.
 */
const DIR = new URL('../../migrations/', import.meta.url);

export interface MigrateOptions {
    /**
     * Whether to prepare the single LOCAL organization AUTH_MODE=none lives in: the
     * `default` row and the stand-in account.
     *
     * Github mode leaves all of it alone — there the organizations are the App's installations,
     * materialized at sign-in, and booting cannot know any installation id.
     */
    localUser?: boolean;
    /**
     * The container is usually still starting when the app boots, and the dashboard must not
     * die waiting for a database it can serve without.
     */
    attempts?: number;
    backoffMs?: number;
    /** How long one attempt waits for another process's migration lock before it fails. */
    lockWaitMs?: number;
    log?: (message: string) => void;
    /** The migration directory; tests point it at a copy whose bodies they alter. */
    dir?: URL;
}

/** An applied file whose body no longer hashes to the ledger's checksum: not transient, never retried. */
export class MigrationChecksumError extends TelemetryError {
    constructor(versions: string[]) {
        super(`Applied migrations were edited after they ran: ${versions.join(', ')}`, 'MIGRATION');
    }
}

/**
 * The numeric prefixes more than one file carries. The ledger key is the filename, so renaming
 * one of an existing pair would re-apply it: the pairs are frozen and a new prefix must be unique.
 */
export function duplicatePrefixes(names: string[]): string[] {
    const seen = new Map<string, number>();
    for (const name of names) {
        const prefix = name.split('_')[0] as string;
        seen.set(prefix, (seen.get(prefix) ?? 0) + 1);
    }
    return [...seen]
        .filter(([, n]) => n > 1)
        .map(([prefix]) => prefix)
        .sort();
}

const checksum = (body: string) => createHash('sha256').update(body).digest('hex');

/** The database-wide advisory lock every migrating process takes, hashed like the claim locks. */
export const MIGRATION_LOCK_KEY = 'factory:migrate';

/**
 * The login of the stand-in account used when AUTH_MODE=none.
 *
 * Underscores are not legal in a GitHub login, so this can never collide with a real one: the
 * stand-in account cannot be impersonated by somebody registering the name.
 */
export const LOCAL_LOGIN = '__local__';

/** GitHub numbers its accounts from 1, so 0 is permanently free for the stand-in. */
const LOCAL_GITHUB_USER_ID = 0;

/**
 * Plants the LOCAL organization so the stand-in membership has something to reference.
 *
 * The row is created, never updated, and only in localUser mode: github mode's organizations are
 * materialized at sign-in from the App's installations, and none of them can be named at boot.
 */
async function seedOrganization(sql: Sql | TransactionSql, orgId: string): Promise<void> {
    await sql`
        insert into organization (id, name) values (${orgId}, ${orgId})
        on conflict (id) do nothing
    `;
}

/**
 * The account AUTH_MODE=none attributes every request to.
 */
async function ensureLocalUser(sql: Sql | TransactionSql, orgId: string): Promise<void> {
    const [user] = await sql<{ id: string }[]>`
        insert into app_user (github_user_id, github_login, display_name)
        values (${LOCAL_GITHUB_USER_ID}, ${LOCAL_LOGIN}, 'Local')
        on conflict (github_user_id) do update set last_login_at = now()
        returning id
    `;
    if (!user) return;
    // The stand-in is the org's admin: AUTH_MODE=none has no sign-in to materialize a membership,
    // so the local org seeds its own — keyed like every membership since 029, by account.
    await sql`
        insert into org_membership (org_id, github_login, user_id, role, claimed_at)
        values (${orgId}, ${LOCAL_LOGIN}, ${user.id}, ${ADMIN_ROLE}, now())
        on conflict (org_id, user_id) do update set user_id = excluded.user_id
    `;
}

/**
 * Drops sessions nobody can present any more.
 *
 * The cookie carries the same expiry, so this is not what enforces it — the read path checks
 * `expires_at` regardless. It exists so the table does not grow without bound on a deployment whose
 * users never log out.
 */
export async function reapSessions(sql: Sql | TransactionSql): Promise<number> {
    const result = await sql`delete from session where expires_at < now()`;
    return result.count;
}

/**
 * Drops pending sign-ins nobody can complete any more.
 *
 * The pending row is the single-use hop between the OAuth callback and the selection screen; the
 * read path spends an expired row on sight regardless (findPendingSignIn deletes it), so like
 * reapSessions this is table hygiene, not enforcement — the cookie expires with the row.
 */
export async function reapPendingSignIns(sql: Sql | TransactionSql): Promise<number> {
    const result = await sql`delete from pending_sign_in where expires_at < now()`;
    return result.count;
}

/**
 * A `.repeatable.sql` file is re-applied on every boot instead of being recorded — unless the
 * ledger holds a versioned file this build does not ship (the database is ahead of it).
 *
 * Without this a fix to a view would never land: the version is already in
 * schema_migrations, so the file is skipped and the old definition survives until someone
 * deletes the volume. Every repeatable file must therefore be `create or replace` only.
 */
const isRepeatable = (name: string) => name.endsWith('.repeatable.sql');

function files(dir: URL): { version: string; sql: string; repeatable: boolean }[] {
    const all = readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => ({
            version: name,
            sql: readFileSync(new URL(name, dir), 'utf8'),
            repeatable: isRepeatable(name),
        }));

    // Versioned first, repeatable last, regardless of filename order. Repeatable files define
    // views over the finished schema, so a new versioned file that adds a column the views read
    // would otherwise fail purely because it sorts after them.
    return [...all.filter((f) => !f.repeatable), ...all.filter((f) => f.repeatable)];
}

/**
 * One attempt's worth of `migrate()`'s work: one transaction under the migration lock, so two
 * processes booting together serialize, and the second reads `schema_migrations` only after the
 * first committed. A lock wait past `lockWaitMs` fails the attempt; the xact lock cannot outlive
 * the transaction or a dead backend. The pool's statement timeout does not bound it: a migration
 * or a backfill inside one runs as long as its data takes, and `lockWaitMs` bounds the wait.
 */
async function applyMigrations(
    pool: Sql,
    options: MigrateOptions,
    lockWaitMs: number,
    log: (message: string) => void
): Promise<void> {
    await pool.begin(async (tx) => {
        await liftStatementTimeout(tx);
        await tx`select set_config('lock_timeout', ${`${lockWaitMs}ms`}, true)`;
        await tx`select pg_advisory_xact_lock(hashtextextended(${MIGRATION_LOCK_KEY}, 0))`;
        await tx`set local lock_timeout to default`;
        await applyLocked(tx, options, log);
    });
}

/**
 * A row without a checksum predates the column: adopt the shipped body once, since what was applied is
 * unrecoverable. A row with one must still match, or boot is refused (F17). Repeatables never have rows.
 */
async function verifyChecksums(
    sql: TransactionSql,
    ledger: { version: string; checksum: string | null }[],
    all: { version: string; sql: string }[]
): Promise<void> {
    const byVersion = new Map(all.map((f) => [f.version, f]));
    const edited: string[] = [];
    for (const row of ledger) {
        const file = byVersion.get(row.version);
        if (!file) continue;
        if (row.checksum === null) {
            await sql`update schema_migrations set checksum = ${checksum(file.sql)} where version = ${row.version}`;
        } else if (row.checksum !== checksum(file.sql)) {
            edited.push(row.version);
        }
    }
    if (edited.length > 0) throw new MigrationChecksumError(edited.sort());
}

async function applyLocked(
    sql: TransactionSql,
    options: MigrateOptions,
    log: (message: string) => void
): Promise<void> {
    await sql`
        create table if not exists schema_migrations (
            version    text primary key,
            applied_at timestamptz not null default now()
        )
    `;
    // The column is added here, not by a numbered migration: the ledger must exist before any
    // migration can run, and this statement is what makes every later boot comparable.
    await sql`alter table schema_migrations add column if not exists checksum text`;

    // A file that used to be versioned and is now repeatable leaves a row behind. The
    // runner ignores it, so this is hygiene rather than a fix — but leaving it makes
    // "repeatable files are never recorded" true only of new writes, not of the table.
    await sql`delete from schema_migrations where version like '%.repeatable.sql'`;

    const ledger = await sql<{ version: string; checksum: string | null }[]>`
        select version, checksum from schema_migrations
    `;
    const applied = new Set(ledger.map((r) => r.version));

    // A ledger version this build does not ship means a newer build already migrated this
    // database: re-applying this build's repeatables would rewrite its newer views. Repeatable rows
    // cannot count here — the delete above removed them in this same transaction.
    const all = files(options.dir ?? DIR);
    const known = new Set(all.filter((f) => !f.repeatable).map((f) => f.version));
    const ahead = [...applied].filter((version) => !known.has(version)).sort();
    if (ahead.length > 0) {
        log(`database is ahead of this build (unknown versions: ${ahead.join(', ')}); skipping repeatable migrations`);
    }

    await verifyChecksums(sql, ledger, all);

    for (const { version, sql: body, repeatable } of all) {
        if (repeatable ? ahead.length > 0 : applied.has(version)) continue;
        log(`applying ${repeatable ? 'repeatable ' : ''}migration ${version}`);
        // Body and version row commit together with every other file in this attempt, so a crash
        // between them cannot record a body without its row (033 and 039 are not replayable).
        await sql.unsafe(body);
        if (repeatable) continue;
        await sql`insert into schema_migrations (version, checksum) values (${version}, ${checksum(body)})
                  on conflict (version) do nothing`;
    }

    if (options.localUser) {
        // After the files, so the columns and defaults exist. Inside the retry loop, so a
        // database that was not up for the first attempt still gets them on a later one.
        // Ordered — the organization row is the foreign key target for what follows.
        await seedOrganization(sql, LOCAL_ORG_ID);
        await ensureLocalUser(sql, LOCAL_ORG_ID);
    }
    await reapSessions(sql);
    await reapPendingSignIns(sql);
}

/**
 * Applies pending migrations. A second run is a no-op because applied versions are recorded — not
 * because every file could survive being replayed: 033 and 039 end in an unguarded
 * `add constraint`, which is why a body and its version row commit together. Statements are `if not exists` or
 * `create or replace` wherever postgres offers it, which is everywhere but those two.
 */
export async function migrate(sql: Sql, options: MigrateOptions): Promise<void> {
    const { attempts = 10, backoffMs = 1000, lockWaitMs = 60_000, log = () => {} } = options;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            await applyMigrations(sql, options, lockWaitMs, log);
            return;
        } catch (e) {
            if (e instanceof MigrationChecksumError) throw e;
            lastError = e;
            if (attempt === attempts) break;
            log(`migration attempt ${attempt} failed, retrying: ${(e as Error).message}`);
            await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
        }
    }

    throw new TelemetryError(
        `Migrations failed after ${attempts} attempts: ${(lastError as Error)?.message}`,
        'MIGRATION'
    );
}
