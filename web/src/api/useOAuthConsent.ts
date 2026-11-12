import { useCallback, useEffect, useState } from 'react';
import type { OAuthClientView } from '../oauth-client.js';
import { request } from './request.js';

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
async function sendDecision(approve: boolean, body: unknown): Promise<{ result: DecisionResult; closed: boolean }> {
    const answer = await request<{ redirect: string }>(`/api/oauth/consent/${approve ? 'approve' : 'deny'}`, {
        method: 'POST',
        body,
        verb: 'Could not send your answer',
        guard: (parsed): parsed is { redirect: string } =>
            typeof (parsed as { redirect?: unknown } | null)?.redirect === 'string',
        malformed: 'The server sent no way back to the app.',
    });
    if (answer.ok) return { result: { ok: true, redirect: answer.value.redirect }, closed: false };
    return {
        result: { ok: false, error: answer.error },
        closed: answer.status === HTTP_BAD_REQUEST || answer.status === HTTP_NOT_FOUND,
    };
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
            const result = await request<ConsentRequest>(`/api/oauth/consent/${encodeURIComponent(id)}`, {
                ...(signal ? { signal } : {}),
                verb: 'Could not load the request',
            });
            if (result.aborted || result.unauthenticated) return;
            if (result.ok) setState({ phase: 'ready', request: result.value });
            else if (result.status === HTTP_NOT_FOUND) setState({ phase: 'gone' });
            else setState({ phase: 'failed', error: result.error });
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
            const { result, closed } = await sendDecision(approve, approve ? { id, csrf, orgId } : { id, csrf });
            // The server closed the request (spent, expired, tampered): re-read so the page shows the truth.
            if (closed) void load();
            return result;
        },
        [id, csrf, load]
    );

    return { state, decide };
}
