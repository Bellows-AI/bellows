import { CONTENT_TYPE_HEADER } from '@factory-ai/core';
import { CredentialError, type CredentialProvider } from '../artifacts/s3-credentials.js';
import { type Credentials, sha256Hex, signRequest } from '../artifacts/sigv4.js';
import type { ObjectClient, ObjectRead } from './external-payloads.js';
import { createProviderHttp } from './provider-http.js';
import { type FaultVerdict, ProviderFault } from './secret-payloads.js';

/**
 * The AWS Secrets Manager adapter (docs/secrets.md): raw JSON 1.1 requests signed with `artifacts/sigv4.ts`,
 * no SDK. One Secrets Manager secret per storage version, named `<prefix>/<ref>/<versionId>`, holds the payload
 * as `SecretBinary` and is created with `ClientRequestToken = versionId`, which makes the write idempotent:
 * AWS accepts the same token with the same bytes again and refuses other bytes. Removal is
 * `ForceDeleteWithoutRecovery`, so plaintext never lingers in a recovery window.
 */

const JSON_1_1 = 'application/x-amz-json-1.1';
const SERVICE = 'secretsmanager';
const DEFAULT_CALL_MS = 5000;
const HTTP_OK = 200;
const HTTP_REDIRECT = 300;
/** Secrets Manager refuses an empty `SecretBinary`, and an empty payload is valid, so every payload is framed. */
const FRAME = 0x01;

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_STATUS_LIMIT = 600;
const ANY_ERROR_STATUS = 'any';

/** What a recognized error type means to a caller. */
type ErrorClass = 'notFound' | 'exists' | 'invalidRequest' | 'expired' | 'definitive' | 'misconfigured' | 'retry';

/**
 * Every error type the adapter acts on, with the HTTP status AWS answers it with (`any`: a 4xx or 5xx, as the
 * status differs between the AWS front ends and emulators; a missing secret is 400 on AWS, 404 on moto). A type outside this table, or a known type under
 * another status, is no evidence of anything.
 */
const KNOWN_ERRORS = new Map<string, { class: ErrorClass; status: readonly number[] | typeof ANY_ERROR_STATUS }>([
    ['ResourceNotFoundException', { class: 'notFound', status: [HTTP_BAD_REQUEST, HTTP_NOT_FOUND] }],
    ['ResourceExistsException', { class: 'exists', status: [HTTP_BAD_REQUEST] }],
    ['InvalidRequestException', { class: 'invalidRequest', status: [HTTP_BAD_REQUEST] }],
    ['ValidationException', { class: 'definitive', status: [HTTP_BAD_REQUEST] }],
    ['InvalidParameterException', { class: 'definitive', status: [HTTP_BAD_REQUEST] }],
    ['ExpiredTokenException', { class: 'expired', status: ANY_ERROR_STATUS }],
    ['ExpiredToken', { class: 'expired', status: ANY_ERROR_STATUS }],
    // Credentials or their permissions are wrong; waiting does not help.
    ...[
        'AccessDeniedException',
        'AccessDenied',
        'UnrecognizedClientException',
        'InvalidSignatureException',
        'InvalidClientTokenId',
        'IncompleteSignature',
        'MissingAuthenticationToken',
        'MissingAuthenticationTokenException',
        'DecryptionFailure',
        'EncryptionFailure',
    ].map((type) => [type, { class: 'misconfigured', status: ANY_ERROR_STATUS }] as const),
    // The provider is busy or failing, not the request wrong.
    ...[
        'ThrottlingException',
        'ThrottledException',
        'RequestLimitExceeded',
        'InternalServiceError',
        'ServiceUnavailable',
        'ServiceUnavailableException',
        'RequestTimeout',
        'RequestTimeoutException',
    ].map((type) => [type, { class: 'retry', status: ANY_ERROR_STATUS }] as const),
]);

/** What one provider answer proves, decided in one place for every call. */
export type AwsAnswer =
    /** A 2xx whose body is a JSON object naming no error. */
    | { kind: 'ok'; json: Record<string, unknown> }
    /** An error status carrying a recognized, non-empty type under the status AWS documents for it. */
    | { kind: 'error'; type: string; class: ErrorClass }
    /** Anything else: a 2xx carrying an error or no object, an unreadable body, an unknown or empty type. */
    | { kind: 'unrecognized' };

export interface AwsObjectClientOptions {
    region: string;
    /** Every object name starts with this; the deployment's namespace in the account. */
    prefix: string;
    /** For an AWS-compatible endpoint (a development emulator); absent for the regional AWS endpoint. */
    endpoint?: string | undefined;
    credentials: CredentialProvider;
    fetch?: typeof fetch | undefined;
    requestMs?: number | undefined;
    maxBodyBytes?: number | undefined;
    now?: (() => Date) | undefined;
}

interface AwsRequest {
    target: string;
    body: Record<string, unknown>;
    /** Absolute (epoch ms): one deadline for the whole outer call, however many exchanges it takes. */
    deadlineAt: number;
    signal: AbortSignal | undefined;
}

