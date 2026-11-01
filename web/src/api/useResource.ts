import { useCallback, useEffect, useRef, useState } from 'react';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

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
            try {
                const response = await fetch(url, { signal });
                if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                    // Handed to the gate rather than rendered as a banner — every later request
                    // would 401 too, so a banner would never clear.
                    reportUnauthenticated();
                    setLoading(false);
                    return;
                }
                if (!response.ok) {
                    setError((await refusalOf(response)).error);
                    setLoading(false);
                    return;
                }
                setData(select((await response.json()) as Body));
                setError(null);
            } catch (e) {
                if (signal.aborted) return;
                setError((e as Error).message);
            } finally {
                setLoading(false);
            }
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

    return { data, loading, error, refresh };
}
