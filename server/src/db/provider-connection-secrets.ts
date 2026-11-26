import type { CreatedEnvSecret, RetiredEnvSecret, UnknownEnvSecret } from './env-secrets.js';
import {
    createEnvSecrets,
    EnvSecretError,
    readSecretValues,
    releaseEnvSecrets,
    retireEnvSecrets,
} from './env-secrets.js';
import type {
    SecretDiagnostic,
    SecretIdentity,
    SecretRef,
    SecretStore,
    SecretVersion,
} from '../secrets/secret-store.js';

/** A stored credential that could not be delivered: the closed code/reason carries the story. */
export { EnvSecretError };

/**
 * A provider connection's key lives in the secret store (docs/secrets.md, docs/api.md): the row
 * keeps the opaque reference and the version it was written at. This file owns what every reader
 * and writer of that arrangement shares: the identity a row's slot implies, the write that mints a
 * fresh reference, the compensation for a write that did not commit, the retirement of a superseded
 * one, and the fail-closed read. The machinery is env-secrets.ts's.
 */

/**
 * The identity is rebuilt from the row's slot on every call and never stored, so a reference copied
 * to another connection, member or organization fails as `identity-mismatch` instead of reading
 * someone's key. The scope is the connection table of one organization (the executor credential's
 * shape), the owner the row's — the organization for a null `user_id`, the member otherwise — and
 * the owning record the row itself.
 */
export function providerConnectionSecretIdentity(
    orgId: string,
    connectionId: string,
    userId: string | null
): SecretIdentity {
    return {
        owner: userId === null ? { kind: 'organization', orgId } : { kind: 'user', userId, orgId },
        scope: { type: 'provider-connection', id: orgId },
        purpose: 'provider-credential',
        owningRecord: { type: 'provider-connection', id: connectionId },
    };
}

/** What the secret helpers take: the store, its diagnostic sink, the compensation's fresh read and the deadlines. */
export interface ProviderConnectionSecretDeps {
    orgId: string;
    secrets: SecretStore;
    /** Where a compensation that could not finish is reported. */
    secretLog: (diagnostic: SecretDiagnostic) => void;
    /** Every `secret_ref` the organization's connections name — the compensation's fresh read. */
    referencedRefs: () => Promise<readonly { secret_ref: string | null }[]>;
    /** Bounds a mint; compensation runs under its own `cleanupDeadlineMs`. */
    writeDeadlineMs: number;
    cleanupDeadlineMs: number;
}

/**
 * Compensation for a write that did not commit: deletes only what a fresh read of the
 * organization's connection rows shows nothing naming. An inconclusive read deletes nothing and
 * reports every candidate. Never throws.
 */
export function releaseConnectionSecrets(
    deps: ProviderConnectionSecretDeps,
    candidates: readonly (RetiredEnvSecret | UnknownEnvSecret)[]
) {
    return releaseEnvSecrets(deps.secrets, candidates, {
        signal: AbortSignal.timeout(deps.cleanupDeadlineMs),
        diagnose: deps.secretLog,
        referencedInScope: deps.referencedRefs,
    });
}

/**
 * Writes one key to the store under `identity`. A failure releases whatever it may have written and
 * throws `EnvSecretError`, which the routes answer 503.
 */
export async function mintConnectionSecret(
    deps: ProviderConnectionSecretDeps,
    identity: SecretIdentity,
    key: string
): Promise<CreatedEnvSecret> {
    const { created, unknown, failure } = await createEnvSecrets(
        deps.secrets,
        [{ name: identity.owningRecord.id, identity, value: key }],
        { signal: AbortSignal.timeout(deps.writeDeadlineMs) }
    );
    if (failure || !created[0]) {
        await releaseConnectionSecrets(deps, [...created, ...unknown]);
        if (failure) throw new EnvSecretError(identity.owningRecord.id, failure.code, failure.reason);
        throw new EnvSecretError(identity.owningRecord.id, 'unavailable', 'provider-unavailable');
    }
    return created[0];
}

/** The stored record a superseding write retires, built from the row it came from. */
export const retiredConnectionSecret = (
    orgId: string,
    connectionId: string,
    userId: string | null,
    row: { secret_ref: string; secret_version: string }
): RetiredEnvSecret => ({
    ref: row.secret_ref as SecretRef,
    version: row.secret_version as SecretVersion,
    identity: providerConnectionSecretIdentity(orgId, connectionId, userId),
});

/** The post-commit deletes of the records the committed rows no longer name. Never throws. */
export function retireConnectionSecrets(deps: ProviderConnectionSecretDeps, retired: readonly RetiredEnvSecret[]) {
    return retireEnvSecrets(deps.secrets, retired, {
        signal: AbortSignal.timeout(deps.cleanupDeadlineMs),
        diagnose: deps.secretLog,
    });
}

/** The row-shaped slot a fail-closed read starts from. */
export interface ConnectionSecretSlot {
    orgId: string;
    userId: string | null;
    connectionId: string;
    name: string;
    ref: unknown;
    version: unknown;
}

/**
 * The stored key, fail-closed: any answer that is not a confirmed value of the stored version throws
 * (`EnvSecretError`), so a caller never treats an inconclusive read as an absent or wrong key.
 */
export async function readConnectionCredential(secrets: SecretStore, slot: ConnectionSecretSlot): Promise<string> {
    if (typeof slot.ref !== 'string' || slot.ref === '' || typeof slot.version !== 'string' || slot.version === '') {
        throw new EnvSecretError(slot.connectionId, 'malformed-row', 'malformed-row');
    }
    const values = await readSecretValues(secrets, [
        {
            name: slot.connectionId,
            ref: slot.ref,
            version: slot.version,
            identity: providerConnectionSecretIdentity(slot.orgId, slot.connectionId, slot.userId),
        },
    ]);
    return values[0]!;
}
