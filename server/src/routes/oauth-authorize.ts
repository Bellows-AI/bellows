import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { OAuthClient } from '../auth/oauth-store.js';
import { SCOPES } from '../auth/route-class.js';
import { createUserResolver } from '../auth/plugin.js';
import { redirectUriMatches } from '../oauth/redirect-match.js';
import {
    CONSENT_PAGE_PATH,
    HTTP_BAD_REQUEST,
    HTTP_UNAVAILABLE,
    OAUTH_PATHS,
    identityOf,
    noStore,
    oauthError,
    readParams,
    redirectWith,
    scopesOf,
    sessionHashOf,
    type OAuthRouteDeps,
} from './oauth-http.js';

const HTTP_FOUND = 302;
const STATE_LIMIT = 4096;
/** RFC 7636: a base64url SHA-256 digest, no padding. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

type Vetted = { error: string; description: string } | { challenge: string; scopes: string[] };
type Ask = {
    client: OAuthClient;
    redirectUri: string;
    vetted: { challenge: string; scopes: string[] };
    state: string | undefined;
};

/** The request parameters that need no store: everything the client can get wrong once its redirect is trusted. */
const vet = (params: Map<string, string>, resource: string): Vetted => {
    if (params.get('response_type') !== 'code') {
        return { error: 'unsupported_response_type', description: 'Only response_type=code is supported.' };
    }
    const challenge = params.get('code_challenge');
    if (!challenge || !S256_CHALLENGE.test(challenge)) {
        return { error: 'invalid_request', description: 'A PKCE code_challenge (S256) is required.' };
    }
    if (params.get('code_challenge_method') !== 'S256') {
        return { error: 'invalid_request', description: 'code_challenge_method must be S256.' };
    }
    const requested = scopesOf(params.get('scope') ?? '');
    const scopes = requested.length === 0 ? [...SCOPES] : requested;
    if (!scopes.every((scope) => (SCOPES as readonly string[]).includes(scope))) {
        return { error: 'invalid_scope', description: `Supported scopes: ${SCOPES.join(' ')}.` };
    }
    const asked = params.get('resource');
    if (asked !== undefined && asked !== resource) return { error: 'invalid_target', description: 'Unknown resource.' };
    return { challenge, scopes };
};

/**
 * The authorization endpoint (RFC 6749 section 3.1, PKCE S256 only, RFC 8707 resource, RFC 9207 `iss`).
 *
 * Order matters: until the client and redirect URI are confirmed against a registered client, an error is shown to the
 * user and never redirected (an open redirect otherwise); after that every refusal goes to the redirect with `error`,
 * `state` and `iss`. A client lookup that could not be confirmed is 503, not "unknown client". A visitor with no session
 * is sent to sign in with the vetted request parked server-side and only an opaque id on the return path
 * (`/authorize/resume`, which binds it once to the new session); a member gets a consent transaction and a redirect to
 * the consent page, carrying the transaction in the fragment.
 */
