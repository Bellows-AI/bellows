import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExecutorScope } from '@factory-ai/core';
import { usePersonalExecutorWrites } from './usePersonalExecutorWrites.js';
import { request } from './request.js';

export interface WorkspaceExecutor {
    /** The row's id: the by-id remove and suspend routes address it (issue 440). */
    id: string;
    name: string;
    /** Suspended (issue 440): listed and configured, but not selectable and cannot launch a run. */
    suspended: boolean;
    type: string;
    createdAt: string;
    /** The default workflow's gate-repair round limit tasks on this executor launch with. */
    gateFixRounds: number;
    /** Deliberately absent from the payload: it may hold credentials, and this is polled. */
}

/**
 * An organization profile as the poll carries it (issue 391): selection metadata only. The
 * configuration may hold provider credentials, and this payload is fetched by a poll every
 * member's browser runs — the full organization configuration answers to the admin list
 * (`listOrgExecutorConfigs`), never to the poll.
 */
export interface OrgExecutor {
    name: string;
    type: string;
    createdAt: string;
    suspended: boolean;
    /** The runner class the profile's tasks run in; null for the deployment's default. */
    runnerClass: string | null;
}

/** The member's default-executor preference as the poll resolves it (issue 391). */
export interface DefaultExecutor {
    scope: ExecutorScope;
    name: string;
}

/**
 * The same row as the poll returns, with the config back — the shape of the on-demand read the
 * executor dialog opens with, never of the poll.
 */
export interface WorkspaceExecutorFull extends WorkspaceExecutor {
    config: object;
}

/** A runner class the board declares (RUNNER_CLASSES): its name and whether it has a Docker daemon. */
export interface RunnerClassOption {
    name: string;
    docker: boolean;
}

/** The dialog's on-demand read: the member's rows with configs, and the classes an org profile may name. */
export type ExecutorConfigsRead =
    | { ok: true; executors: WorkspaceExecutorFull[]; runnerClasses: RunnerClassOption[] }
    | { ok: false; error: string };

export interface WorkspacePayload {
    executors: WorkspaceExecutor[];
    /** The organization's profiles, selection metadata only (issue 391). */
    orgExecutors: OrgExecutor[];
    /**
     * The member's resolved default: their stored preference while it still resolves, else the
     * server's deterministic fallback. Null when nothing is selectable.
     */
    defaultExecutor: DefaultExecutor | null;
}

export interface UseWorkspace {
    data: WorkspacePayload | null;
    loading: boolean;
    error: string | null;
    saving: boolean;
    saveExecutors: (
        executors: { name: string; type: string; config: object; gateFixRounds: number; suspended?: boolean }[]
    ) => Promise<string | null>;
    /** Removes ONE personal profile by id (issue 440); the by-id route cannot clobber other rows. */
    removeExecutor: (id: string) => Promise<string | null>;
    /** Suspends or resumes ONE personal profile by id (issue 440). */
    suspendExecutor: (id: string, suspended: boolean) => Promise<string | null>;
    /**
     * Stores the member's default-executor preference (issue 391): names a profile by scope and
     * name, either scope, without touching the shared profile or anyone else's default.
     */
    setDefaultExecutor: (scope: ExecutorScope, name: string) => Promise<string | null>;
    /**
     * The whole executor list with configs — the read the dialog opens with. Never part of the
     * poll: the payload holds the credentials the member pasted, so it is fetched once per dialog
     * open instead.
     */
    listExecutorConfigs: () => Promise<ExecutorConfigsRead>;
    refresh: () => void;
}

/**
 * The two executor/workspace PUT bodies, module-level like the reads above: the hook hands them
 * its URLs and payloads and keeps only the poll re-arm.
 */
async function putJson(
    url: string,
    body: unknown,
    fallbackError: string
): Promise<{ ok: true } | { ok: false; error: string }> {
    const result = await request(url, { method: 'PUT', body, verb: fallbackError, empty: true });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * What a full executor row must look like for the dialog to be safe: it pre-fills from these rows
 * and the page calls `.some()` on the list, so a 2xx body that is not that shape is refused as an
 * error result, never handed on to throw in the render.
 */
const isExecutorFull = (row: unknown): row is WorkspaceExecutorFull =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as WorkspaceExecutorFull).name === 'string' &&
    typeof (row as WorkspaceExecutorFull).type === 'string' &&
    typeof (row as WorkspaceExecutorFull).createdAt === 'string' &&
    typeof (row as WorkspaceExecutorFull).gateFixRounds === 'number' &&
    typeof (row as WorkspaceExecutorFull).config === 'object' &&
    (row as WorkspaceExecutorFull).config !== null;