export interface AwsCallResult {
    status: number;
    /** The parsed body; null when it was not JSON. */
    json: unknown;
    answer: AwsAnswer;
}

export interface AwsObjectClient extends ObjectClient {
    /** One signed Secrets Manager call, answered with whatever the provider said; transport faults throw. */
    call(
        target: string,
        body: Record<string, unknown>,
        budgetMs?: number,
        signal?: AbortSignal | undefined
    ): Promise<AwsCallResult>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function errorType(json: unknown): string | null {
    const raw = isObject(json) ? json.__type : undefined;
    return typeof raw === 'string' ? (raw.split('#').pop() ?? '') : null;
}

/** The single classifier of a provider answer: no call reads a status, a type or a body any other way. */
export function classifyAnswer(status: number, json: unknown): AwsAnswer {
    const type = errorType(json);
    if (status >= HTTP_OK && status < HTTP_REDIRECT) {
        return isObject(json) && !('__type' in json) ? { kind: 'ok', json } : { kind: 'unrecognized' };
    }
    const known = type ? KNOWN_ERRORS.get(type) : undefined;
    if (!known || status < HTTP_BAD_REQUEST) {
        return { kind: 'unrecognized' };
    }
    const statusMatches =
        known.status === ANY_ERROR_STATUS ? status < HTTP_STATUS_LIMIT : known.status.includes(status);
    return statusMatches && type ? { kind: 'error', type, class: known.class } : { kind: 'unrecognized' };
}

/**
 * The verdict of an answer that is no success the caller expected. A recognized error carries its own; anything
 * else is no evidence, so it takes `unproven`: `ambiguous` where a request may have landed, `retry` for a read.
 */
function verdictOf(answer: AwsAnswer, unproven: FaultVerdict): FaultVerdict {
    if (answer.kind !== 'error') {
        return unproven;
    }
    switch (answer.class) {
        case 'misconfigured':
            return 'misconfigured';
        case 'retry':
        case 'expired':
            return 'retry';
        case 'definitive':
        case 'invalidRequest':
            return 'definitive';
        default:
            return unproven;
    }
}

const isError = (answer: AwsAnswer, errorClass: ErrorClass) => answer.kind === 'error' && answer.class === errorClass;

/** The payload bytes of a `SecretBinary`, or null when it is not canonical base64 of a framed payload. */
function unframe(encoded: unknown): Uint8Array | null {
    if (typeof encoded !== 'string') {
        return null;
    }
    const bytes = Buffer.from(encoded, 'base64');
    return bytes.toString('base64') === encoded && bytes.length > 0 && bytes[0] === FRAME ? bytes.subarray(1) : null;
}

const fail = (verdict: FaultVerdict): never => {
    throw new ProviderFault(verdict);
};

/**
 * Resolves only once the provider has said the object is gone: a delete answer that does not name the object, or
 * a refusal as an invalid request, is checked with a describe, and anything but a ResourceNotFound there leaves
 * the object believed present.
 */
async function removeBy(
    send: (target: string, body: Record<string, unknown>) => Promise<AwsCallResult>,
    name: string
): Promise<void> {
    const { answer: deleted } = await send('DeleteSecret', { SecretId: name, ForceDeleteWithoutRecovery: true });
    if (isError(deleted, 'notFound') || (deleted.kind === 'ok' && deleted.json.Name === name)) {
        return;
    }
    if (deleted.kind === 'error' && !isError(deleted, 'invalidRequest')) {
        return fail(verdictOf(deleted, 'ambiguous'));
    }
    const { answer: described } = await send('DescribeSecret', { SecretId: name });
    if (isError(described, 'notFound')) {
        return;
    }
    // An unconfirmed delete never says the object is gone; a refused one with the object still there is final,
    // and only a describe that names the object says it is still there.
    const stillThere = described.kind === 'ok' && described.json.Name === name;
    return fail(deleted.kind === 'error' && stillThere ? 'definitive' : verdictOf(described, 'ambiguous'));
}

/**
 * The credentials, or a fault once the deadline or the caller's abort comes first: a waiter never waits past its
 * own deadline, and a late answer is dropped. Nothing reached the provider yet, so running out of time here is a
 * retry and a credential failure is never ambiguous.
 */
async function withinDeadline(
    pending: Promise<Credentials>,
    deadlineAt: number,
    signal: AbortSignal | undefined
): Promise<Credentials> {
    pending.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderFault('retry')), Math.max(0, deadlineAt - Date.now()));
        onAbort = () => reject(new ProviderFault('retry'));
        if (signal?.aborted) {
            onAbort();
        } else {
            signal?.addEventListener('abort', onAbort, { once: true });
        }
    });
    stop.catch(() => undefined);
    try {
        return await Promise.race([pending, stop]);
    } catch (error) {
        if (error instanceof ProviderFault) {
            throw error;
        }
        throw new ProviderFault(
            error instanceof CredentialError && error.kind === 'misconfigured' ? 'misconfigured' : 'retry'
        );
    } finally {
        clearTimeout(timer);
        if (onAbort) {
            signal?.removeEventListener('abort', onAbort);
        }
    }
}

