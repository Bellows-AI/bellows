import { randomUUID } from 'node:crypto';
import type { SubscriptionTokenPolicy } from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import { startIntervalLoop } from '../interval-loop.js';
import { logger } from '../log.js';
import type { SecretDiagnostic, SecretStore } from '../secrets/secret-store.js';
import { EnvSecretError } from './env-secrets.js';
import { retireCredentials, type StoredCredential } from './executor-credentials.js';
import {
    type EnvRow,
    InconclusiveRead,
    type LegacyRow,
    PROVIDER_NAME,
    planExecutor,
    samePath,
    varsFor,
} from './executor-provider-plan.js';
import { isInconclusiveFault, resolveConnectionInput } from './executor-provider-resolve.js';
import { waitAdvisoryXactLock } from './pool.js';
import {
    mintConnectionSecret,
    providerConnectionSecretIdentity,
    readConnectionCredential,
    releaseConnectionSecrets,
} from './provider-connection-secrets.js';
import {
    connectionSecretDeps,
    insertConnectionRow,
    ProviderConnectionCapError,
    scopeLockKey,
} from './provider-connection-store.js';

/**
 * Migration 175's data step (docs/persistence.md, docs/workspace.md): an executor the migration marked pending gets a
 * provider connection of its provider in its scope, holding the key its config or its scope's variables carry, named
 * after the provider; the key leaves the config. An executor whose key or provider cannot be CONFIRMED — a bad config,
 * a missing variable, a key or endpoint the routes would refuse — is suspended with the reason and never guessed or
 * deleted. Only a failed or timed-out secret store read is inconclusive: the row stays pending and the next pass
 * retries it. One transaction per executor, a lock serializing replicas, and a rerun finds nothing pending.
 */

const LOCK_KEY = 'executor-provider-migration';
export const EXECUTOR_PROVIDER_MIGRATION_INTERVAL_MS = 600_000;
/** A check violation is a confirmed answer; a foreign key or unique one is a race (a reused connection deleted, a name taken) a retry clears. */
const CHECK_VIOLATION = '23514';

export interface ExecutorProviderMigrationDeps {
    /** The cross-org pool: the step reads every organization's pending rows. */
    sql: Sql;
    secrets: SecretStore;
    secretLog: (diagnostic: SecretDiagnostic) => void;
    /** Whether an org may hold a subscription connection (`AppConfig` satisfies it). */
    subscriptionPolicy: SubscriptionTokenPolicy;
    signal?: AbortSignal;
}

export interface ExecutorProviderMigrationResult {
    converted: number;
    suspended: number;
    /** Rows left pending because a secret store read was not confirmed: the next pass retries them. */
    inconclusive: number;
    /** Rows still pending after the pass; zero ends the loop. */
    remaining: number;
    /** Another replica held the lock. */
    busy: boolean;
}

type Outcome = 'converted' | 'suspended' | 'stale';

async function suspendRow(sql: Sql | TransactionSql, orgId: string, row: LegacyRow, reason: string): Promise<Outcome> {
    const updated = await sql`
        update executor_profile set
            suspended = true, provider_migration_reason = ${reason}, provider_migration_pending = false, updated_at = now()
        where org_id = ${orgId} and id = ${row.id} and user_id is not distinct from ${row.user_id}
            and provider_migration_pending and provider_connection_id is null
        returning id
    `;
    return updated.length === 0 ? 'stale' : 'suspended';
}

