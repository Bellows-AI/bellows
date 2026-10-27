/**
 * The storage contract every secret consumer (environment secrets, managed connection grants,
 * executor credentials) shares. Types and the closed unions only: no backend ships here, the
 * test-only reference store and the conformance suite live under `server/test/`. Consumers own
 * payload serialization and authorization; this store owns identity, versions, idempotency and
 * recovery. `docs/secrets.md` is the owning page.
 */

/** An organization-owned secret, or a user-owned one that carries its organization when it has one. */
export type SecretOwner =
    | { kind: 'organization'; orgId: string }
    | { kind: 'user'; userId: string; orgId: string | null };

export const SECRET_SCOPE_TYPES = [
    'organization',
    'workspace',
    'repository',
    'connection',
    'executor-profile',
] as const;
export type SecretScopeType = (typeof SECRET_SCOPE_TYPES)[number];

export const SECRET_PURPOSES = ['environment-secret', 'connection-grant', 'executor-credential'] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

/** Immutable once a reference is created; every operation checks all of it, retries included. */
export interface SecretIdentity {
    owner: SecretOwner;
    scope: { type: SecretScopeType; id: string };
    purpose: SecretPurpose;
    owningRecord: { type: string; id: string };
}

/** Opaque, application-generated; never a provider path and never a capability on its own. */
export type SecretRef = string & { readonly __brand: 'SecretRef' };
/** Opaque logical value version; a rekey keeps it, every successful replace changes it. */
export type SecretVersion = string & { readonly __brand: 'SecretVersion' };
/** Server-issued, scoped to an identity by the records it creates. */
export type OperationId = string & { readonly __brand: 'OperationId' };

export const SECRET_ERROR_CODES = [
    'not-found',
    'identity-mismatch',
    'conflict',
    'invalid-input',
    'invalid-configuration',
    'integrity-failure',
    'unavailable',
    'outcome-unknown',
] as const;
export type SecretErrorCode = (typeof SECRET_ERROR_CODES)[number];

/** A closed set: no reason can carry a payload, a ciphertext, a key or a provider response. */
export const SECRET_ERROR_REASONS = [
    'reference-not-found',
    'operation-not-found',
    'identity-mismatch',
    'stale-version',
    'reference-exists',
    'operation-pending',
    'operation-id-reused',
    'operation-id-invalid',
    'operation-id-expired',
    'identity-invalid',
    'ref-invalid',
    'version-invalid',
    'payload-null',
    'payload-not-bytes',
    'payload-too-large',
    'configuration-invalid',
    'integrity-check-failed',
    'provider-unavailable',
    'provider-timeout',
    'aborted',
] as const;
export type SecretErrorReason = (typeof SECRET_ERROR_REASONS)[number];

export interface SecretError {
    code: SecretErrorCode;
    reason: SecretErrorReason;
}

export type SecretResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: SecretError };

export interface SecretCall {
    identity: SecretIdentity;
    ref: SecretRef;
    /** Checked before any write; an aborted call that began the provider write is outcome-unknown. */
    signal?: AbortSignal | undefined;
}

export interface CreateSecretInput extends SecretCall {
    operationId: OperationId;
    payload: Uint8Array;
}
export interface ReplaceSecretInput extends CreateSecretInput {
    expectedVersion: SecretVersion;
}
export interface DeleteSecretInput extends SecretCall {
    operationId: OperationId;
    expectedVersion: SecretVersion;
}
export type ReadSecretInput = SecretCall;
export interface ReconcileInput extends SecretCall {
    operationId: OperationId;
}

export interface MutationOutcome {
    /** The new active version; null for a delete. */
    version: SecretVersion | null;
}

export type OperationStatus =
    | { state: 'pending' }
    | { state: 'unknown' }
    | { state: 'succeeded'; result: MutationOutcome }
    | { state: 'failed'; error: SecretError };

/** What a backend may log. Closed, so a payload or a provider body has no field to ride in. */
export interface SecretDiagnostic {
    event:
        | 'mutation-finished'
        | 'operation-unknown'
        | 'operation-reconciled'
        | 'provider-error'
        | 'cleanup-failed'
        | 'collected';
    kind?: 'create' | 'replace' | 'delete';
    ref?: SecretRef;
    code?: SecretErrorCode;
    reason?: SecretErrorReason;
}

export interface SecretStore {
    /** A fresh server-issued operation ID; a mutation never invents its own. */
    issueOperationId(): Promise<OperationId>;
    /** Create-if-absent: an existing or tombstoned reference conflicts. */
    create(input: CreateSecretInput): Promise<SecretResult<{ version: SecretVersion }>>;
    /** Active bytes and version only; staged values are never visible. */
    readActive(input: ReadSecretInput): Promise<SecretResult<{ value: Uint8Array; version: SecretVersion }>>;
    /** Activates a new logical version iff `expectedVersion` is still active. */
    replace(input: ReplaceSecretInput): Promise<SecretResult<{ version: SecretVersion }>>;
    /** Tombstones the reference iff `expectedVersion` is still active; cleanup is asynchronous. */
    delete(input: DeleteSecretInput): Promise<SecretResult>;
    /** Resolves an operation by identity and ID; may roll an interrupted one forward, never back. */
    reconcileOperation(input: ReconcileInput): Promise<SecretResult<{ status: OperationStatus }>>;
}