export function createAwsObjectClient(options: AwsObjectClientOptions): AwsObjectClient {
    const { region, prefix } = options;
    const url = new URL(options.endpoint ?? `https://${SERVICE}.${region}.amazonaws.com`);
    const http = createProviderHttp({
        fetch: options.fetch,
        requestMs: options.requestMs,
        maxBodyBytes: options.maxBodyBytes,
    });
    const now = options.now ?? (() => new Date());

    const credentialsBy = (request: AwsRequest, fresh: boolean) =>
        withinDeadline(options.credentials(fresh ? { fresh: true } : undefined), request.deadlineAt, request.signal);

    async function exchange(request: AwsRequest, fresh: boolean): Promise<AwsCallResult> {
        const { target, body, deadlineAt, signal } = request;
        const credentials = await credentialsBy(request, fresh);
        const bytes = new TextEncoder().encode(JSON.stringify(body));
        const headers = signRequest({
            method: 'POST',
            url,
            headers: { [CONTENT_TYPE_HEADER]: JSON_1_1, 'x-amz-target': `${SERVICE}.${target}` },
            payloadHash: sha256Hex(bytes),
            region,
            service: SERVICE,
            credentials,
            now: now(),
        });
        // The time left is read after the credentials arrived, immediately before the dispatch.
        const response = await http.send(
            url,
            { method: 'POST', headers, body: bytes },
            deadlineAt - Date.now(),
            signal
        );
        let json: unknown = null;
        try {
            json = JSON.parse(new TextDecoder().decode(response.body));
        } catch {
            json = null;
        }
        return { status: response.status, json, answer: classifyAnswer(response.status, json) };
    }

    /** Signs and sends until `deadlineAt`; an expired-token answer is repeated once with fresh credentials. */
    async function callBy(
        target: string,
        body: Record<string, unknown>,
        deadlineAt: number,
        signal: AbortSignal | undefined
    ): Promise<AwsCallResult> {
        const request = { target, body, deadlineAt, signal };
        const first = await exchange(request, false);
        if (!isError(first.answer, 'expired')) {
            return first;
        }
        // The cached credentials were refused: fetch new ones once. Still expired means the source is serving
        // stale keys, which a later attempt may outlive.
        const second = await exchange(request, true);
        if (isError(second.answer, 'expired')) {
            throw new ProviderFault('retry');
        }
        return second;
    }

    const call = (
        target: string,
        body: Record<string, unknown>,
        budgetMs = DEFAULT_CALL_MS,
        signal?: AbortSignal | undefined
    ) => callBy(target, body, Date.now() + budgetMs, signal);

    /** A write's answer names what was asked for, or the write is unconfirmed. */
    const created = (answer: AwsAnswer, name: string, versionId: string): boolean =>
        answer.kind === 'ok' && answer.json.Name === name && answer.json.VersionId === versionId;

    return {
        storage: 'aws',
        call,
        nameOf: (ref, versionId) => `${prefix}/${ref}/${versionId}`,
        async put({ name, versionId, payload }, budgetMs, signal) {
            const result = await call(
                'CreateSecret',
                {
                    Name: name,
                    ClientRequestToken: versionId,
                    SecretBinary: Buffer.concat([Buffer.from([FRAME]), payload]).toString('base64'),
                },
                budgetMs,
                signal
            );
            const { answer } = result;
            if (answer.kind === 'ok') {
                // An answer that does not name this object and version leaves the write unconfirmed.
                return created(answer, name, versionId) ? 'written' : fail('ambiguous');
            }
            return isError(answer, 'exists') ? 'exists' : fail(verdictOf(answer, 'ambiguous'));
        },
        async get(name, versionId, budgetMs, signal): Promise<ObjectRead> {
            const result = await call('GetSecretValue', { SecretId: name, VersionId: versionId }, budgetMs, signal);
            const { answer } = result;
            if (answer.kind === 'unrecognized' && result.status < HTTP_BAD_REQUEST) {
                // A 2xx that is no readable secret is a wrong answer, not an unavailable provider.
                return 'malformed';
            }
            if (answer.kind === 'ok') {
                const json = answer.json;
                const payload = unframe(json.SecretBinary);
                return typeof json.Name === 'string' && typeof json.VersionId === 'string' && payload
                    ? { name: json.Name, versionId: json.VersionId, payload }
                    : 'malformed';
            }
            return isError(answer, 'notFound') ? 'absent' : fail(verdictOf(answer, 'retry'));
        },
        async remove(name, budgetMs, signal) {
            // One deadline for the delete and the describe that may follow it.
            const deadlineAt = Date.now() + budgetMs;
            await removeBy((target, body) => callBy(target, body, deadlineAt, signal), name);
        },
    };
}
