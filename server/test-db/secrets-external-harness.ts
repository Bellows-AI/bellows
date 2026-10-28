import { randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { type AwsObjectClient, createAwsObjectClient } from '../src/secrets/aws-secrets-manager.js';
import { type ObjectClient, createExternalPayloads } from '../src/secrets/external-payloads.js';
import type { PayloadStore } from '../src/secrets/secret-payloads.js';
import { type SecretRepo, createSecretRepo } from '../src/secrets/postgres-secret-repo.js';
import { type CoordinatedSecretStore, createSecretStoreOver } from '../src/secrets/postgres-secret-store.js';
import type { OperationKeys } from '../src/secrets/secret-keys.js';
import type { SecretDiagnostic, SecretIdentity, SecretRef } from '../src/secrets/secret-store.js';
import { type SecretStoreFaults, type SecretStoreHarness, createFaults } from '../test/secrets-conformance.js';
import { AWS_TEST_ENDPOINT, AWS_TEST_KEYS, AWS_TEST_REGION } from './secrets-aws-provider.js';
import { databaseSnapshot, steppedRepo } from './secrets-postgres-harness.js';

/**
 * TEST-ONLY: the conformance harness over the external (AWS) secret store, with provider faults injected at
 * the adapter's `fetch` seam, so the real request, response and error mapping code runs under every fault.
 * Each harness gets its own prefix, so concurrent suites never see one another's objects, and nothing is
 * cleaned up afterwards (docs/secrets.md).
 */

/** What a faulty provider says; the sentinel rides in it so a leak into a result is visible. */
const unavailable = (body: string) =>
    new Response(JSON.stringify({ __type: 'ServiceUnavailable', message: body }), { status: 503 });

const targetOf = (init: RequestInit | undefined): string =>
    String((init?.headers as Record<string, string> | undefined)?.['x-amz-target'] ?? '').replace(
        'secretsmanager.',
        ''
    );

const connectionReset = () =>
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });

export function faultyFetch(faults: SecretStoreFaults, real: typeof fetch = fetch): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
        const target = targetOf(init);
        if (target === 'CreateSecret') {
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
        if (target === 'GetSecretValue' && faults.providerRead === 'unavailable') {
            return unavailable(faults.providerErrorBody);
        }
        if ((target === 'DeleteSecret' || target === 'DescribeSecret') && faults.providerDelete === 'fail') {
            return unavailable(faults.providerErrorBody);
        }
        return real(url, init);
    }) as typeof fetch;
}

export interface ExternalHarness<C extends ObjectClient = AwsObjectClient> extends SecretStoreHarness {
    open(): CoordinatedSecretStore;
    reopen(): CoordinatedSecretStore;
    /** The provider client with no fault injection, for inspecting and tampering with the provider directly. */
    provider: C;
    prefix: string;
    keys: OperationKeys;
    realRepo: SecretRepo;
    now(): number;
}

export interface ExternalHarnessOptions {
    deadlineMs?: number;
    ready?: Promise<unknown>;
    /** AWS only: credentials the adapter signs with; a test of wrong credentials passes others. */
    credentials?: () => Promise<{ accessKeyId: string; secretAccessKey: string }>;
    /** Vault only: the client token the adapter presents; a test of a refused or a policy-limited token passes another. */
    token?: string;
    /** Where the adapter sends requests; a test of an outage passes a closed port. */
    endpoint?: string;
    /** Wraps the faulty fetch the store talks through, to script an answer the real provider would not give. */
    wrapFetch?: (inner: typeof fetch) => typeof fetch;
    /** A prefix to share with another harness, for a second replica. */
    prefix?: string;
    keys?: OperationKeys;
}

/** What differs between external providers in the harness: the client, the fault seam and the direct provider access. */
export interface ProviderKit<C extends ObjectClient> {
    /** Where the provider listens unless a test points the adapter elsewhere. */
    endpoint: string;
    client(config: { prefix: string; endpoint: string; fetch?: typeof fetch }, options: ExternalHarnessOptions): C;
    faultyFetch(faults: SecretStoreFaults, real?: typeof fetch): typeof fetch;
    /** Every object the provider holds under the prefix. */
    names(provider: C, prefix: string): Promise<string[]>;
    /** The provider moves the same bytes to a new provider version; returns that version. */
    rekey(provider: C, row: { provider_ref: string; provider_version: string }): Promise<string>;
    /** The provider's bytes change under the same name and version. */
    tamper(provider: C, row: { provider_ref: string; provider_version: string }): Promise<void>;
}

export function createExternalHarness(sql: Sql, options: ExternalHarnessOptions = {}): ExternalHarness {
    return createHarnessOver(awsKit, sql, options);
}

