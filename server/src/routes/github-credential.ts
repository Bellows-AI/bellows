import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { JOB_ID_HEADER, LEASE_TOKEN_HEADER } from '../auth/plugin.js';
import { UUID } from '../config.js';
import type { GithubCredentialOfLease } from '../db/github-credential.js';
import type { MintedToken } from '../github/app-token.js';
import { bad } from './helpers.js';

/**
 * `POST /api/jobs/:id/credentials/github` (docs/connections.md): a running attempt's GitHub token,
 * minted now and narrowed to the task's repository. The runner's helper and the driver's
 * supervised steps both ask here with the attempt pair, the only credential the route accepts
 * (`CONNECTOR_ROUTES` in auth/plugin.ts). The attempt is checked before the mint and again after
 * it, so a cancel, settle or reclaim during the GitHub exchange withholds the token. The token is
 * in the answer and nowhere else: no log line, no error text, `Cache-Control: no-store`.
 */

/** The org's mint, or null when the org holds no GitHub App installation (the offline board). */
export type GithubMint = (orgId: string, repo: string | null) => Promise<MintedToken | null>;

export interface GithubCredentialDeps {
    credentialOfLease: GithubCredentialOfLease;
    mint: GithubMint;
}

const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
/** The request carries nothing; the pair is in the headers. */
const BODY_LIMIT = 1024;

/** One sentence for every refusal of the attempt: which check failed is not the caller's to learn. */
const ATTEMPT_REFUSED =
    'This attempt may not have a GitHub token: it is no longer running, or its task is no longer authorized. Do not retry.';
const NO_APP = 'This board holds no GitHub App installation for the organization, so it issues no GitHub token.';
const NO_TOKEN = 'GitHub did not issue a token. Retry shortly.';

export function githubCredentialRoutes({ credentialOfLease, mint }: GithubCredentialDeps): FastifyPluginAsync {
    const handle = async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header('cache-control', 'no-store');
        const jobId = (request.params as { id: string }).id;
        const leaseToken = request.headers[LEASE_TOKEN_HEADER];
        if (request.headers[JOB_ID_HEADER] !== jobId || typeof leaseToken !== 'string') {
            return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Job id and lease token required', HTTP_FORBIDDEN);
        }
        // A malformed id is no attempt, refused before the database's uuid cast can throw.
        if (!UUID.test(jobId))
            return bad(reply, ERROR_CODES.CONNECTION_NOT_AUTHORIZED, ATTEMPT_REFUSED, HTTP_FORBIDDEN);
        const attempt = await credentialOfLease(jobId, leaseToken);
        if (!attempt.ok) return bad(reply, ERROR_CODES.CONNECTION_NOT_AUTHORIZED, ATTEMPT_REFUSED, HTTP_FORBIDDEN);
        let minted: MintedToken | null;
        try {
            minted = await mint(attempt.orgId, attempt.repo);
        } catch {
            // Not logged and not quoted: GitHub's error body is a remote string, and this route's
            // answer is read by the agent.
            request.log.warn({ jobId }, 'github credential mint failed');
            return bad(reply, ERROR_CODES.UNAVAILABLE, NO_TOKEN, HTTP_BAD_GATEWAY);
        }
        if (minted === null) return bad(reply, ERROR_CODES.GITHUB_UNAVAILABLE, NO_APP, HTTP_CONFLICT);
        // The exchange took time: the attempt must still be the live one before the token leaves.
        const still = await credentialOfLease(jobId, leaseToken);
        if (!still.ok || still.orgId !== attempt.orgId) {
            return bad(reply, ERROR_CODES.CONNECTION_NOT_AUTHORIZED, ATTEMPT_REFUSED, HTTP_FORBIDDEN);
        }
        return reply.send({ token: minted.token, expiresAt: minted.expiresAt });
    };

    return async (app) => {
        app.post('/api/jobs/:id/credentials/github', { bodyLimit: BODY_LIMIT }, handle);
    };
}
