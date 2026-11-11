import { describe, expect, it } from 'vitest';
import { CredentialError } from '../src/artifacts/s3-credentials.js';
import { createGcpObjectClient } from '../src/secrets/gcp-secret-manager.js';
import { ProviderFault } from '../src/secrets/secret-payloads.js';
import { GCP_TEST_PROJECT, createGcpEmulator } from '../test-db/secrets-gcp-provider.js';

/** The Secret Manager adapter (docs/secrets.md): every name starts with the prefix, no list, no destroy. */
const PREFIX = 'bellows-test-';
const REF = 'sec_00000000-0000-4000-8000-000000000001';
const VERSION = '00000000-0000-4000-8000-000000000002';
const BUDGET = 2000;
const bytes = (text: string) => new TextEncoder().encode(text);
const plain = (value: unknown) => ({
    ...(value as object),
    payload: Buffer.from((value as { payload: Uint8Array }).payload),
});
const framed = (text: string) => Buffer.concat([Buffer.from([1]), Buffer.from(text)]);

function setup(
    options: {
        fence?: string;
        kmsKey?: string | null;
        wrap?: (inner: typeof fetch) => typeof fetch;
        credentials?: Parameters<typeof createGcpObjectClient>[0]['credentials'];
    } = {}
) {
    const emulator = createGcpEmulator(options.fence === undefined ? {} : { fence: options.fence });
    const client = createGcpObjectClient({
        project: GCP_TEST_PROJECT,
        prefix: PREFIX,
        location: 'europe-west3',
        kmsKey: options.kmsKey ?? null,
        endpoint: 'https://secretmanager.test',
        credentials: options.credentials ?? (async () => ({ token: 'tok', quotaProject: null })),
        fetch: options.wrap ? options.wrap(emulator.fetch) : emulator.fetch,
    });
    return { emulator, client, name: client.nameOf(REF, VERSION) };
}

const verdictOf = async (promise: Promise<unknown>) => {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(ProviderFault);
        return (error as ProviderFault).verdict;
    }
    throw new Error('expected a ProviderFault');
};

const answering =
    (match: (method: string, path: string) => boolean, response: () => Response) =>
    (inner: typeof fetch): typeof fetch =>
    async (url, init) =>
        match(init?.method ?? 'GET', new URL(String(url)).pathname) ? response() : inner(url, init);

const gcpError = (status: number, code: string, message = 'refused') =>
    new Response(JSON.stringify({ error: { code: status, status: code, message } }), { status });

