import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
    type ConnectionModels,
    fetchConnectionModels,
    listProviderConnections,
    type ProviderConnectionMeta,
} from './providerConnections.js';

/**
 * The two reads the connection UI shares: the member's visible connections, and one connection's live models.
 * Both hold only metadata and model names — never a key — and both discard an answer that belongs to a selection
 * the member has since left (an aborted request, a newer attempt).
 */

/**
 * Bumped by every write to a connection (create, edit, rotate, remove): the mounted lists re-read and the model reads
 * run again, so a dialog, a chip and the settings page never keep a catalog that an edit made stale.
 */
let epoch = 0;
const listeners = new Set<() => void>();

export function connectionsChanged(): void {
    epoch += 1;
    for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
const currentEpoch = () => epoch;

export interface UseProviderConnections {
    /** Null until the first answer, and after a failed one with nothing held: a failed read is never "no connections". */
    connections: ProviderConnectionMeta[] | null;
    loading: boolean;
    error: string | null;
    refresh: () => void;
}

/** The visible connections; reads only while `enabled` (a closed dialog fetches nothing). */
export function useProviderConnections(enabled = true): UseProviderConnections {
    const [connections, setConnections] = useState<ProviderConnectionMeta[] | null>(null);
    const [loading, setLoading] = useState(enabled);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const changed = useSyncExternalStore(subscribe, currentEpoch, currentEpoch);

    useEffect(() => {
        if (!enabled) return;
        const own = new AbortController();
        setLoading(true);
        void listProviderConnections(own.signal).then((result) => {
            if (own.signal.aborted) return;
            if (result.ok) {
                setConnections(result.connections);
                setError(null);
            } else {
                setError(result.error);
            }
            setLoading(false);
        });
        return () => own.abort();
    }, [enabled, attempt, changed]);

    const refresh = useCallback(() => setAttempt((n) => n + 1), []);
    return { connections, loading, error, refresh };
}

export interface UseConnectionModels {
    /** Null while no connection is selected. */
    models: ConnectionModels | null;
    retry: () => void;
}

/**
 * The selected connection's live models. A new selection starts `loading` at once and aborts the previous request, so
 * a slow answer for the connection the member left never lands on the one they chose.
 */
export function useConnectionModels(connectionId: string | null, enabled = true): UseConnectionModels {
    const [state, setState] = useState<{ id: string; models: ConnectionModels } | null>(null);
    const [attempt, setAttempt] = useState(0);
    const changed = useSyncExternalStore(subscribe, currentEpoch, currentEpoch);
    const latest = useRef(connectionId);
    latest.current = connectionId;

    useEffect(() => {
        if (connectionId === null || !enabled) return;
        const own = new AbortController();
        setState({ id: connectionId, models: { state: 'loading' } });
        void fetchConnectionModels(connectionId, own.signal).then((answer) => {
            if (own.signal.aborted || answer === null || latest.current !== connectionId) return;
            setState({ id: connectionId, models: answer });
        });
        return () => own.abort();
    }, [connectionId, enabled, attempt, changed]);

    const retry = useCallback(() => setAttempt((n) => n + 1), []);
    if (connectionId === null || !enabled) return { models: null, retry };
    // Between a selection and its effect, the held answer may still be the previous connection's.
    const held = state !== null && state.id === connectionId ? state.models : { state: 'loading' as const };
    return { models: held, retry };
}
