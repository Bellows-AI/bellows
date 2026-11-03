import { timingSafeEqual } from 'node:crypto';
import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ConsentView, OAuthClient } from '../auth/oauth-store.js';
import type { Caller } from '../auth/store.js';
import { bad, body as jsonBody } from './helpers.js';
import {
    HTTP_UNAVAILABLE,
    OAUTH_PATHS,
    cookieSessionOf,
    identityOf,
    noStore,
    redirectWith,
    type OAuthRouteDeps,
} from './oauth-http.js';

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const BODY_LIMIT = 4096;
const FIELD_LIMIT = 256;
const CONSENT_INVALID = 'consent_invalid';

/** What the consent screen may say of the client; `uri` is the page it claims, shown as text and never followed. */
const clientView = (clientId: string, client: OAuthClient | null) => ({
    id: clientId,
    kind: client?.kind ?? null,
    name: client?.name ?? null,
    uri: typeof client?.metadata?.client_uri === 'string' ? client.metadata.client_uri : null,
});

const isField = (value: unknown): value is string => typeof value === 'string' && value.length <= FIELD_LIMIT;

/**
 * The consent transaction API behind the consent screen (BEL-103 renders it; docs/auth.md). Every route here is the
 * signed-in COOKIE session and nothing else: a bearer token, an MCP token included, never approves its own grant.
 * Approving also needs the transaction's CSRF value, which only the redirect from the authorize endpoint carried, and
 * the JSON-only body keeps a cross-site form out (a form post is 415, as on every other state-changing route).
 *
 * Approve and deny read nothing from the request but the id and the CSRF value: the client, redirect, resource and
 * scopes were frozen when the transaction was opened, and the the user comes from the live session, and the organization is the session's unless the approval names another the caller belongs to.
 */
export const oauthConsentRoutes =
    (deps: OAuthRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const { config, auth, oauth } = deps;
        const { issuer } = identityOf(config);
        const sessionOf = cookieSessionOf({ config, auth });

        const unconfirmed = (reply: FastifyReply, error: Error) => {
            app.log.error({ err: error }, 'oauth consent could not be confirmed');
            return bad(reply, ERROR_CODES.UNAVAILABLE, 'Try again shortly.', HTTP_UNAVAILABLE);
        };

        app.get(OAUTH_PATHS.consent, async (request, reply) => {
            noStore(reply);
            try {
                const session = await sessionOf(request, reply);
                if (!session) return reply;
                const view = await oauth.readConsent((request.params as { id: string }).id);
                const own =
                    view && view.sessionHash.length === session.sessionHash.length
                        ? timingSafeEqual(view.sessionHash, session.sessionHash)
                        : false;
                if (!view || !own)
                    return bad(reply, ERROR_CODES.NOT_FOUND, 'No such authorization request', HTTP_NOT_FOUND);
                const client = await oauth.findClient(view.clientId);
                return reply.code(HTTP_OK).send({
                    client: clientView(view.clientId, client),
                    scopes: view.scopes,
                    resource: view.resource,
                    redirectUri: view.redirectUri,
                    organization: { id: session.caller.org.id, name: session.caller.org.name },
                    organizations: await auth.membershipsOf(session.caller.user.id),
                    user: { login: session.caller.user.login },
                });
            } catch (e) {
                return unconfirmed(reply, e as Error);
            }
        });

        /** The redirect that answers a spent transaction: a fresh code when approved, `access_denied` otherwise. */
        const answer = async (approve: boolean, view: ConsentView, caller: Caller, orgId: string): Promise<string> => {
            const state = view.clientState ?? undefined;
            if (!approve) return redirectWith(view.redirectUri, issuer, { error: 'access_denied', state });
            const { code } = await oauth.createCode({
                clientId: view.clientId,
                userId: caller.user.id,
                orgId,
                scopes: view.scopes,
                codeChallenge: view.codeChallenge,
                resource: view.resource,
                redirectUri: view.redirectUri,
            });
            return redirectWith(view.redirectUri, issuer, { code, state });
        };

        /** The chosen org must be one the caller belongs to right now; checked before the transaction is spent. */
        const belongsTo = async (caller: Caller, orgId: string): Promise<boolean> =>
            orgId === caller.org.id || (await auth.membershipsOf(caller.user.id)).some((org) => org.id === orgId);

        /** Spends the transaction for this session, then answers it; null when there was nothing valid to spend. */
        const settle = async (
            approve: boolean,
            request: FastifyRequest,
            session: { caller: Caller; sessionHash: Buffer }
        ) => {
            const { id, csrf, orgId } = jsonBody(request.body);
            if (!isField(id) || !isField(csrf) || (orgId !== undefined && !isField(orgId))) return null;
            const chosen = orgId ?? session.caller.org.id;
            if (approve && !(await belongsTo(session.caller, chosen))) return null;
            // Spent before the code exists: a repeat, a wrong CSRF value or another session's id finds nothing.
            const view = await oauth.consumeConsent({ id, sessionHash: session.sessionHash, csrf });
            return view ? answer(approve, view, session.caller, chosen) : null;
        };

        const decide = (approve: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
            noStore(reply);
            try {
                const session = await sessionOf(request, reply);
                if (!session) return reply;
                const redirect = await settle(approve, request, session);
                if (redirect === null) {
                    return bad(
                        reply,
                        CONSENT_INVALID,
                        'This authorization request is no longer valid. Start again from the app.'
                    );
                }
                return reply.code(HTTP_OK).send({ redirect });
            } catch (e) {
                return unconfirmed(reply, e as Error);
            }
        };

        app.post(OAUTH_PATHS.approve, { bodyLimit: BODY_LIMIT }, decide(true));
        app.post(OAUTH_PATHS.deny, { bodyLimit: BODY_LIMIT }, decide(false));
    };
