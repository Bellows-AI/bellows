/**
 * The one interface the artifact index writes through. Two backends implement it: `s3-store.ts`
 * (EKS, and RustFS in compose) and `fs-store.ts` (`npm test`, single-replica dev); both pass
 * `server/test/artifacts.contract.test.ts`.
 *
 * Objects are immutable: a key is written once. `put` never overwrites, and tells the caller
 * whether the key was already taken — it does NOT say whether the stored body matches, because
 * the object stores answer an identical retry and a different body the same way. The index
 * (`artifact-store.ts`) arbitrates by the sha256 it recorded.
 */
export interface ObjectStore {
    /** Create-only write: `created`, or `exists` when the key is taken (the stored body is untouched). */
    put(key: string, body: Uint8Array): Promise<PutResult>;
    /** The whole body, or null when the key does not exist. */
    get(key: string): Promise<Uint8Array | null>;
    /** The body's size in bytes, or null when the key does not exist. */
    head(key: string): Promise<{ size: number } | null>;
    /** Idempotent: deleting an absent key succeeds. */
    delete(key: string): Promise<void>;
}

export type PutResult = 'created' | 'exists';
