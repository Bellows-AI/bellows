/**
 * Where a secret version's payload bytes live (docs/secrets.md). The coordination code (intent, operation,
 * pointer, activation, collection) is shared by every backend and reaches the payload only through this seam:
 * the database store keeps an AES envelope in the version row, an external provider keeps the plaintext and
 * the row keeps a keyed MAC of it. A payload store throws `ProviderFault` for anything that went wrong at its
 * provider; the store classifies it (`secret-call.ts`) and the fault's message is never surfaced.
 */

export type PayloadStorage = 'database' | 'aws' | 'vault';

/** What a failed provider call means for the call that raised it. */
export type FaultVerdict = 'retry' | 'ambiguous' | 'definitive' | 'misconfigured';

export class ProviderFault extends Error {
    constructor(readonly verdict: FaultVerdict) {
        super(`provider fault: ${verdict}`);
    }
}

/** What a payload is bound to; the AAD of an envelope and the MAC input of an external version. */
export interface PayloadAad {
    identityKey: string;
    ref: string;
    logicalVersion: string;
}

/** The `secret_version` columns a payload store owns (`092_secret_external.sql`). */
export interface PayloadColumns {
    storage: PayloadStorage;
    keyId: string | null;
    envelope: Buffer | null;
    providerRef: string | null;
    providerVersion: string | null;
    payloadMac: string | null;
}

/** A stored version as a payload store sees it. */
export interface StoredPayload extends PayloadColumns {
    id: string;
    ref: string;
    logicalVersion: string;
}

export interface PayloadStore {
    readonly storage: PayloadStorage;
    /**
     * True when the payload outlives its row (a provider object): removal retires the row to `deleting`,
     * removes the payload, then drops the row. False when deleting the row removes the payload, so removal is
     * one guarded delete that no older release can see half done.
     */
    readonly twoPhase: boolean;
    /** The columns to stage for a new version; null when this store cannot produce one (a missing key). */
    prepare(aad: PayloadAad, versionId: string, payload: Uint8Array): PayloadColumns | null;
    /** True when the staged row was prepared for this very payload. Pure: no provider call. */
    holds(row: StoredPayload, aad: PayloadAad, payload: Uint8Array): boolean;
    /** The provider write for a staged row; `exists` when the object was already there (the caller reads it back). */
    write(
        row: StoredPayload,
        payload: Uint8Array,
        budgetMs: number,
        signal: AbortSignal | undefined
    ): Promise<'written' | 'exists'>;
    /** The plaintext; `absent` only when the provider confirmed there is none; null when it does not verify. */
    read(
        row: StoredPayload,
        aad: PayloadAad,
        budgetMs: number,
        signal: AbortSignal | undefined
    ): Promise<Uint8Array | 'absent' | null>;
    /** Removes the provider object; resolves only once it is confirmed gone (or never existed). */
    remove(row: StoredPayload, budgetMs: number, signal: AbortSignal | undefined): Promise<void>;
}
