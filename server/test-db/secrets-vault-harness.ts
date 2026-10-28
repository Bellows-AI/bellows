import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createVaultObjectClient } from '../src/secrets/vault-kv.js';
import type { SecretStoreFaults } from '../test/secrets-conformance.js';
import {
    type ExternalHarness,
    type ExternalHarnessOptions,
    type ProviderKit,
    createHarnessOver,
} from './secrets-external-harness.js';
import { VAULT_TEST_ADDR, VAULT_TEST_MOUNT, VAULT_TEST_TOKEN, listPaths, vaultApi } from './secrets-vault-provider.js';

/**
 * TEST-ONLY: the conformance harness over the Vault KV v2 secret store, with provider faults injected at the
 * adapter's `fetch` seam so the real request, response and error mapping code runs under every fault. The
 * conformance faults map to Vault calls as the AWS ones do: the write is the data POST, the read the data GET and
 * the removal the metadata DELETE.
 */

export type VaultClient = ReturnType<typeof createVaultObjectClient>;

const unavailable = (body: string) => new Response(JSON.stringify({ errors: [body] }), { status: 503 });

const connectionReset = () =>
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });

const isData = (url: string | URL) => new URL(String(url)).pathname.includes('/data/');
const isMetadata = (url: string | URL) => new URL(String(url)).pathname.includes('/metadata/');

export function faultyVaultFetch(faults: SecretStoreFaults, real: typeof fetch = fetch): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST' && isData(url)) {
            faults.providerWriteCount += 1;
            if (faults.providerWrite === 'timeout-lost') {
                throw connectionReset();
            }
            if (faults.providerWrite === 'unavailable-with-body') {
                return unavailable(faults.providerErrorBody);
            }
            const response = await real(url, init);
            if (faults.providerWrite === 'timeout-applied') {
                await response.arrayBuffer();
                throw connectionReset();
            }
            return response;
        }
        if (method === 'GET' && isData(url) && faults.providerRead === 'unavailable') {
            return unavailable(faults.providerErrorBody);
        }
        if (method === 'DELETE' && isMetadata(url) && faults.providerDelete === 'fail') {
            return unavailable(faults.providerErrorBody);
        }
        return real(url, init);
    }) as typeof fetch;
}

const pathOf = (name: string) => `${VAULT_TEST_MOUNT}/data/${name}`;

async function writeObject(name: string, versionId: string, payloadBase64: string): Promise<void> {
    const written = await vaultApi('POST', pathOf(name), {
        options: { cas: 0 },
        data: { name, version_id: versionId, payload: payloadBase64 },
    });
    if (written.status !== 200) {
        throw new Error(`could not write the provider object (${written.status})`);
    }
}

async function storedPayload(row: { provider_ref: string }): Promise<string> {
    const read = await vaultApi<{ data: { data: { payload: string } } }>(
        'GET',
        `${pathOf(row.provider_ref)}?version=1`
    );
    return read.json.data.data.payload;
}

const vaultKit: ProviderKit<VaultClient> = {
    endpoint: VAULT_TEST_ADDR,
    client: ({ prefix, endpoint, fetch: inner }, options) =>
        createVaultObjectClient({
            addr: endpoint,
            mount: VAULT_TEST_MOUNT,
            prefix,
            auth: { kind: 'token', token: options.token ?? VAULT_TEST_TOKEN },
            fetch: inner,
        }),
    faultyFetch: faultyVaultFetch,
    names: (_provider, prefix) => listPaths(prefix),
    // One object per storage version: the provider "moves" the bytes by recreating the object under a new id.
    async rekey(_provider, row) {
        const payload = await storedPayload(row);
        const version = randomUUID();
        await vaultApi('DELETE', `${VAULT_TEST_MOUNT}/metadata/${row.provider_ref}`);
        await writeObject(row.provider_ref, version, payload);
        return version;
    },
    async tamper(_provider, row) {
        const bytes = Buffer.from(await storedPayload(row), 'base64');
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
        await vaultApi('DELETE', `${VAULT_TEST_MOUNT}/metadata/${row.provider_ref}`);
        await writeObject(row.provider_ref, row.provider_version, bytes.toString('base64'));
    },
};

export function createVaultHarness(sql: Sql, options: ExternalHarnessOptions = {}): ExternalHarness<VaultClient> {
    return createHarnessOver(vaultKit, sql, options);
}
