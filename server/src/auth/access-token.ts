import { randomBytes } from 'node:crypto';

/**
 * A prefix, not decoration: it makes a leaked token greppable in a log or a repository, and it
 * lets the board tell "this is an access token" — and which kind — from "this is something else"
 * without a database lookup. The same reasoning a greppable credential prefix carries.
 */
export const PERSONAL_TOKEN_PREFIX = 'fat_';
export const ORG_TOKEN_PREFIX = 'oat_';
/**
 * The MCP OAuth pair (server/src/auth/oauth-store.ts). Deliberately NOT matched by `isAccessToken`: a `mat_` is a
 * different credential kind, honoured on the MCP route only, so every other route answers it as an unknown bearer.
 */
export const MCP_ACCESS_PREFIX = 'mat_';
export const MCP_REFRESH_PREFIX = 'mrt_';

/** CSPRNG bytes minted into the token body, before base64url encoding. */
const TOKEN_BYTES = 32;

export const isAccessToken = (token: string): boolean =>
    token.startsWith(PERSONAL_TOKEN_PREFIX) || token.startsWith(ORG_TOKEN_PREFIX);

/** 32 bytes from the CSPRNG, base64url, prefixed. */
export const mintAccessToken = (kind: 'personal' | 'org'): string =>
    `${kind === 'personal' ? PERSONAL_TOKEN_PREFIX : ORG_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;

export const mintMcpToken = (kind: 'access' | 'refresh'): string =>
    `${kind === 'access' ? MCP_ACCESS_PREFIX : MCP_REFRESH_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
