import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { ObjectClient } from '../src/secrets/external-payloads.js';
import { createGcpObjectClient } from '../src/secrets/gcp-secret-manager.js';
import type { SecretStoreFaults } from '../test/secrets-conformance.js';
import {
    type ExternalHarness,
    type ExternalHarnessOptions,
    type ProviderKit,
    createHarnessOver,
} from './secrets-external-harness.js';
import { GCP_TEST_ENDPOINT, GCP_TEST_PROJECT, sharedGcpEmulator, type GcpEmulator } from './secrets-gcp-provider.js';

/**
 * TEST-ONLY: the conformance harness over the Google Cloud Secret Manager store, with provider faults injected at
 * the adapter's `fetch` seam in front of the in-process emulator, so the real request, response and error mapping
 * code runs under every fault. The conformance faults map to Secret Manager calls as the AWS ones do: the write is
 * the secret creation, the read the version access and the removal the secret deletion.
 */

const unavailable = (body: string) =>
    new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: body } }), { status: 503 });

const connectionReset = () =>
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });

const pathOf = (url: string | URL) => new URL(String(url)).pathname;

export function faultyGcpFetch(faults: SecretStoreFaults, real: typeof fetch): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const path = pathOf(url);
        if (method === 'POST' && path.endsWith('/secrets')) {
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
        if (method === 'GET' && path.endsWith(':access') && faults.providerRead === 'unavailable') {
            return unavailable(faults.providerErrorBody);
        }
        if (method === 'DELETE' && faults.providerDelete === 'fail') {
            return unavailable(faults.providerErrorBody);
        }
        return real(url, init);
    }) as typeof fetch;
}

export const GCP_TEST_LOCATION = 'europe-west3';

export const gcpClient = (
    config: { prefix: string; endpoint?: string; fetch?: typeof fetch },
    emulator: GcpEmulator = sharedGcpEmulator
): ObjectClient =>
    createGcpObjectClient({
        project: GCP_TEST_PROJECT,
        prefix: config.prefix,
        location: GCP_TEST_LOCATION,
        endpoint: config.endpoint ?? GCP_TEST_ENDPOINT,
        credentials: async () => ({ token: 'test-token', quotaProject: null }),
        fetch: config.fetch ?? emulator.fetch,
    });

const gcpKit: ProviderKit<ObjectClient> = {
    endpoint: GCP_TEST_ENDPOINT,
    client: (config) => gcpClient(config),
    faultyFetch: (faults) => faultyGcpFetch(faults, sharedGcpEmulator.fetch),
    names: async (_provider, prefix) => sharedGcpEmulator.names(prefix),
    // One secret per storage version: the provider "moves" the bytes by recreating the secret under a new id.
    async rekey(_provider, row) {
        const bytes = sharedGcpEmulator.first(row.provider_ref);
        sharedGcpEmulator.drop(row.provider_ref);
        sharedGcpEmulator.seed(row.provider_ref, [bytes]);
        return randomUUID();
    },
    async tamper(_provider, row) {
        const bytes = Buffer.from(sharedGcpEmulator.first(row.provider_ref) ?? []);
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
        sharedGcpEmulator.drop(row.provider_ref);
        sharedGcpEmulator.seed(row.provider_ref, [bytes]);
    },
};

export function createGcpHarness(sql: Sql, options: ExternalHarnessOptions = {}): ExternalHarness<ObjectClient> {
    return createHarnessOver(gcpKit, sql, { prefix: `factory-test-${randomUUID()}-`, ...options });
}
