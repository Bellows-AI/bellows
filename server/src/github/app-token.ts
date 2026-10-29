import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { JSON_HEADERS } from '@factory-ai/core';
import type { GitHubConfig } from '../config.js';
import type { TokenProvider } from './token.js';

/**
 * Mints installation access tokens for a GitHub App, which is what the repo-read path authenticates
 * with now that GITHUB_TOKEN is gone.
 *
 * Two credentials, one derived from the other. The App's private key signs a short-lived JWT that
 * proves "I am this App"; that JWT buys an *installation* token that says "I am this App, acting on
 * this installation", and only the second one can read a repository. The first never leaves this
 * file.
 *
 * Hand-rolled rather than @octokit/auth-app for the reason auth/github.ts gives for hand-rolling the
 * OAuth exchange: the signing and the refresh window are the parts worth being able to read here,
 * and a library would own them while bringing a dependency tree for the rest.
 */

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/** GitHub's ceiling on an App JWT is 10 minutes. Nine leaves room for a slow clock. */
const JWT_TTL_SECONDS = 540;

/**
 * How early the JWT claims to have been issued.
 *
 * GitHub rejects an `iat` in its own future, and the two clocks are not the same clock. Backdating
 * by a minute is the documented remedy; without it a machine running a few seconds fast fails every
 * mint with a 401 that reads exactly like a bad key.
 */
const JWT_CLOCK_SKEW_SECONDS = 60;

/**
 * How long before expiry a cached installation token is replaced.
 *
 * Installation tokens last an hour, and a full repo walk is minutes of sequential paging. Refreshing
 * only on expiry means a walk that starts at minute 58 dies halfway through with a 401 — which
 * surfaces as a rejected credential rather than as an expired one, and sends the reader to the App's
 * settings page instead of to this constant.
 */
const REFRESH_MARGIN_MINUTES = 5;
const REFRESH_MARGIN_MS = REFRESH_MARGIN_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * How long a mint request may run before it is abandoned.
 *
 * A runner's credential request waits on this mint, and a repo read behind it; GitHub answering
 * slowly must not hold either open. The token POST aborts on this clock and the caller surfaces the
 * failure.
 */
const MINT_TIMEOUT_MS = 5000;

/** The mint body for a runner token: `repo` is `owner/name`, and GitHub's `repositories` wants the name. */
function scopeBody(repo: string | null): string {
    const name = repo?.split('/')[1];
    if (repo && !name) throw new GitHubAppError(`repository "${repo}" is not owner/name`);
    return JSON.stringify({ ...(name ? { repositories: [name] } : {}), permissions: RUNNER_TOKEN_PERMISSIONS });
}

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/**
 * An RS256 JWT, which is the only signature GitHub accepts for an App.
 *
 * `iss` is the App id as a string. GitHub now issues client ids of the form `Iv23li…` alongside the
 * numeric form and accepts either here, so this must not coerce to a number.
 */
function appJwt(appId: string, key: KeyObject, nowMs: number): string {
    const issued = Math.floor(nowMs / MS_PER_SECOND) - JWT_CLOCK_SKEW_SECONDS;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat: issued, exp: issued + JWT_TTL_SECONDS, iss: appId }));
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).end().sign(key);
    return `${header}.${payload}.${base64url(signature)}`;
}

export interface AppTokenOptions {
    readonly github: Extract<GitHubConfig, { mode: 'app' }>;
    /**
     * The installation to mint for. REQUIRED since #99: the org registry passes each
     * organization's installation_id, so one process holds one provider per installation and the
     * old single-installation discovery (fatal on 0 or several) has nothing left to answer.
     */
    readonly installationId: string;
    readonly fetchFn?: typeof fetch;
    readonly now?: () => number;
    readonly mintTimeoutMs?: number;
}

export class GitHubAppError extends Error {}

/** How much of a remote error body is worth quoting — enough for GitHub's reason, not a dump. */
const ERROR_DETAIL_LIMIT = 200;
const HTTP_UNPROCESSABLE = 422;

