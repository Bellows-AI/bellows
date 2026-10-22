import type { FastifyReply } from 'fastify';
import type { InstallationRepo } from '../github/app-client.js';
import { SESSION_COOKIE, hashToken, mintToken, type sessionCookieOptions, sign } from '../auth/session.js';
import type { AuthStore, Caller } from '../auth/store.js';

/**
 * The pieces the OAuth callback and the onboarding completion route both need — split out purely
 * to keep `auth.ts` and `auth-onboarding.ts` each under the repo's line-count ceiling.
 */

export const HTTP_OK = 200;
export const HTTP_NO_CONTENT = 204;
export const HTTP_FOUND = 302;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_SERVER_ERROR = 500;
export const HTTP_UNAVAILABLE = 503;

export const MS_PER_SECOND = 1000;

/** An installation id is a decimal string and nothing else — the org ids are installation ids. */
export const INSTALLATION_ID = /^\d+$/;

export type ListInstallationRepos = ((installationId: string) => Promise<InstallationRepo[] | null>) | undefined;

export interface SessionDeps {
    sessionTtlMs: number;
    secret: string;
    cookie: ReturnType<typeof sessionCookieOptions>;
    store: AuthStore;
}

/*
 * The tail every sign-in shares: the session row.
 *
 * The session part — the cookie's Max-Age and the row's expires_at describe the same
 * instant: the first stops the browser sending it, the second stops this server honouring
 * a copy of it that no browser is enforcing. The row carries the org it was created in —
 * the whole session reads from there until POST /api/auth/org says otherwise.
 */
export async function startSession(deps: SessionDeps, reply: FastifyReply, caller: Caller): Promise<void> {
    const token = mintToken();
    await deps.store.createSession(
        hashToken(token),
        caller.user.id,
        new Date(Date.now() + deps.sessionTtlMs),
        caller.org.id
    );
    reply.setCookie(SESSION_COOKIE, sign(token, deps.secret), deps.cookie);
}
