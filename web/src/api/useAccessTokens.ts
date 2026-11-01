import { useCallback } from 'react';
import { mutate } from './mutate.js';
import { useResource } from './useResource.js';

/** A list-row view of an access token. A token's secret — or its hash — is never in a list. */
export interface AccessTokenView {
    id: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
}

/** The one-time answer of a successful mint: the plaintext, or why it was refused. */
export type MintResult = { ok: true; token: string } | { ok: false; error: string };

export interface UseAccessTokens {
    tokens: AccessTokenView[] | null;
    loading: boolean;
    error: string | null;
    create: (label: string) => Promise<MintResult>;
    revoke: (id: string) => Promise<string | null>;
}

const selectTokens = (body: { tokens: AccessTokenView[] }) => body.tokens;

/**
 * One scope of access tokens — the caller's personal list, or the organization's.
 *
 * No polling, like `useEnv`: the list only changes when the page holding it mints or revokes, and
 * each success refetches so the table shows exactly what is stored.
 */
export function useAccessTokens(scope: 'personal' | 'org'): UseAccessTokens {
    // The org scope is the same routes under one prefix; the admin gate lives on the server.
    const base = scope === 'org' ? '/api/tokens/org' : '/api/tokens';
    const { data: tokens, loading, error, refresh } = useResource(base, selectTokens);

    const create = useCallback(
        async (label: string): Promise<MintResult> => {
            const result = await mutate(
                base,
                { method: 'POST', body: { label }, verb: 'Could not create the token' },
                async (response) => ((await response.json()) as { token: string }).token
            );
            if (!result.ok) return { ok: false, error: result.error };
            refresh();
            return { ok: true, token: result.value };
        },
        [base, refresh]
    );

    const revoke = useCallback(
        async (id: string): Promise<string | null> => {
            const result = await mutate(`${base}/${id}/revoke`, { method: 'POST', verb: 'Could not revoke the token' });
            if (!result.ok) return result.error;
            refresh();
            return null;
        },
        [base, refresh]
    );

    return { tokens, loading, error, create, revoke };
}
