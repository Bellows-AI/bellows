import { useCallback } from 'react';
import type { OAuthClientKind } from '../oauth-client.js';
import { mutate } from './mutate.js';
import { useResource } from './useResource.js';

/** One app the caller has connected to MCP: a live grant family, never a token or its hash. */
export interface OAuthGrantView {
    id: string;
    client: { id: string; name: string | null; kind: OAuthClientKind };
    org: { id: string; name: string };
    scopes: string[];
    createdAt: string;
    /** When a token was last issued (not last used); null once all its tokens are swept. */
    lastIssuedAt: string | null;
}

export interface UseOAuthGrants {
    /** Null until the first read lands, and after a failed one: a failed read is `error`, never an empty list. */
    grants: OAuthGrantView[] | null;
    loading: boolean;
    error: string | null;
    revoke: (id: string) => Promise<string | null>;
}

const selectGrants = (body: { grants: OAuthGrantView[] }) => body.grants;

/** The caller's connected apps (`GET /api/oauth/grants`); each revoke refetches so the list shows what is stored. */
export function useOAuthGrants(): UseOAuthGrants {
    const { data: grants, loading, error, refresh } = useResource('/api/oauth/grants', selectGrants);

    const revoke = useCallback(
        async (id: string): Promise<string | null> => {
            const result = await mutate(`/api/oauth/grants/${id}/revoke`, {
                method: 'POST',
                verb: 'Could not disconnect the app',
            });
            if (!result.ok) return result.error;
            refresh();
            return null;
        },
        [refresh]
    );

    return { grants, loading, error, revoke };
}
