import { readFile as readFileFromDisk } from 'node:fs/promises';
import { JSON_HEADERS } from '@factory-ai/core';
import { type ProviderHttp, MIN_DISPATCH_MS, awaitWithin } from './provider-http.js';
import { type FaultVerdict, ProviderFault } from './secret-payloads.js';
import { classifyAnswer } from './vault-answer.js';

/**
 * Where the Vault client token comes from (docs/secrets.md). `token` is a fixed token for development and tests.
 * `kubernetes` logs in at `auth/kubernetes/login` with the pod's projected service-account token, re-reading the
 * file on every login so a rotated token is picked up, and caches the client token for 80% of its lease. One login
 * runs at a time: a caller that finds one in flight waits for it, but never past its own deadline, and the
 * login itself (token-file read included) is bounded by its own request timeout, not by whichever caller started
 * it. A login that outlives that bound is abandoned: its slot is cleared and its late result is never installed.
 */

export type VaultAuth = { kind: 'token'; token: string } | { kind: 'kubernetes'; role: string; tokenFile: string };

export interface TokenSource {
    /** A client token, logging in when none is cached; waits for a login at most until `deadlineAt`. */
    token(deadlineAt: number, signal: AbortSignal | undefined): Promise<string>;
    /**
     * Vault refused `token`: forget it if it is still the current one. True when a new login can change the
     * answer (a Kubernetes login), false when the token is fixed.
     */
    refuse(token: string): boolean;
}

export interface TokenSourceOptions {
    auth: VaultAuth;
    /** The Vault address without a trailing slash. */
    origin: string;
    http: ProviderHttp;
    requestMs: number;
    clock: () => number;
    readFile?: ((path: string) => Promise<string>) | undefined;
}

const LEASE_FRACTION = 0.8;
const MS_PER_SECOND = 1000;
/** A token file that is missing or unreadable by this process will not fix itself; any other errno may. */
const MISCONFIGURED_ERRNO = new Set(['ENOENT', 'ENOTDIR', 'EACCES']);

const fail = (verdict: FaultVerdict): never => {
    throw new ProviderFault(verdict);
};

export function createTokenSource(options: TokenSourceOptions): TokenSource {
    const { auth, origin, http, requestMs, clock } = options;
    if (auth.kind === 'token') {
        return { token: async () => auth.token, refuse: () => false };
    }
    const { role, tokenFile } = auth;
    const readFile = options.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'));
    let cached: { token: string; expiresAt: number } | null = null;
    let inflight: Promise<string> | null = null;

    /** One login attempt; `live` goes false once the attempt is abandoned, after which it sends and installs nothing. */
    interface Attempt {
        live: boolean;
    }

    async function projectedToken(): Promise<string> {
        let content: string;
        try {
            content = await readFile(tokenFile);
        } catch (error) {
            const code = (error as { code?: unknown } | null)?.code;
            return fail(typeof code === 'string' && MISCONFIGURED_ERRNO.has(code) ? 'misconfigured' : 'retry');
        }
        return content.trim() === '' ? fail('misconfigured') : content.trim();
    }

    /** A login is no write of ours, so a request that may have landed is a retry, never ambiguous. */
    async function login(attempt: Attempt): Promise<string> {
        const jwt = await projectedToken();
        if (!attempt.live) {
            return fail('retry');
        }
        const response = await http
            .send(
                `${origin}/v1/auth/kubernetes/login`,
                {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ role, jwt }),
                    redirect: 'manual',
                },
                requestMs,
                undefined
            )
            .catch((error: unknown) =>
                fail(error instanceof ProviderFault && error.verdict === 'misconfigured' ? 'misconfigured' : 'retry')
            );
        const answer = classifyAnswer('login', response.status, new TextDecoder().decode(response.body));
        if (answer.kind === 'ok') {
            const { token, leaseSeconds } = answer.value;
            if (!attempt.live) {
                return fail('retry');
            }
            cached = { token, expiresAt: clock() + leaseSeconds * MS_PER_SECOND * LEASE_FRACTION };
            return token;
        }
        return fail(answer.kind === 'denied' || answer.kind === 'unmounted' ? 'misconfigured' : 'retry');
    }

    /** A login raced against its own timeout across every step; on timeout it is abandoned, not left pending. */
    function boundedLogin(): Promise<string> {
        const attempt: Attempt = { live: true };
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                attempt.live = false;
                reject(new ProviderFault('retry'));
            }, requestMs);
            login(attempt)
                .then(resolve, reject)
                .finally(() => clearTimeout(timer));
        });
    }

    return {
        async token(deadlineAt, signal) {
            if (cached && clock() < cached.expiresAt) {
                return cached.token;
            }
            if (signal?.aborted || deadlineAt - Date.now() < MIN_DISPATCH_MS) {
                return fail('retry');
            }
            if (!inflight) {
                const started: Promise<string> = boundedLogin().finally(() => {
                    if (inflight === started) {
                        inflight = null;
                    }
                });
                inflight = started;
            }
            return awaitWithin(inflight, deadlineAt, signal);
        },
        refuse(token) {
            if (cached?.token === token) {
                cached = null;
            }
            return true;
        },
    };
}
