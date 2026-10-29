import { createSecretRef } from '../secrets/secret-input.js';
import type {
    OperationId,
    SecretDiagnostic,
    SecretError,
    SecretErrorCode,
    SecretErrorReason,
    SecretIdentity,
    SecretRef,
    SecretStore,
    SecretVersion,
} from '../secrets/secret-store.js';

/**
 * Environment secrets live in the secret store (docs/secrets.md, docs/env.md): the `env_var` row keeps
 * the opaque reference and the version it was written at. This file owns the three things every reader
 * and writer of that arrangement shares: the identity a row's slot implies, the UTF-8 codec, and the
 * batched read that fails closed.
 */

/** Which of the three scopes a row belongs to. */
export type EnvSecretScope =
    | { kind: 'org' }
    | { kind: 'workspace'; userId: string }
    | { kind: 'repo'; owner: string; name: string };

/**
 * The identity is rebuilt from the row's slot on every call and never stored, so a reference copied to
 * another organization, scope or name fails as `identity-mismatch` instead of reading someone's secret.
 */
export function envSecretIdentity(orgId: string, scope: EnvSecretScope, name: string): SecretIdentity {
    const owner: SecretIdentity['owner'] =
        scope.kind === 'workspace' ? { kind: 'user', userId: scope.userId, orgId } : { kind: 'organization', orgId };
    const scopeId: SecretIdentity['scope'] =
        scope.kind === 'org'
            ? { type: 'organization', id: orgId }
            : scope.kind === 'workspace'
              ? { type: 'workspace', id: scope.userId }
              : { type: 'repository', id: `${scope.owner}/${scope.name}` };
    return { owner, scope: scopeId, purpose: 'environment-secret', owningRecord: { type: 'env-var', id: name } };
}

export const encodeEnvSecret = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * Strict: bytes that are not valid UTF-8 are an error, never replacement characters. A leading
 * byte-order mark is part of the value, not stripped.
 */
export const decodeEnvSecret = (bytes: Uint8Array): string =>
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

type RowFault = 'malformed-row' | 'version-mismatch' | 'invalid-encoding';

/**
 * A secret that could not be delivered. Carries the variable's name and a closed code/reason, never a
 * value, a ciphertext or a provider message, so it is safe to log and to answer a caller with.
 */
export class EnvSecretError extends Error {
    constructor(
        readonly envName: string,
        readonly code: SecretErrorCode | RowFault,
        readonly reason: SecretErrorReason | RowFault
    ) {
        super(`environment secret ${envName} unavailable: ${code}/${reason}`);
        this.name = 'EnvSecretError';
    }
}

export interface EncryptedEnvRow {
    name: string;
    ref: string;
    version: string;
    identity: SecretIdentity;
}

/**
 * Reads every row's active value, `concurrency` at a time, under one absolute deadline for the whole
 * batch. Any answer that is not a confirmed value of the stored version throws: a secret is never
 * dropped from an environment because its read was inconclusive. Results are in the rows' order.
 */
export async function readSecretValues(
    store: SecretStore,
    rows: readonly EncryptedEnvRow[],
    { deadlineMs = 15_000, concurrency = 2 }: { deadlineMs?: number; concurrency?: number } = {}
): Promise<string[]> {
    const signal = AbortSignal.timeout(deadlineMs);
    const values: string[] = new Array(rows.length);
    let next = 0;
    let failure: EnvSecretError | undefined;

    const readOne = async (row: EncryptedEnvRow): Promise<string> => {
        let result: Awaited<ReturnType<SecretStore['readActive']>>;
        try {
            result = await store.readActive({ identity: row.identity, ref: row.ref as SecretRef, signal });
        } catch {
            throw new EnvSecretError(row.name, 'unavailable', 'provider-unavailable');
        }
        if (!result.ok) throw new EnvSecretError(row.name, result.error.code, result.error.reason);
        if ((result.version as SecretVersion) !== row.version) {
            throw new EnvSecretError(row.name, 'version-mismatch', 'version-mismatch');
        }
        try {
            return decodeEnvSecret(result.value);
        } catch {
            throw new EnvSecretError(row.name, 'invalid-encoding', 'invalid-encoding');
        }
    };

    // A store that finishes a read after the signal fired must not stretch the claim transaction: no
    // read starts past the deadline, and the batch rejects at it whatever the reads in flight do.
    const expired = () =>
        new EnvSecretError(rows[next]?.name ?? rows[0]?.name ?? '', 'unavailable', 'provider-timeout');
    const worker = async (): Promise<void> => {
        while (!failure && next < rows.length) {
            if (signal.aborted) {
                failure ??= expired();
                return;
            }
            const index = next++;
            try {
                values[index] = await readOne(rows[index] as EncryptedEnvRow);
            } catch (error) {
                failure ??= error as EnvSecretError;
                return;
            }
        }
    };

    let onAbort: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
        onAbort = () => reject(expired());
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        await Promise.race([Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker)), deadline]);
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    if (failure) throw failure;
    return values;
}

