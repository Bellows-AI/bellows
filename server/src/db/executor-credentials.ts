import { isCredentialKey, STORED_CREDENTIAL_PREFIX } from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import type {
    SecretDiagnostic,
    SecretIdentity,
    SecretRef,
    SecretStore,
    SecretVersion,
} from '../secrets/secret-store.js';
import {
    type CreatedEnvSecret,
    createEnvSecrets,
    EnvSecretError,
    readSecretValues,
    releaseEnvSecrets,
    type RetiredEnvSecret,
    retireEnvSecrets,
} from './env-secrets.js';

/**
 * Provider keys in executor settings live in the secret store (docs/workspace.md, docs/secrets.md). A
 * credential-shaped value (`isCredentialKey`) in a profile's `config` is replaced by
 * `stored-credential:<ref>`, and `executor_profile.secret_refs` records each reference's version and
 * the path it stands at. A save that sends the marker back keeps the value; the claim resolves every
 * marker before the config travels. The write, compensation and read machinery is env-secrets.ts's.
 */

/** One stored credential of a profile: where it stands in `config` and the value's reference. */
export interface StoredCredential {
    path: string[];
    ref: string;
    version: string;
}

/**
 * Owned by the organization and bound to the path, so a profile keeps its credentials across a rename,
 * a whole-list rewrite and a scope change, while a reference moved to another path or organization
 * reads as `identity-mismatch`. Rebuilt on every call, never stored.
 */
export function executorCredentialIdentity(orgId: string, path: readonly string[]): SecretIdentity {
    return {
        owner: { kind: 'organization', orgId },
        scope: { type: 'executor-profile', id: orgId },
        purpose: 'executor-credential',
        owningRecord: { type: 'executor-config', id: JSON.stringify(path) },
    };
}

const pathKey = (path: readonly string[]) => JSON.stringify(path);
const isMarker = (value: string) => value.startsWith(STORED_CREDENTIAL_PREFIX);
const markerOf = (ref: string) => `${STORED_CREDENTIAL_PREFIX}${ref}`;

/** Every non-empty string at a credential-shaped key, at any depth, with its path. */
export function credentialsIn(config: unknown, path: string[] = []): { path: string[]; value: string }[] {
    if (Array.isArray(config)) return config.flatMap((item, index) => credentialsIn(item, [...path, String(index)]));
    if (typeof config !== 'object' || config === null) return [];
    return Object.entries(config).flatMap(([key, value]) =>
        typeof value === 'string' && value !== '' && isCredentialKey(key)
            ? [{ path: [...path, key], value }]
            : credentialsIn(value, [...path, key])
    );
}

/** A copy of `value` with each listed path set to its new string, or removed when it maps to undefined. */
function rewrite(value: unknown, at: ReadonlyMap<string, string | undefined>, path: string[] = []): unknown {
    if (Array.isArray(value)) return value.map((item, index) => rewrite(item, at, [...path, String(index)]));
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
        const here = [...path, key];
        if (!at.has(pathKey(here))) out[key] = rewrite(inner, at, here);
        else if (at.get(pathKey(here)) !== undefined) out[key] = at.get(pathKey(here));
    }
    return out;
}

/** The new values of a batch of configs, written to the store before any transaction. */
export interface MintedCredentials {
    /** Keyed by config index, then path. */
    readonly fresh: ReadonlyMap<number, ReadonlyMap<string, CreatedEnvSecret>>;
    /** Everything a failed write may have left in the store: released, never trusted to be absent. */
    readonly candidates: Parameters<typeof releaseEnvSecrets>[1];
}

/**
 * The sealed form of one config: every new value replaced by its marker, every marker naming a stored
 * credential of `previous` at the same path kept, and any other marker removed — a reference this
 * profile never held is not the caller's to name. `used` makes each stored credential kept once.
 */
