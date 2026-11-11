import { CONTENT_TYPE_HEADER, ERROR_CODES, JSON_CONTENT_TYPE } from '@factory-ai/core';
import { CredentialError } from '../artifacts/s3-credentials.js';
import type { ObjectClient, ObjectRead } from './external-payloads.js';
import type { GcpToken, GcpTokenProvider } from './gcp-credentials.js';
import { awaitWithin, createProviderHttp } from './provider-http.js';
import { type FaultVerdict, ProviderFault } from './secret-payloads.js';

/**
 * The Google Cloud Secret Manager adapter (docs/secrets.md): REST over the bounded provider HTTP, no SDK. One
 * Secret Manager secret per storage version, named `<prefix><ref>-<versionId>`, so every name starts with the
 * configured prefix and an IAM condition on the name prefix fences the backend in. The secret is created with
 * user-managed replication in one location and holds the payload, framed, as its only version. Removal deletes
 * the secret resource, which destroys every version, so plaintext never lingers and no destroy right is needed.
 * The backend never lists and never reads a secret's metadata: the store tracks every object by row.
 */

const DEFAULT_ENDPOINT = 'https://secretmanager.googleapis.com';
const HTTP_OK = 200;
const HTTP_REDIRECT = 300;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_INTERNAL = 500;
const HTTP_UNAVAILABLE = 503;
const HTTP_GATEWAY_TIMEOUT = 504;
/** The leading byte every stored payload carries, so an empty payload is still bytes at the provider. */
const FRAME = 0x01;
const FIRST_VERSION = '1';

type ErrorClass = 'notFound' | 'exists' | 'expired' | 'invalidRequest' | 'misconfigured' | 'retry' | 'transient';

/**
 * Error `status` strings Secret Manager documents, with the HTTP statuses each travels with. `retry`: the service did
 * not take the request (overloaded, unavailable); `transient`: it may have processed it before failing.
 */
// Three of Secret Manager's status names are spelled as the dashboard's own error codes, which have one home.
const KNOWN_ERRORS = new Map<string, { class: ErrorClass; http: readonly number[] }>([
    [ERROR_CODES.NOT_FOUND, { class: 'notFound', http: [HTTP_NOT_FOUND] }],
    ['ALREADY_EXISTS', { class: 'exists', http: [HTTP_CONFLICT] }],
    [ERROR_CODES.UNAUTHENTICATED, { class: 'expired', http: [HTTP_UNAUTHORIZED] }],
    ['PERMISSION_DENIED', { class: 'misconfigured', http: [HTTP_FORBIDDEN] }],
    ['INVALID_ARGUMENT', { class: 'invalidRequest', http: [HTTP_BAD_REQUEST] }],
    ['FAILED_PRECONDITION', { class: 'invalidRequest', http: [HTTP_BAD_REQUEST] }],
    ['RESOURCE_EXHAUSTED', { class: 'retry', http: [HTTP_TOO_MANY_REQUESTS] }],
    ['ABORTED', { class: 'transient', http: [HTTP_CONFLICT] }],
    ['INTERNAL', { class: 'transient', http: [HTTP_INTERNAL] }],
    [ERROR_CODES.UNAVAILABLE, { class: 'retry', http: [HTTP_UNAVAILABLE] }],
    ['DEADLINE_EXCEEDED', { class: 'transient', http: [HTTP_GATEWAY_TIMEOUT] }],
]);

type GcpAnswer =
    | { kind: 'ok'; json: Record<string, unknown> }
    | { kind: 'error'; class: ErrorClass; message: string }
    | { kind: 'unrecognized' };

interface GcpCallResult {
    status: number;
    answer: GcpAnswer;
}