/** The answer of a call raced against a signal: its value, or nothing because the signal won. */
type Raced<T> = { lost: false; value: T } | { lost: true };

/**
 * The store bounds a call by its own deadline, not the caller's signal (docs/secrets.md), so a consumer
 * races the signal itself. The abandoned call keeps running; its late answer or rejection is ignored.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<Raced<T>> {
    promise.catch(() => {});
    if (signal.aborted) return Promise.resolve({ lost: true });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<Raced<T>>((resolve) => {
        onAbort = () => resolve({ lost: true });
        signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([promise.then((value): Raced<T> => ({ lost: false, value })), aborted]).finally(() => {
        if (onAbort) signal.removeEventListener('abort', onAbort);
    });
}

/**
 * The only `invalid-input` reasons `prepare()` produces, and it answers them before any repo call
 * (postgres-secret-mutation.ts), so a create refused with one of them wrote nothing and is never reconciled.
 */
export const PRE_WRITE_REFUSALS: readonly SecretErrorReason[] = [
    'identity-invalid',
    'ref-invalid',
    'operation-id-invalid',
    'payload-null',
    'payload-not-bytes',
    'payload-too-large',
];

const isPreWriteRefusal = (error: SecretError): boolean =>
    error.code === 'invalid-input' && PRE_WRITE_REFUSALS.includes(error.reason);

export interface CreatedEnvSecret {
    name: string;
    ref: SecretRef;
    version: SecretVersion;
    identity: SecretIdentity;
}

/** A create that may have written: it is reconciled once, never trusted to have failed. */
export interface UnknownEnvSecret {
    name: string;
    ref: SecretRef;
    identity: SecretIdentity;
    operationId: OperationId;
}

/** A stored record to delete at a known version. */
export interface RetiredEnvSecret {
    ref: SecretRef;
    version: SecretVersion;
    identity: SecretIdentity;
}

const CLEANUP_CONCURRENCY = 4;

type Diagnose = (diagnostic: SecretDiagnostic) => void;

const unavailable = (name: string, lost: boolean) =>
    new EnvSecretError(name, 'unavailable', lost ? 'provider-timeout' : 'provider-unavailable');

/** Runs `fn` over `items`, `concurrency` at a time; `fn` never throws. */
async function eachLimited<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await fn(items[next++] as T);
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/**
 * Writes every item to the store. Each ref and operation id is minted before its create is sent, so a
 * create that is lost or abandoned stays tracked. Workers stop starting creates after the first
 * failure or once the signal fires; every call in flight settles, by answer or by losing the race.
 */
