import { describe, expect, it } from 'vitest';
import { CredentialError } from '../src/artifacts/s3-credentials.js';
import { classifyAnswer, createAwsObjectClient } from '../src/secrets/aws-secrets-manager.js';
import { ProviderFault } from '../src/secrets/secret-payloads.js';

/** The Secrets Manager adapter over a scripted fetch: the wire shape and what each answer means. */
const SENTINEL = 'sentinel-provider-body';
const KEYS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' };
const VERSION_ID = '7f1f0c4e-0000-4000-8000-000000000001';
const NAME = `pfx/sec_1/${VERSION_ID}`;
const utf8 = (value: string) => new TextEncoder().encode(value);
/** The adapter frames a payload with one leading byte, because Secrets Manager refuses an empty binary. */
const framed = (value: string) => Buffer.concat([Buffer.from([1]), Buffer.from(value)]).toString('base64');

interface Seen {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
}

type Script = (seen: Seen, init: RequestInit) => Response | Promise<Response>;

function client(script: Script, options: Partial<Parameters<typeof createAwsObjectClient>[0]> = {}) {
    const seen: Seen[] = [];
    const fetcher = (async (url: string | URL, init: RequestInit) => {
        const record = {
            url: String(url),
            headers: init.headers as Record<string, string>,
            body: JSON.parse(String(new TextDecoder().decode(init.body as Uint8Array))) as Record<string, unknown>,
        };
        seen.push(record);
        return script(record, init);
    }) as typeof fetch;
    const aws = createAwsObjectClient({
        region: 'eu-west-1',
        prefix: 'pfx',
        credentials: async () => KEYS,
        fetch: fetcher,
        requestMs: 500,
        ...options,
    });
    return { aws, seen };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const awsErrorBody = (status: number, body: unknown) => json(status, body);
const awsError = (status: number, type: string) => json(status, { __type: type, message: SENTINEL });

async function faultOf(promise: Promise<unknown>): Promise<ProviderFault> {
    const error = await promise.then(
        () => new Error('resolved'),
        (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ProviderFault);
    expect((error as Error).message).not.toContain(SENTINEL);
    return error as ProviderFault;
}

describe('the AWS Secrets Manager adapter: requests', () => {
    it('names objects <prefix>/<ref>/<versionId>', () => {
        const { aws } = client(() => json(200, {}));
        expect(aws.nameOf('sec_1', VERSION_ID)).toBe(NAME);
        expect(aws.storage).toBe('aws');
    });

    it('creates with the version id as the idempotency token, the payload as binary, signed for secretsmanager', async () => {
        const { aws, seen } = client(() => json(200, { Name: NAME, VersionId: VERSION_ID }));
        expect(await aws.put({ name: NAME, versionId: VERSION_ID, payload: utf8('hello') }, 1000, undefined)).toBe(
            'written'
        );
        expect(seen).toHaveLength(1);
        const request = seen[0] as Seen;
        expect(request.url).toBe('https://secretsmanager.eu-west-1.amazonaws.com/');
        expect(request.headers['x-amz-target']).toBe('secretsmanager.CreateSecret');
        expect(request.headers['content-type']).toBe('application/x-amz-json-1.1');
        expect(request.headers.authorization).toContain('/eu-west-1/secretsmanager/aws4_request');
        expect(request.body).toEqual({
            Name: NAME,
            ClientRequestToken: VERSION_ID,
            SecretBinary: framed('hello'),
        });
    });

    it('frames an empty payload so the provider never sees an empty binary', async () => {
        const { aws, seen } = client(() => json(200, { Name: NAME, VersionId: VERSION_ID }));
        await aws.put({ name: NAME, versionId: VERSION_ID, payload: new Uint8Array(0) }, 1000, undefined);
        expect(seen[0]?.body.SecretBinary).toBe(framed(''));
    });

    it('sends to the configured endpoint', async () => {
        const { aws, seen } = client(() => json(200, { Name: NAME, VersionId: VERSION_ID }), {
            endpoint: 'http://127.0.0.1:5999',
        });
        await aws.put({ name: NAME, versionId: VERSION_ID, payload: utf8('hello') }, 1000, undefined);
        expect(seen[0]?.url).toBe('http://127.0.0.1:5999/');
    });

    it('answers exists for a name that is already taken', async () => {
        const { aws } = client(() => awsError(400, 'ResourceExistsException'));
        expect(await aws.put({ name: NAME, versionId: VERSION_ID, payload: utf8('hello') }, 1000, undefined)).toBe(
            'exists'
        );
    });

    it('reads one version by id and decodes its binary', async () => {
        const { aws, seen } = client(() =>
            json(200, { Name: NAME, VersionId: VERSION_ID, SecretBinary: framed('hello') })
        );
        const read = await aws.get(NAME, VERSION_ID, 1000, undefined);
        expect(seen[0]?.headers['x-amz-target']).toBe('secretsmanager.GetSecretValue');
        expect(seen[0]?.body).toEqual({ SecretId: NAME, VersionId: VERSION_ID });
        expect(read).toMatchObject({ name: NAME, versionId: VERSION_ID });
        expect(new TextDecoder().decode((read as { payload: Uint8Array }).payload)).toBe('hello');
    });

    it('removes without a recovery window', async () => {
        const { aws, seen } = client(() => json(200, { Name: NAME }));
        await aws.remove(NAME, 1000, undefined);
        expect(seen[0]?.headers['x-amz-target']).toBe('secretsmanager.DeleteSecret');
        expect(seen[0]?.body).toEqual({ SecretId: NAME, ForceDeleteWithoutRecovery: true });
    });
});

describe('the AWS Secrets Manager adapter: what an answer means', () => {
    it('reads absent only for a ResourceNotFoundException', async () => {
        const { aws } = client(() => awsError(400, 'ResourceNotFoundException'));
        expect(await aws.get(NAME, VERSION_ID, 1000, undefined)).toBe('absent');
    });

    it.each([
        ['not json', new Response('<html>', { status: 200 })],
        ['a body with no binary', json(200, { Name: NAME, VersionId: VERSION_ID })],
        ['a string secret', json(200, { Name: NAME, VersionId: VERSION_ID, SecretString: 'x' })],
        ['binary that is not framed', json(200, { Name: NAME, VersionId: VERSION_ID, SecretBinary: 'aGVsbG8=' })],
        ['non-base64 binary', json(200, { Name: NAME, VersionId: VERSION_ID, SecretBinary: '***' })],
        ['a body with no name', json(200, { VersionId: VERSION_ID, SecretBinary: framed('hi') })],
        ['an empty object', json(200, {})],
        ['an array', json(200, [])],
    ])('reads malformed, never absent, for %s', async (_label, response) => {
        const { aws } = client(() => response);
        expect(await aws.get(NAME, VERSION_ID, 1000, undefined)).toBe('malformed');
    });

    it.each([
        [503, 'ServiceUnavailable', 'retry'],
        [500, 'InternalServiceError', 'retry'],
        [429, 'TooManyRequests', 'retry'],
        [400, 'ThrottlingException', 'retry'],
        [401, 'x', 'misconfigured'],
        [403, 'x', 'misconfigured'],
        [400, 'AccessDeniedException', 'misconfigured'],
        [400, 'UnrecognizedClientException', 'misconfigured'],
        [400, 'InvalidSignatureException', 'misconfigured'],
        [400, 'DecryptionFailure', 'misconfigured'],
        [400, 'InvalidParameterException', 'definitive'],
        [400, 'SomethingNew', 'retry'],
        [302, 'x', 'ambiguous'],
    ])('maps %i %s on a read to %s without the body', async (status, type, verdict) => {
        const { aws } = client(() => awsError(status, type));
        expect((await faultOf(aws.get(NAME, VERSION_ID, 1000, undefined))).verdict).toBe(verdict);
    });

    it('maps a failing write the same way', async () => {
        const { aws } = client(() => awsError(503, 'ServiceUnavailable'));
        expect(
            (await faultOf(aws.put({ name: NAME, versionId: VERSION_ID, payload: utf8('x') }, 1000, undefined))).verdict
        ).toBe('retry');
    });

    it('refreshes expired credentials once and repeats the request', async () => {
        const fresh: boolean[] = [];
        let answers = 0;
        const { aws, seen } = client(
            () => {
                answers += 1;
                return answers === 1
                    ? awsError(400, 'ExpiredTokenException')
                    : json(200, { Name: NAME, VersionId: VERSION_ID });
            },
            {
                credentials: async (options) => {
                    fresh.push(options?.fresh === true);
                    return KEYS;
                },
            }
        );
        expect(await aws.put({ name: NAME, versionId: VERSION_ID, payload: utf8('x') }, 1000, undefined)).toBe(
            'written'
        );
        expect(seen).toHaveLength(2);
        expect(fresh).toEqual([false, true]);
    });

    it('retries, not fails, when credentials are still expired after the refresh', async () => {
        const { aws, seen } = client(() => awsError(400, 'ExpiredTokenException'));
        expect((await faultOf(aws.get(NAME, VERSION_ID, 1000, undefined))).verdict).toBe('retry');
        expect(seen).toHaveLength(2);
    });

    it('treats a delete of a missing object as done', async () => {
        const { aws } = client(() => awsError(400, 'ResourceNotFoundException'));
        await expect(aws.remove(NAME, 1000, undefined)).resolves.toBeUndefined();
    });

    it('describes before believing an InvalidRequestException on delete means gone', async () => {
        const gone = client((seen) =>
            seen.headers['x-amz-target'] === 'secretsmanager.DeleteSecret'
                ? awsError(400, 'InvalidRequestException')
                : awsError(400, 'ResourceNotFoundException')
        );
        await expect(gone.aws.remove(NAME, 1000, undefined)).resolves.toBeUndefined();
        expect(gone.seen.map((s) => s.headers['x-amz-target'])).toEqual([
            'secretsmanager.DeleteSecret',
            'secretsmanager.DescribeSecret',
        ]);

        const still = client((seen) =>
            seen.headers['x-amz-target'] === 'secretsmanager.DeleteSecret'
                ? awsError(400, 'InvalidRequestException')
                : json(200, { Name: NAME })
        );
        expect((await faultOf(still.aws.remove(NAME, 1000, undefined))).verdict).toBe('definitive');

        // A describe that does not name the object proves nothing about it: the refusal stays unproven.
        for (const body of [{}, { Name: 'another/object' }]) {
            const unnamed = client((seen) =>
                seen.headers['x-amz-target'] === 'secretsmanager.DeleteSecret'
                    ? awsError(400, 'InvalidRequestException')
                    : json(200, body)
            );
            expect((await faultOf(unnamed.aws.remove(NAME, 1000, undefined))).verdict).toBe('ambiguous');
        }
    });

    it('never treats a failed delete as gone', async () => {
        const { aws } = client(() => awsError(503, 'ServiceUnavailable'));
        expect((await faultOf(aws.remove(NAME, 1000, undefined))).verdict).toBe('retry');
    });
});

describe('the AWS Secrets Manager adapter: transport', () => {
    const network = (code: string) => () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });
    };

    it.each([
        ['ECONNREFUSED', 'retry'],
        ['ENOTFOUND', 'retry'],
        ['UND_ERR_CONNECT_TIMEOUT', 'retry'],
        ['ECONNRESET', 'ambiguous'],
        ['UND_ERR_SOCKET', 'ambiguous'],
        ['SOMETHING_ELSE', 'ambiguous'],
    ])('maps a %s network error to %s', async (code, verdict) => {
        const { aws } = client(network(code));
        expect((await faultOf(aws.get(NAME, VERSION_ID, 1000, undefined))).verdict).toBe(verdict);
    });

    it('treats its own request timeout as ambiguous', async () => {
        const { aws } = client(
            (_seen, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
                }),
            { requestMs: 25 }
        );
        expect((await faultOf(aws.get(NAME, VERSION_ID, 5000, undefined))).verdict).toBe('ambiguous');
    });

    it('bounds a request by the budget it was given', async () => {
        const { aws } = client(
            (_seen, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
                }),
            { requestMs: 60_000 }
        );
        const started = Date.now();
        expect((await faultOf(aws.get(NAME, VERSION_ID, 40, undefined))).verdict).toBe('ambiguous');
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it('treats the caller aborting mid-flight as ambiguous', async () => {
        const abort = new AbortController();
        const { aws } = client(
            (_seen, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
                    setTimeout(() => abort.abort(), 10);
                })
        );
        expect(
            (await faultOf(aws.put({ name: NAME, versionId: VERSION_ID, payload: utf8('x') }, 5000, abort.signal)))
                .verdict
        ).toBe('ambiguous');
    });

    it('does not dispatch for a call that is already aborted', async () => {
        const abort = new AbortController();
        abort.abort();
        const { aws, seen } = client(() => json(200, {}));
        expect(
            (await faultOf(aws.put({ name: NAME, versionId: VERSION_ID, payload: utf8('x') }, 5000, abort.signal)))
                .verdict
        ).toBe('retry');
        expect(seen).toHaveLength(0);
    });

    it('does not start a request the remaining budget cannot cover, so a deadline never lands mid-flight', async () => {
        const { aws, seen } = client(() => json(200, {}));
        expect((await faultOf(aws.get(NAME, VERSION_ID, 5, undefined))).verdict).toBe('retry');
        expect(seen).toHaveLength(0);
    });

    it('rejects a body that errors mid-stream as ambiguous', async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(utf8('{"Name":'));
                controller.error(new Error('socket closed'));
            },
        });
        const { aws } = client(() => new Response(stream, { status: 200 }));
        expect((await faultOf(aws.get(NAME, VERSION_ID, 1000, undefined))).verdict).toBe('ambiguous');
    });

    it('cancels an oversize body instead of reading it', async () => {
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(1024).fill(65));
            },
            cancel() {
                cancelled = true;
            },
        });
        const { aws } = client(() => new Response(stream, { status: 200 }), { maxBodyBytes: 4096 });
        expect((await faultOf(aws.get(NAME, VERSION_ID, 1000, undefined))).verdict).toBe('ambiguous');
        expect(cancelled).toBe(true);
    });

    it('cancels the body of an error response it does not need', async () => {
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(1024).fill(65));
            },
            cancel() {
                cancelled = true;
            },
        });
        const { aws } = client(() => new Response(stream, { status: 503 }), { maxBodyBytes: 4096 });
        expect((await faultOf(aws.get(NAME, VERSION_ID, 1000, undefined))).verdict).toBe('retry');
        expect(cancelled).toBe(true);
    });
});

