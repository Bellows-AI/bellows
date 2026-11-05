import { ADMIN_ROLE, CLAUDE_CODE, type Role } from '@factory-ai/core';
import type { ConnectionView } from '../src/api/connections.js';
import type { OrgExecutorFull } from '../src/api/orgExecutors.js';
import type { SubscriptionScope, SubscriptionView } from '../src/api/notificationSubscriptions.js';
import type { InstallationRepo } from '../src/api/useRepos.js';
import type { Session } from '../src/api/useSession.js';
import type { WorkspaceExecutorFull, WorkspacePayload } from '../src/api/useWorkspace.js';
import type { FetchCall, FetchHandler, FetchReply } from './dom.js';

/**
 * A stateful stand-in for the board's settings routes, for the `*.dom.test.tsx` suites that mount
 * a settings page through the real route table. Writes change the state the next read answers,
 * the way the server's own rows do; anything a test needs to refuse goes through `override`.
 */

export interface SettingsBoard {
    role: Role;
    installationRepos: InstallationRepo[];
    executors: WorkspaceExecutorFull[];
    orgExecutors: (OrgExecutorFull & { suspended: boolean })[];
    connections: ConnectionView[];
    /** The notification subscriptions of each scope, and the channel kinds the board can send through. */
    subscriptions: Record<SubscriptionScope, SubscriptionView[]>;
    connectorKinds: string[];
    /** Whether `GET /api/integrations` reports Jira as configured on this deployment. */
    jiraConfigured: boolean;
}

const AT = '2026-09-01T00:00:00.000Z';
let nextId = 0;
const id = () => `00000000-0000-4000-8000-${(++nextId).toString().padStart(12, '0')}`;

export function settingsBoard(overrides: Partial<SettingsBoard> = {}): SettingsBoard {
    return {
        role: ADMIN_ROLE,
        installationRepos: [],
        executors: [],
        orgExecutors: [],
        connections: [],
        subscriptions: { org: [], workspace: [] },
        connectorKinds: ['discord'],
        jiraConfigured: true,
        ...overrides,
    };
}

/** A loaded workspace read with nothing configured: no executors of either scope. */
export const emptyWorkspace = (): { loading: false; data: WorkspacePayload } => ({
    loading: false,
    data: { executors: [], orgExecutors: [], defaultExecutor: null },
});

export const installationRepo = (owner: string, name: string): InstallationRepo => ({
    owner,
    name,
    private: true,
    defaultBranch: null,
    pushedAt: AT,
});

export const personalExecutor = (name: string, config: object = {}): WorkspaceExecutorFull => ({
    id: id(),
    name,
    type: CLAUDE_CODE,
    config,
    gateFixRounds: 3,
    suspended: false,
    createdAt: AT,
});

export const orgExecutor = (name: string): SettingsBoard['orgExecutors'][number] => ({
    id: id(),
    name,
    type: CLAUDE_CODE,
    config: {},
    gateFixRounds: 3,
    createdAt: AT,
    updatedAt: AT,
    createdBy: null,
    suspended: false,
});

export const connection = (site: string, overrides: Partial<ConnectionView> = {}): ConnectionView => ({
    id: id(),
    provider: 'jira',
    site,
    account: 'stub-account-a@example.com',
    access: 'read',
    status: 'active',
    needsReconnect: false,
    createdAt: AT,
    ...overrides,
});

export const subscription = (overrides: Partial<SubscriptionView> = {}): SubscriptionView => ({
    id: id(),
    connectorKind: 'discord',
    connectorConfig: {},
    eventKinds: ['task.ready'],
    repos: [],
    enabled: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
});

function session(board: SettingsBoard): Session {
    return {
        authenticated: true,
        user: { id: 'u1', login: 'e2e-member', name: 'E2E Member', githubUserId: 1, avatarUrl: null },
        role: board.role,
        membership: { invitedAt: null, claimedAt: AT },
        account: { createdAt: AT, lastLoginAt: AT },
        organization: { id: 'org1', name: 'Bellows-AI' },
        organizations: [{ id: 'org1', name: 'Bellows-AI' }],
        mode: 'github',
        mcp: false,
        batches: false,
    };
}

/** The server's fallback: the first active personal profile, else the first active org one. */
function defaultExecutor(board: SettingsBoard) {
    const personal = board.executors.find((row) => !row.suspended);
    if (personal) return { scope: 'user' as const, name: personal.name };
    const org = board.orgExecutors.find((row) => !row.suspended);
    return org ? { scope: 'org' as const, name: org.name } : null;
}

