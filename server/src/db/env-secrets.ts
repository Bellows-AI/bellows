import type {
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