export const oauthAuthorizeRoutes =
    (deps: OAuthRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const { config, auth, oauth } = deps;
        const { issuer, resource, sessionSecret } = identityOf(config);
        const resolveClient = deps.resolveClient ?? ((clientId: string) => oauth.findClient(clientId));
        const resolveUser = createUserResolver({ config, store: auth });

        const unavailable = (reply: FastifyReply, error: Error) => {
            app.log.error({ err: error }, 'oauth authorize could not be confirmed');
            return oauthError(reply, HTTP_UNAVAILABLE, 'temporarily_unavailable', 'Try again shortly.');
        };
        const shown = (reply: FastifyReply, description: string) =>
            oauthError(reply, HTTP_BAD_REQUEST, 'invalid_request', description);

        /** Phase 1: who is asking, and where may the answer go. Nothing here redirects. */
        const confirmClient = async (params: Map<string, string>, reply: FastifyReply) => {
            const clientId = params.get('client_id');
            const redirectUri = params.get('redirect_uri');
            if (!clientId) return shown(reply, 'client_id is required.');
            let client: Awaited<ReturnType<typeof resolveClient>>;
            try {
                client = await resolveClient(clientId);
            } catch (e) {
                return unavailable(reply, e as Error);
            }
            if (!client) return shown(reply, 'Unknown client.');
            if (!redirectUri || !redirectUriMatches(redirectUri, client.redirectUris)) {
                return shown(reply, 'redirect_uri is not registered for this client.');
            }
            return { client, redirectUri };
        };

        /** A consent transaction for this session, and the redirect to the page that renders it. */
        const openConsent = async (reply: FastifyReply, sessionHash: Buffer, ask: Ask) => {
            try {
                const transaction = await oauth.createConsent({
                    sessionHash,
                    clientId: ask.client.clientId,
                    redirectUri: ask.redirectUri,
                    resource,
                    scopes: ask.vetted.scopes,
                    codeChallenge: ask.vetted.challenge,
                    clientState: ask.state ?? null,
                });
                const fragment = new URLSearchParams({ id: transaction.id, csrf: transaction.csrf });
                return reply.redirect(`${issuer}${CONSENT_PAGE_PATH}#${fragment.toString()}`, HTTP_FOUND);
            } catch (e) {
                return unavailable(reply, e as Error);
            }
        };

        const signIn = (reply: FastifyReply, returnTo: string) =>
            reply.redirect(`/api/auth/github?returnTo=${encodeURIComponent(returnTo)}`, HTTP_FOUND);

        /** Phase 3: a member consents; anyone else signs in first, the request parked meanwhile. */
        const proceed = async (request: FastifyRequest, reply: FastifyReply, ask: Ask) => {
            let caller: Awaited<ReturnType<typeof resolveUser>>;
            try {
                caller = await resolveUser(request);
            } catch (e) {
                return unavailable(reply, e as Error);
            }
            const sessionHash = sessionHashOf(request, sessionSecret);
            if (caller && sessionHash) return openConsent(reply, sessionHash, ask);
            try {
                const id = await oauth.createPending({
                    clientId: ask.client.clientId,
                    redirectUri: ask.redirectUri,
                    resource,
                    scopes: ask.vetted.scopes,
                    codeChallenge: ask.vetted.challenge,
                    clientState: ask.state ?? null,
                });
                return signIn(reply, `${OAUTH_PATHS.resume}?id=${id}`);
            } catch (e) {
                return unavailable(reply, e as Error);
            }
        };

        app.get(OAUTH_PATHS.authorize, async (request, reply) => {
            noStore(reply);
            const params = readParams(request.query);
            if (!params) return shown(reply, 'Repeated or malformed parameters.');
            const confirmed = await confirmClient(params, reply);
            if ('statusCode' in confirmed) return confirmed;
            const { client, redirectUri } = confirmed;

            // Phase 2: the request itself. Every refusal reaches the client's redirect with `iss`.
            const state = params.get('state');
            const refuse = (error: string, description: string, echo: string | undefined) =>
                reply.redirect(
                    redirectWith(redirectUri, issuer, { error, error_description: description, state: echo }),
                    HTTP_FOUND
                );
            // An oversized state is refused, not echoed back into the redirect.
            if (state !== undefined && state.length > STATE_LIMIT) {
                return refuse('invalid_request', 'state is too long.', undefined);
            }
            const vetted = vet(params, resource);
            if ('error' in vetted) return refuse(vetted.error, vetted.description, state);

            return proceed(request, reply, { client, redirectUri, vetted, state });
        });

        /** Spends the parked request for this session and opens its consent, if the client still accepts it. */
        const bind = async (reply: FastifyReply, sessionHash: Buffer, id: string) => {
            try {
                const parked = await oauth.consumePending(id);
                if (!parked) return shown(reply, 'This sign-in link has expired or was already used. Start again.');
                const client = await resolveClient(parked.clientId);
                if (!client || !redirectUriMatches(parked.redirectUri, client.redirectUris)) {
                    return shown(reply, 'redirect_uri is not registered for this client.');
                }
                return openConsent(reply, sessionHash, {
                    client,
                    redirectUri: parked.redirectUri,
                    vetted: { challenge: parked.codeChallenge, scopes: [...parked.scopes] },
                    state: parked.clientState ?? undefined,
                });
            } catch (e) {
                return unavailable(reply, e as Error);
            }
        };

        // The way back from sign-in: the parked request binds to the session that has just appeared, once.
        app.get(OAUTH_PATHS.resume, async (request, reply) => {
            noStore(reply);
            const id = readParams(request.query)?.get('id');
            if (!id) return shown(reply, 'This sign-in link is not valid.');
            let caller: Awaited<ReturnType<typeof resolveUser>>;
            try {
                caller = await resolveUser(request);
            } catch (e) {
                return unavailable(reply, e as Error);
            }
            const sessionHash = sessionHashOf(request, sessionSecret);
            if (!caller || !sessionHash) return signIn(reply, `${OAUTH_PATHS.resume}?id=${encodeURIComponent(id)}`);
            return bind(reply, sessionHash, id);
        });
    };