export function createHarnessOver<C extends ObjectClient>(
    kit: ProviderKit<C>,
    sql: Sql,
    options: ExternalHarnessOptions = {}
): ExternalHarness<C> {
    const keys: OperationKeys = options.keys ?? { operationKey: randomBytes(32), fingerprintKey: randomBytes(32) };
    const prefix = options.prefix ?? `factory-test/${randomUUID()}`;
    let now = Date.UTC(2026, 0, 1);
    const clock = { now: () => now };
    const faults = createFaults();
    const diagnostics: unknown[] = [];
    const log = (d: SecretDiagnostic) => diagnostics.push(d);
    const config = { prefix, endpoint: options.endpoint ?? kit.endpoint };
    const provider = kit.client(config, options);
    const stored = kit.faultyFetch(faults);
    const faulty = kit.client({ ...config, fetch: options.wrapFetch ? options.wrapFetch(stored) : stored }, options);
    const realRepo = createSecretRepo(sql);
    // The conformance suite's `after-stage` is "the payload is durable, the pointer has not moved". For an
    // external store that is after the provider write, not after the row insert, so this harness fires it there.
    const operationOfVersion = new Map<string, string>();
    const stage = steppedRepo(realRepo, faults, false);
    const repo: typeof stage = {
        ...stage,
        async stageVersion(version, budgetMs) {
            if (version.operationId) {
                operationOfVersion.set(version.id, version.operationId);
            }
            return stage.stageVersion(version, budgetMs);
        },
    };
    const external = createExternalPayloads(faulty, keys);
    const payloads: PayloadStore = {
        ...external,
        async write(row, payload, budgetMs, signal) {
            const written = await external.write(row, payload, budgetMs, signal);
            const operationId = operationOfVersion.get(row.id);
            if (operationId) {
                await faults.onStep?.({ step: 'after-stage', operationId: operationId as never });
            }
            return written;
        },
    };
    const open = () =>
        createSecretStoreOver({
            repo,
            keys,
            payloads,
            clock,
            log,
            deadlineMs: options.deadlineMs ?? 3000,
            ready: options.ready,
        });
    const activeRow = async (ref: SecretRef) => {
        const rows = await sql<{ id: string; provider_ref: string; provider_version: string }[]>`
            select v.id, v.provider_ref, v.provider_version
              from secret_active a join secret_version v on v.id = a.version_id where a.ref = ${ref}`;
        const row = rows[0];
        if (!row) {
            throw new Error('nothing active for that reference');
        }
        return row;
    };
    return {
        open,
        reopen: open,
        provider,
        prefix,
        keys,
        realRepo,
        now: () => now,
        clock: {
            advance(ms) {
                now += ms;
            },
        },
        faults,
        // An external store has no data keys, so a "rekey" is the provider moving the same bytes to a new
        // provider version; the row follows it (docs/secrets.md).
        async rekey(_identity: SecretIdentity, ref: SecretRef) {
            const row = await activeRow(ref);
            const version = await kit.rekey(provider, row);
            await sql`update secret_version set provider_version = ${version} where id = ${row.id}`;
        },
        async collect() {
            await open().collect();
        },
        // The provider's bytes change under the same name and version: the MAC in the row no longer verifies.
        async tamper(ref: SecretRef) {
            await kit.tamper(provider, await activeRow(ref));
        },
        async durableSnapshot() {
            return { db: await databaseSnapshot(sql), provider: await kit.names(provider, prefix) };
        },
        diagnostics: () => structuredClone(diagnostics),
    };
}

/** The AWS Secrets Manager provider; every call goes through the adapter's `call`, so the real wire code runs. */
const awsKit: ProviderKit<AwsObjectClient> = {
    endpoint: AWS_TEST_ENDPOINT,
    client: ({ prefix, endpoint, fetch: inner }, options) =>
        createAwsObjectClient({
            region: AWS_TEST_REGION,
            prefix,
            endpoint,
            credentials: options.credentials ?? (async () => AWS_TEST_KEYS),
            fetch: inner,
        }),
    faultyFetch,
    async names(provider, prefix) {
        const names: string[] = [];
        let token: string | undefined;
        do {
            const { json } = await provider.call('ListSecrets', {
                Filters: [{ Key: 'name', Values: [prefix] }],
                MaxResults: 100,
                ...(token ? { NextToken: token } : {}),
            });
            const page = json as { SecretList?: { Name: string }[]; NextToken?: string };
            names.push(...(page.SecretList ?? []).map((secret) => secret.Name));
            token = page.NextToken;
        } while (token);
        return names.sort();
    },
    async rekey(provider, row) {
        const version = randomUUID();
        await provider.call('PutSecretValue', {
            SecretId: row.provider_ref,
            ClientRequestToken: version,
            SecretBinary: await storedBinary(provider, row),
        });
        return version;
    },
    async tamper(provider, row) {
        const bytes = Buffer.from(await storedBinary(provider, row), 'base64');
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
        await provider.call('DeleteSecret', { SecretId: row.provider_ref, ForceDeleteWithoutRecovery: true });
        await provider.call('CreateSecret', {
            Name: row.provider_ref,
            ClientRequestToken: row.provider_version,
            SecretBinary: bytes.toString('base64'),
        });
    },
};

// The provider's stored bytes for a version exactly as it holds them (framing included), base64.
async function storedBinary(
    provider: AwsObjectClient,
    row: { provider_ref: string; provider_version: string }
): Promise<string> {
    const { json } = await provider.call('GetSecretValue', {
        SecretId: row.provider_ref,
        VersionId: row.provider_version,
    });
    return (json as { SecretBinary: string }).SecretBinary;
}
