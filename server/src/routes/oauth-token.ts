import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { OAuthStore, TokenGrant } from '../auth/oauth-store.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_UNAUTHORIZED,
    HTTP_UNAVAILABLE,
    OAUTH_PATHS,
    identityOf,
    noStore,
    oauthError,
    readParams,
    scopesOf,
    type OAuthRouteDeps,
} from './oauth-http.js';

const HTTP_OK = 200;
const BODY_LIMIT = 8192;
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
/** RFC 7636 section 4.1. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** A form body with a repeated key kept as an array, which `readParams` then refuses. */
const parseForm = (text: string): Record<string, string | string[]> => {
    const fields: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
    for (const [key, value] of new URLSearchParams(text)) {
        const seen = fields[key];
        fields[key] = seen === undefined ? value : [...(Array.isArray(seen) ? seen : [seen]), value];
    }
    return fields;
};

type Refusal = readonly [status: number, error: string, description?: string];
type TokenResult = Awaited<ReturnType<OAuthStore['consumeCode']>>;
type Parsed = { refusal: Refusal } | { clientId: string; run: (oauth: OAuthStore) => Promise<TokenResult> };

const invalidRequest = (description: string): { refusal: Refusal } => ({
    refusal: [HTTP_BAD_REQUEST, 'invalid_request', description],
});

const parseCode = (params: Map<string, string>, clientId: string, resource: string): Parsed => {
    const code = params.get('code');
    const redirectUri = params.get('redirect_uri');
    const codeVerifier = params.get('code_verifier');
    if (!code || !redirectUri || !codeVerifier) {
        return invalidRequest('code, redirect_uri and code_verifier are required.');
    }
    if (!VERIFIER.test(codeVerifier)) return invalidRequest('code_verifier is malformed.');
    return {
        clientId,
        run: (oauth) =>
            oauth.consumeCode({
                code,
                clientId,
                redirectUri,
                resource: params.get('resource') || resource,
                codeVerifier,
            }),
    };
};

const parseRefresh = (params: Map<string, string>, clientId: string): Parsed => {
    const refreshToken = params.get('refresh_token');
    if (!refreshToken) return invalidRequest('refresh_token is required.');
    const scope = params.get('scope');
    const asked = params.get('resource');
    return {
        clientId,
        run: (oauth) =>
            oauth.refresh({
                refreshToken,
                clientId,
                ...(scope ? { scopes: scopesOf(scope) } : {}),
                ...(asked ? { resource: asked } : {}),
            }),
    };
};

const parseTokenRequest = (params: Map<string, string>, resource: string): Parsed => {
    const grantType = params.get('grant_type');
    const clientId = params.get('client_id');
    if (!grantType) return invalidRequest('grant_type is required.');
    if (!clientId) return invalidRequest('client_id is required.');
    if (grantType === 'authorization_code') return parseCode(params, clientId, resource);
    if (grantType === 'refresh_token') return parseRefresh(params, clientId);
    return { refusal: [HTTP_BAD_REQUEST, 'unsupported_grant_type'] };
};

const tokenResponse = (grant: TokenGrant) => ({
    access_token: grant.accessToken,
    token_type: 'Bearer',
    expires_in: grant.expiresIn,
    refresh_token: grant.refreshToken,
    scope: grant.scopes.join(' '),
});

/**
 * The token and revocation endpoints (RFC 6749 section 5, RFC 7009), for public clients only (`none`): the client
 * proves possession with PKCE, never a secret. Both take `application/x-www-form-urlencoded` (what the SDKs send) or
 * JSON; the form parser is registered in this plugin's scope alone, so no other board route accepts a form post.
 *
 * Store refusals map to the RFC 6749 code of the same name. A store call that throws is `temporarily_unavailable`
 * (503), never `invalid_grant`: a client that is told its grant is dead discards it.
 */
export const oauthTokenRoutes =
    (deps: OAuthRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const { config, oauth } = deps;
        const { resource } = identityOf(config);
        const resolveClient = deps.resolveClient ?? ((clientId: string) => oauth.findClient(clientId));

        app.addContentTypeParser(
            FORM_CONTENT_TYPE,
            { parseAs: 'string', bodyLimit: BODY_LIMIT },
            (_request, text, done) => {
                done(null, parseForm(text as string));
            }
        );

        const unavailable = (reply: FastifyReply, error: Error) => {
            app.log.error({ err: error }, 'oauth token request could not be confirmed');
            return oauthError(reply, HTTP_UNAVAILABLE, 'temporarily_unavailable', 'Try again shortly.');
        };

        app.post(OAUTH_PATHS.token, { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            noStore(reply);
            const params = readParams(request.body);
            if (!params)
                return oauthError(reply, HTTP_BAD_REQUEST, 'invalid_request', 'Repeated or malformed parameters.');
            const parsed = parseTokenRequest(params, resource);
            if ('refusal' in parsed) return oauthError(reply, ...parsed.refusal);
            let result: TokenResult;
            try {
                if (!(await resolveClient(parsed.clientId)))
                    return oauthError(reply, HTTP_UNAUTHORIZED, 'invalid_client');
                result = await parsed.run(oauth);
            } catch (e) {
                return unavailable(reply, e as Error);
            }
            if (!result.ok) return oauthError(reply, HTTP_BAD_REQUEST, result.error);
            return reply.code(HTTP_OK).send(tokenResponse(result));
        });

        app.post(OAUTH_PATHS.revoke, { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            noStore(reply);
            const params = readParams(request.body);
            const token = params?.get('token');
            const clientId = params?.get('client_id');
            if (!token || !clientId) {
                return oauthError(reply, HTTP_BAD_REQUEST, 'invalid_request', 'token and client_id are required.');
            }
            try {
                await oauth.revoke({ token, clientId });
            } catch (e) {
                return unavailable(reply, e as Error);
            }
            // RFC 7009 section 2.2: 200 whether or not the token was known, so the answer reveals nothing.
            return reply.code(HTTP_OK).send();
        });
    };
