import { ORG_SCOPE, type ExecutorType, type ModelProvider } from '@factory-ai/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listOrgExecutorConfigs } from './orgExecutors.js';
import { listProviderConnections, type ProviderConnectionMeta, setupProvider } from './providerConnections.js';
import { request } from './request.js';
import {
    listExecutorConfigs,
    type OrgExecutor,
    type WorkspaceExecutor,
    type WorkspacePayload,
} from './useWorkspace.js';

/**
 * The thin client the model setup UI still reads and saves through until the provider screens replace it. There is no
 * server view of it any more: the view is derived from `/api/workspace` and `/api/provider-connections`, and a save is
 * the provider setup command (`POST /api/provider-connections/setup`).
 */

/** One scope's setup, names only; null when it has none. */
export interface ModelScopeView {
    provider: string | null;
    keyNames: string[];
    /** The provider's base URL when the scope holds it as a plain variable. */
    baseUrl?: string;
    /** The scope holds the provider's base URL as a secret: set, its value withheld. */
    baseUrlSet?: true;
}

export type SetupScope = 'org' | 'personal';

/** The default executor: ids and names, the connection's safe metadata, never a credential. */
export interface SelectedExecutorView {
    scope: SetupScope;
    executorId: string;
    name: string;
    agentType: ExecutorType;
    model: string | null;
    suspended: boolean;
    /** The executor's revision: a save of this executor sends it back, so an older read cannot overwrite a newer save. Empty when the member's read could not see it. */
    updatedAt: string;
    /** The connection the executor runs on, when the member may see it; null for the environment's keys. */
    connection: { id: string; name: string; provider: ModelProvider; scope: SetupScope; baseUrl: string | null } | null;
}

export interface ModelSetupView {
    org: ModelScopeView | null;
    personal: ModelScopeView | null;
    /** The configured default executor (the member's, else the organization's); absent when none is configured. */
    selected?: SelectedExecutorView;
    effective: 'executor' | 'personal' | 'org' | null;
}

/** What a setup does about the connection: seal a new one, select one, or replace one's key. */
export type ConnectionBody =
    | { intent: 'create'; provider: ModelProvider; key: string; baseUrl?: string; name: string }
    | { intent: 'reuse'; id: string }
    | { intent: 'rotate'; id: string; key: string; baseUrl?: string };

/** The provider setup the hook sends (the request id is the hook's): the connection intent and the executor it runs, made the default. */
export interface ModelSetupSave {
    scope: SetupScope;
    agentType: ExecutorType;
    model: string;
    connection: ConnectionBody;
    /** An edit names the executor by its stable id; a new one needs a name. */
    executor: { id?: string; name?: string; expectedUpdatedAt?: string };
}

/** What a save answers: the stable identities the next save carries. */
export interface SavedSetup {
    scope: SetupScope;
    executorId: string;
    executorName: string;
    connectionId: string | null;
    connectionName: string | null;
    replayed: boolean;
}

/** The default executor's connection, from the executor row's own safe fields and the list's endpoint. */
function connectionOf(
    row: WorkspaceExecutor | OrgExecutor,
    connections: readonly ProviderConnectionMeta[]
): SelectedExecutorView['connection'] {
    const { providerConnectionId: id, providerConnectionName: name, providerConnectionProvider: provider } = row;
    const scope = row.providerConnectionScope;
    if (!id || !name || !provider || !scope) return null;
    return { id, name, provider, scope, baseUrl: connections.find((c) => c.id === id)?.baseUrl ?? null };
}

/** What the default executor's configuration adds to the poll's row: its model and revision. */
interface Detail {
    model: string | null;
    updatedAt: string;
}

/** The view from the reads: the member's resolved default and the connection it runs on; nothing selected is `effective: null`. */
export function viewOf(
    workspace: WorkspacePayload,
    connections: readonly ProviderConnectionMeta[],
    detail: Detail | null
): ModelSetupView {
    const def = workspace.defaultExecutor;
    const org = def?.scope === ORG_SCOPE;
    const row = def ? (org ? workspace.orgExecutors : workspace.executors).find((e) => e.name === def.name) : undefined;
    if (!def || !row) return { org: null, personal: null, effective: null };
    const selected: SelectedExecutorView = {
        scope: org ? 'org' : 'personal',
        executorId: row.id,
        name: row.name,
        agentType: row.type as ExecutorType,
        model: detail?.model ?? null,
        suspended: row.suspended || def.unusable === 'suspended',
        updatedAt: detail?.updatedAt ?? '',
        connection: connectionOf(row, connections),
    };
    return {
        org: null,
        personal: null,
        selected,
        effective: selected.suspended ? null : 'executor',
    };
}

