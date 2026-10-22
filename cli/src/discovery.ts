import type { VisibleRepos, WorkspaceView } from './board.js';

/**
 * The data a discovery command reports, joined from the board's own reads. Pure: nothing here
 * calls the board, and nothing a discovery command calls writes — no sync, no provisioning.
 */

export interface RepoRow {
    repo: string;
    private: boolean;
    defaultBranch: string | null;
}

export interface RepoDiscovery {
    repos: RepoRow[];
    /** The board's named reason the list may be stale or empty, else null. */
    error: string | null;
    fetchedAt: string | null;
}

/** The repositories the board tracks, as the board lists them. */
export function repoDiscovery(visible: VisibleRepos): RepoDiscovery {
    return {
        repos: visible.repos.map((repo) => ({
            repo: `${repo.owner}/${repo.name}`,
            private: repo.private,
            defaultBranch: repo.defaultBranch,
        })),
        error: visible.meta.error,
        fetchedAt: visible.meta.fetchedAt,
    };
}

export interface ExecutorRow {
    /** The `--executor-scope` value that selects it. */
    scope: 'user' | 'org';
    name: string;
    type: string;
    suspended: boolean;
    /** The caller's resolved default: what a task naming no executor gets. */
    default: boolean;
}

/** Personal profiles, then the org's, each with its selection scope; credentials never ride along. */
export function executorDiscovery(workspace: WorkspaceView): { executors: ExecutorRow[] } {
    const row = (scope: ExecutorRow['scope'], profile: WorkspaceView['executors'][number]): ExecutorRow => ({
        scope,
        name: profile.name,
        type: profile.type,
        suspended: profile.suspended === true,
        default: workspace.defaultExecutor?.scope === scope && workspace.defaultExecutor.name === profile.name,
    });
    return {
        executors: [
            ...workspace.executors.map((profile) => row('user', profile)),
            ...workspace.orgExecutors.map((profile) => row('org', profile)),
        ],
    };
}
