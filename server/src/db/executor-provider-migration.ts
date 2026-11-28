import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import {
    type EnvRow,
    findVar,
    InconclusiveRead,
    type KeySource,
    type LegacyRow,
    PROVIDER_NAME,
    planExecutor,
    samePath,
    type ScopeVars,
    varsFor,
} from './executor-provider-plan.js';
import { startIntervalLoop } from '../interval-loop.js';
import { logger } from '../log.js';
import type { SecretDiagnostic, SecretStore } from '../secrets/secret-store.js';
import { envSecretIdentity, EnvSecretError, readSecretValues } from './env-secrets.js';
import { executorCredentialIdentity, retireCredentials, type StoredCredential } from './executor-credentials.js';
import {
    connectionSecretDeps,
    insertConnectionRow,
    ProviderConnectionCapError,
    scopeLockKey,
} from './provider-connection-store.js';
import { waitAdvisoryXactLock } from './pool.js';
import {
    mintConnectionSecret,
    providerConnectionSecretIdentity,
    readConnectionCredential,
    releaseConnectionSecrets,
} from './provider-connection-secrets.js';

/**
 * Migration 175's data step (docs/persistence.md, docs/workspace.md): an executor with no provider connection gets one
 * of its provider in its scope, holding the key its config or its scope's variables carry, named after the provider;
 * the key leaves the config. An executor whose key or provider cannot be CONFIRMED is suspended with the reason and
 * never guessed or deleted. A failed, timed-out or malformed read is inconclusive: the row stays as it was and the next
 * pass retries it. One transaction per executor, a lock serializing replicas, and a rerun finds nothing legacy.
 */

const LOCK_KEY = 'executor-provider-migration';
const CONSTRAINT = 'executor_profile_provider_required_ck';
export const EXECUTOR_PROVIDER_MIGRATION_INTERVAL_MS = 600_000;

export interface ExecutorProviderMigrationDeps {
    /** The cross-org pool: the step reads every organization's legacy rows. */
    sql: Sql;
    secrets: SecretStore;
    secretLog: (diagnostic: SecretDiagnostic) => void;
    signal?: AbortSignal;
}

export interface ExecutorProviderMigrationResult {
    converted: number;
    suspended: number;
    /** Rows left as they were because a read was not confirmed: the next pass retries them. */
    inconclusive: number;
    /** Whether the constraint is validated (no legacy row remains anywhere). */
    validated: boolean;
    /** Another replica held the lock. */
    busy: boolean;
}

/** The key's value, fail-closed: a stored credential, a variable of the scope or a literal. Throws when not confirmed. */
async function readKey(
    { deps, orgId, row, vars }: { deps: ExecutorProviderMigrationDeps; orgId: string; row: LegacyRow; vars: ScopeVars },
    source: KeySource
): Promise<{ value: string } | { absent: string }> {
    if (source.kind === 'literal') return { value: source.value };
    try {
        if (source.kind === 'stored') {
            const stored = row.secret_refs.find((s) => samePath(s.path, source.path));
            if (!stored) throw new InconclusiveRead(`no stored credential at ${source.path.join('.')}`);
            const [value] = await readSecretValues(deps.secrets, [
                {
                    name: source.path.join('.'),
                    ref: stored.ref,
                    version: stored.version,
                    identity: executorCredentialIdentity(orgId, stored.path),
                },
            ]);
            return { value: value! };
        }
        const hit = findVar(vars, source.name);
        if (!hit) return { absent: source.name };
        if (!hit.row.is_secret) return { value: hit.row.value! };
        if (!hit.row.secret_ref || !hit.row.secret_version) throw new InconclusiveRead('malformed variable row');
        const [value] = await readSecretValues(deps.secrets, [
            {
                name: source.name,
                ref: hit.row.secret_ref,
                version: hit.row.secret_version,
                identity: envSecretIdentity(
                    orgId,
                    hit.layer.kind === 'org' ? { kind: 'org' } : { kind: 'workspace', userId: hit.layer.userId! },
                    source.name
                ),
            },
        ]);
        return { value: value! };
    } catch (error) {
        if (error instanceof EnvSecretError) throw new InconclusiveRead(error.message);
        throw error;
    }
}

type Outcome = 'converted' | 'suspended' | 'stale';

