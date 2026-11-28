import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import {
    CLAUDE_CODE,
    CLAUDE_CODE_OAUTH_TOKEN,
    ENV_SUBSTITUTION,
    type ExecutorType,
    isCredentialKey,
    modelFitsProvider,
    type ModelProvider,
    normalizeModelId,
    OPENAI_COMPATIBLE_NPM,
    OPENCODE,
    PROVIDER_BASE_URL_ENV,
    PROVIDER_ENV,
    providerSupportsAgent,
    STORED_CREDENTIAL_PREFIX,
} from '@factory-ai/core';
import { startIntervalLoop } from '../interval-loop.js';
import { logger } from '../log.js';
import type { SecretDiagnostic, SecretStore } from '../secrets/secret-store.js';
import { envSecretIdentity, EnvSecretError, readSecretValues } from './env-secrets.js';
import {
    credentialsIn,
    executorCredentialIdentity,
    retireCredentials,
    type StoredCredential,
} from './executor-credentials.js';
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
const PG_UNIQUE_VIOLATION = '23505';

/** What a connection made here is named, before the dedup suffix. */
const PROVIDER_NAME: Readonly<Record<ModelProvider, string>> = {
    anthropic: 'Anthropic',
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    litellm: 'LiteLLM',
    'openai-compatible': 'Custom endpoint',
    subscription: 'Claude subscription',
};

/** The key each provider's variable name stands for in a Claude Code `env`; LiteLLM is Anthropic's name with a host. */
const PROVIDER_OF_ENV_NAME: Readonly<Record<string, ModelProvider>> = {
    ANTHROPIC_API_KEY: 'anthropic',
    OPENROUTER_API_KEY: 'openrouter',
    OPENAI_API_KEY: 'openai',
    [CLAUDE_CODE_OAUTH_TOKEN]: 'subscription',
};

/** The OpenCode block ids whose provider is the id itself. */
const PROVIDER_OF_BLOCK_ID: Readonly<Record<string, ModelProvider>> = {
    anthropic: 'anthropic',
    openrouter: 'openrouter',
    openai: 'openai',
};

/** The providers a scope's variable names can point to; LiteLLM and the custom endpoint carry a host a name cannot. */
const SCOPE_PROVIDERS: readonly ModelProvider[] = ['anthropic', 'openrouter', 'openai', 'subscription'];

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

interface LegacyRow {
    id: string;
    user_id: string | null;
    name: string;
    type: ExecutorType;
    config: unknown;
    secret_refs: StoredCredential[];
    created_by: string | null;
}

interface EnvRow {
    user_id: string | null;
    name: string;
    value: string | null;
    is_secret: boolean;
    secret_ref: string | null;
    secret_version: string | null;
}

/** An answer that is not a confirmed value: the caller leaves the row alone. */
class InconclusiveRead extends Error {}

/** Where a key comes from: a stored credential at a path, an environment variable, or a literal in the config. */
type KeySource =
    | { kind: 'stored'; path: string[] }
    | { kind: 'variable'; name: string }
    | { kind: 'literal'; value: string };

type Plan =
    | { kind: 'suspend'; reason: string }
    | {
          kind: 'convert';
          provider: ModelProvider;
          baseUrl: string | null;
          source: KeySource;
          /** The config the executor keeps. */
          config: Record<string, unknown>;
          /** The config paths whose stored credential the step consumed. */
          consumed: string[][];
      };

const suspend = (reason: string): Plan => ({ kind: 'suspend', reason });
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';
const samePath = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);

/** The source of a key value found in a config at `path`. */
function sourceOf(value: string, path: string[]): KeySource {
    const reference = ENV_SUBSTITUTION.exec(value);
    if (reference) return { kind: 'variable', name: reference[1]! };
    if (value.startsWith(STORED_CREDENTIAL_PREFIX)) return { kind: 'stored', path };
    return { kind: 'literal', value };
}

/** One key the config wires: its provider, where it comes from and the config paths that carry it. */
interface Wiring {
    provider: ModelProvider;
    source: KeySource;
    baseUrl: string | null;
    /** The key's own path, then the endpoint's when the config carries one. */
    paths: string[][];
}

type Wirings = { wirings: Wiring[] } | { refusal: string };