export interface GcpObjectClientOptions {
    project: string;
    /** Starts every secret name; the config guarantees it is non-empty. */
    prefix: string;
    location: string;
    kmsKey?: string | null | undefined;
    credentials: GcpTokenProvider;
    /** Tests only: the Secret Manager origin. */
    endpoint?: string | undefined;
    fetch?: typeof fetch | undefined;
    requestMs?: number | undefined;
    maxBodyBytes?: number | undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** What an answer is: a 2xx JSON object, a documented error whose status and HTTP code agree, or nothing we know. */
function classifyAnswer(status: number, json: unknown): GcpAnswer {
    if (status >= HTTP_OK && status < HTTP_REDIRECT) {
        return isObject(json) ? { kind: 'ok', json } : { kind: 'unrecognized' };
    }
    const error = isObject(json) && isObject(json.error) ? json.error : null;
    const known = typeof error?.status === 'string' ? KNOWN_ERRORS.get(error.status) : undefined;
    if (!error || !known || status < HTTP_BAD_REQUEST || !known.http.includes(status)) {
        return { kind: 'unrecognized' };
    }
    return { kind: 'error', class: known.class, message: typeof error.message === 'string' ? error.message : '' };
}

/**
 * The verdict of an answer that is no success the caller expected. A recognized error carries its own; anything
 * else, and a server-side failure that may have processed the request, is no evidence, so it takes `unproven`:
 * `ambiguous` where a request may have landed, `retry` for a read.
 */
function verdictOf(answer: GcpAnswer, unproven: FaultVerdict): FaultVerdict {
    if (answer.kind !== 'error') {
        return unproven;
    }
    switch (answer.class) {
        case 'misconfigured':
            return 'misconfigured';
        case 'retry':
        case 'expired':
            return 'retry';
        case 'invalidRequest':
            return 'definitive';
        default:
            return unproven;
    }
}

const isError = (answer: GcpAnswer, errorClass: ErrorClass) => answer.kind === 'error' && answer.class === errorClass;

/** A not-found that names the secret asked about: a 404 for anything else (a project, a path) proves nothing. */
const missing = (answer: GcpAnswer, secretId: string): boolean =>
    answer.kind === 'error' && answer.class === 'notFound' && answer.message.includes(`/secrets/${secretId}`);

const fail = (verdict: FaultVerdict): never => {
    throw new ProviderFault(verdict);
};

/** The payload bytes of a framed, canonical base64 `payload.data`, or null. */
function unframe(encoded: unknown): Uint8Array | null {
    if (typeof encoded !== 'string') {
        return null;
    }
    const bytes = Buffer.from(encoded, 'base64');
    return bytes.toString('base64') === encoded && bytes.length > 0 && bytes[0] === FRAME ? bytes.subarray(1) : null;
}

/**
 * The token, or a fault once the deadline or the caller's abort comes first. Nothing reached the provider yet, so
 * running out of time here is a retry and a credential failure is never ambiguous.
 */
async function withinDeadline(
    pending: Promise<GcpToken>,
    deadlineAt: number,
    signal: AbortSignal | undefined
): Promise<GcpToken> {
    try {
        return await awaitWithin(pending, deadlineAt, signal);
    } catch (error) {
        if (error instanceof ProviderFault) {
            throw error;
        }
        throw new ProviderFault(
            error instanceof CredentialError && error.kind === 'misconfigured' ? 'misconfigured' : 'retry'
        );
    }
}

interface GcpRequest {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: Record<string, unknown>;
    deadlineAt: number;
    signal: AbortSignal | undefined;
}

/** The REST transport: sends until `deadlineAt`, repeating a refused token's call once with a fresh one. */
function createTransport(options: GcpObjectClientOptions): (request: GcpRequest) => Promise<GcpCallResult> {
    const base = `${(options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '')}/v1/projects/${encodeURIComponent(options.project)}`;
    const http = createProviderHttp({
        fetch: options.fetch,
        requestMs: options.requestMs,
        maxBodyBytes: options.maxBodyBytes,
        rawStatuses: true,
    });

    async function exchange(request: GcpRequest, fresh: boolean): Promise<GcpCallResult> {
        const { method, path, body, deadlineAt, signal } = request;
        const credential = await withinDeadline(
            options.credentials(fresh ? { fresh: true } : undefined),
            deadlineAt,
            signal
        );
        const headers: Record<string, string> = { authorization: `Bearer ${credential.token}` };
        if (credential.quotaProject) {
            headers['x-goog-user-project'] = credential.quotaProject;
        }
        if (body) {
            headers[CONTENT_TYPE_HEADER] = JSON_CONTENT_TYPE;
        }
        // The time left is read after the token arrived, immediately before the dispatch.
        const response = await http.send(
            `${base}${path}`,
            { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) },
            deadlineAt - Date.now(),
            signal
        );
        let json: unknown = null;
        try {
            json = JSON.parse(new TextDecoder().decode(response.body));
        } catch {
            json = null;
        }
        return { status: response.status, answer: classifyAnswer(response.status, json) };
    }

    /** Sends until `deadlineAt`; a refused token is repeated once with a fresh one. */
    async function callBy(request: GcpRequest): Promise<GcpCallResult> {
        const first = await exchange(request, false);
        if (!isError(first.answer, 'expired')) {
            return first;
        }
        const second = await exchange(request, true);
        if (isError(second.answer, 'expired')) {
            throw new ProviderFault('retry');
        }
        return second;
    }

    return callBy;
}

