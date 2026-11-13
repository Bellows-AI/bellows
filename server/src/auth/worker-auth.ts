/**
 * The worker routes' credential (docs/auth.md): a driver credential, a per-driver `drv_` or JOB_BOARD_TOKEN as the
 * pool, and the reach it grants. Split from `plugin.ts`, whose hook calls `enforceWorker` with the matched route
 * pattern and the bearer already read.
 */
import { ERROR_CODES } from '@factory-ai/core';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfig } from '../config.js';
import { UUID } from '../identifiers.js';
import { DRIVER_CREDENTIAL_PREFIX, type DriverGrant } from './driver-credentials.js';

/** Constant-time equality for two secrets that arrived as strings. */
export function secretsMatch(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/** A worker pattern that names its row: the job or reclaim id is the router's `:id` param. */
const ROW_PATTERN = /^\/api\/(jobs|reclaims)\/:id\//;

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

export interface WorkerAuthDeps {
    auth: AuthConfig;
    jobOrgOf: (jobId: string) => Promise<string | null>;
    reclaimOrgOf: (reclaimId: string) => Promise<string | null>;
    driverCredentialOf: (token: string) => Promise<DriverGrant | null>;
}

/** What the hook read off the request: the matched route pattern ('' for none) and the bearer. */
export interface WorkerRequest {
    pattern: string;
    token: string | null;
}

/**
 * The driver credential a bearer is, or null for none. JOB_BOARD_TOKEN is the pool, checked constant-time before any
 * database round trip — a wrong guess costs a compare, not a query. A `drv_` token is looked up by its hash; a lookup
 * that cannot answer throws, and the hook's guard turns that into a 503, never a 401 a driver would give up on.
 */
async function driverGrantOf(
    boardToken: string,
    credentialOf: WorkerAuthDeps['driverCredentialOf'],
    token: string | null
): Promise<DriverGrant | null> {
    if (!token) return null;
    if (secretsMatch(token, boardToken)) return { id: 'board', orgs: null };
    if (!token.startsWith(DRIVER_CREDENTIAL_PREFIX)) return null;
    return credentialOf(token);
}

/** The board-wide worker routes a credential scoped to some organizations may not call. */
const POOL_ONLY_ROUTES: ReadonlySet<string> = new Set(['/api/metrics']);

const refuseOrg = (reply: FastifyReply) =>
    reply
        .code(HTTP_FORBIDDEN)
        .send({ error: 'This driver credential does not serve that organization', code: ERROR_CODES.FORBIDDEN });

export async function enforceWorker(
    deps: WorkerAuthDeps,
    { pattern, token }: WorkerRequest,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    const { auth, jobOrgOf, reclaimOrgOf } = deps;
    // Open in `none` mode, like every other route in it. Requiring a secret here would buy
    // nothing — anyone who can reach this port can already queue a command that an agent runs —
    // while breaking `npm run driver` against a local board, which is the ordinary way this is
    // developed. The two credentials are disjoint when there ARE credentials; `none` means there
    // are none.
    if (auth.mode === 'none') return;

    // A driver credential authenticates the DRIVER and bounds its reach (the pool, or named organizations); the org a
    // call operates on still comes from the row it names. Revoked or past its rotation window, it no longer resolves.
    const grant = await driverGrantOf(auth.jobBoardToken, deps.driverCredentialOf, token);
    if (!grant) {
        await reply.code(HTTP_UNAUTHORIZED).send({ error: 'Invalid worker token', code: ERROR_CODES.UNAUTHENTICATED });
        return;
    }

    // The claim routes and the reaper's lease lookup name no row — they ASK about the board as a
    // whole — so their principal carries null and the route answers across every org's board.
    // Every other worker route carries the job (or reclaim) id in its URL, and the org comes from
    // that row; an id that resolves to nothing is the route's
    // own 404, answered here to keep the store lookup from inventing a runtime for a row that does
    // not exist. The segment is captured before any shape check, so a MALFORMED id is refused on
    // the same terms instead of slipping through with a null org — which the route's storeOf()
    // would turn into a 503 before its own id validation ran — and so a resolver is never handed a
    // string postgres would refuse to cast.
    //
    // A scoped credential is refused on another organization's row with a 403, never the 404 above: a driver reads a
    // 404 as "the thread was removed" and would end the run, and the row is not absent, only not this credential's.
    // The org-less routes are narrowed in the route layer (`boardsFor`, the lease lookup), except the board-wide ones.
    if (grant.orgs && POOL_ONLY_ROUTES.has(pattern)) {
        await refuseOrg(reply);
        return;
    }
    const rowId = ROW_PATTERN.test(pattern) ? (request.params as { id?: string }).id : undefined;
    let orgId: string | null = null;
    if (rowId && UUID.test(rowId)) {
        orgId = pattern.startsWith('/api/reclaims/') ? await reclaimOrgOf(rowId) : await jobOrgOf(rowId);
    }
    if (rowId && !orgId) {
        await reply.code(HTTP_NOT_FOUND).send({ error: 'No such job', code: ERROR_CODES.NOT_FOUND });
        return;
    }
    if (orgId && grant.orgs && !grant.orgs.includes(orgId)) {
        await refuseOrg(reply);
        return;
    }
    request.auth = { kind: 'worker', orgId, orgs: grant.orgs };
}