/**
 * The default executor's model and revision, from the on-demand configuration reads the executor dialogs use. A member
 * cannot read an organization profile's configuration: its model and revision stay unknown, which a save tolerates.
 */
async function detailOf(workspace: WorkspacePayload): Promise<Detail | null> {
    const def = workspace.defaultExecutor;
    const org = def?.scope === ORG_SCOPE;
    const row = def ? (org ? workspace.orgExecutors : workspace.executors).find((e) => e.name === def.name) : undefined;
    if (!row) return null;
    const read = org ? await listOrgExecutorConfigs() : await listExecutorConfigs();
    if (!read.ok) return null;
    const full = (read.executors as { id: string; config: object; updatedAt?: string }[]).find((e) => e.id === row.id);
    if (!full) return null;
    const model = (full.config as { model?: unknown }).model;
    return { model: typeof model === 'string' ? model : null, updatedAt: full.updatedAt ?? '' };
}

type Read = { ok: true; view: ModelSetupView } | { ok: false; error: string };

/** Reads the workspace and the connections; any failed read is an error, never "no setup". */
async function readView(signal?: AbortSignal): Promise<Read & { aborted?: true }> {
    const [workspace, connections] = await Promise.all([
        request<WorkspacePayload>('/api/workspace', {
            ...(signal ? { signal } : {}),
            verb: 'Could not read the model setup',
        }),
        listProviderConnections(signal),
    ]);
    if (workspace.aborted || ('aborted' in connections && connections.aborted))
        return { ok: false, error: '', aborted: true };
    if (!workspace.ok)
        return workspace.unauthenticated
            ? { ok: false, error: '', aborted: true }
            : { ok: false, error: workspace.error };
    if (!connections.ok) return { ok: false, error: connections.error };
    return { ok: true, view: viewOf(workspace.value, connections.connections, await detailOf(workspace.value)) };
}

/** Every mounted read's refresh: a save re-reads the others, so the shell's banner follows a save without a reload. */
const readers = new Set<() => void>();

export interface UseModelSetup {
    data: ModelSetupView | null;
    loading: boolean;
    error: string | null;
    refresh: () => void;
    /** Writes the setup; the saved identities, or the refusal's sentence on failure. */
    save: (body: ModelSetupSave) => Promise<{ ok: true; saved: SavedSetup } | { ok: false; error: string }>;
    /** Re-reads the setup and settles once it has landed (or failed): a save hands over only after it. */
    reread: () => Promise<void>;
}

export function useModelSetup(): UseModelSetup {
    const [data, setData] = useState<ModelSetupView | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null);

    const refresh = useCallback(() => {
        controller.current?.abort();
        const own = new AbortController();
        controller.current = own;
        void readView(own.signal).then((result) => {
            // A superseded read never lands; a 401 went to the gate. A failed read keeps the last true answer.
            if (own.signal.aborted || ('aborted' in result && result.aborted)) return;
            if (result.ok) {
                setData(result.view);
                setError(null);
            } else {
                setError(result.error);
            }
            setLoading(false);
        });
    }, []);

    useEffect(() => {
        refresh();
        readers.add(refresh);
        return () => {
            readers.delete(refresh);
            controller.current?.abort();
        };
    }, [refresh]);

    // The same body keeps one request id until it lands, so a retry after an unknown outcome replays instead of writing twice.
    const attempt = useRef<{ body: string; requestId: string } | null>(null);
    const save = useCallback(
        async (body: ModelSetupSave) => {
            const text = JSON.stringify(body);
            if (attempt.current?.body !== text) attempt.current = { body: text, requestId: crypto.randomUUID() };
            const { expectedUpdatedAt, ...executor } = body.executor;
            const result = await setupProvider({
                scope: body.scope,
                requestId: attempt.current.requestId,
                connection: body.connection,
                executor: {
                    ...executor,
                    agentType: body.agentType,
                    model: body.model,
                    ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
                },
                makeDefault: true,
            });
            if (!result.ok) return { ok: false, error: result.error } as const;
            attempt.current = null;
            for (const reader of readers) if (reader !== refresh) reader();
            return { ok: true, saved: result.value } as const;
        },
        [refresh]
    );
    const reread = useCallback(async () => {
        const result = await readView();
        if (result.ok) setData(result.view);
    }, []);
    return { data, loading, error, refresh, save, reread };
}
