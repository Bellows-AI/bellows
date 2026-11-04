import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { SCOPES } from '../auth/route-class.js';
import { MCP_PATH } from '../config-mcp.js';
import { OAUTH_PATHS } from './oauth-http.js';

/** RFC 9728: the MCP resource and the one authorization server that issues tokens for it. */
export const protectedResourceMetadata = (issuer: string, resource: string) => ({
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
});

/** RFC 8414 (+ RFC 7591 registration, + the Client ID Metadata Document draft). Public clients only (`none`, PKCE S256); every authorization response carries `iss` (RFC 9207). */
export const authorizationServerMetadata = (issuer: string) => ({
    issuer,
    authorization_endpoint: `${issuer}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${issuer}${OAUTH_PATHS.token}`,
    revocation_endpoint: `${issuer}${OAUTH_PATHS.revoke}`,
    registration_endpoint: `${issuer}${OAUTH_PATHS.register}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
});

const CACHE = 'public, max-age=300';

/**
 * Discovery documents, open (outside `/api/`, no credential) and registered only when MCP is on in github mode, so an
 * `AUTH_MODE=none` board publishes nothing. The path-inserted form is what the 401 challenge points at.
 */
export const oauthMetadataRoutes =
    (issuer: string, resource: string): FastifyPluginAsync =>
    async (app) => {
        const resourceDocument = async (_request: unknown, reply: FastifyReply) =>
            reply.header('cache-control', CACHE).send(protectedResourceMetadata(issuer, resource));
        app.get('/.well-known/oauth-protected-resource', resourceDocument);
        app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, resourceDocument);
        app.get('/.well-known/oauth-authorization-server', async (_request, reply) =>
            reply.header('cache-control', CACHE).send(authorizationServerMetadata(issuer))
        );
    };