function workspace(board: SettingsBoard) {
    return {
        executors: board.executors.map(({ config: _config, ...row }) => row),
        orgExecutors: board.orgExecutors.map(({ name, type, createdAt, suspended }) => ({
            name,
            type,
            createdAt,
            suspended,
        })),
        defaultExecutor: defaultExecutor(board),
    };
}

type ExecutorRow = { name: string; type: string; config: object; gateFixRounds: number; suspended?: boolean };

function routes(board: SettingsBoard, { method, url, body }: FetchCall): FetchReply | undefined {
    const path = url.split('?')[0] ?? url;
    const byId = (rows: { id: string }[]) => rows.findIndex((row) => path.includes(`/${row.id}`));
    if (method === 'GET' && path === '/api/auth/me') return session(board);
    if (method === 'GET' && path === '/api/env') return { org: [], workspace: [], repos: [] };
    if (method === 'GET' && path === '/api/repos') {
        return {
            repos: board.installationRepos,
            installation: { id: '1', account: 'Bellows-AI', repositorySelection: 'all' },
            meta: { fetchedAt: AT, error: null },
        };
    }
    if (method === 'GET' && path === '/api/workspace') return workspace(board);
    if (method === 'GET' && path === '/api/workspace/executors') return { executors: board.executors };
    if (method === 'PUT' && path === '/api/workspace/executors') {
        const rows = (body as { executors: ExecutorRow[] }).executors;
        board.executors = rows.map((row) => ({
            id: board.executors.find((old) => old.name === row.name)?.id ?? id(),
            createdAt: AT,
            ...row,
            suspended: row.suspended ?? false,
        }));
        return {};
    }
    if (path.startsWith('/api/workspace/executors/')) {
        const index = byId(board.executors);
        if (index < 0) return { status: 404, body: { error: 'No such executor' } };
        if (method === 'DELETE') board.executors.splice(index, 1);
        else if (path.endsWith('/suspension')) {
            board.executors[index] = {
                ...board.executors[index]!,
                suspended: (body as { suspended: boolean }).suspended,
            };
        }
        return { status: 204 };
    }
    if (method === 'GET' && path === '/api/org/executors') return { executors: board.orgExecutors };
    if (path.startsWith('/api/org/executors/')) {
        const index = byId(board.orgExecutors);
        if (index < 0) return { status: 404, body: { error: 'No such executor' } };
        if (method === 'DELETE') board.orgExecutors.splice(index, 1);
        else if (path.endsWith('/suspension')) {
            board.orgExecutors[index] = {
                ...board.orgExecutors[index]!,
                suspended: (body as { suspended: boolean }).suspended,
            };
        }
        return { status: 204 };
    }
    if (method === 'GET' && path === '/api/integrations') {
        return { integrations: [{ provider: 'jira', configured: board.jiraConfigured }] };
    }
    if (method === 'GET' && path === '/api/connections') return { connections: board.connections };
    if (method === 'DELETE' && path.startsWith('/api/connections/')) {
        board.connections = board.connections.filter((row) => !path.endsWith(`/${row.id}`));
        return { status: 204 };
    }
    return subscriptionRoutes(board, path, method, body);
}

const SUBSCRIPTION_PATH = /^\/api\/(org|workspace)\/notification-subscriptions(?:\/([^/]+)(\/test)?)?$/;

/** The org and personal subscription routes: a list that answers the board's rows, writes that change them. */
function subscriptionRoutes(board: SettingsBoard, path: string, method: string, body: unknown): FetchReply | undefined {
    const match = SUBSCRIPTION_PATH.exec(path);
    if (!match) return undefined;
    const scope = match[1] as SubscriptionScope;
    const rowId = match[2];
    const rows = board.subscriptions[scope];
    if (!rowId && method === 'GET') return { subscriptions: rows, connectorKinds: board.connectorKinds };
    if (!rowId && method === 'POST') {
        const { credential: _credential, ...fields } = body as Record<string, unknown>;
        const created = subscription(fields as Partial<SubscriptionView>);
        rows.push(created);
        return { status: 201, body: created };
    }
    const index = rows.findIndex((row) => row.id === rowId);
    if (index < 0) return { status: 404, body: { error: 'No such notification subscription' } };
    if (match[3] && method === 'POST') return { result: { status: 'delivered' } };
    if (method === 'PUT') {
        const { credential: _credential, ...fields } = body as Record<string, unknown>;
        rows[index] = { ...rows[index]!, ...(fields as Partial<SubscriptionView>) };
        return rows[index];
    }
    if (method === 'DELETE') rows.splice(index, 1);
    return { status: 204 };
}

/** The board as a `stubFetch` handler; `override` answers first, and `undefined` falls through. */
export const boardHandler =
    (board: SettingsBoard, override: FetchHandler = () => undefined): FetchHandler =>
    (call) =>
        override(call) ?? routes(board, call);