/** A free name in the scope: the provider's, then `<name> 2`, `<name> 3`. */
async function freeName(tx: TransactionSql, orgId: string, owner: string | null, base: string): Promise<string> {
    const taken = new Set(
        (
            await tx<{ name: string }[]>`
                select name from provider_connection where org_id = ${orgId} and user_id is not distinct from ${owner}
            `
        ).map((r) => r.name)
    );
    for (let n = 1; ; n += 1) {
        const candidate = n === 1 ? base : `${base} ${n}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/** The scope's own connection already holding this key at this endpoint: the one a shared key resolves to. */
async function findSharedConnection(
    deps: ExecutorProviderMigrationDeps,
    {
        orgId,
        row,
        provider,
        baseUrl,
        key,
    }: { orgId: string; row: LegacyRow; provider: string; baseUrl: string | null; key: string }
): Promise<string | undefined> {
    const existing = await deps.sql<
        { id: string; user_id: string | null; name: string; secret_ref: string; secret_version: string }[]
    >`
        select id, user_id, name, secret_ref, secret_version from provider_connection
        where org_id = ${orgId} and user_id is not distinct from ${row.user_id}
            and provider = ${provider} and base_url is not distinct from ${baseUrl}
        order by created_at, id
    `;
    for (const candidate of existing) {
        const held = await readConnectionCredential(deps.secrets, {
            orgId,
            userId: candidate.user_id,
            connectionId: candidate.id,
            name: candidate.name,
            ref: candidate.secret_ref,
            version: candidate.secret_version,
        }).catch((error: unknown) => {
            // A confirmed fault on another connection's secret says nothing about this key: skip that candidate.
            if (!(error instanceof EnvSecretError)) throw error;
            if (isInconclusiveFault(error)) throw new InconclusiveRead(error.message);
        });
        if (held !== undefined && held === key) return candidate.id;
    }
    return undefined;
}

async function convertRow(
    deps: ExecutorProviderMigrationDeps,
    orgId: string,
    row: LegacyRow,
    all: readonly EnvRow[]
): Promise<Outcome> {
    const plan = planExecutor(row, all);
    if (plan.kind === 'suspend') return suspendRow(deps.sql, orgId, row, plan.reason);
    const resolved = await resolveConnectionInput(
        {
            sql: deps.sql,
            secrets: deps.secrets,
            subscriptionPolicy: deps.subscriptionPolicy,
            orgId,
            row,
            vars: varsFor(all, row.user_id),
        },
        plan
    );
    if ('suspend' in resolved) return suspendRow(deps.sql, orgId, row, resolved.suspend);
    const key = { value: resolved.key };
    const baseUrl = resolved.baseUrl;

    const secretDeps = connectionSecretDeps({
        sql: deps.sql,
        orgId,
        secrets: deps.secrets,
        secretLog: deps.secretLog,
    });
    const reuse = await findSharedConnection(deps, { orgId, row, provider: plan.provider, baseUrl, key: key.value });
    const newId = randomUUID();
    const made =
        reuse === undefined
            ? await mintConnectionSecret(
                  secretDeps,
                  providerConnectionSecretIdentity(orgId, newId, row.user_id),
                  key.value
              )
            : null;
    let outcome: Outcome = 'stale';
    try {
        outcome = await deps.sql.begin(async (tx) => {
            const [current] = await tx<{ type: string; config: unknown; secret_refs: StoredCredential[] }[]>`
                select type, config, secret_refs from executor_profile
                where org_id = ${orgId} and id = ${row.id} and user_id is not distinct from ${row.user_id}
                    and provider_migration_pending and provider_connection_id is null
                for update
            `;
            if (
                !current ||
                current.type !== row.type ||
                JSON.stringify(current.config) !== JSON.stringify(row.config)
            ) {
                return 'stale';
            }
            let connectionId = reuse;
            if (connectionId === undefined) {
                connectionId = newId;
                await waitAdvisoryXactLock(tx, scopeLockKey(orgId, row.user_id));
                await insertConnectionRow(tx, {
                    orgId,
                    id: newId,
                    owner: row.user_id,
                    made: made!,
                    input: {
                        scope: row.user_id === null ? 'org' : 'personal',
                        userId: row.created_by,
                        provider: plan.provider,
                        name: await freeName(tx, orgId, row.user_id, PROVIDER_NAME[plan.provider]),
                        baseUrl,
                        key: key.value,
                    },
                });
            }
            const secretRefs = current.secret_refs.filter((s) => !plan.consumed.some((p) => samePath(p, s.path)));
            await tx`
                update executor_profile set
                    provider_connection_id = ${connectionId}, config = ${tx.json(plan.config as never)},
                    secret_refs = ${tx.json(secretRefs as never)}, provider_migration_pending = false, updated_at = now()
                where org_id = ${orgId} and id = ${row.id}
            `;
            return 'converted';
        });
    } catch (error) {
        if (made) await releaseConnectionSecrets(secretDeps, [made]);
        if (error instanceof ProviderConnectionCapError) {
            return suspendRow(
                deps.sql,
                orgId,
                row,
                'the scope holds the most provider connections allowed; remove one and choose a connection'
            );
        }
        if ((error as { code?: string }).code === CHECK_VIOLATION) {
            return suspendRow(deps.sql, orgId, row, 'the connection could not be stored: a value failed its checks');
        }
        throw error;
    }
    if (outcome !== 'converted') {
        if (made) await releaseConnectionSecrets(secretDeps, [made]);
        return outcome;
    }
    await retireUnreferenced(
        deps,
        orgId,
        row.secret_refs.filter((s) => plan.consumed.some((p) => samePath(p, s.path)))
    );
    return outcome;
}

/** The old stored credentials no executor of the organization names any more, retired after the commit. */
async function retireUnreferenced(deps: ExecutorProviderMigrationDeps, orgId: string, candidates: StoredCredential[]) {
    if (candidates.length === 0) return;
    const named = await deps.sql<{ ref: string }[]>`
        select entry ->> 'ref' as ref from executor_profile, jsonb_array_elements(secret_refs) as entry
        where org_id = ${orgId}
    `;
    const still = new Set(named.map((r) => r.ref));
    await retireCredentials(
        {
            sql: deps.sql,
            orgId,
            secrets: deps.secrets,
            secretLog: deps.secretLog,
            writeDeadlineMs: 30_000,
            cleanupDeadlineMs: 10_000,
        },
        candidates.filter((c) => !still.has(c.ref))
    );
}

/** One organization's legacy executors, one at a time: a row that fails is counted and left as it was. */
async function migrateOrg(
    deps: ExecutorProviderMigrationDeps,
    orgId: string,
    result: ExecutorProviderMigrationResult
): Promise<void> {
    const all = await deps.sql<EnvRow[]>`
        select user_id, name, value, is_secret, secret_ref, secret_version
        from env_var where org_id = ${orgId} and repo_owner is null
    `;
    const rows = await deps.sql<LegacyRow[]>`
        select id, user_id, name, type, config, secret_refs, created_by from executor_profile
        where org_id = ${orgId} and provider_migration_pending
        order by (user_id is not null), position, name, id
    `;
    for (const row of rows) {
        if (deps.signal?.aborted) return;
        try {
            const outcome = await convertRow(deps, orgId, row, all);
            if (outcome === 'converted') result.converted += 1;
            if (outcome === 'suspended') result.suspended += 1;
        } catch (error) {
            result.inconclusive += 1;
            const confirmed = error instanceof InconclusiveRead;
            logger('executor-provider-migration').warn(
                { err: error, executor: row.id },
                confirmed ? 'read not confirmed; executor left as it was' : 'executor left as it was'
            );
        }
    }
}

/** Every organization with a pending executor, then how many remain pending anywhere. */
async function migrateAll(deps: ExecutorProviderMigrationDeps, result: ExecutorProviderMigrationResult) {
    const orgs = await deps.sql<{ org_id: string }[]>`
        select distinct org_id from executor_profile where provider_migration_pending
    `;
    for (const { org_id: orgId } of orgs) {
        if (deps.signal?.aborted) break;
        await migrateOrg(deps, orgId, result);
    }
    const [left] = await deps.sql<{ n: number }[]>`
        select count(*)::int as n from executor_profile where provider_migration_pending
    `;
    result.remaining = left?.n ?? 1;
}

/**
 * One pass over every organization's legacy executors, under a session lock so replicas take turns. A row whose read
 * is not confirmed stays as it was (`inconclusive`); nothing is ever deleted.
 */
export async function migrateExecutorProviders(
    deps: ExecutorProviderMigrationDeps
): Promise<ExecutorProviderMigrationResult> {
    const result: ExecutorProviderMigrationResult = {
        converted: 0,
        suspended: 0,
        inconclusive: 0,
        remaining: 0,
        busy: false,
    };
    const lock = await deps.sql.reserve();
    try {
        const [got] = await lock<{ locked: boolean }[]>`
            select pg_try_advisory_lock(hashtextextended(${LOCK_KEY}, 0)) as locked
        `;
        if (!got?.locked) return { ...result, busy: true };
        try {
            await migrateAll(deps, result);
        } finally {
            await lock`select pg_advisory_unlock(hashtextextended(${LOCK_KEY}, 0))`;
        }
    } finally {
        lock.release();
    }
    return result;
}

/**
 * The boot step: a pass now and on an interval, until none is pending (a busy pass or an unconfirmed read is retried).
 * `pass` and `intervalMs` are the tests' seams.
 */
export function startExecutorProviderMigration(
    deps: Omit<ExecutorProviderMigrationDeps, 'signal'>,
    { pass = migrateExecutorProviders, intervalMs = EXECUTOR_PROVIDER_MIGRATION_INTERVAL_MS } = {}
) {
    let stop: (() => Promise<void>) | undefined;
    stop = startIntervalLoop(
        'executor-provider-migration',
        async (signal) => {
            const result = await pass({ ...deps, signal });
            if (!result.busy && result.remaining === 0) void stop?.();
        },
        intervalMs
    );
    return () => stop!();
}