describe('the AWS Secrets Manager adapter: credentials', () => {
    it('maps a misconfigured credential source to misconfigured, and sends nothing', async () => {
        const { aws, seen } = client(() => json(200, {}), {
            credentials: async () => {
                throw new CredentialError('no credentials', 'misconfigured');
            },
        });
        expect((await faultOf(aws.get(NAME, VERSION_ID, 1000, undefined))).verdict).toBe('misconfigured');
        expect(seen).toHaveLength(0);
    });

    it('retries a credential source that is unavailable', async () => {
        const { aws } = client(() => json(200, {}), {
            credentials: async () => {
                throw new CredentialError('timed out', 'unavailable');
            },
        });
        expect((await faultOf(aws.get(NAME, VERSION_ID, 1000, undefined))).verdict).toBe('retry');
    });

    it('classifies any other credential failure as retry rather than leaking it', async () => {
        const { aws } = client(() => json(200, {}), {
            credentials: async () => {
                throw new Error(`boom ${SENTINEL}`);
            },
        });
        expect((await faultOf(aws.get(NAME, VERSION_ID, 1000, undefined))).verdict).toBe('retry');
    });
});

const created = () => json(200, { Name: NAME, VersionId: VERSION_ID });
const PUT = { name: NAME, versionId: VERSION_ID, payload: utf8('x') };
const targetOf = (seen: Seen) => seen.headers['x-amz-target'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SLACK_MS = 60;

describe('the AWS Secrets Manager adapter: a mutation answer is validated, never assumed', () => {
    it.each([
        ['null', () => json(200, null)],
        ['an empty object', () => json(200, {})],
        ['an array', () => json(200, [])],
        ['not json', () => new Response('<html>', { status: 200 })],
        ['another version', () => json(200, { Name: NAME, VersionId: 'other' })],
        ['another name', () => json(200, { Name: 'pfx/other/x', VersionId: VERSION_ID })],
        ['no version', () => json(200, { Name: NAME })],
    ])('leaves a create answered with %s ambiguous, never written', async (_label, answer) => {
        const { aws } = client(answer);
        expect((await faultOf(aws.put(PUT, 1000, undefined))).verdict).toBe('ambiguous');
    });

    it('leaves a create answered with an unreadable error ambiguous', async () => {
        const { aws } = client(() => new Response('<html>', { status: 400 }));
        expect((await faultOf(aws.put(PUT, 1000, undefined))).verdict).toBe('ambiguous');
    });

    it('leaves a write whose answer exceeds the body cap ambiguous, as the write may have landed', async () => {
        const { aws } = client(() => new Response(new Uint8Array(8192).fill(65), { status: 200 }), {
            maxBodyBytes: 4096,
        });
        expect((await faultOf(aws.put(PUT, 1000, undefined))).verdict).toBe('ambiguous');
    });

    it('never reads an oversize answer as absent', async () => {
        const { aws } = client(() => new Response(new Uint8Array(8192).fill(65), { status: 400 }), {
            maxBodyBytes: 4096,
        });
        expect((await faultOf(aws.get(NAME, VERSION_ID, 1000, undefined))).verdict).toBe('ambiguous');
    });

    it.each([
        ['null', () => json(200, null)],
        ['an empty object', () => json(200, {})],
        ['another name', () => json(200, { Name: 'pfx/other/x' })],
        ['not json', () => new Response('<html>', { status: 200 })],
    ])('does not believe a delete answered with %s until a describe says it is gone', async (_label, answer) => {
        const still = client((seen) =>
            targetOf(seen) === 'secretsmanager.DeleteSecret' ? answer() : json(200, { Name: NAME })
        );
        expect((await faultOf(still.aws.remove(NAME, 1000, undefined))).verdict).not.toBe('definitive');
        expect(still.seen.map(targetOf)).toEqual(['secretsmanager.DeleteSecret', 'secretsmanager.DescribeSecret']);

        const gone = client((seen) =>
            targetOf(seen) === 'secretsmanager.DeleteSecret' ? answer() : awsError(400, 'ResourceNotFoundException')
        );
        await expect(gone.aws.remove(NAME, 1000, undefined)).resolves.toBeUndefined();
    });

    it('does not believe a delete whose answer exceeds the body cap', async () => {
        const { aws } = client(() => new Response(new Uint8Array(8192).fill(65), { status: 200 }), {
            maxBodyBytes: 4096,
        });
        await expect(aws.remove(NAME, 1000, undefined)).rejects.toBeInstanceOf(ProviderFault);
    });

    it('never treats an unreadable describe as the object being gone', async () => {
        const { aws } = client((seen) =>
            targetOf(seen) === 'secretsmanager.DeleteSecret' ? json(200, null) : new Response('<html>', { status: 400 })
        );
        await expect(aws.remove(NAME, 1000, undefined)).rejects.toBeInstanceOf(ProviderFault);
    });
});

describe('the AWS Secrets Manager adapter: one absolute deadline across nested exchanges', () => {
    const DEADLINE_MS = 40;
    const LATE_MS = 90;

    it('returns by its deadline and dispatches nothing after it when credentials are late', async () => {
        const { aws, seen } = client(created, {
            credentials: async () => {
                await sleep(LATE_MS);
                return KEYS;
            },
        });
        const started = Date.now();
        expect((await faultOf(aws.put(PUT, DEADLINE_MS, undefined))).verdict).toBe('retry');
        expect(Date.now() - started).toBeLessThan(DEADLINE_MS + SLACK_MS);
        await sleep(LATE_MS + SLACK_MS);
        expect(seen).toHaveLength(0);
    });

    it('stops waiting for late credentials when the caller aborts', async () => {
        const abort = new AbortController();
        const { aws, seen } = client(created, {
            credentials: async () => {
                await sleep(LATE_MS);
                return KEYS;
            },
        });
        setTimeout(() => abort.abort(), 10);
        const started = Date.now();
        await faultOf(aws.put(PUT, 5000, abort.signal));
        expect(Date.now() - started).toBeLessThan(LATE_MS);
        await sleep(LATE_MS + SLACK_MS);
        expect(seen).toHaveLength(0);
    });

    it('does not repeat an expired-token request when the refreshed credentials arrive after the deadline', async () => {
        const { aws, seen } = client(() => awsError(400, 'ExpiredTokenException'), {
            credentials: async (options) => {
                if (options?.fresh) {
                    await sleep(LATE_MS);
                }
                return KEYS;
            },
        });
        const started = Date.now();
        expect((await faultOf(aws.get(NAME, VERSION_ID, 80, undefined))).verdict).toBe('retry');
        expect(Date.now() - started).toBeLessThan(80 + SLACK_MS);
        await sleep(LATE_MS + SLACK_MS);
        expect(seen).toHaveLength(1);
    });

    it('does not verify a delete after the budget its first exchange left is spent', async () => {
        const { aws, seen } = client(async (request) => {
            await sleep(45);
            return targetOf(request) === 'secretsmanager.DeleteSecret'
                ? awsError(400, 'InvalidRequestException')
                : awsError(400, 'ResourceNotFoundException');
        });
        const started = Date.now();
        await faultOf(aws.remove(NAME, 60, undefined));
        expect(Date.now() - started).toBeLessThan(60 + SLACK_MS);
        await sleep(LATE_MS);
        expect(seen.map(targetOf)).toEqual(['secretsmanager.DeleteSecret']);
    });

    it('does not verify a delete when the describe credentials arrive after the deadline', async () => {
        let calls = 0;
        const { aws, seen } = client(() => awsError(400, 'InvalidRequestException'), {
            credentials: async () => {
                calls += 1;
                if (calls > 1) {
                    await sleep(LATE_MS);
                }
                return KEYS;
            },
        });
        const started = Date.now();
        await faultOf(aws.remove(NAME, 80, undefined));
        expect(Date.now() - started).toBeLessThan(80 + SLACK_MS);
        await sleep(LATE_MS + SLACK_MS);
        expect(seen).toHaveLength(1);
    });
});

describe('the AWS Secrets Manager adapter: an error is evidence only under a recognized type and its status', () => {
    const NOT_FOUND_ON_SUCCESS = () => json(200, { __type: 'ResourceNotFoundException' });
    const malformedErrors: Array<[string, () => Response]> = [
        ['an empty type', () => awsErrorBody(400, { __type: '' })],
        ['no type', () => awsErrorBody(400, { message: SENTINEL })],
        ['an unknown type', () => awsErrorBody(400, { __type: 'SomethingNew' })],
        ['a non-string type', () => awsErrorBody(400, { __type: 7 })],
        ['a namespace with an empty type', () => awsErrorBody(400, { __type: 'com.amazon#' })],
    ];

    it('does not confirm a delete from a 200 that carries ResourceNotFoundException', async () => {
        const { aws } = client(NOT_FOUND_ON_SUCCESS);
        expect((await faultOf(aws.remove(NAME, 1000, undefined))).verdict).toBe('ambiguous');
    });

    it('does not confirm a delete from a describe that is a 200 carrying ResourceNotFoundException', async () => {
        const { aws, seen } = client((s) =>
            targetOf(s) === 'secretsmanager.DeleteSecret'
                ? awsError(400, 'InvalidRequestException')
                : NOT_FOUND_ON_SUCCESS()
        );
        expect((await faultOf(aws.remove(NAME, 1000, undefined))).verdict).toBe('ambiguous');
        expect(seen.map(targetOf)).toEqual(['secretsmanager.DeleteSecret', 'secretsmanager.DescribeSecret']);
    });

    it('does not read absent from a 200 that carries ResourceNotFoundException', async () => {
        const { aws } = client(NOT_FOUND_ON_SUCCESS);
        expect(await aws.get(NAME, VERSION_ID, 1000, undefined)).toBe('malformed');
    });

    it('does not confirm a delete from ResourceNotFoundException under a status that is not documented for it', async () => {
        const { aws } = client(() => json(409, { __type: 'ResourceNotFoundException' }));
        expect((await faultOf(aws.remove(NAME, 1000, undefined))).verdict).toBe('ambiguous');
    });

    it.each(malformedErrors)('leaves a create answered 400 with %s ambiguous', async (_label, answer) => {
        const { aws } = client(answer);
        expect((await faultOf(aws.put(PUT, 1000, undefined))).verdict).toBe('ambiguous');
    });

    it.each(malformedErrors)('never reads absent from a 400 with %s', async (_label, answer) => {
        const { aws } = client(answer);
        expect((await faultOf(aws.get(NAME, VERSION_ID, 1000, undefined))).verdict).toBe('retry');
    });

    it.each(malformedErrors)('never confirms a delete answered 400 with %s', async (_label, answer) => {
        const { aws } = client(answer);
        expect((await faultOf(aws.remove(NAME, 1000, undefined))).verdict).toBe('ambiguous');
    });

    it('treats a 2xx carrying an error type on a create as unconfirmed', async () => {
        const { aws } = client(() => json(200, { __type: 'ResourceExistsException' }));
        expect((await faultOf(aws.put(PUT, 1000, undefined))).verdict).toBe('ambiguous');
    });

    it('does not believe a ResourceExistsException under a status that is not documented for it', async () => {
        const { aws } = client(() => json(404, { __type: 'ResourceExistsException' }));
        expect((await faultOf(aws.put(PUT, 1000, undefined))).verdict).toBe('ambiguous');
    });
});

describe('the AWS Secrets Manager adapter: a status no one documents proves nothing about a write', () => {
    it.each([100, 302, 304])('leaves a create answered %i ambiguous, not definitively failed', async (status) => {
        const { aws } = client(() => json(200, {}), {
            fetch: (async () => ({ status, body: null, headers: new Headers() })) as unknown as typeof fetch,
        });
        expect((await faultOf(aws.put(PUT, 1000, undefined))).verdict).toBe('ambiguous');
    });
});

describe('classifyAnswer: the one classifier of a provider answer', () => {
    const DOCUMENTED_400 = [
        ['ResourceNotFoundException', 'notFound'],
        ['ResourceExistsException', 'exists'],
        ['InvalidRequestException', 'invalidRequest'],
        ['ValidationException', 'definitive'],
        ['InvalidParameterException', 'definitive'],
    ] as const;
    const ANY_STATUS = [
        ['ExpiredTokenException', 'expired'],
        ['AccessDeniedException', 'misconfigured'],
        ['UnrecognizedClientException', 'misconfigured'],
        ['ThrottlingException', 'retry'],
        ['InternalServiceError', 'retry'],
    ] as const;

    it('accepts ResourceNotFoundException under 404 too, as an AWS-compatible emulator answers it', () => {
        expect(classifyAnswer(404, { __type: 'ResourceNotFoundException' })).toMatchObject({ class: 'notFound' });
    });

    it.each(DOCUMENTED_400)('%s is %s under 400 and with a namespace prefix', (type, errorClass) => {
        expect(classifyAnswer(400, { __type: type })).toEqual({ kind: 'error', type, class: errorClass });
        expect(classifyAnswer(400, { __type: `com.amazonaws.secretsmanager#${type}` })).toEqual({
            kind: 'error',
            type,
            class: errorClass,
        });
    });

    it.each(DOCUMENTED_400)('%s is unrecognized under any other status', (type) => {
        for (const status of [200, 201, 302, 409, 500]) {
            expect(classifyAnswer(status, { __type: type })).toEqual({ kind: 'unrecognized' });
        }
    });

    it.each(ANY_STATUS)('%s is %s under an error status and unrecognized under a 2xx', (type, errorClass) => {
        for (const status of [400, 403, 500]) {
            expect(classifyAnswer(status, { __type: type })).toEqual({ kind: 'error', type, class: errorClass });
        }
        expect(classifyAnswer(200, { __type: type })).toEqual({ kind: 'unrecognized' });
    });

    it.each([
        [400, { __type: '' }],
        [400, { __type: 'com#' }],
        [400, { __type: 'SomethingNew' }],
        [400, { __type: null }],
        [400, {}],
        [400, null],
        [400, []],
        [400, 'ResourceNotFoundException'],
        [200, null],
        [200, []],
        [200, 'x'],
    ])('%i %j is unrecognized', (status, body) => {
        expect(classifyAnswer(status, body)).toEqual({ kind: 'unrecognized' });
    });

    it('is ok only for a 2xx JSON object that names no error', () => {
        expect(classifyAnswer(200, { Name: 'x' })).toEqual({ kind: 'ok', json: { Name: 'x' } });
        expect(classifyAnswer(200, { Name: 'x', __type: 'Anything' })).toEqual({ kind: 'unrecognized' });
    });
});
