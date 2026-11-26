/** The safe provider connection fields an executor row carries (copied from core, never imported): no key, no secret reference. */
export interface ExecutorConnectionView {
    providerConnectionId?: string | null;
    providerConnectionName?: string | null;
    providerConnectionProvider?: string | null;
    providerConnectionScope?: 'org' | 'personal' | null;
    /** Pasted config credentials or endpoints take precedence over the connection. */
    configOverridesConnection?: boolean;
}

/** The slice of the workspace read discovery shows: executor selection metadata. */
export interface WorkspaceView {
    executors: ({ name: string; type: string; suspended?: boolean } & ExecutorConnectionView)[];
    /** `runnerClass`: the named runner class the org profile's tasks run on; null or absent means the default. */
    orgExecutors: ({
        name: string;
        type: string;
        runnerClass?: string | null;
        suspended?: boolean;
    } & ExecutorConnectionView)[];
    defaultExecutor: { scope: string; name: string } | null;
}
