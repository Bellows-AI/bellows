import { useRef, useState } from 'react';
import { type ProviderSetupBody, setupProvider } from '../api/providerConnections.js';
import { connectionsChanged } from '../api/useProviderConnections.js';

/**
 * Sends the provider setup command (`POST /api/provider-connections/setup`). One request id per submission: the same
 * body keeps its id, so a retry after a refusal, an unknown outcome or a later step that failed replays instead of
 * writing twice, and a changed body is a new submission. A second press while one runs is ignored. A landed setup re-reads every
 * mounted connection list.
 */
export function useSetupSubmit() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const running = useRef(false);
    const attempt = useRef<{ body: string; requestId: string } | null>(null);

    const submit = async (body: Omit<ProviderSetupBody, 'requestId'>): Promise<boolean> => {
        if (running.current) return false;
        running.current = true;
        setBusy(true);
        setError(null);
        try {
            const text = JSON.stringify(body);
            if (attempt.current?.body !== text) attempt.current = { body: text, requestId: crypto.randomUUID() };
            const result = await setupProvider({ ...body, requestId: attempt.current.requestId });
            if (!result.ok) {
                setError(result.error);
                return false;
            }
            // The id is kept: pressing again after a later step failed replays this setup instead of repeating it.
            connectionsChanged();
            return true;
        } finally {
            running.current = false;
            setBusy(false);
        }
    };
    return { busy, error, submit };
}