describe('the gcp object client', () => {
    it('names every object under the prefix and calls only create, addVersion, access and delete on it', async () => {
        const { emulator, client, name } = setup({ fence: PREFIX });
        expect(name.startsWith(PREFIX)).toBe(true);
        expect(await client.put({ name, versionId: VERSION, payload: bytes('v1') }, BUDGET, undefined)).toBe('written');
        const read = await client.get(name, VERSION, BUDGET, undefined);
        expect(plain(read)).toEqual({ name, versionId: VERSION, payload: Buffer.from('v1') });
        await client.remove(name, BUDGET, undefined);
        const calls = emulator.requests.map((request) => `${request.method} ${request.path.split('/secrets')[1]}`);
        expect(calls).toEqual([
            `POST ?secretId=${encodeURIComponent(name)}`,
            `POST /${name}:addVersion`,
            `GET /${name}/versions/1:access`,
            `DELETE /${name}`,
        ]);
        expect(emulator.requests.every((request) => request.secretId === null || request.secretId === name)).toBe(true);
    });

    it('creates the secret with user-managed replication in one location, and with a customer-managed key when set', async () => {
        const kms = 'projects/p/locations/europe-west3/keyRings/r/cryptoKeys/k';
        const { emulator, client, name } = setup({ kmsKey: kms });
        await client.put({ name, versionId: VERSION, payload: bytes('x') }, BUDGET, undefined);
        expect(emulator.requests[0]?.body).toEqual({
            replication: {
                userManaged: {
                    replicas: [{ location: 'europe-west3', customerManagedEncryption: { kmsKeyName: kms } }],
                },
            },
        });
        const plain = setup();
        await plain.client.put({ name: plain.name, versionId: VERSION, payload: bytes('x') }, BUDGET, undefined);
        expect(plain.emulator.requests[0]?.body).toEqual({
            replication: { userManaged: { replicas: [{ location: 'europe-west3' }] } },
        });
    });

    it('stores an empty payload as bytes and reads it back empty', async () => {
        const { client, name } = setup();
        await client.put({ name, versionId: VERSION, payload: new Uint8Array() }, BUDGET, undefined);
        expect(plain(await client.get(name, VERSION, BUDGET, undefined))).toEqual({
            name,
            versionId: VERSION,
            payload: Buffer.alloc(0),
        });
    });

    it('treats a taken name with a readable version as existing and writes nothing more', async () => {
        const { emulator, client, name } = setup();
        emulator.seed(name, [framed('earlier')]);
        expect(await client.put({ name, versionId: VERSION, payload: bytes('v1') }, BUDGET, undefined)).toBe('exists');
        expect(emulator.requests.some((request) => request.path.endsWith(':addVersion'))).toBe(false);
        expect(emulator.first(name)).toEqual(framed('earlier'));
    });

    it('finishes a write that crashed between the secret and its version', async () => {
        const { emulator, client, name } = setup();
        emulator.seed(name, []);
        expect(await client.put({ name, versionId: VERSION, payload: bytes('v1') }, BUDGET, undefined)).toBe('written');
        expect(emulator.first(name)).toEqual(framed('v1'));
    });

    it('refreshes a refused token once and repeats the call', async () => {
        const fresh: boolean[] = [];
        let refused = true;
        const { client, name } = setup({
            credentials: async (options) => {
                fresh.push(options?.fresh === true);
                return { token: 'tok', quotaProject: null };
            },
            wrap: answering(
                (method, path) => refused && method === 'POST' && path.endsWith('/secrets'),
                () => {
                    refused = false;
                    return gcpError(401, 'UNAUTHENTICATED');
                }
            ),
        });
        expect(await client.put({ name, versionId: VERSION, payload: bytes('v1') }, BUDGET, undefined)).toBe('written');
        expect(fresh).toEqual([false, true, false]);
    });

    it('sends the quota project of a user credential', async () => {
        let header: string | undefined;
        const { client, name } = setup({
            credentials: async () => ({ token: 'tok', quotaProject: 'quota-1' }),
            wrap: (inner) => async (url, init) => {
                header = (init?.headers as Record<string, string> | undefined)?.['x-goog-user-project'];
                return inner(url, init);
            },
        });
        await client.put({ name, versionId: VERSION, payload: bytes('v1') }, BUDGET, undefined);
        expect(header).toBe('quota-1');
    });

    it('reports a credential that is misconfigured as misconfigured and a late one as a retry', async () => {
        const broken = setup({
            credentials: async () => {
                throw new CredentialError('bad', 'misconfigured');
            },
        });
        expect(await verdictOf(broken.client.get(broken.name, VERSION, BUDGET, undefined))).toBe('misconfigured');
        const down = setup({
            credentials: async () => {
                throw new CredentialError('down', 'unavailable');
            },
        });
        expect(await verdictOf(down.client.get(down.name, VERSION, BUDGET, undefined))).toBe('retry');
    });

    describe('what a read concludes', () => {
        it('says absent only for a not-found that names the secret', async () => {
            const { client, name } = setup();
            expect(await client.get(name, VERSION, BUDGET, undefined)).toBe('absent');
        });

        it.each([
            ['a not-found that names nothing', () => gcpError(404, 'NOT_FOUND', 'Project not found.')],
            ['a server error', () => gcpError(500, 'INTERNAL')],
            ['an overload', () => gcpError(429, 'RESOURCE_EXHAUSTED')],
            ['a refused version', () => gcpError(400, 'FAILED_PRECONDITION')],
            ['a body that is not an error', () => new Response('<html>', { status: 404 })],
            ['an empty body', () => new Response('', { status: 500 })],
            ['a 200 with no body', () => new Response('', { status: 200 })],
        ])('never says absent for %s', async (_what, response) => {
            const { client, name } = setup({ wrap: answering((method) => method === 'GET', response) });
            expect(await verdictOf(client.get(name, VERSION, BUDGET, undefined))).toBe(
                _what === 'a refused version' ? 'definitive' : 'retry'
            );
        });

        it('reports a permission failure as misconfigured', async () => {
            const { client, name } = setup({
                wrap: answering(
                    (method) => method === 'GET',
                    () => gcpError(403, 'PERMISSION_DENIED')
                ),
            });
            expect(await verdictOf(client.get(name, VERSION, BUDGET, undefined))).toBe('misconfigured');
        });

        it.each([
            ['an unframed payload', (n: string) => ({ name: `x/secrets/${n}/versions/1`, payload: { data: 'AAA=' } })],
            [
                'a payload that is not base64',
                (n: string) => ({ name: `x/secrets/${n}/versions/1`, payload: { data: '%%%' } }),
            ],
            ['an answer for another secret', () => ({ name: 'x/secrets/OTHER/versions/1', payload: { data: 'AQ==' } })],
            ['an answer with no payload', (n: string) => ({ name: `x/secrets/${n}/versions/1` })],
        ])('is malformed for %s', async (_what, json) => {
            const { client, name } = setup({
                wrap: answering(
                    (method) => method === 'GET',
                    () => new Response(JSON.stringify(json(name)), { status: 200 })
                ),
            });
            expect(await client.get(name, VERSION, BUDGET, undefined)).toBe('malformed');
        });
    });

    describe('what a write concludes', () => {
        it.each([
            ['create', (method: string, path: string) => method === 'POST' && path.endsWith('/secrets')],
            ['addVersion', (_method: string, path: string) => path.endsWith(':addVersion')],
        ])('is ambiguous for an unconfirmed %s answer and misconfigured for a refused one', async (_step, match) => {
            const wrong = setup({ wrap: answering(match, () => new Response('{}', { status: 200 })) });
            expect(
                await verdictOf(
                    wrong.client.put({ name: wrong.name, versionId: VERSION, payload: bytes('x') }, BUDGET, undefined)
                )
            ).toBe('ambiguous');
            const refused = setup({ wrap: answering(match, () => gcpError(403, 'PERMISSION_DENIED')) });
            expect(
                await verdictOf(
                    refused.client.put(
                        { name: refused.name, versionId: VERSION, payload: bytes('x') },
                        BUDGET,
                        undefined
                    )
                )
            ).toBe('misconfigured');
            const internal = setup({ wrap: answering(match, () => gcpError(500, 'INTERNAL')) });
            expect(
                await verdictOf(
                    internal.client.put(
                        { name: internal.name, versionId: VERSION, payload: bytes('x') },
                        BUDGET,
                        undefined
                    )
                )
            ).toBe('ambiguous');
            const invalid = setup({ wrap: answering(match, () => gcpError(400, 'INVALID_ARGUMENT')) });
            expect(
                await verdictOf(
                    invalid.client.put(
                        { name: invalid.name, versionId: VERSION, payload: bytes('x') },
                        BUDGET,
                        undefined
                    )
                )
            ).toBe('definitive');
        });
    });

    describe('removal', () => {
        it('deletes the secret, so the old value can no longer be read, and a repeat is still gone', async () => {
            const { emulator, client, name } = setup();
            await client.put({ name, versionId: VERSION, payload: bytes('v1') }, BUDGET, undefined);
            await client.remove(name, BUDGET, undefined);
            expect(emulator.first(name)).toBeNull();
            expect(await client.get(name, VERSION, BUDGET, undefined)).toBe('absent');
            await client.remove(name, BUDGET, undefined);
            expect(emulator.requests.some((request) => request.path.includes('destroy'))).toBe(false);
        });

        it.each([
            ['an unavailable service', () => gcpError(503, 'UNAVAILABLE'), 'retry'],
            ['a server error', () => gcpError(500, 'INTERNAL'), 'ambiguous'],
            ['a not-found that names nothing', () => gcpError(404, 'NOT_FOUND', 'Project not found.'), 'ambiguous'],
            ['an empty answer', () => new Response('', { status: 200 }), 'ambiguous'],
            ['an empty object under another 2xx status', () => new Response('{}', { status: 202 }), 'ambiguous'],
            ['an acknowledgement that is not empty', () => new Response('{"error":"x"}', { status: 200 }), 'ambiguous'],
            ['a permission failure', () => gcpError(403, 'PERMISSION_DENIED'), 'misconfigured'],
        ])('never reports gone for %s', async (_what, response, verdict) => {
            const { client, name } = setup({ wrap: answering((method) => method === 'DELETE', response) });
            expect(await verdictOf(client.remove(name, BUDGET, undefined))).toBe(verdict);
        });
    });

    it('is fenced in by an IAM condition on the prefix: a name outside it is refused, and listing is never needed', async () => {
        const { emulator, client } = setup({ fence: 'another-' });
        const name = client.nameOf(REF, VERSION);
        await client.put({ name, versionId: VERSION, payload: bytes('x') }, BUDGET, undefined).catch(() => undefined);
        expect(await verdictOf(client.get(name, VERSION, BUDGET, undefined))).toBe('misconfigured');
        expect(emulator.requests.every((request) => request.method !== 'GET' || request.path.endsWith(':access'))).toBe(
            true
        );
    });
});
