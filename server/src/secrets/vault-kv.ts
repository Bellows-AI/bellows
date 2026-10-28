import { JSON_HEADERS } from '@factory-ai/core';
import type { ObjectClient, ObjectRead } from './external-payloads.js';
import { DEFAULT_REQUEST_MS, createProviderHttp } from './provider-http.js';
import { type FaultVerdict, ProviderFault } from './secret-payloads.js';
import { OBJECT_VERSION, type OkValue, type VaultAnswer, type VaultOp, classifyAnswer } from './vault-answer.js';
import { type VaultAuth, createTokenSource } from './vault-token.js';

/**
 * The HashiCorp Vault KV v2 adapter (docs/secrets.md): raw HTTP, no client library. One secret per storage version,
 * at `<mount>/data/<prefix>/<ref>/<versionId>`, written once with `options.cas = 0` (an existing secret is refused,
 * so a repeat of the same write is idempotent and a different one never overwrites) and read back at version 1.
 * Removal is a delete of the metadata path, which removes every version and the metadata. Every answer goes
 * through `classifyAnswer`; a 403 re-logs in once per call (Kubernetes auth) before it counts as misconfigured.
 */

const HTTP_OK = 200;
const HTTP_REDIRECT = 300;

export interface VaultClientOptions {
    /** The Vault origin, no path. */
    addr: string;
    /** The KV v2 mount path. */
    mount: string;
    /** Every object name starts with this; the deployment's namespace in the mount. */
    prefix: string;
    auth: VaultAuth;
    fetch?: typeof fetch | undefined;
    requestMs?: number | undefined;
    maxBodyBytes?: number | undefined;
    /** Epoch ms, for the lifetime of a cached client token. */
    clock?: (() => number) | undefined;
    readFile?: ((path: string) => Promise<string>) | undefined;
}

const fail = (verdict: FaultVerdict): never => {
    throw new ProviderFault(verdict);
};

/**
 * The verdict of an answer that is no success the caller expected. A recognized refusal carries its own; anything
 * else is no evidence, so it takes `unproven`: `ambiguous` where a request may have landed, `retry` for a read.
 */
function verdictOf(answer: VaultAnswer<unknown>, unproven: FaultVerdict): FaultVerdict {
    switch (answer.kind) {
        case 'denied':
        case 'unmounted':
            return 'misconfigured';
        case 'retry':
            return 'retry';
        default:
            return unproven;
    }
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export function createVaultObjectClient(options: VaultClientOptions): ObjectClient {
    const { mount, prefix } = options;
    const origin = options.addr.replace(/\/$/, '');
    const requestMs = options.requestMs ?? DEFAULT_REQUEST_MS;
    const http = createProviderHttp({
        fetch: options.fetch,
        requestMs,
        maxBodyBytes: options.maxBodyBytes,
        rawStatuses: true,
    });
    const tokens = createTokenSource({
        auth: options.auth,
        origin,
        http,
        requestMs,
        clock: options.clock ?? Date.now,
        readFile: options.readFile,
    });
    const urlOf = (area: 'data' | 'metadata', name: string) =>
        `${origin}/v1/${encodePath(mount)}/${area}/${encodePath(name)}`;

    /** One request with the client token; a refused token is replaced once, and the second refusal is returned. */
    async function exchange<O extends Exclude<VaultOp, 'login'>>(
        op: O,
        request: { method: string; url: string; body?: unknown },
        deadlineAt: number,
        signal: AbortSignal | undefined
    ): Promise<{ status: number; answer: VaultAnswer<OkValue[O]> }> {
        let token = await tokens.token(deadlineAt, signal);
        for (let refusals = 0; ; refusals += 1) {
            const response = await http.send(
                request.url,
                {
                    method: request.method,
                    headers: {
                        'X-Vault-Token': token,
                        ...(request.body === undefined ? {} : JSON_HEADERS),
                    },
                    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
                    redirect: 'manual',
                },
                // The time left is read after the token arrived, immediately before the dispatch.
                deadlineAt - Date.now(),
                signal
            );
            const answer = classifyAnswer(op, response.status, new TextDecoder().decode(response.body));
            if (answer.kind !== 'denied' || refusals === 1 || !tokens.refuse(token)) {
                return { status: response.status, answer };
            }
            token = await tokens.token(deadlineAt, signal);
        }
    }

    return {
        storage: 'vault',
        nameOf: (ref, versionId) => `${prefix}/${ref}/${versionId}`,
        async put({ name, versionId, payload }, budgetMs, signal) {
            const { answer } = await exchange(
                'write',
                {
                    method: 'POST',
                    url: urlOf('data', name),
                    body: {
                        options: { cas: 0 },
                        data: { name, version_id: versionId, payload: Buffer.from(payload).toString('base64') },
                    },
                },
                Date.now() + budgetMs,
                signal
            );
            if (answer.kind === 'ok') {
                return 'written';
            }
            return answer.kind === 'exists' ? 'exists' : fail(verdictOf(answer, 'ambiguous'));
        },
        async get(name, _versionId, budgetMs, signal): Promise<ObjectRead> {
            const { status, answer } = await exchange(
                'read',
                { method: 'GET', url: `${urlOf('data', name)}?version=${OBJECT_VERSION}` },
                Date.now() + budgetMs,
                signal
            );
            switch (answer.kind) {
                case 'ok':
                    return answer.value;
                case 'absent':
                    return 'absent';
                case 'tombstoned':
                    return 'malformed';
                case 'unrecognized':
                    // Only a 2xx that is no readable secret is a wrong answer; a 1xx, 3xx or 4xx says nothing about the secret.
                    return status >= HTTP_OK && status < HTTP_REDIRECT ? 'malformed' : fail('retry');
                default:
                    return fail(verdictOf(answer, 'retry'));
            }
        },
        async remove(name, budgetMs, signal) {
            const { answer } = await exchange(
                'delete',
                { method: 'DELETE', url: urlOf('metadata', name) },
                Date.now() + budgetMs,
                signal
            );
            // Gone is a validated 204, or a validated 404 that names no metadata; nothing else confirms it.
            if (answer.kind !== 'ok' && answer.kind !== 'absent') {
                fail(verdictOf(answer, 'ambiguous'));
            }
        },
    };
}