/** A declared class must name itself and say whether it has Docker: the select shows both. */
const isRunnerClass = (row: unknown): row is RunnerClassOption =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as RunnerClassOption).name === 'string' &&
    typeof (row as RunnerClassOption).docker === 'boolean';

/**
 * The one on-demand executor read — the dialog's only fetch. Module-level because it captures no
 * hook state: exported so the offline suite can pin the wire shape and its error handling, the
 * way `pollDelay` and `pollCompletedJobs` are.
 */
export const listExecutorConfigs = async (): Promise<ExecutorConfigsRead> => {
    type Body = { executors: WorkspaceExecutorFull[]; runnerClasses: RunnerClassOption[] };
    const result = await request<Body>('/api/workspace/executors', {
        verb: 'Could not load the executors',
        guard: (body): body is Body => {
            const { executors, runnerClasses } = (body ?? {}) as { executors?: unknown; runnerClasses?: unknown };
            return (
                Array.isArray(executors) &&
                executors.every(isExecutorFull) &&
                Array.isArray(runnerClasses) &&
                runnerClasses.every(isRunnerClass)
            );
        },
        malformed: 'Could not load the executors: unexpected response shape.',
    });
    return result.ok
        ? { ok: true, executors: result.value.executors, runnerClasses: result.value.runnerClasses }
        : { ok: false, error: result.error };
};

/**
 * The default-executor preference (issue 391). A refusal is the dialog's error message; a
 * preference naming no accessible profile is the route's 404. Module-level like the other
 * on-demand fetches above: it captures no hook state.
 */
export const putDefaultExecutor = (
    scope: ExecutorScope,
    name: string
): Promise<{ ok: true } | { ok: false; error: string }> =>
    putJson(
        '/api/workspace/executors/default',
        { executor: name, executorScope: scope },
        'Could not save the default executor'
    );

export function useWorkspace(): UseWorkspace {
    const [data, setData] = useState<WorkspacePayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const poll = useCallback(async (signal: AbortSignal) => {
        const result = await request<WorkspacePayload>('/api/workspace', { signal });
        // A superseded read leaves state alone; a 401 went to the gate, which swaps the tree.
        if (result.aborted) return;
        if (result.ok) {
            setData(result.value);
            setError(null);
        } else if (!result.unauthenticated) {
            // Deliberately does not clear `data`: what is on screen is still the last true answer.
            setError(result.error);
        }
        setLoading(false);
    }, []);

    // One read at a time: a newer read aborts the one in flight. No timers — the lists change only
    // when the member writes, and every write re-reads.
    const controller = useRef<AbortController | null>(null);
    const start = useCallback(() => {
        controller.current?.abort();
        const own = new AbortController();
        controller.current = own;
        void poll(own.signal);
    }, [poll]);

    useEffect(() => {
        start();
        return () => {
            controller.current?.abort();
        };
    }, [start]);

    /**
     * The executor PUT is not asynchronous — nothing clones — so no re-arm timing is needed.
     */
    const saveExecutors = useCallback(
        async (
            executors: { name: string; type: string; config: object; gateFixRounds: number; suspended?: boolean }[]
        ): Promise<string | null> => {
            setSaving(true);
            try {
                const result = await putJson('/api/workspace/executors', { executors }, 'Could not save the executors');
                if (!result.ok) return result.error;
                start();
                return null;
            } finally {
                setSaving(false);
            }
        },
        [start]
    );

    const { removeExecutor, suspendExecutor } = usePersonalExecutorWrites(start);

    /** The preference write, with the poll re-arm the other writes share. */
    const setDefaultExecutor = useCallback(
        async (scope: ExecutorScope, name: string): Promise<string | null> => {
            const result = await putDefaultExecutor(scope, name);
            if (result.ok) {
                start();
                return null;
            }
            return result.error;
        },
        [start]
    );

    return {
        data,
        loading,
        error,
        saving,
        saveExecutors,
        removeExecutor,
        suspendExecutor,
        setDefaultExecutor,
        listExecutorConfigs,
        refresh: start,
    };
}
