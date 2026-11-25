import { ADMIN_ROLE, ERROR_CODES, gitlabForgeOf } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import { safeReturnPath } from '../auth/session.js';
import { INTEGRATIONS_RETURN_PATH } from '../integrations/authorization-types.js';
import { GITLAB_CALLBACK_PATH, type GitlabLinks, type StartLinkResult } from '../integrations/gitlab-link.js';
import type { MemberForgeGrants } from '../integrations/member-forge-grant.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, body as jsonBody, guard } from './helpers.js';

/**
 * A person's GitLab authorization, API only until the settings page arrives (docs/connections.md): the member's link
 * and the admin's activation both start here and come back through one callback. Thin on purpose: this file parses a
 * request, calls the link service and answers; a callback never logs its query (it carries the code and the state) and
 * never redirects anywhere but the path stored at the start.
 */

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_SEE_OTHER = 303;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;

const CONTROL_BODY_LIMIT = 4096;
const QUERY_VALUE_LIMIT = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only the path, query and fragment of a redirect are ever used; the host is a placeholder for the URL parser. */
const REDIRECT_BASE = 'http://board.invalid';
const PATH = '/api/forge-grants/gitlab';
export const GITLAB_ACTIVATION_PATH = '/api/org/gitlab-connections/:id/activation';
const GITLAB_RESULT = 'gitlab';

const signInRequired = (reply: FastifyReply) =>
    reply.code(HTTP_UNAUTHORIZED).send({ error: 'Sign in required', code: ERROR_CODES.UNAUTHENTICATED });

const queryValue = (raw: unknown): string | undefined =>
    typeof raw === 'string' && raw.length > 0 && raw.length <= QUERY_VALUE_LIMIT ? raw : undefined;

/** `returnTo` with the outcome appended, as a path only. */
function redirectTo(returnTo: string, result: string): string {
    const url = new URL(safeReturnPath(returnTo, REDIRECT_BASE), REDIRECT_BASE);
    url.searchParams.set('integration', GITLAB_RESULT);
    url.searchParams.set('result', result);
    return `${url.pathname}${url.search}${url.hash}`;
}

const log = (request: FastifyRequest) => (e: Error) => request.log.error({ err: e });

const noSuchConnection = (reply: FastifyReply) =>
    bad(reply, ERROR_CODES.NOT_FOUND, 'No such GitLab connection', HTTP_NOT_FOUND);

function answerStart(reply: FastifyReply, result: StartLinkResult) {
    if (result.ok) {
        const { authorizeUrl, expiresAt } = result;
        return reply.code(HTTP_CREATED).header('cache-control', 'no-store').send({ authorizeUrl, expiresAt });
    }
    if (result.reason === 'not-found') return noSuchConnection(reply);
    if (result.reason === 'not-active') {
        return bad(
            reply,
            ERROR_CODES.GITLAB_CONNECTION_PENDING,
            'This GitLab connection is not active yet: an admin must activate it first',
            HTTP_CONFLICT
        );
    }
    return bad(
        reply,
        ERROR_CODES.INTEGRATION_NOT_CONFIGURED,
        'GitLab sign-in needs the board to have a public URL',
        HTTP_UNAVAILABLE
    );
}

/** The active connections and where the caller stands on each: a read the board could not confirm is a 503. */
async function listConnections(
    { orgs, memberGrants }: { orgs: OrgRegistry; memberGrants: MemberForgeGrants },
    request: FastifyRequest,
    reply: FastifyReply
) {
    const caller = callerOf(request);
    if (!caller) return signInRequired(reply);
    const orgId = orgOf(request);
    const store = (await orgs.for(orgId))?.forgeConnections;
    if (!store) {
        return bad(
            reply,
            ERROR_CODES.WORKSPACE_UNAVAILABLE,
            'No connection store for this organization',
            HTTP_UNAVAILABLE
        );
    }
    const read = await guard(reply, log(request), async () => {
        const active = (await store.list()).filter((connection) => connection.active);
        return Promise.all(
            active.map(async ({ id, host }) => ({
                id,
                host,
                standing: await memberGrants.standing(orgId, caller.user.id, gitlabForgeOf(host)),
            }))
        );
    });
    if (!read.ok) return reply;
    return reply.code(HTTP_OK).header('cache-control', 'no-store').send({ connections: read.value });
}

const startLink =
    (links: GitlabLinks, purpose: 'link' | 'activate') => async (request: FastifyRequest, reply: FastifyReply) => {
        const caller = callerOf(request);
        if (!caller) return signInRequired(reply);
        const { id } = request.params as { id?: string };
        if (id === undefined || !UUID.test(id)) return noSuchConnection(reply);
        const fields = jsonBody(request.body);
        const returnTo = typeof fields.returnTo === 'string' ? fields.returnTo : undefined;
        const orgId = orgOf(request);
        const started = await guard(reply, log(request), () =>
            links.start({ orgId, userId: caller.user.id, connectionId: id, purpose, returnTo })
        );
        return started.ok ? answerStart(reply, started.value) : reply;
    };

async function completeLink(links: GitlabLinks, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return signInRequired(reply);
    const query = request.query as Record<string, unknown>;
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    try {
        const done = await links.complete({
            orgId: orgOf(request),
            userId: caller.user.id,
            admin: caller.role === ADMIN_ROLE,
            state: queryValue(query.state),
            code: queryValue(query.code),
            error: queryValue(query.error),
        });
        return reply.redirect(redirectTo(done.returnTo, done.ok ? done.result : done.failure), HTTP_SEE_OTHER);
    } catch {
        // Closed diagnostics only: an error may quote a code or a token.
        request.log.warn('gitlab authorization callback failed');
        return reply.redirect(redirectTo(INTEGRATIONS_RETURN_PATH, 'error'), HTTP_SEE_OTHER);
    }
}

export const gitlabLinkRoutes =
    ({
        orgs,
        links,
        memberGrants,
    }: {
        orgs: OrgRegistry;
        links: GitlabLinks;
        memberGrants: MemberForgeGrants;
    }): FastifyPluginAsync =>
    async (app) => {
        app.post(`${PATH}/:id/link`, { bodyLimit: CONTROL_BODY_LIMIT }, startLink(links, 'link'));
        app.post(GITLAB_ACTIVATION_PATH, { bodyLimit: CONTROL_BODY_LIMIT }, startLink(links, 'activate'));

        app.get(PATH, (request, reply) => listConnections({ orgs, memberGrants }, request, reply));

        // `warn`: the request line of this route would carry the query, which holds the code and the state.
        app.get(GITLAB_CALLBACK_PATH, { logLevel: 'warn' }, (request, reply) => completeLink(links, request, reply));
    };
