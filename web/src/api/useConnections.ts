import { useCallback, useEffect, useState } from 'react';
import { listConnections, type ConnectionView } from './connections.js';

/** The caller's connections: `loading` until the read lands, then `ok` with the rows or `error` with the sentence. */
export type UseConnections =
    | { state: 'loading' }
    | { state: 'error'; error: string }
    | { state: 'ok'; connections: ConnectionView[] };

/** One read per mount, so each navigation to a page that shows connections asks again. */
export function useConnections(): UseConnections {
    const [result, setResult] = useState<UseConnections>({ state: 'loading' });

    const load = useCallback(async (isMounted: () => boolean) => {
        const read = await listConnections();
        if (!isMounted()) return;
        setResult(read.ok ? { state: 'ok', connections: read.connections } : { state: 'error', error: read.error });
    }, []);

    useEffect(() => {
        let mounted = true;
        void load(() => mounted);
        return () => {
            mounted = false;
        };
    }, [load]);

    return result;
}
