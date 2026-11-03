import type { FastifyPluginAsync } from 'fastify';
import { oauthAuthorizeRoutes } from './oauth-authorize.js';
import { oauthConsentRoutes } from './oauth-consent.js';
import { identityOf, type OAuthRouteDeps } from './oauth-http.js';
import { oauthMetadataRoutes } from './oauth-metadata.js';
import { oauthTokenRoutes } from './oauth-token.js';

/** The inbound OAuth authorization server of the MCP endpoint (docs/mcp.md): discovery, authorize, consent, token, revoke. */
export const oauthRoutes =
    (deps: OAuthRouteDeps): FastifyPluginAsync =>
    async (app) => {
        const { issuer, resource } = identityOf(deps.config);
        await app.register(oauthMetadataRoutes(issuer, resource));
        await app.register(oauthAuthorizeRoutes(deps));
        await app.register(oauthConsentRoutes(deps));
        await app.register(oauthTokenRoutes(deps));
    };