export function createGcpObjectClient(options: GcpObjectClientOptions): ObjectClient {
    const { prefix, location } = options;
    const callBy = createTransport(options);

    const secretPath = (secretId: string) => `/secrets/${encodeURIComponent(secretId)}`;
    const replication = () => ({
        userManaged: {
            replicas: [
                {
                    location,
                    ...(options.kmsKey ? { customerManagedEncryption: { kmsKeyName: options.kmsKey } } : {}),
                },
            ],
        },
    });
    const addVersion = (secretId: string, payload: Uint8Array, deadlineAt: number, signal: AbortSignal | undefined) =>
        callBy({
            method: 'POST',
            path: `${secretPath(secretId)}:addVersion`,
            body: { payload: { data: Buffer.concat([Buffer.from([FRAME]), payload]).toString('base64') } },
            deadlineAt,
            signal,
        });
    const access = (secretId: string, deadlineAt: number, signal: AbortSignal | undefined) =>
        callBy({
            method: 'GET',
            path: `${secretPath(secretId)}/versions/${FIRST_VERSION}:access`,
            deadlineAt,
            signal,
        });

    /** A response names the object asked for, or the write or read it answers is unconfirmed. */
    const names = (json: Record<string, unknown>, secretId: string): boolean =>
        typeof json.name === 'string' && json.name.endsWith(`/secrets/${secretId}/versions/${FIRST_VERSION}`);

    async function addAndConfirm(
        secretId: string,
        payload: Uint8Array,
        deadlineAt: number,
        signal: AbortSignal | undefined
    ): Promise<'written'> {
        const { answer } = await addVersion(secretId, payload, deadlineAt, signal);
        if (answer.kind === 'ok' && names(answer.json, secretId)) {
            return 'written';
        }
        return fail(answer.kind === 'ok' ? 'ambiguous' : verdictOf(answer, 'ambiguous'));
    }

    /**
     * The name is taken: a crash between create and addVersion leaves a secret with no version. Only a validated
     * absence of the first version is filled; a readable one is left for the caller's MAC check to believe.
     */
    async function completeExisting(
        secretId: string,
        payload: Uint8Array,
        deadlineAt: number,
        signal: AbortSignal | undefined
    ): Promise<'written' | 'exists'> {
        const { answer } = await access(secretId, deadlineAt, signal);
        if (answer.kind === 'ok') {
            return names(answer.json, secretId) ? 'exists' : fail('ambiguous');
        }
        if (missing(answer, secretId)) {
            return addAndConfirm(secretId, payload, deadlineAt, signal);
        }
        return fail(verdictOf(answer, 'ambiguous'));
    }

    return {
        storage: 'gcp',
        nameOf: (ref, versionId) => `${prefix}${ref}-${versionId}`,
        async put({ name, payload }, budgetMs, signal) {
            const deadlineAt = Date.now() + budgetMs;
            const { answer } = await callBy({
                method: 'POST',
                path: `/secrets?secretId=${encodeURIComponent(name)}`,
                body: { replication: replication() },
                deadlineAt,
                signal,
            });
            if (isError(answer, 'exists')) {
                return completeExisting(name, payload, deadlineAt, signal);
            }
            const confirmed =
                answer.kind === 'ok' &&
                typeof answer.json.name === 'string' &&
                answer.json.name.endsWith(`/secrets/${name}`);
            if (!confirmed) {
                return fail(answer.kind === 'ok' ? 'ambiguous' : verdictOf(answer, 'ambiguous'));
            }
            return addAndConfirm(name, payload, deadlineAt, signal);
        },
        async get(name, versionId, budgetMs, signal): Promise<ObjectRead> {
            const { answer } = await access(name, Date.now() + budgetMs, signal);
            if (answer.kind === 'ok') {
                const data = isObject(answer.json.payload) ? answer.json.payload.data : undefined;
                const payload = unframe(data);
                return names(answer.json, name) && payload ? { name, versionId, payload } : 'malformed';
            }
            return missing(answer, name) ? 'absent' : fail(verdictOf(answer, 'retry'));
        },
        async remove(name, budgetMs, signal) {
            const { status, answer } = await callBy({
                method: 'DELETE',
                path: secretPath(name),
                deadlineAt: Date.now() + budgetMs,
                signal,
            });
            // Gone is the provider's empty-object 200, or a not-found that names this secret; nothing else is evidence.
            const acknowledged = status === HTTP_OK && answer.kind === 'ok' && Object.keys(answer.json).length === 0;
            if (acknowledged || missing(answer, name)) {
                return;
            }
            return fail(verdictOf(answer, 'ambiguous'));
        },
    };
}
