/**
 * The bytes a grant keeps in the SecretStore: one UTF-8 JSON document. The codec is the only place that knows
 * the shape. A payload that does not decode is `integrity` and never "empty", so a damaged secret can never be
 * read as "no credential".
 */
export type GrantAuthority = { scopes: string[] };

export interface GrantPayload {
    accessToken: string;
    /** Epoch milliseconds, or null for a token that does not expire. */
    accessExpiresAt: number | null;
    refreshToken: string | null;
    authority: GrantAuthority;
}

const FORMAT = 1;

export class GrantPayloadError extends Error {
    constructor() {
        super('grant payload failed to decode: integrity');
        this.name = 'GrantPayloadError';
    }
}

const isStringList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The scopes of a stored authority document, or null when it is not the `{ scopes: string[] }` shape. */
export function authorityScopes(authority: unknown): string[] | null {
    if (typeof authority !== 'object' || authority === null) return null;
    const scopes = (authority as { scopes?: unknown }).scopes;
    return isStringList(scopes) ? [...scopes] : null;
}

export function encodeGrantPayload(payload: GrantPayload): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ v: FORMAT, ...payload }));
}

export function decodeGrantPayload(bytes: Uint8Array): GrantPayload {
    let doc: Record<string, unknown>;
    try {
        doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    } catch {
        throw new GrantPayloadError();
    }
    const scopes = authorityScopes(doc.authority);
    if (
        typeof doc !== 'object' ||
        doc === null ||
        doc.v !== FORMAT ||
        typeof doc.accessToken !== 'string' ||
        doc.accessToken.length === 0 ||
        !(doc.accessExpiresAt === null || typeof doc.accessExpiresAt === 'number') ||
        !(doc.refreshToken === null || typeof doc.refreshToken === 'string') ||
        scopes === null
    ) {
        throw new GrantPayloadError();
    }
    return {
        accessToken: doc.accessToken,
        accessExpiresAt: doc.accessExpiresAt as number | null,
        refreshToken: doc.refreshToken as string | null,
        authority: { scopes },
    };
}