/** A Claude Code `env`: every credential-shaped entry is a key the step must understand. */
function claudeWirings(env: Record<string, unknown>): Wirings {
    const wirings: Wiring[] = [];
    for (const [name, value] of Object.entries(env)) {
        if (!isCredentialKey(name) || !nonEmpty(value)) continue;
        const provider = PROVIDER_OF_ENV_NAME[name];
        if (!provider) return { refusal: `the config holds a key ${name} that no provider connection can take` };
        const host = env.ANTHROPIC_BASE_URL;
        const proxied = provider === 'anthropic' && nonEmpty(host);
        wirings.push({
            provider: proxied ? 'litellm' : provider,
            source: sourceOf(value, ['env', name]),
            baseUrl: proxied ? host : null,
            paths: proxied
                ? [
                      ['env', name],
                      ['env', 'ANTHROPIC_BASE_URL'],
                  ]
                : [['env', name]],
        });
    }
    return { wirings };
}

/** An OpenCode `provider` map: each block with an `options.apiKey` is a key. */
function openCodeWirings(providers: Record<string, unknown>): Wirings {
    const wirings: Wiring[] = [];
    for (const [id, block] of Object.entries(providers)) {
        const options = isRecord(block) ? block.options : undefined;
        if (!isRecord(block) || !isRecord(options) || !nonEmpty(options.apiKey)) continue;
        const keyPath = ['provider', id, 'options', 'apiKey'];
        const hostPath = ['provider', id, 'options', 'baseURL'];
        const host = nonEmpty(options.baseURL) ? options.baseURL : null;
        let provider: ModelProvider | undefined;
        if (block.npm === OPENAI_COMPATIBLE_NPM) {
            if (host === null) return { refusal: `the endpoint block ${id} names no baseURL` };
            provider = 'openai-compatible';
        } else {
            provider = PROVIDER_OF_BLOCK_ID[id];
        }
        if (!provider) return { refusal: `the provider block ${id} names no provider a connection can take` };
        wirings.push({
            provider,
            source: sourceOf(options.apiKey, keyPath),
            baseUrl: host,
            paths: host === null ? [keyPath] : [keyPath, hostPath],
        });
    }
    return { wirings };
}

/** `config` without the values at `paths`, and without the objects that leave empty; a custom endpoint block goes whole. */
function without(config: Record<string, unknown>, paths: readonly string[][], blockIds: readonly string[]) {
    const out = structuredClone(config);
    for (const id of blockIds) delete (out.provider as Record<string, unknown>)[id];
    for (const path of paths) {
        const trail: Record<string, unknown>[] = [out];
        for (const key of path.slice(0, -1)) {
            const next = trail[trail.length - 1]![key];
            if (!isRecord(next)) break;
            trail.push(next);
        }
        delete trail[trail.length - 1]![path[path.length - 1]!];
        for (let depth = trail.length - 1; depth > 0 && Object.keys(trail[depth]!).length === 0; depth -= 1) {
            delete trail[depth - 1]![path[depth - 1]!];
        }
    }
    if (isRecord(out.provider) && Object.keys(out.provider).length === 0) delete out.provider;
    return out;
}

/** The variables of one scope the step reads: the names present, in the order the claim stacks them. */
interface ScopeVars {
    /** Stacked scopes, nearest first: a personal executor's own variables, then the organization's. */
    layers: { kind: 'workspace' | 'org'; userId: string | null; rows: Map<string, EnvRow> }[];
}

const varsFor = (all: readonly EnvRow[], owner: string | null): ScopeVars => {
    const layer = (kind: 'workspace' | 'org', userId: string | null) => ({
        kind,
        userId,
        rows: new Map(
            all
                .filter((row) => row.user_id === userId && (row.is_secret || nonEmpty(row.value)))
                .map((row) => [row.name, row])
        ),
    });
    return { layers: owner === null ? [layer('org', null)] : [layer('workspace', owner), layer('org', null)] };
};

const findVar = (vars: ScopeVars, name: string) => {
    for (const layer of vars.layers) {
        const row = layer.rows.get(name);
        if (row) return { layer, row };
    }
    return undefined;
};

const scopeName = (owner: string | null) => (owner === null ? 'the organization' : 'the member');

/** The provider a model id's prefix names for OpenCode, when it names one. */
const providerOfModel = (type: ExecutorType, model: unknown): ModelProvider | undefined => {
    if (type !== OPENCODE || !nonEmpty(model) || !model.includes('/')) return undefined;
    return PROVIDER_OF_BLOCK_ID[model.slice(0, model.indexOf('/'))];
};

/**
 * What the executor becomes, judged from its config alone and its scope's variable NAMES (no secret is read here):
 * the config's own wiring first, then the model's provider prefix, then the scope's provider names. Several
 * candidates or none is a confirmed ambiguity, suspended with its reason, never `inferProvider`'s fixed priority.
 */
