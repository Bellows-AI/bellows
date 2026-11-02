import { useCallback, useEffect, useRef, useState } from 'react';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/** The pause after the last keystroke before the search goes out. */
export const BRANCH_SEARCH_DEBOUNCE_MS = 300;

interface BranchPage {
    branches: string[];
    cursor: string | null;
    defaultBranch: string | null;
}

export type BranchStatus = 'loading' | 'ready' | 'error';

export interface UseBranches {
    status: BranchStatus;
    branches: string[];
    defaultBranch: string | null;
    /** More pages follow the ones loaded. */
    hasMore: boolean;
    loadingMore: boolean;
    /** Why the last read failed; the list shown (if any) is what loaded before it. */
    error: string | null;
    loadMore: () => void;
    /** Reads again what failed: the next page if that failed, else the first. */
    retry: () => void;
}

interface Held {
    /** The (repo, query) the data below answers. */
    key: string;
    status: BranchStatus;
    branches: string[];
    cursor: string | null;
    defaultBranch: string | null;
    loadingMore: boolean;
    error: string | null;
    moreFailed: boolean;
}

const fresh = (key: string): Held => ({
    key,
    status: 'loading',
    branches: [],
    cursor: null,
    defaultBranch: null,
    loadingMore: false,
    error: null,
    moreFailed: false,
});

const keyOf = (repo: string, query: string): string => `${repo}\n${query}`;

/** Reads one page. A non-OK answer or a malformed body is a thrown message, never an empty list. */
async function readPage(repo: string, query: string, cursor: string | null, signal: AbortSignal): Promise<BranchPage> {
    const params = new URLSearchParams();
    if (query !== '') params.set('q', query);
    if (cursor !== null) params.set('cursor', cursor);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const response = await fetch(`/api/repos/${repo}/branches${suffix}`, { signal });
    if (response.status === HTTP_STATUS_UNAUTHORIZED) {
        reportUnauthenticated();
        throw new Error('Your session expired');
    }
    if (!response.ok) throw new Error((await refusalOf(response, 'Could not list branches')).error);
    const body = (await response.json()) as Partial<BranchPage>;
    if (!Array.isArray(body.branches)) throw new Error('Could not list branches (unexpected answer)');
    return { branches: body.branches, cursor: body.cursor ?? null, defaultBranch: body.defaultBranch ?? null };
}

/** The value, after it has held still for `ms`; an empty value goes through at once. */
function useDebounced(value: string, ms: number): string {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        if (value === '' || ms === 0) {
            setSettled(value);
            return;
        }
        const timer = setTimeout(() => setSettled(value), ms);
        return () => clearTimeout(timer);
    }, [value, ms]);
    return settled;
}

/**
 * A repository's branches for the picker: server-side prefix search on the debounced `query`, and
 * pages by cursor. Reads only while `enabled` (the picker is open). A new repo or query starts the
 * list over and aborts the read in flight; an answer for anything but the current (repo, query) is
 * discarded. A failure is an `error`, never an empty list: `ready` with `[]` is only a 200 `[]`.
 */
export function useBranches(repo: string, query: string, enabled: boolean): UseBranches {
    const settled = useDebounced(query, BRANCH_SEARCH_DEBOUNCE_MS);
    const key = keyOf(repo, settled);
    const [held, setHeld] = useState<Held>(() => fresh(key));
    const [attempt, setAttempt] = useState(0);
    const more = useRef<AbortController | null>(null);
    const current = useRef(key);
    current.current = key;

    useEffect(() => {
        if (!enabled || repo === '') return;
        const controller = new AbortController();
        setHeld(fresh(key));
        readPage(repo, settled, null, controller.signal).then(
            (page) => {
                if (controller.signal.aborted) return;
                setHeld({ ...fresh(key), ...page, status: 'ready' });
            },
            (e: unknown) => {
                if (controller.signal.aborted) return;
                setHeld({ ...fresh(key), status: 'error', error: (e as Error).message });
            }
        );
        return () => {
            controller.abort();
            more.current?.abort();
        };
    }, [enabled, repo, settled, key, attempt]);

    const loadMore = useCallback(() => {
        const { cursor, loadingMore, status } = held;
        if (status !== 'ready' || cursor === null || loadingMore || held.key !== current.current) return;
        const asked = held.key;
        const controller = new AbortController();
        more.current = controller;
        setHeld((h) => (h.key === asked ? { ...h, loadingMore: true, error: null, moreFailed: false } : h));
        readPage(repo, settled, cursor, controller.signal).then(
            (page) => {
                if (controller.signal.aborted || current.current !== asked) return;
                setHeld((h) =>
                    h.key !== asked
                        ? h
                        : {
                              ...h,
                              // A cursor is a snapshot position: a branch created or deleted between
                              // pages may repeat, so names are deduped on append.
                              branches: [...new Set([...h.branches, ...page.branches])],
                              cursor: page.cursor,
                              loadingMore: false,
                          }
                );
            },
            (e: unknown) => {
                if (controller.signal.aborted || current.current !== asked) return;
                setHeld((h) =>
                    h.key !== asked ? h : { ...h, loadingMore: false, error: (e as Error).message, moreFailed: true }
                );
            }
        );
    }, [held, repo, settled]);

    const retry = useCallback(() => {
        if (held.moreFailed) loadMore();
        else setAttempt((n) => n + 1);
    }, [held.moreFailed, loadMore]);

    // Until the effect has restarted for a new (repo, query), what is held answers another key:
    // say loading rather than show it.
    const stale = held.key !== key;
    const view = stale ? fresh(key) : held;
    return {
        status: view.status,
        branches: view.branches,
        defaultBranch: view.defaultBranch,
        hasMore: view.cursor !== null,
        loadingMore: view.loadingMore,
        error: view.error,
        loadMore,
        retry,
    };
}