function seal(
    config: Record<string, unknown>,
    fresh: ReadonlyMap<string, CreatedEnvSecret> | undefined,
    previous: readonly StoredCredential[],
    used: Set<string>
): { config: Record<string, unknown>; secretRefs: StoredCredential[] } {
    const at = new Map<string, string | undefined>();
    const secretRefs: StoredCredential[] = [];
    for (const { path, value } of credentialsIn(config)) {
        const key = pathKey(path);
        const made = fresh?.get(key);
        if (made) {
            at.set(key, markerOf(made.ref));
            secretRefs.push({ path, ref: made.ref, version: made.version });
            continue;
        }
        const kept = previous.find((p) => markerOf(p.ref) === value && pathKey(p.path) === key && !used.has(p.ref));
        if (kept) {
            used.add(kept.ref);
            secretRefs.push(kept);
        } else {
            at.set(key, undefined);
        }
    }
    return { config: rewrite(config, at) as Record<string, unknown>, secretRefs };
}

export interface ExecutorCredentialDeps {
    sql: Sql;
    orgId: string;
    secrets: SecretStore;
    secretLog: (diagnostic: SecretDiagnostic) => void;
    writeDeadlineMs: number;
    cleanupDeadlineMs: number;
}

/** Each stored credential of the organization's profiles, as the compensation's fresh read sees them. */
const referencedInOrg = (sql: Sql, orgId: string) => () =>
    sql<{ secret_ref: string | null }[]>`
        select entry ->> 'ref' as secret_ref
        from executor_profile, jsonb_array_elements(secret_refs) as entry
        where org_id = ${orgId}
    `;

/**
 * Writes every new credential value of `configs` to the store. A failure releases what it may have
 * written and throws `EnvSecretError`, which the routes answer 503.
 */
export async function mintCredentials(
    deps: ExecutorCredentialDeps,
    configs: readonly Record<string, unknown>[]
): Promise<MintedCredentials> {
    const items = configs.flatMap((config, index) =>
        credentialsIn(config)
            .filter(({ value }) => !isMarker(value))
            .map(({ path, value }) => ({
                name: JSON.stringify([index, ...path]),
                identity: executorCredentialIdentity(deps.orgId, path),
                value,
            }))
    );
    const { created, unknown, failure } = await createEnvSecrets(deps.secrets, items, {
        signal: AbortSignal.timeout(deps.writeDeadlineMs),
    });
    if (failure) {
        await releaseCredentials(deps, [...created, ...unknown]);
        throw failure;
    }
    const fresh = new Map<number, Map<string, CreatedEnvSecret>>();
    for (const made of created) {
        const [index, ...path] = JSON.parse(made.name) as [number, ...string[]];
        const byPath = fresh.get(index) ?? new Map<string, CreatedEnvSecret>();
        byPath.set(pathKey(path), made);
        fresh.set(index, byPath);
    }
    return { fresh, candidates: created };
}

/** Compensation for a write that did not commit: only what no profile of the organization names. */
export function releaseCredentials(deps: ExecutorCredentialDeps, candidates: MintedCredentials['candidates']) {
    return releaseEnvSecrets(deps.secrets, candidates, {
        signal: AbortSignal.timeout(deps.cleanupDeadlineMs),
        diagnose: deps.secretLog,
        referencedInScope: referencedInOrg(deps.sql, deps.orgId),
    });
}

/** The post-commit deletes of the stored credentials the committed rows no longer name. Never throws. */
export function retireCredentials(deps: ExecutorCredentialDeps, retired: readonly StoredCredential[]) {
    const targets: RetiredEnvSecret[] = retired.map(({ path, ref, version }) => ({
        ref: ref as SecretRef,
        version: version as SecretVersion,
        identity: executorCredentialIdentity(deps.orgId, path),
    }));
    return retireEnvSecrets(deps.secrets, targets, {
        signal: AbortSignal.timeout(deps.cleanupDeadlineMs),
        diagnose: deps.secretLog,
    });
}

/**
 * Seals a batch of configs inside the write's transaction against the stored credentials the rewritten
 * rows held (`previous`). Answers the sealed rows and what `previous` no longer names.
 */
export function sealAll(
    configs: readonly Record<string, unknown>[],
    minted: MintedCredentials,
    previous: readonly StoredCredential[]
): { sealed: { config: Record<string, unknown>; secretRefs: StoredCredential[] }[]; retired: StoredCredential[] } {
    const used = new Set<string>();
    const sealed = configs.map((config, index) => seal(config, minted.fresh.get(index), previous, used));
    const retired = previous.filter((p) => !used.has(p.ref));
    return { sealed, retired };
}