export function planExecutor(row: LegacyRow, all: readonly EnvRow[]): Plan {
    if (!isRecord(row.config)) throw new InconclusiveRead('config is not an object');
    const config = row.config;
    const model = config.model;
    const vars = varsFor(all, row.user_id);

    const found =
        row.type === CLAUDE_CODE
            ? isRecord(config.env)
                ? claudeWirings(config.env)
                : { wirings: [] }
            : isRecord(config.provider)
              ? openCodeWirings(config.provider)
              : { wirings: [] };
    if ('refusal' in found) return suspend(found.refusal);
    const stray = credentialsIn(config).filter(
        ({ path }) => !found.wirings.some((w) => w.paths.some((p) => samePath(p, path)))
    );
    if (stray.length > 0)
        return suspend(`the config holds a key at ${stray[0]!.path.join('.')} that no provider takes`);
    if (found.wirings.length > 1) return suspend('the config wires several provider keys; choose one connection');

    const checked = (provider: ModelProvider) =>
        !providerSupportsAgent(provider, row.type)
            ? `${PROVIDER_NAME[provider]} cannot run a ${row.type} executor`
            : !modelFitsProvider(provider, row.type, nonEmpty(model) ? model : '')
              ? `the model ${String(model)} does not belong to ${PROVIDER_NAME[provider]}`
              : null;

    const [wiring] = found.wirings;
    let provider: ModelProvider;
    let baseUrl: string | null;
    let source: KeySource;
    let consumed: string[][] = [];
    let kept = config;
    if (wiring) {
        ({ provider, baseUrl, source } = wiring);
        const blocks =
            provider === 'openai-compatible' && wiring.paths[0]![0] === 'provider' ? [wiring.paths[0]![1]!] : [];
        kept = without(config, wiring.paths, blocks);
        consumed = source.kind === 'stored' ? [source.path] : [];
        if (blocks.length > 0 && nonEmpty(model)) {
            const rest = model.startsWith(`${blocks[0]}/`) ? model.slice(blocks[0]!.length + 1) : model;
            kept.model = normalizeModelId(provider, row.type, rest);
        }
    } else {
        const named = providerOfModel(row.type, model);
        const candidates = named
            ? [named]
            : SCOPE_PROVIDERS.filter((p) => findVar(vars, PROVIDER_ENV[p]) && !checked(p));
        if (candidates.length === 0) {
            return suspend(
                `${scopeName(row.user_id)} scope holds no provider key (${SCOPE_PROVIDERS.map((p) => PROVIDER_ENV[p]).join(', ')}) this executor can use`
            );
        }
        if (candidates.length > 1) {
            return suspend(
                `the scope holds keys for several providers (${candidates.map((p) => PROVIDER_ENV[p]).join(', ')}); choose a connection`
            );
        }
        const only = candidates[0]!;
        const hostName = PROVIDER_BASE_URL_ENV[only];
        const host = hostName === null ? undefined : findVar(vars, hostName)?.row.value;
        baseUrl = nonEmpty(host) ? host : null;
        provider = only === 'anthropic' && baseUrl !== null ? 'litellm' : only;
        source = { kind: 'variable', name: PROVIDER_ENV[only] };
    }

    const refusal = checked(provider);
    if (refusal) return suspend(refusal);
    return { kind: 'convert', provider, baseUrl, source, config: kept, consumed };
}

/** The key's value, fail-closed: a stored credential, a variable of the scope or a literal. Throws when not confirmed. */
async function readKey(
    deps: ExecutorProviderMigrationDeps,
    orgId: string,
    row: LegacyRow,
    source: KeySource,
    vars: ScopeVars
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
    const key = await readKey(deps, orgId, row, plan.source, varsFor(all, row.user_id));
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
            const orgs = await deps.sql<{ org_id: string }[]>`
                select distinct org_id from executor_profile where provider_connection_id is null and provider_migration_reason is null
            `;
            for (const { org_id: orgId } of orgs) {
                if (deps.signal?.aborted) break;
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
                    if (deps.signal?.aborted) break;
                    try {
                        const outcome = await convertRow(deps, orgId, row, all);
                        if (outcome === 'converted') result.converted += 1;
                        if (outcome === 'suspended') result.suspended += 1;
                    } catch (error) {
                        result.inconclusive += 1;
                        logger('executor-provider-migration').warn(
                            { err: error, executor: row.id },
                            error instanceof InconclusiveRead
                                ? 'read not confirmed; executor left as it was'
                                : 'executor left as it was'
                        );
                    }
                }
            }
            result.validated = await validateWhenDone(deps.sql);
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
