import type { BoardClient } from './board.js';
import type { CliConfig } from './config.js';
import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE } from './http.js';
import type { Transport } from './transport.js';

/**
 * What `auth status` reports, and the shapes of `job preflight`'s question and the board's answer
 * (`POST /api/jobs/preflight`, which makes every check). Preflight is advisory — the board rechecks
 * every rule at create and at claim, and its refusal is the answer.
 */

/** The effective configuration with the credential reduced to whether it is set, and of which kind. */
export interface ConfigSummary {
    url: string;
    /** Never a character of the token: `kind` is read from its public prefix, for display only. */
    token: { set: boolean; kind: 'personal' | 'org' | 'unrecognized' | null };
    requestTimeoutSeconds: number;
    readRetries: number;
    /** Where each value came from: `env`, the settings file's path, or `default`. */
    sources: CliConfig['sources'];
}

const MS_PER_SECOND = 1000;

function tokenKind(token: string): ConfigSummary['token']['kind'] {
    if (!token) return null;
    if (token.startsWith('fat_')) return 'personal';
    if (token.startsWith('oat_')) return 'org';
    return 'unrecognized';
}

export function configSummary(config: CliConfig): ConfigSummary {
    return {
        url: config.url,
        token: { set: config.token !== '', kind: tokenKind(config.token) },
        requestTimeoutSeconds: config.requestTimeoutMs / MS_PER_SECOND,
        readRetries: config.readRetries,
        sources: config.sources,
    };
}

export interface PreflightSelection {
    repo?: string | undefined;
    executor?: string | undefined;
    executorScope?: 'user' | 'org' | undefined;
    /** The branch the task checks out and publishes against; absent is the repo's default branch. */
    baseBranch?: string | undefined;
    skills?: string[] | undefined;
    connections?: string[] | undefined;
}

export interface PreflightCheck {
    subject: 'repo' | 'executor' | 'skill' | 'connection';
    name: string | null;
    /** `unverified`: only the board can say, and it does at claim. */
    status: 'ok' | 'blocked' | 'unverified';
    detail: string;
    /** On a blocked check only a connection of the caller's own clears: which provider, and why. */
    integration?: { provider: string; reason: 'missing' | 'ambiguous' | 'reconnect' | 'unknown' };
}

export interface Preflight {
    ready: boolean;
    checks: PreflightCheck[];
}

/** The board's preflight over the client's transport: a read-only question asked with a POST, so never retried. */
export function preflightRoutes(
    request: Transport['request'],
    authHeaders: () => Record<string, string>
): Pick<BoardClient, 'preflight'> {
    return {
        async preflight(selection) {
            const headers = { ...authHeaders(), [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE };
            const init = { method: 'POST', headers, body: JSON.stringify(selection) };
            return (await request(() => ({ path: '/api/jobs/preflight', holdMs: 0 }), init)) as Preflight;
        },
    };
}
