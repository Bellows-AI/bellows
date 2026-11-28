import type { ProviderConnectionMeta } from '@factory-ai/core';
import type { ModelSetupView } from '../src/api/useModelSetup.js';
import type { WorkspacePayload } from '../src/api/useWorkspace.js';
import type { FetchCall, FetchReply } from './dom.js';

/**
 * The reads the model setup hook derives its view from, answered from a `ModelSetupView` fixture: the thin client has
 * no route of its own any more, so a test keeps its fixture and routes the four URLs through `modelSetupReads`
 * (`GET /api/workspace`, `GET /api/provider-connections`, and the on-demand configuration reads of the default executor,
 * `GET /api/workspace/executors` and `GET /api/org/executors`). Only `selected` and `effective: null` are expressible.
 */

export const WORKSPACE_URL = '/api/workspace';
export const PROVIDER_CONNECTIONS_URL = '/api/provider-connections';
export const SETUP_URL = '/api/provider-connections/setup';
export const VERIFY_URL = '/api/provider-connections/verify';

export const NO_SETUP: ModelSetupView = { org: null, personal: null, effective: null };

/** What the hook answers when nothing is configured: no default executor, no rows. */
export const BARE_WORKSPACE: WorkspacePayload = {
    executors: [],
    orgExecutors: [],
    defaultExecutor: null,
};

/** `POST /api/provider-connections/setup` calls, in order. */
export const setupCalls = (calls: FetchCall[]) => calls.filter((c) => c.method === 'POST' && c.url === SETUP_URL);
/** `POST /api/provider-connections/verify` calls, in order. */
export const verifyCalls = (calls: FetchCall[]) => calls.filter((c) => c.method === 'POST' && c.url === VERIFY_URL);
/** How many times the setup view was read: the hook alone reads `GET /api/provider-connections`, once per read. */
export const setupReads = (calls: FetchCall[]) =>
    calls.filter((c) => c.method === 'GET' && c.url === PROVIDER_CONNECTIONS_URL).length;

const AT = '2026-01-02T03:04:05.678Z';

/** The workspace the view's default executor implies, on top of `base` (which keeps its other rows). */
export function workspaceOf(view: ModelSetupView, base: WorkspacePayload = BARE_WORKSPACE): WorkspacePayload {
    const { selected } = view;
    if (!selected) return base;
    const row = {
        id: selected.executorId,
        name: selected.name,
        type: selected.agentType,
        createdAt: AT,
        suspended: selected.suspended,
        ...(selected.connection
            ? {
                  providerConnectionId: selected.connection.id,
                  providerConnectionName: selected.connection.name,
                  providerConnectionProvider: selected.connection.provider,
                  providerConnectionScope: selected.connection.scope,
              }
            : {}),
    };
    const defaultExecutor = {
        scope: selected.scope === 'org' ? ('org' as const) : ('user' as const),
        name: selected.name,
    };
    // A row the test already keeps under the same id stays as it wrote it.
    const kept = (rows: readonly { id: string }[]) => rows.some((r) => r.id === row.id);
    if (selected.scope === 'org') {
        const orgExecutors = kept(base.orgExecutors)
            ? base.orgExecutors
            : [...base.orgExecutors, { ...row, runnerClass: null }];
        return { ...base, orgExecutors, defaultExecutor };
    }
    const executors = kept(base.executors) ? base.executors : [...base.executors, { ...row, gateFixRounds: 3 }];
    return { ...base, executors, defaultExecutor };
}

/** The connection list the view's default executor runs on. */
export function connectionsOf(view: ModelSetupView): ProviderConnectionMeta[] {
    const connection = view.selected?.connection;
    return connection ? [{ ...connection, hasKey: true }] : [];
}

/** The on-demand configuration read of the default executor: its model and revision. */
function configRead(view: ModelSetupView): { executors: object[]; runnerClasses: object[] } {
    const { selected } = view;
    if (!selected) return { executors: [], runnerClasses: [] };
    return {
        executors: [
            {
                id: selected.executorId,
                name: selected.name,
                type: selected.agentType,
                createdAt: AT,
                gateFixRounds: 3,
                runnerClass: null,
                suspended: selected.suspended,
                config: selected.model === null ? {} : { model: selected.model },
                ...(selected.updatedAt ? { updatedAt: selected.updatedAt } : {}),
            },
        ],
        runnerClasses: [],
    };
}

/**
 * The fetch answers for the setup reads, or `undefined` for any other URL. `{ status }` fails the connections read, which fails the view's read. `base` is the workspace a test keeps besides the default executor.
 */
export function modelSetupReads(
    view: ModelSetupView | { status: number },
    call: FetchCall,
    base: WorkspacePayload = BARE_WORKSPACE
): FetchReply | undefined {
    if (call.method !== 'GET') return undefined;
    if ('status' in view) {
        // The connections read fails alone: the workspace stays readable for the page's other consumers.
        if (call.url === PROVIDER_CONNECTIONS_URL) return view;
        return call.url === WORKSPACE_URL ? base : undefined;
    }
    if (call.url === WORKSPACE_URL) return workspaceOf(view, base);
    if (call.url === PROVIDER_CONNECTIONS_URL) return { connections: connectionsOf(view) };
    if (call.url === '/api/workspace/executors' && view.selected?.scope !== 'org') return configRead(view);
    if (call.url === '/api/org/executors' && view.selected?.scope === 'org') return configRead(view);
    return undefined;
}
