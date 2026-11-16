import type { ExchangeResult, IssuedTokens } from '../oauth-provider.js';

/** What every outbound OAuth provider's hooks share (docs/connections.md): a bounded body read and the token answer. */

const MAX_BODY_BYTES = 65_536;
const MS_PER_SECOND = 1000;
const REFUSALS = new Set(['invalid_grant', 'invalid_request', 'unauthorized_client', 'access_denied']);
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const REFUSAL_STATUSES = new Set([HTTP_BAD_REQUEST, HTTP_UNAUTHORIZED, HTTP_FORBIDDEN]);

class BodyTooLarge extends Error {}

/** Reads at most 64 KiB; rejects on a transport error, an abort or a premature close. */
export async function readCapped(res: Response): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > MAX_BODY_BYTES) throw new BodyTooLarge();
            chunks.push(next.value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const sortedScopes = (scopes: Iterable<string>): string[] => [...new Set(scopes)].sort();

/** A provider's reading of the token answer's `scope`: the scopes, or null when the value is not a scope at all. */
export type ScopeParser = (scope: unknown) => string[] | null;

/** A token answer, or null when it is not one: the provider may have spent the code, so null is never definitive. */
function tokensFrom(json: unknown, scopesOf: ScopeParser): IssuedTokens | null {
    if (!isRecord(json)) return null;
    const { access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken, scope } = json;
    if (typeof accessToken !== 'string' || accessToken === '') return null;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
    if (refreshToken !== undefined && typeof refreshToken !== 'string') return null;
    const scopes = scope === undefined ? undefined : scopesOf(scope);
    if (scopes === null) return null;
    return {
        accessToken,
        expiresAt: Date.now() + expiresIn * MS_PER_SECOND,
        refreshToken: refreshToken || null,
        ...(scopes === undefined ? {} : { authority: { scopes: sortedScopes(scopes) } }),
    };
}

/** A token endpoint answer: tokens, a refusal the provider meant, or unconfirmed. */
export function answerOf(res: Response, text: string, scopesOf: ScopeParser): ExchangeResult {
    let json: unknown = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    if (res.ok) {
        const tokens = tokensFrom(json, scopesOf);
        return tokens ? { ok: true, tokens } : { ok: false, failure: 'ambiguous' };
    }
    const error = isRecord(json) ? json.error : undefined;
    const refused = REFUSAL_STATUSES.has(res.status) && typeof error === 'string' && REFUSALS.has(error);
    return { ok: false, failure: refused ? 'definitive' : 'ambiguous' };
}