async function json(response: Response, what: string, unprocessableHint?: string): Promise<unknown> {
    if (!response.ok) {
        // The body carries GitHub's own reason ("integration not found", "expired") and is the
        // difference between a fixable error and a mystery. Bounded, because it is a remote body.
        const detail = (await response.text().catch(() => '')).slice(0, ERROR_DETAIL_LIMIT);
        const hint = response.status === HTTP_UNPROCESSABLE && unprocessableHint ? ` (${unprocessableHint})` : '';
        throw new GitHubAppError(`${what} failed with ${response.status}${detail ? `: ${detail}` : ''}${hint}`);
    }
    return response.json();
}

/**
 * A narrowed runner token, the instant GitHub says it stops working (`expires_at`), and what GitHub
 * answered it can do: `permissions` (name to access) and `repositories` (names; empty when the mint
 * named none). Both were checked against the ceiling asked for before the token was returned.
 */
export interface MintedToken {
    token: string;
    expiresAt: string;
    permissions: Record<string, string>;
    repositories: string[];
}

/** `revoked`: the token no longer works (GitHub confirmed, or already refused it). `failed`: unconfirmed. */
export type RevokeOutcome = 'revoked' | 'failed';

export interface InstallationTokenProvider extends TokenProvider {
    /** The installation these tokens are for, discovered on first use if it was not configured. */
    installationId(): Promise<string>;
    /**
     * A token minted NOW for one attempt, never served from the cache and never shared with another
     * caller: two attempts asking at once get two distinct tokens, so no attempt's credential is
     * another's (docs/connections.md). `expiresAt` is GitHub's own `expires_at`, which the runner's
     * helper renews ahead of.
     *
     * The token is narrowed to `repo` (`owner/name`) and to `RUNNER_TOKEN_PERMISSIONS`, so a
     * compromised run cannot push to the rest of the installation. It is therefore never what `get`
     * caches: `get` serves the repo-read path, which needs every repository. A null repo gets the
     * permission narrowing alone — there is no repository to name.
     */
    fresh(repo?: string | null): Promise<MintedToken>;
    /**
     * Revokes ONE installation token (`DELETE /installation/token`, authenticated by that token) at
     * the configured `apiUrl`. Never retried; a throw or timeout is `failed`, never read as revoked.
     */
    revoke(token: string): Promise<RevokeOutcome>;
}

/**
 * The installation permissions a runner's token carries, pinned to what the driver's helpers call:
 * git push (`contents`), opening and viewing PRs and review replies (`pull_requests`), PR-level
 * comments (`issues`), the review collector's check reads (`checks`) and `gh pr checks`, which
 * GitHub gates on `actions` to read a check suite's workflow run. A permission the installation
 * lacks makes GitHub refuse the mint with a 422 (`mint` names it), so this is a subset of what
 * docs/security.md asks the App to hold.
 */
export const RUNNER_TOKEN_PERMISSIONS = {
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    checks: 'read',
    actions: 'read',
} as const;

const ACCESS_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;

/** GitHub adds this read-only permission to every installation token; it is not a grant the runner asked for. */
const IMPLICIT_PERMISSIONS: Record<string, string> = { metadata: 'read' };

/**
 * The permissions GitHub answered, if every one is within the ceiling asked for (a name in `asked`,
 * at no higher access); null when the field is absent, malformed or broader.
 */
function withinPermissions(answered: unknown, asked: Record<string, string>): Record<string, string> | null {
    if (typeof answered !== 'object' || answered === null || Array.isArray(answered)) return null;
    const granted: Record<string, string> = {};
    for (const [name, access] of Object.entries(answered)) {
        const ceiling = asked[name] ?? IMPLICIT_PERMISSIONS[name];
        if (typeof access !== 'string' || ceiling === undefined) return null;
        const rank = ACCESS_RANK[access];
        if (rank === undefined || rank > (ACCESS_RANK[ceiling] ?? 0)) return null;
        granted[name] = access;
    }
    return granted;
}

/** The repository names GitHub answered when exactly the one asked for; null otherwise (including absent). */
function withinRepositories(answered: unknown, asked: string[]): string[] | null {
    if (!Array.isArray(answered)) return null;
    const names = answered.map((entry) => (entry as { name?: unknown } | null)?.name);
    if (names.length !== asked.length || !names.every((name, i) => name === asked[i])) return null;
    return names as string[];
}

