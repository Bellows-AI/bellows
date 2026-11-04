import { isValidRedirectUri } from './redirect-match.js';

/**
 * What a public client may say about itself, whether in a Client ID Metadata Document (CIMD) or an RFC 7591
 * registration request: redirect URIs (checked by the one rule in `redirect-match.ts`), a display name, and the
 * only authentication it can have, `none`. A secret or any other method is refused, not ignored, so a client never
 * believes it holds something the server does not enforce. A grant this server does not issue is dropped (claude.ai's
 * document lists jwt-bearer): the token endpoint refuses it anyway, and only `authorization_code` is required.
 */
export const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2048;
const MAX_NAME_LENGTH = 100;
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;
const GRANTS: readonly string[] = ['authorization_code', 'refresh_token'];

type Refusal = { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };
export type ClientMetadata =
    | {
          ok: true;
          name: string | null;
          redirectUris: string[];
          metadata: { grant_types: string[]; response_types: string[]; token_endpoint_auth_method: 'none' };
      }
    | Refusal;

const bad = (error: Refusal['error'], description: string): Refusal => ({ ok: false, error, description });

const stringList = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null;

const hasControlCharacter = (text: string): boolean =>
    [...text].some((char) => (char.codePointAt(0) ?? 0) < FIRST_PRINTABLE || char.codePointAt(0) === DELETE);

const redirectsOf = (document: Record<string, unknown>): string[] | Refusal => {
    const uris = stringList(document.redirect_uris);
    if (!uris || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
        return bad('invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs.`);
    }
    const unique = [...new Set(uris)];
    if (unique.some((uri) => uri.length > MAX_URI_LENGTH || !isValidRedirectUri(uri))) {
        return bad('invalid_redirect_uri', 'A redirect URI is not allowed.');
    }
    return unique;
};

const nameOf = (value: unknown): string | null | Refusal => {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length > MAX_NAME_LENGTH || hasControlCharacter(value)) {
        return bad('invalid_client_metadata', 'client_name is not allowed.');
    }
    return value.trim() === '' ? null : value.trim();
};

const grantsOf = (document: Record<string, unknown>): string[] | Refusal => {
    const grants = document.grant_types === undefined ? [...GRANTS] : stringList(document.grant_types);
    if (!grants?.includes('authorization_code')) {
        return bad('invalid_client_metadata', 'grant_types must include authorization_code.');
    }
    return [...new Set(grants.filter((grant) => GRANTS.includes(grant)))];
};

const publicOnly = (document: Record<string, unknown>): Refusal | null => {
    const method = document.token_endpoint_auth_method;
    if (method !== undefined && method !== 'none') {
        return bad('invalid_client_metadata', 'Only token_endpoint_auth_method "none" is supported.');
    }
    if ('client_secret' in document || 'client_secret_expires_at' in document) {
        return bad('invalid_client_metadata', 'A public client has no secret.');
    }
    const responses = document.response_types === undefined ? ['code'] : stringList(document.response_types);
    return responses?.length === 1 && responses[0] === 'code'
        ? null
        : bad('invalid_client_metadata', 'response_types must be ["code"].');
};

const isRefusal = (value: unknown): value is Refusal => typeof value === 'object' && value !== null && 'ok' in value;

export const parseClientMetadata = (document: Record<string, unknown>): ClientMetadata => {
    const redirectUris = redirectsOf(document);
    if (isRefusal(redirectUris)) return redirectUris;
    const name = nameOf(document.client_name);
    if (isRefusal(name)) return name;
    const refusal = publicOnly(document);
    if (refusal) return refusal;
    const grants = grantsOf(document);
    if (isRefusal(grants)) return grants;
    return {
        ok: true,
        name,
        redirectUris,
        metadata: { grant_types: grants, response_types: ['code'], token_endpoint_auth_method: 'none' },
    };
};