export async function createEnvSecrets(
    store: SecretStore,
    items: readonly { name: string; identity: SecretIdentity; value: string }[],
    { signal, concurrency = 4 }: { signal: AbortSignal; concurrency?: number }
): Promise<{ created: CreatedEnvSecret[]; unknown: UnknownEnvSecret[]; failure?: EnvSecretError }> {
    const created: CreatedEnvSecret[] = [];
    const unknown: UnknownEnvSecret[] = [];
    let failure: EnvSecretError | undefined;
    let next = 0;

    const createOne = async ({ name, identity, value }: (typeof items)[number]): Promise<void> => {
        const ref = createSecretRef();
        let operationId: OperationId;
        try {
            const issued = await untilAborted(store.issueOperationId(), signal);
            if (issued.lost) {
                failure ??= unavailable(name, true);
                return;
            }
            operationId = issued.value;
        } catch {
            failure ??= unavailable(name, false);
            return;
        }
        const track = { name, ref, identity, operationId };
        try {
            const answer = await untilAborted(
                store.create({ identity, ref, operationId, payload: encodeEnvSecret(value), signal }),
                signal
            );
            if (answer.lost) {
                unknown.push(track);
                failure ??= unavailable(name, true);
            } else if (answer.value.ok) {
                created.push({ name, ref, version: answer.value.version, identity });
            } else if (isPreWriteRefusal(answer.value.error)) {
                failure ??= new EnvSecretError(name, answer.value.error.code, answer.value.error.reason);
            } else {
                unknown.push(track);
                failure ??= new EnvSecretError(name, answer.value.error.code, answer.value.error.reason);
            }
        } catch {
            unknown.push(track);
            failure ??= unavailable(name, false);
        }
    };

    const worker = async (): Promise<void> => {
        while (!failure && !signal.aborted && next < items.length)
            await createOne(items[next++] as (typeof items)[number]);
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    if (!failure && next < items.length) failure = unavailable((items[next] as (typeof items)[number]).name, true);
    return failure ? { created, unknown, failure } : { created, unknown };
}

/** Deletes one stored record; reports, never throws, and counts only a confirmed answer as done. */
async function deleteOne(store: SecretStore, target: RetiredEnvSecret, signal: AbortSignal, diagnose: Diagnose) {
    const { ref, identity, version } = target;
    const report = (code: SecretErrorCode, reason: SecretErrorReason) =>
        diagnose({ event: 'cleanup-failed', kind: 'delete', ref, code, reason });
    try {
        const issued = await untilAborted(store.issueOperationId(), signal);
        if (issued.lost) return report('unavailable', 'provider-timeout');
        const answer = await untilAborted(
            store.delete({ identity, ref, expectedVersion: version, operationId: issued.value, signal }),
            signal
        );
        if (answer.lost) return report('unavailable', 'provider-timeout');
        const result = answer.value;
        if (result.ok || (result.error.code === 'not-found' && result.error.reason === 'reference-not-found')) return;
        report(result.error.code, result.error.reason);
    } catch {
        report('unavailable', 'provider-unavailable');
    }
}

/** Reconciles one create that may have written, exactly once, and deletes it if it landed. */
async function reconcileOne(store: SecretStore, target: UnknownEnvSecret, signal: AbortSignal, diagnose: Diagnose) {
    const { ref, identity, operationId } = target;
    const report = (code: SecretErrorCode, reason: SecretErrorReason) =>
        diagnose({ event: 'cleanup-failed', kind: 'create', ref, code, reason });
    try {
        const answer = await untilAborted(store.reconcileOperation({ identity, ref, operationId, signal }), signal);
        if (answer.lost) return report('unavailable', 'provider-timeout');
        const result = answer.value;
        if (!result.ok) return report(result.error.code, result.error.reason);
        const { status } = result;
        if (status.state === 'failed') return;
        if (status.state === 'succeeded' && status.result.version !== null) {
            return await deleteOne(store, { ref, identity, version: status.result.version }, signal, diagnose);
        }
        report('outcome-unknown', 'operation-pending');
    } catch {
        report('unavailable', 'provider-unavailable');
    }
}

/**
 * Compensation for a write that did not commit: deletes the creates that landed and reconciles the ones
 * that may have, but only the refs a fresh read of the PUT's own scope confirms no row names. An
 * inconclusive read deletes nothing and reports every candidate. Never throws.
 */
export async function releaseEnvSecrets(
    store: SecretStore,
    candidates: readonly (RetiredEnvSecret | UnknownEnvSecret)[],
    {
        signal,
        diagnose,
        referencedInScope,
    }: {
        signal: AbortSignal;
        diagnose: Diagnose;
        referencedInScope: () => Promise<readonly { secret_ref: string | null }[]>;
    }
): Promise<void> {
    if (candidates.length === 0) return;
    let referenced: Set<string>;
    try {
        // The read is raced like every store call: a blocked scope read must not outlast the cleanup deadline.
        const answer = await untilAborted(referencedInScope(), signal);
        if (answer.lost) throw new Error('aborted');
        const rows: unknown = answer.value;
        if (!Array.isArray(rows)) throw new Error('malformed');
        referenced = new Set();
        for (const row of rows as { secret_ref?: unknown }[]) {
            if (typeof row?.secret_ref === 'string') referenced.add(row.secret_ref);
            else if (row?.secret_ref !== null) throw new Error('malformed');
        }
    } catch {
        for (const { ref } of candidates) diagnose({ event: 'cleanup-failed', kind: 'delete', ref });
        return;
    }
    const orphans = candidates.filter(({ ref }) => !referenced.has(ref));
    await eachLimited(orphans, CLEANUP_CONCURRENCY, (target) =>
        'operationId' in target
            ? reconcileOne(store, target, signal, diagnose)
            : deleteOne(store, target, signal, diagnose)
    );
}

/** The post-commit deletes of the records the committed rows no longer name. Never throws. */
export async function retireEnvSecrets(
    store: SecretStore,
    retired: readonly RetiredEnvSecret[],
    { signal, diagnose }: { signal: AbortSignal; diagnose: Diagnose }
): Promise<void> {
    await eachLimited(retired, CLEANUP_CONCURRENCY, (target) => deleteOne(store, target, signal, diagnose));
}
