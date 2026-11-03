import { JSON_HEADERS } from '@factory-ai/core';
import { useCallback, useEffect, useState } from 'react';
import type { OAuthClientView } from '../oauth-client.js';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/** What the consent routes report of the transaction the authorize redirect opened. */
export interface ConsentRequest {
    client: OAuthClientView & { uri: string | null };
    scopes: string[];
    resource: string;
    redirectUri: string;
    organization: { id: string; name: string };
    /** Every org the caller belongs to; the grant is bound to the one they choose. */
    organizations: { id: string; name: string }[];
    user: { login: string };
}

/** `gone`: the server said there is no such pending request (spent, expired, or another session's). */
export type ConsentState =
    | { phase: 'loading' }
    | { phase: 'ready'; request: ConsentRequest }
    | { phase: 'gone' }
    | { phase: 'failed'; error: string };

export type DecisionResult = { ok: true; redirect: string } | { ok: false; error: string };

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

/** A decision's answer: the redirect to follow, or why not; `closed` when the server no longer holds the request. */
async function readDecision(response: Response): Promise<{ result: DecisionResult; closed: boolean }> {
    if (response.status === HTTP_STATUS_UNAUTHORIZED) {
        reportUnauthenticated();
        return { result: { ok: false, error: 'Your session expired' }, closed: false };
    }
    if (!response.ok) {
        const { error } = await refusalOf(response, 'Could not send your answer');
        return {
            result: { ok: false, error },
            closed: response.status === HTTP_BAD_REQUEST || response.status === HTTP_NOT_FOUND,
        };
    }
    const body = (await response.json()) as { redirect?: unknown };
    if (typeof body.redirect !== 'string') {
        return { result: { ok: false, error: 'The server sent no way back to the app.' }, closed: false };
    }
    return { result: { ok: true, redirect: body.redirect }, closed: false };
}

/**
 * The consent transaction behind `/oauth/consent#id=…&csrf=…` (docs/auth.md). `reload` re-reads it, which the
 * page does after a refused decision so it never keeps offering a request the server has already closed.
 */
export function useOAuthConsent(id: string | null, csrf: string | null) {
    const [state, setState] = useState<ConsentState>({ phase: id ? 'loading' : 'gone' });

    const load = useCallback(
        async (signal?: AbortSignal) => {
            if (!id) {
                setState({ phase: 'gone' });
                return;
            }
            try {
                const response = await fetch(`/api/oauth/consent/${encodeURIComponent(id)}`, signal ? { signal } : {});
                if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                    reportUnauthenticated();
                    return;
                }
                if (response.status === HTTP_NOT_FOUND) {
                    setState({ phase: 'gone' });
                    return;
                }
                if (!response.ok) {
                    setState({
                        phase: 'failed',
                        error: (await refusalOf(response, 'Could not load the request')).error,
                    });
                    return;
                }
                setState({ phase: 'ready', request: (await response.json()) as ConsentRequest });
            } catch (e) {
                if (!signal?.aborted) setState({ phase: 'failed', error: (e as Error).message });
            }
        },
        [id]
    );

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);

    /** Approve or deny: a JSON POST that answers the redirect to follow (the CSP keeps `form-action 'none'`). */
    const decide = useCallback(
        async (approve: boolean, orgId?: string): Promise<DecisionResult> => {
            if (!id || !csrf) return { ok: false, error: 'This request is missing its security token.' };
            try {
                const response = await fetch(`/api/oauth/consent/${approve ? 'approve' : 'deny'}`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify(approve ? { id, csrf, orgId } : { id, csrf }),
                });
                const { result, closed } = await readDecision(response);
                // The server closed the request (spent, expired, tampered): re-read so the page shows the truth.
                if (closed) void load();
                return result;
            } catch (e) {
                return { ok: false, error: (e as Error).message };
            }
        },
        [id, csrf, load]
    );

    return { state, decide };
}
