import { useCallback, useEffect, useRef, useState } from 'react';
import { listConnections, type ConnectionView } from './connections.js';

/** The caller's connections: `loading` until the read lands, then `ok` with the rows or `error` with the sentence. */
export type UseConnections =
    | { state: 'loading' }
    | { state: 'error'; error: string }
    | { state: 'ok'; connections: ConnectionView[] };

/** The read plus `reload`: ask again without going back to `loading`, so a page re-reads after an action in place. */
export type ConnectionsRead = UseConnections & { reload: () => Promise<void> };

/** One read per mount, so each navigation to a page that shows connections asks again. */
export function useConnections(): ConnectionsRead {
    const [result, setResult] = useState<UseConnections>({ state: 'loading' });
    const mounted = useRef(true);

    const reload = useCallback(async () => {
        const read = await listConnections();
        if (!mounted.current) return;
        setResult(read.ok ? { state: 'ok', connections: read.connections } : { state: 'error', error: read.error });
    }, []);

    useEffect(() => {
        mounted.current = true;
        void reload();
        return () => {
            mounted.current = false;
        };
    }, [reload]);

    return { ...result, reload };
}
