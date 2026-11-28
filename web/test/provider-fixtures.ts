import type { ProviderConnectionMeta } from '@factory-ai/core';
import type { Session } from '../src/api/useSession.js';
import type { WorkspacePayload } from '../src/api/useWorkspace.js';
import { type FetchCall, type FetchReply, stubFetch } from './dom.js';
import { memberSession } from './fixtures.js';

/**
 * The reads the provider screens derive their view from — `GET /api/workspace` and `GET /api/provider-connections` —
 * and the calls they make, shared by the onboarding specs.
 */

export const WORKSPACE_URL = '/api/workspace';
export const PROVIDER_CONNECTIONS_URL = '/api/provider-connections';
export const SETUP_URL = '/api/provider-connections/setup';
export const VERIFY_URL = '/api/provider-connections/verify';

/** Nothing configured: no default executor, no rows. */
export const BARE_WORKSPACE: WorkspacePayload = { executors: [], orgExecutors: [], defaultExecutor: null };

const CREATED = '2026-01-02T03:04:05.678Z';

/** An organization default executor on one connection, as the workspace and connection reads carry it. */
export function orgDefault(
    over: { name?: string; type?: string; suspended?: boolean; provider?: ProviderConnectionMeta['provider'] } = {}
): { workspace: WorkspacePayload; connections: ProviderConnectionMeta[] } {
    const { name = 'Claude Code · Sonnet', type = 'claude-code', suspended = false, provider = 'anthropic' } = over;
    const connection = { id: 'connection-org', name: 'Anthropic', provider, scope: 'org' as const, baseUrl: null };
    return {
        workspace: {
            executors: [],
            orgExecutors: [
                {
                    id: 'executor-org',
                    name,
                    type,
                    createdAt: CREATED,
                    suspended,
                    runnerClass: null,
                    providerConnectionId: connection.id,
                    providerConnectionName: connection.name,
                    providerConnectionProvider: connection.provider,
                    providerConnectionScope: connection.scope,
                },
            ],
            defaultExecutor: { scope: 'org', name },
        },
        connections: [{ ...connection, hasKey: true }],
    };
}

/** The on-demand configuration read of an organization executor (`GET /api/org/executors`): its model and revision. */
export const orgConfigRead = (model: string | null, updatedAt = CREATED) => ({
    executors: [
        {
            id: 'executor-org',
            name: 'Claude Code · Sonnet',
            type: 'claude-code',
            createdAt: CREATED,
            gateFixRounds: 3,
            runnerClass: null,
            suspended: false,
            config: model === null ? {} : { model },
            updatedAt,
        },
    ],
    runnerClasses: [],
});

/** The two reads the composers derive their executors and models from: `undefined` for any other URL. */
export function workspaceReads(
    call: FetchCall,
    workspace: WorkspacePayload = BARE_WORKSPACE,
    connections: ProviderConnectionMeta[] = []
): FetchReply | undefined {
    if (call.method !== 'GET') return undefined;
    if (call.url === WORKSPACE_URL) return workspace;
    if (call.url === PROVIDER_CONNECTIONS_URL) return { connections };
    return undefined;
}

const postsTo = (url: string) => (calls: FetchCall[]) => calls.filter((c) => c.method === 'POST' && c.url === url);
/** `POST /api/provider-connections/setup` calls, in order. */
export const setupCalls = postsTo(SETUP_URL);
/** `POST /api/provider-connections/verify` calls, in order. */
export const verifyCalls = postsTo(VERIFY_URL);

/** The models the key check lists unless a test says otherwise. */
export const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
const SAVED = {
    scope: 'org',
    executorId: 'executor-1',
    executorName: 'Claude Code · Sonnet',
    connectionId: 'connection-1',
    connectionName: 'Anthropic',
    replayed: false,
};

interface Board {
    session?: Partial<Session>;
    workspace?: FetchReply;
    connections?: FetchReply;
    verify?: (call: FetchCall) => FetchReply;
    setup?: FetchReply;
    config?: FetchReply;
}

/** The board of an open setup walk (an admin by default), answering as configured unless a test says otherwise. */
export function board(over: Board = {}) {
    let setup: Session['setup'] = { completed: false, done: [], skipped: [] };
    return stubFetch((call) => {
        if (call.url === '/api/auth/me') return memberSession({ role: 'admin', ...over.session, setup });
        if (call.method === 'POST' && call.url === '/api/onboarding/setup') {
            const { step, action } = call.body as { step: 'provider' | 'tools'; action: 'done' | 'skip' };
            setup = {
                completed: false,
                done: action === 'done' ? [step] : [],
                skipped: action === 'skip' ? [step] : [],
            };
            return { status: 204 };
        }
        if (call.method === 'POST' && call.url === SETUP_URL) return over.setup ?? SAVED;
        if (call.url === VERIFY_URL) return over.verify?.(call) ?? { ok: true, models: MODELS };
        if (call.url === WORKSPACE_URL) return over.workspace ?? BARE_WORKSPACE;
        if (call.url === PROVIDER_CONNECTIONS_URL) return over.connections ?? { connections: [] };
        if (call.url === '/api/org/executors') return over.config ?? orgConfigRead('claude-sonnet-5-5');
    });
}
