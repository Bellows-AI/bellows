import {
    ORG_SCOPE,
    type ExecutorType,
    type ProviderConnectionMeta,
    type ProviderConnectionScope,
} from '@factory-ai/core';
import { useEffect, useState } from 'react';
import { listOrgExecutorConfigs } from '../api/orgExecutors.js';
import type { UseProviderConnections } from '../api/useProviderConnections.js';
import {
    listExecutorConfigs,
    type OrgExecutor,
    type UseWorkspace,
    type WorkspaceExecutor,
    type WorkspacePayload,
} from '../api/useWorkspace.js';

/**
 * The member's default executor and the connection it runs on, derived from `/api/workspace` and
 * `/api/provider-connections` — there is no server view of it. Names and ids only: never a key.
 */

export interface DefaultExecutor {
    scope: ProviderConnectionScope;
    id: string;
    name: string;
    agentType: ExecutorType;
    suspended: boolean;
    /** The connection the executor runs on, when the member may see it. */
    connection: ProviderConnectionMeta | null;
}

/** What the default executor's configuration adds: its model and revision, which the poll's row does not carry. */
export interface ExecutorDetail {
    model: string | null;
    updatedAt: string;
}

/** The resolved default as a row of its scope's list; null when none is configured or its row is not in the list. */
export function defaultExecutorOf(
    workspace: WorkspacePayload,
    connections: readonly ProviderConnectionMeta[]
): DefaultExecutor | null {
    const def = workspace.defaultExecutor;
    if (!def) return null;
    const org = def.scope === ORG_SCOPE;
    const rows: readonly (WorkspaceExecutor | OrgExecutor)[] = org ? workspace.orgExecutors : workspace.executors;
    const row = rows.find((candidate) => candidate.name === def.name);
    if (!row) return null;
    return {
        scope: org ? 'org' : 'personal',
        id: row.id,
        name: row.name,
        agentType: row.type as ExecutorType,
        suspended: row.suspended || def.unusable === 'suspended',
        connection: connections.find((connection) => connection.id === row.providerConnectionId) ?? null,
    };
}

/** Whether the member may replace the executor's own key: its connection is in the executor's scope, which they may write. */
export const canReplaceKey = (executor: DefaultExecutor, admin: boolean): boolean =>
    executor.connection !== null &&
    executor.connection.scope === executor.scope &&
    (executor.scope === 'personal' || admin);

/**
 * The configuration read the executor dialogs use. A member cannot read an organization profile's configuration: its
 * model and revision stay unknown, and so does everything that needs them.
 */
async function readDetail(executor: DefaultExecutor): Promise<ExecutorDetail | null> {
    const read = executor.scope === 'org' ? await listOrgExecutorConfigs() : await listExecutorConfigs();
    if (!read.ok) return null;
    const full = (read.executors as { id: string; config: object; updatedAt?: string }[]).find(
        (row) => row.id === executor.id
    );
    if (!full) return null;
    const { model } = full.config as { model?: unknown };
    return { model: typeof model === 'string' ? model : null, updatedAt: full.updatedAt ?? '' };
}

/**
 * What the reads came to. A failed read is `error`, never `none`: an unconfirmed answer says nothing about the setup,
 * so it shows neither the set-up banner nor the empty form.
 */
export type DefaultExecutorRead =
    | { state: 'loading' }
    | { state: 'error'; error: string; retry: () => void }
    | { state: 'none' }
    | { state: 'set'; executor: DefaultExecutor; detail: ExecutorDetail | null };

export function useDefaultExecutor(workspace: UseWorkspace, connections: UseProviderConnections): DefaultExecutorRead {
    const retry = () => {
        workspace.refresh();
        connections.refresh();
    };
    const executor =
        workspace.data && connections.connections ? defaultExecutorOf(workspace.data, connections.connections) : null;
    const [detail, setDetail] = useState<ExecutorDetail | null>(null);
    const identity = executor ? `${executor.scope}:${executor.id}` : null;

    useEffect(() => {
        setDetail(null);
        if (!executor) return;
        let current = true;
        void readDetail(executor).then((read) => {
            if (current) setDetail(read);
        });
        return () => {
            current = false;
        };
        // The executor's identity and the connection list: a save re-reads the list, and the revision with it.
    }, [identity, connections.connections]);

    if (workspace.error !== null || connections.error !== null) {
        return { state: 'error', error: workspace.error ?? connections.error ?? '', retry };
    }
    if (workspace.data === null || connections.connections === null) return { state: 'loading' };
    // A default that names a row the list does not hold, without the server saying it is missing, is two reads that
    // disagree: inconclusive, never "nothing is set up".
    const named = workspace.data.defaultExecutor;
    if (!executor && named && named.unusable !== 'missing') {
        return { state: 'error', error: 'The default executor could not be matched to its row.', retry };
    }
    return executor ? { state: 'set', executor, detail } : { state: 'none' };
}
