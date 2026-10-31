import { ERROR_CODES, selectedBy } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { AuthorizationFlow, StartAuthorizationInput } from '../integrations/authorization-flow.js';
import { contextOfSession } from '../integrations/trusted-context.js';
import { bad, body as jsonBody, guard } from './helpers.js';

/**
 * The outbound OAuth connect (docs/connections.md): where a signed-in person starts a connection to a provider and
 * where the provider sends them back. Thin on purpose: this file parses a request, calls the authorization flow
 * and answers; the transaction, the state and the return path are the flow's. A callback never logs its query (it
 * carries the code and the state) and never redirects anywhere but the path stored at the start.
 */

const HTTP_CREATED = 201;
const HTTP_SEE_OTHER = 303;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

const START_BODY_LIMIT = 4096;
const QUERY_VALUE_LIMIT = 2048;
const START_KEYS = new Set(['connectionId', 'returnTo', 'interactionId', 'access', 'site', 'jobId']);
const NOT_CONFIGURED =
    'Jira OAuth is not configured on this deployment: the operator sets ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET (docs/jira-app-runbook.md)';
/** Only the path, query and fragment of a redirect are ever used; the host is a placeholder for the URL parser. */
const REDIRECT_BASE = 'http://board.invalid';

export interface IntegrationRoutesDeps {
    flowOf: (orgId: string) => AuthorizationFlow;
}

/** The start body's fields, or the sentence it is refused with: every key known, every value a string. */
function parseStart(raw: unknown): Omit<StartAuthorizationInput, 'provider'> | string {
    const fields = jsonBody(raw);
    const unknown = Object.keys(fields).find((key) => !START_KEYS.has(key));
    if (unknown) return `Unknown field ${unknown}`;
    for (const [key, value] of Object.entries(fields)) {
        if (typeof value !== 'string') return `${key} must be a string`;
    }
    return fields as Omit<StartAuthorizationInput, 'provider'>;
}

/** One callback query value: a string within the limit, else treated as absent. */
const queryValue = (raw: unknown): string | undefined =>
    typeof raw === 'string' && raw.length > 0 && raw.length <= QUERY_VALUE_LIMIT ? raw : undefined;

/** `returnTo` with the outcome appended, as a path only. */
function redirectTo(returnTo: string, provider: string, result: string): string {
    const url = new URL(returnTo, REDIRECT_BASE);
    url.searchParams.set('integration', provider);
    url.searchParams.set('result', result);
    return `${url.pathname}${url.search}${url.hash}`;
}

const signInRequired = (reply: FastifyReply) =>
    reply.code(HTTP_UNAUTHORIZED).send({ error: 'Sign in required', code: ERROR_CODES.UNAUTHENTICATED });

export function integrationRoutes({ flowOf }: IntegrationRoutesDeps): FastifyPluginAsync {
    const start = async (request: FastifyRequest, reply: FastifyReply) => {
        const caller = callerOf(request);
        if (!caller) return signInRequired(reply);
        const { provider } = request.params as { provider: string };
        const parsed = parseStart(request.body);
        if (typeof parsed === 'string') return bad(reply, ERROR_CODES.BAD_BODY, parsed);
        const orgId = orgOf(request);
        const started = await guard(
            reply,
            (e) => request.log.error({ err: e }, 'integration authorization start failed'),
            () => flowOf(orgId).startAuthorization(contextOfSession(caller, orgId), { provider, ...parsed })
        );
        if (!started.ok) return reply;
        const result = started.value;
        if (result.ok) {
            const { authorizationId, authorizeUrl, expiresAt } = result;
            return reply
                .code(HTTP_CREATED)
                .header('cache-control', 'no-store')
                .send({ authorizationId, authorizeUrl, expiresAt });
        }
        if (result.reason === 'not-configured' || (result.reason === 'unknown-provider' && selectedBy(provider))) {
            return bad(reply, ERROR_CODES.INTEGRATION_NOT_CONFIGURED, NOT_CONFIGURED, HTTP_UNAVAILABLE);
        }
        if (result.reason === 'unknown-provider' || result.reason === 'not-found') {
            return bad(reply, ERROR_CODES.NOT_FOUND, 'No such integration or connection', HTTP_NOT_FOUND);
        }
        return bad(reply, ERROR_CODES.BAD_BODY, 'The authorization request is not valid');
    };

    const callback = async (request: FastifyRequest, reply: FastifyReply) => {
        const caller = callerOf(request);
        if (!caller) return signInRequired(reply);
        const { provider } = request.params as { provider: string };
        const query = request.query as Record<string, unknown>;
        const input = { state: queryValue(query.state), code: queryValue(query.code), error: queryValue(query.error) };
        const orgId = orgOf(request);
        // The client going away ends the exchange, until the provider has accepted the code (the flow detaches it).
        const abort = new AbortController();
        reply.raw.once('close', () => {
            if (!reply.raw.writableFinished) abort.abort();
        });
        reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
        try {
            const done = await flowOf(orgId).completeAuthorization(contextOfSession(caller, orgId), input, {
                signal: abort.signal,
            });
            return reply.redirect(
                redirectTo(done.returnTo, provider, done.ok ? 'connected' : done.failure),
                HTTP_SEE_OTHER
            );
        } catch {
            // Closed diagnostics only: the flow already logged its event, and an error may quote a code or a token.
            request.log.warn({ provider }, 'integration authorization callback failed');
            return reply.redirect(redirectTo('/', provider, 'error'), HTTP_SEE_OTHER);
        }
    };

    return async (app) => {
        app.post('/api/integrations/:provider/authorizations', { bodyLimit: START_BODY_LIMIT }, start);
        // `warn`: the request line of this route would carry the query, which holds the code and the state.
        app.get('/api/integrations/:provider/callback', { logLevel: 'warn' }, callback);
    };
}
