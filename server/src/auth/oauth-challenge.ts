import { SCOPES, type Scope } from './route-class.js';

/** RFC 9728 path-inserted metadata location of the MCP resource, under the board's public origin. */
export const resourceMetadataUrl = (publicUrl: string): string =>
    `${publicUrl}/.well-known/oauth-protected-resource/api/mcp`;

const quoted = (value: string): string => `"${value.replace(/["\\]/g, '')}"`;

/**
 * The `WWW-Authenticate` value of an MCP resource refusal (RFC 6750 / RFC 9728), one builder for both:
 * - `unauthorized` (401): `resource_metadata` so a client can discover the authorization server, and the scopes on offer;
 * - `insufficient_scope` (403): the scopes the refused call needs. `error="insufficient_scope"` is an OAuth code, distinct
 *   from the board's `integration_required` outcome.
 */
export const challengeFor = (
    challenge:
        | { kind: 'unauthorized'; metadataUrl: string | null; scopes?: readonly Scope[] }
        | { kind: 'insufficient_scope'; metadataUrl: string | null; scopes: readonly Scope[] }
): string => {
    const params: string[] = [];
    if (challenge.kind === 'insufficient_scope') params.push(`error=${quoted('insufficient_scope')}`);
    params.push(`scope=${quoted((challenge.scopes ?? SCOPES).join(' '))}`);
    if (challenge.metadataUrl) params.push(`resource_metadata=${quoted(challenge.metadataUrl)}`);
    return `Bearer ${params.join(', ')}`;
};
