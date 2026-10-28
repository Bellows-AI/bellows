import { createHmac } from 'node:crypto';
import { sameBytes } from './database-payloads.js';
import type { OperationKeys } from './secret-keys.js';
import {
    type PayloadAad,
    type PayloadColumns,
    type PayloadStorage,
    type PayloadStore,
    ProviderFault,
    type StoredPayload,
} from './secret-payloads.js';

/**
 * The payload store every external provider shares (docs/secrets.md): one write-once provider object per
 * storage version, plaintext at the provider, and in the version row a reference plus `payload_mac`, a keyed
 * MAC that binds the bytes to the identity, the reference, the logical version and the object name. A
 * provider adapter implements only `ObjectClient`, the four object calls; naming, the MAC, and what a read
 * must verify before its bytes are believed live here, once.
 */

/** What a provider answered for one object read. `malformed`: an answer that is not a well-formed object. */
export type ObjectRead = { name: string; versionId: string; payload: Uint8Array } | 'absent' | 'malformed';

export interface ObjectClient {
    readonly storage: Exclude<PayloadStorage, 'database'>;
    /** The provider's name for one storage version's object: `<prefix>/<ref>/<versionId>`. */
    nameOf(ref: string, versionId: string): string;
    /** Creates the object idempotently under `versionId`; `exists` when the name is already taken. */
    put(
        object: { name: string; versionId: string; payload: Uint8Array },
        budgetMs: number,
        signal: AbortSignal | undefined
    ): Promise<'written' | 'exists'>;
    /** One version of one object; `absent` only when the provider said the object does not exist. */
    get(name: string, versionId: string, budgetMs: number, signal: AbortSignal | undefined): Promise<ObjectRead>;
    /** Resolves only once the object is confirmed gone (or was never there). */
    remove(name: string, budgetMs: number, signal: AbortSignal | undefined): Promise<void>;
}

const MAC_VERSION = 'payload-mac-v1';

export function createExternalPayloads(
    client: ObjectClient,
    keys: Pick<OperationKeys, 'fingerprintKey'>
): PayloadStore {
    /** The header is JSON, so no field can run into the next; the payload follows it raw. */
    const macOf = (aad: PayloadAad, providerRef: string, payload: Uint8Array): string =>
        createHmac('sha256', keys.fingerprintKey)
            .update(
                `${JSON.stringify([MAC_VERSION, client.storage, aad.identityKey, aad.ref, aad.logicalVersion, providerRef])}\n`
            )
            .update(payload)
            .digest('hex');

    const sameMac = (stored: string, expected: string) =>
        sameBytes(Buffer.from(stored, 'utf8'), Buffer.from(expected, 'utf8'));

    /** The object this row names, only when it is the one its own reference and id derive: never a foreign name. */
    const ownName = (row: StoredPayload): string | null =>
        row.storage === client.storage && row.providerRef === client.nameOf(row.ref, row.id) ? row.providerRef : null;

    return {
        storage: client.storage,
        twoPhase: true,
        prepare(aad: PayloadAad, versionId: string, payload: Uint8Array): PayloadColumns {
            const providerRef = client.nameOf(aad.ref, versionId);
            return {
                storage: client.storage,
                keyId: null,
                envelope: null,
                providerRef,
                providerVersion: versionId,
                payloadMac: macOf(aad, providerRef, payload),
            };
        },
        holds(row, aad, payload) {
            const name = ownName(row);
            return (
                name !== null &&
                row.providerVersion === row.id &&
                row.payloadMac !== null &&
                sameMac(row.payloadMac, macOf(aad, name, payload))
            );
        },
        async write(row, payload, budgetMs, signal) {
            const name = ownName(row);
            if (name === null || row.providerVersion === null) {
                throw new ProviderFault('definitive');
            }
            return client.put({ name, versionId: row.providerVersion, payload }, budgetMs, signal);
        },
        async read(row, aad, budgetMs, signal) {
            const name = ownName(row);
            if (name === null || row.providerVersion === null || row.payloadMac === null) {
                return null;
            }
            const object = await client.get(name, row.providerVersion, budgetMs, signal);
            if (object === 'absent') {
                return 'absent';
            }
            if (object === 'malformed' || object.name !== name || object.versionId !== row.providerVersion) {
                return null;
            }
            return sameMac(row.payloadMac, macOf(aad, name, object.payload)) ? object.payload : null;
        },
        async remove(row, budgetMs, signal) {
            const name = ownName(row);
            if (name === null) {
                throw new ProviderFault('definitive');
            }
            await client.remove(name, budgetMs, signal);
        },
    };
}
