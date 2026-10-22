import { useCallback, useEffect, useState } from 'react';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

export interface InstallationRepo {
    owner: string;
    name: string;
    private: boolean;
    defaultBranch: string | null;
    pushedAt: string | null;
}

export interface ReposPayload {
    repos: InstallationRepo[];
    installation: { id: string; account: string | null; repositorySelection: 'all' | 'selected' | null } | null;
    meta: {
        fetchedAt: string | null;
        /** Named, so the picker can say "GitHub is unreachable" rather than "no repositories". */
        error: string | null;
    };
}

export interface UseRepos {
    data: ReposPayload | null;
    loading: boolean;
    error: string | null;
    /** Reads the list again, e.g. from a Retry button. */
    refresh: () => void;
}

/** What a page lists as tracked: a confirmed list, or unknown with the reason (null while loading). */
export function trackedRepos(read: Pick<UseRepos, 'data' | 'error'>): {
    repos: { owner: string; name: string }[] | null;
    error: string | null;
} {
    if (read.data === null) return { repos: null, error: read.error };
    if (read.data.repos.length === 0 && read.data.meta.error !== null) {
        return { repos: null, error: read.data.meta.error };
    }
    return { repos: read.data.repos.map(({ owner, name }) => ({ owner, name })), error: null };
}

/**
 * The installation's repositories, fetched once.
 *
 * No polling, unlike `useWorkspace`: the answer changes when a human installs the App on another
 * repository, which is not something worth asking about every two seconds while somebody stares at
 * a list. `enabled` keeps the request from firing until the dialog is actually open.
 */
export function useRepos(enabled: boolean): UseRepos {
    const [data, setData] = useState<ReposPayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(enabled);
    const [attempt, setAttempt] = useState(0);
    const refresh = useCallback(() => setAttempt((n) => n + 1), []);

    const load = useCallback(async (signal: AbortSignal) => {
        setLoading(true);
        try {
            const response = await fetch('/api/repos', { signal });
            if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                reportUnauthenticated();
                return;
            }
            if (!response.ok) {
                setError((await refusalOf(response)).error);
                return;
            }
            setData((await response.json()) as ReposPayload);
            setError(null);
        } catch (e) {
            if (signal.aborted) return;
            setError((e as Error).message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [enabled, load, attempt]);

    return { data, loading, error, refresh };
}
