import { useCallback, useEffect, useState } from 'react';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/**
 * Whether this deployment can connect each provider, from `GET /api/integrations` (booleans only). `loading` until
 * the read lands; `error` for anything that is not a well-formed answer, a 404 included, so a failed check is never
 * read as "not configured"; `ok` with the answer per provider id.
 */
export type UseIntegrationConfig =
    | { state: 'loading' }
    | { state: 'error' }
    | { state: 'ok'; configured: Readonly<Record<string, boolean>> };

const parse = (body: unknown): Record<string, boolean> | null => {
    const rows = (body as { integrations?: unknown } | null)?.integrations;
    if (!Array.isArray(rows)) return null;
    const configured: Record<string, boolean> = {};
    for (const row of rows) {
        const entry = row as { provider?: unknown; configured?: unknown } | null;
        if (typeof entry?.provider !== 'string' || typeof entry.configured !== 'boolean') return null;
        configured[entry.provider] = entry.configured;
    }
    return configured;
};

const read = async (): Promise<UseIntegrationConfig> => {
    try {
        const response = await fetch('/api/integrations');
        if (response.status === HTTP_STATUS_UNAUTHORIZED) reportUnauthenticated();
        if (!response.ok) return { state: 'error' };
        const configured = parse(await response.json());
        return configured ? { state: 'ok', configured } : { state: 'error' };
    } catch {
        return { state: 'error' };
    }
};

/** One read per mount; `retry` asks again after a failure. */
export function useIntegrationConfig(): UseIntegrationConfig & { retry: () => void } {
    const [result, setResult] = useState<UseIntegrationConfig>({ state: 'loading' });
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let mounted = true;
        void read().then((next) => {
            if (mounted) setResult(next);
        });
        return () => {
            mounted = false;
        };
    }, [attempt]);

    const retry = useCallback(() => {
        setResult({ state: 'loading' });
        setAttempt((n) => n + 1);
    }, []);

    return { ...result, retry };
}