/** GitHub's `expires_at` as epoch ms; a missing or unparseable one falls back to the documented hour. */
function expiryOf(answered: string | undefined, nowMs: number): number {
    const parsed = answered ? Date.parse(answered) : NaN;
    return Number.isFinite(parsed) ? parsed : nowMs + SECONDS_PER_HOUR * MS_PER_SECOND;
}

/** What GitHub answered if it stays within the narrowed `scope` asked for; null when broader or unverifiable. */
function withinCeiling(
    answered: { permissions?: unknown; repositories?: unknown },
    scope: string
): { permissions: Record<string, string>; repositories: string[] } | null {
    const asked = JSON.parse(scope) as { repositories?: string[]; permissions: Record<string, string> };
    const permissions = withinPermissions(answered.permissions, asked.permissions);
    const repositories = asked.repositories ? withinRepositories(answered.repositories, asked.repositories) : [];
    return permissions && repositories ? { permissions, repositories } : null;
}

const PERMISSION_LABELS = {
    contents: 'Contents',
    pull_requests: 'Pull requests',
    issues: 'Issues',
    checks: 'Checks',
    actions: 'Actions',
} as const satisfies Record<keyof typeof RUNNER_TOKEN_PERMISSIONS, string>;

/** What an operator needs to read off a refused narrowed mint: which permissions, and where to grant them. */
const GRANT_HINT = `if the cause is permissions, the GitHub App must hold ${(
    Object.entries(RUNNER_TOKEN_PERMISSIONS) as [keyof typeof PERMISSION_LABELS, string][]
)
    .map(([name, access]) => `${PERMISSION_LABELS[name]}: ${access}`)
    .join(
        ', '
    )} on this installation; grant any missing one in the App's permissions settings and accept the update on the installation (docs/security.md)`;