async function suspendRow(sql: Sql | TransactionSql, orgId: string, row: LegacyRow, reason: string): Promise<Outcome> {
    const updated = await sql`
        update executor_profile set suspended = true, provider_migration_reason = ${reason}, updated_at = now()
        where org_id = ${orgId} and id = ${row.id} and user_id is not distinct from ${row.user_id}
            and provider_connection_id is null and provider_migration_reason is null
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

async function convertRow(
    deps: ExecutorProviderMigrationDeps,
    orgId: string,
    row: LegacyRow,
    all: readonly EnvRow[]
): Promise<Outcome> {
    const plan = planExecutor(row, all);
    if (plan.kind === 'suspend') return suspendRow(deps.sql, orgId, row, plan.reason);
    const key = await readKey({ deps, orgId, row, vars: varsFor(all, row.user_id) }, plan.source);
    if ('absent' in key) {
        return suspendRow(
            deps.sql,
            orgId,
            row,
            `the variable ${key.absent} the executor names is not set in its scope`
        );
    }

    const secretDeps = connectionSecretDeps({
        sql: deps.sql,
        orgId,
        secrets: deps.secrets,
        secretLog: deps.secretLog,
    });
    // The scope's own connection already holding this key at this endpoint is the one a shared key resolves to.
    const existing = await deps.sql<
        { id: string; user_id: string | null; name: string; secret_ref: string; secret_version: string }[]
    >`
        select id, user_id, name, secret_ref, secret_version from provider_connection
        where org_id = ${orgId} and user_id is not distinct from ${row.user_id}
            and provider = ${plan.provider} and base_url is not distinct from ${plan.baseUrl}
        order by created_at, id
    `;
    let reuse: string | undefined;
    for (const candidate of existing) {
        const held = await readConnectionCredential(deps.secrets, {
            orgId,
            userId: candidate.user_id,
            connectionId: candidate.id,
            name: candidate.name,
            ref: candidate.secret_ref,
            version: candidate.secret_version,
        }).catch((error: unknown) => {
            throw error instanceof EnvSecretError ? new InconclusiveRead(error.message) : error;
        });
        if (held === key.value) {
            reuse = candidate.id;
            break;
        }
    }

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
            const [current] = await tx<{ config: unknown; secret_refs: StoredCredential[] }[]>`
                select config, secret_refs from executor_profile
                where org_id = ${orgId} and id = ${row.id} and user_id is not distinct from ${row.user_id}
                    and provider_connection_id is null and provider_migration_reason is null
                for update
            `;
            if (!current || JSON.stringify(current.config) !== JSON.stringify(row.config)) return 'stale';
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
                        baseUrl: plan.baseUrl,
                        key: key.value,
                    },
                });
            }
            const secretRefs = current.secret_refs.filter((s) => !plan.consumed.some((p) => samePath(p, s.path)));
            await tx`
                update executor_profile set
                    provider_connection_id = ${connectionId}, config = ${tx.json(plan.config as never)},
                    secret_refs = ${tx.json(secretRefs as never)}, updated_at = now()
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

/** Validates the constraint once nothing legacy remains; true when it is validated. */
async function validateWhenDone(sql: Sql): Promise<boolean> {
    const [counted] = await sql<{ legacy: number }[]>`
        select count(*)::int as legacy from executor_profile where provider_connection_id is null and provider_migration_reason is null
    `;
    const status = () =>
        sql<{ convalidated: boolean }[]>`
            select convalidated from pg_constraint where conname = ${CONSTRAINT} and conrelid = 'executor_profile'::regclass
        `;
    if ((await status())[0]?.convalidated !== false) return true;
    if ((counted?.legacy ?? 1) > 0) return false;
    await sql`select bellows_validate_executor_provider_required()`;
    return (await status())[0]?.convalidated === true;
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
        where org_id = ${orgId} and provider_connection_id is null and provider_migration_reason is null
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

/** Every organization with a legacy executor, then the constraint's validation once none is left. */
async function migrateAll(deps: ExecutorProviderMigrationDeps, result: ExecutorProviderMigrationResult) {
    const orgs = await deps.sql<{ org_id: string }[]>`
        select distinct org_id from executor_profile
        where provider_connection_id is null and provider_migration_reason is null
    `;
    for (const { org_id: orgId } of orgs) {
        if (deps.signal?.aborted) break;
        await migrateOrg(deps, orgId, result);
    }
    result.validated = await validateWhenDone(deps.sql);
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
        validated: false,
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

/** The boot step: a pass now and on an interval, until nothing legacy remains (a pass with none is two cheap reads). */
export function startExecutorProviderMigration(deps: Omit<ExecutorProviderMigrationDeps, 'signal'>) {
    return startIntervalLoop(
        'executor-provider-migration',
        (signal) => migrateExecutorProviders({ ...deps, signal }),
        EXECUTOR_PROVIDER_MIGRATION_INTERVAL_MS
    );
}