/**
 * Runs one profile write: mint the new values, run `write` in a transaction with the sealed configs,
 * release on a failed write, retire what the committed rows no longer name. `write` answers the
 * stored credentials of the rows it replaced, read under the transaction.
 */
export async function writeSealed<T>(
    deps: ExecutorCredentialDeps,
    configs: readonly Record<string, unknown>[],
    write: (
        tx: TransactionSql,
        sealedOf: (previous: readonly StoredCredential[]) => ReturnType<typeof sealAll>['sealed']
    ) => Promise<T>
): Promise<T> {
    const minted = await mintCredentials(deps, configs);
    let retired: StoredCredential[] = [];
    let sealedRows = false;
    let result: T;
    try {
        result = (await deps.sql.begin((tx) =>
            write(tx, (previous) => {
                const out = sealAll(configs, minted, previous);
                retired = out.retired;
                sealedRows = true;
                return out.sealed;
            })
        )) as T;
    } catch (error) {
        await releaseCredentials(deps, minted.candidates);
        throw error;
    }
    // A write that found no row to seal (an id naming nothing) leaves what it minted unreferenced.
    if (!sealedRows) await releaseCredentials(deps, minted.candidates);
    await retireCredentials(deps, retired);
    return result;
}

/** The stored credentials of the rows a statement returned, flattened. */
export function storedOf(rows: readonly { secret_refs: StoredCredential[] }[]): StoredCredential[] {
    return rows.flatMap((row) => row.secret_refs);
}

/**
 * The config a runner gets: every marker replaced by its stored value. A marker no stored credential of
 * the row names, a plaintext credential, or a read that is not a confirmed value of the stored version
 * throws, so the claim rolls back and the task stays queued: a key is never dropped from a profile.
 */
export async function resolveCredentials(
    secrets: SecretStore,
    orgId: string,
    config: Record<string, unknown>,
    secretRefs: readonly StoredCredential[]
): Promise<Record<string, unknown>> {
    const rows = credentialsIn(config).map(({ path, value }) => {
        const stored = secretRefs.find((s) => markerOf(s.ref) === value && pathKey(s.path) === pathKey(path));
        if (!stored) throw new EnvSecretError(pathKey(path), 'malformed-row', 'malformed-row');
        return {
            name: pathKey(path),
            ref: stored.ref,
            version: stored.version,
            identity: executorCredentialIdentity(orgId, path),
        };
    });
    if (rows.length === 0) return config;
    const values = await readSecretValues(secrets, rows);
    return rewrite(config, new Map(rows.map((row, index) => [row.name, values[index]]))) as Record<string, unknown>;
}

/**
 * The one-shot conversion of the organization's profiles saved before credentials moved to the store:
 * each plaintext value is written to the store and the row swapped to its marker, compare-and-set on the
 * config it read, so a concurrent save wins and the conversion's own write is released. Throws when a
 * row is left unconverted; the executor store's gate retries it on the next call.
 */
export async function convertPlaintextCredentials(deps: ExecutorCredentialDeps): Promise<void> {
    const rows = await deps.sql<{ id: string; config: Record<string, unknown>; secret_refs: StoredCredential[] }[]>`
        select id, config, secret_refs from executor_profile where org_id = ${deps.orgId}
    `;
    for (const row of rows) {
        if (!credentialsIn(row.config).some(({ value }) => !isMarker(value))) continue;
        await writeSealed(deps, [row.config], async (tx, sealedOf) => {
            const [sealed] = sealedOf(row.secret_refs);
            const updated = await tx`
                update executor_profile
                set config = ${tx.json(sealed!.config as never)}, secret_refs = ${tx.json(sealed!.secretRefs as never)}
                where org_id = ${deps.orgId} and id = ${row.id} and config = ${tx.json(row.config as never)}
                returning id
            `;
            if (updated.length === 0) throw new Error('executor profile changed during credential conversion');
        });
    }
}

/**
 * The executor store's gate: `ready`, then this organization's conversion, run once. A failed
 * conversion fails that call and is retried by the next.
 */
export function convertedGate(deps: ExecutorCredentialDeps, ready: Promise<unknown> | undefined) {
    let converted: Promise<void> | undefined;
    return async () => {
        if (ready) await ready;
        converted ??= convertPlaintextCredentials(deps).catch((error: unknown) => {
            converted = undefined;
            throw error;
        });
        await converted;
    };
}
