import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './request.js';

/**
 * The fetch-once-and-refetch-on-demand read shared by the settings hooks (`useEnv`,
 * `useAccessTokens`, `useWorkflowsManagement`): no polling, `refresh()` after each write, a newer
 * refresh aborts the one in flight. `select` takes the response body to the held value and must be
 * a module-level function (it is a dependency of the load).
 */
export function useResource<Body, T>(url: string, select: (body: Body) => T) {
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null);

    const load = useCallback(
        async (signal: AbortSignal) => {
            const result = await request<Body>(url, { signal });
            // A read that was superseded (a newer refresh, or a write that adopted its own rows) must
            // never land, nor touch loading or error: its answer is older than what the page holds.
            if (signal.aborted) return;
            if (result.ok) {
                setData(select(result.value));
                setError(null);
            } else if (!result.unauthenticated) {
                // A 401 is handed to the gate rather than rendered as a banner: every later request
                // would 401 too, so a banner would never clear.
                setError(result.error);
            }
            setLoading(false);
        },
        [url, select]
    );

    const refresh = useCallback(() => {
        controller.current?.abort();
        const own = new AbortController();
        controller.current = own;
        void load(own.signal);
    }, [load]);

    useEffect(() => {
        refresh();
        return () => controller.current?.abort();
    }, [refresh]);

    return { data, setData, loading, error, refresh };
}