export function installationTokenProvider(options: AppTokenOptions): InstallationTokenProvider {
    const { github, fetchFn = fetch, now = Date.now, mintTimeoutMs = MINT_TIMEOUT_MS } = options;

    // Parsed once, at construction. A well-shaped but invalid PEM then fails at boot, where
    // loadConfig's shape check left off, rather than at the first fetch minutes later.
    let key: KeyObject;
    try {
        key = createPrivateKey(github.privateKeyPem);
    } catch (error) {
        throw new GitHubAppError(`GITHUB_APP_PRIVATE_KEY is not a usable private key: ${(error as Error).message}`);
    }

    const installation = options.installationId;
    let cached: { token: string; expiresAt: number } | null = null;
    // Single-flight for the cached whole-installation token. Two concurrent callers past a stale
    // cache would otherwise mint two tokens and race to store one; GitHub does not invalidate the
    // loser, but it counts against the App and the discarded token stays live for an hour.
    let pending: Promise<string> | null = null;
    const singleFlight = (run: () => Promise<string>): Promise<string> => {
        pending ??= run().finally(() => {
            pending = null;
        });
        return pending;
    };

    /** One token revoked, authenticated by itself. `failed` on anything GitHub did not confirm. */
    const revoke = async (token: string): Promise<RevokeOutcome> => {
        try {
            const response = await fetchFn(`${github.apiUrl}/installation/token`, {
                method: 'DELETE',
                headers: {
                    authorization: `Bearer ${token}`,
                    accept: 'application/vnd.github+json',
                    'user-agent': 'factory-ai',
                },
                signal: AbortSignal.timeout(mintTimeoutMs),
            });
            // 401: GitHub no longer accepts the token, which is the state a revoke is after.
            return response.status === HTTP_NO_CONTENT || response.status === HTTP_UNAUTHORIZED ? 'revoked' : 'failed';
        } catch {
            return 'failed';
        }
    };

    /** `scope` is the request body of a narrowed mint; null mints the whole installation. */
    const mint = async (scope: string | null): Promise<MintedToken> => {
        const jwt = appJwt(github.appId, key, now());

        const response = await fetchFn(`${github.apiUrl}/app/installations/${installation}/access_tokens`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${jwt}`,
                accept: 'application/vnd.github+json',
                'user-agent': 'factory-ai',
                ...(scope ? JSON_HEADERS : {}),
            },
            ...(scope ? { body: scope } : {}),
            // The hold MINT_TIMEOUT_MS bounds: a hung GitHub aborts here instead of pinning the
            // caller's transaction open.
            signal: AbortSignal.timeout(mintTimeoutMs),
        });
        // A narrowed mint asks for RUNNER_TOKEN_PERMISSIONS; a 422 means the installation holds less.
        const body = (await json(response, 'installation token request', scope ? GRANT_HINT : undefined)) as {
            token?: string;
            expires_at?: string;
            permissions?: unknown;
            repositories?: unknown;
        };
        if (!body.token) throw new GitHubAppError('installation token response carried no token');

        // A narrowed mint is only as narrow as GitHub's own answer says: a token broader than asked for,
        // or one whose breadth the answer does not state, is revoked and never returned.
        const ceiling = scope ? withinCeiling(body, scope) : { permissions: {}, repositories: [] };
        if (!ceiling) {
            await revoke(body.token);
            throw new GitHubAppError('installation token is broader than requested, or its scope is unverified');
        }

        // GitHub's own expiry, not now()+1h. The document says an hour; trusting the field means a
        // change on their side shortens the window here rather than producing a token this process
        // believes in for longer than it is valid.
        const expiresAt = expiryOf(body.expires_at, now());
        return { token: body.token, expiresAt: new Date(expiresAt).toISOString(), ...ceiling };
    };

    return {
        async get() {
            if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
            return singleFlight(async () => {
                const minted = await mint(null);
                cached = { token: minted.token, expiresAt: Date.parse(minted.expiresAt) };
                return minted.token;
            });
        },

        // No single-flight: a scoped mint is one attempt's credential, and sharing an in-flight
        // one would hand two attempts the same token.
        fresh: async (repo = null) => mint(scopeBody(repo)),

        revoke,

        async installationId() {
            return installation;
        },
    };
}

export interface AppSlugOptions {
    readonly github: Extract<GitHubConfig, { mode: 'app' }>;
    readonly fetchFn?: typeof fetch;
    readonly now?: () => number;
    readonly slugTimeoutMs?: number;
}

export interface AppSlugProvider {
    /** The App's URL slug — the `apps/<slug>` path segment of its install page. */
    slug(): Promise<string>;
}

/**
 * The App's slug, for building install-page URLs (`github.com/apps/<slug>/installations/new`).
 *
 * `GET /app` authenticates with the App JWT — not the installation token every app-client call
 * carries — which is why it lives here beside the signer rather than in app-client.ts. The slug
 * is cached for the life of the process (a rename is cosmetic and nothing keys on it); failures
 * are rethrown uncached, because the caller is the sign-in request path (0 installations →
 * redirect to the install page) and a stale miss there must fail the sign-in, not loop it.
 */
export function createAppSlugProvider(options: AppSlugOptions): AppSlugProvider {
    const { github, fetchFn = fetch, now = Date.now } = options;
    const slugTimeoutMs = options.slugTimeoutMs ?? MINT_TIMEOUT_MS;

    let key: KeyObject;
    try {
        key = createPrivateKey(github.privateKeyPem);
    } catch (error) {
        throw new GitHubAppError(`GITHUB_APP_PRIVATE_KEY is not a usable private key: ${(error as Error).message}`);
    }

    let cached: string | null = null;

    return {
        async slug() {
            if (cached) return cached;
            const jwt = appJwt(github.appId, key, now());
            const response = await fetchFn(`${github.apiUrl}/app`, {
                headers: {
                    authorization: `Bearer ${jwt}`,
                    accept: 'application/vnd.github+json',
                    'user-agent': 'factory-ai',
                },
                // The sign-in request path holds: a hung GitHub aborts here rather than pinning
                // the browser's callback.
                signal: AbortSignal.timeout(slugTimeoutMs),
            });
            const body = (await json(response, 'app lookup')) as { slug?: string };
            if (!body.slug) throw new GitHubAppError('app response carried no slug');
            cached = body.slug;
            return body.slug;
        },
    };
}
