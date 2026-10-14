import { ADMIN_ROLE, CLAUDE_CODE, type Role } from '@factory-ai/core';
import type { ConnectionView } from '../src/api/connections.js';
import type { OrgExecutorFull } from '../src/api/orgExecutors.js';
import type { InstallationRepo } from '../src/api/useRepos.js';
import type { Session } from '../src/api/useSession.js';
import type { WorkspaceExecutorFull, WorkspacePayload, WorkspaceRepo } from '../src/api/useWorkspace.js';
import type { FetchCall, FetchHandler, FetchReply } from './dom.js';

/**
 * A stateful stand-in for the board's settings routes, for the `*.dom.test.tsx` suites that mount
 * a settings page through the real route table. Writes change the state the next read answers,
 * the way the server's own rows do; anything a test needs to refuse goes through `override`.
 */

export interface SettingsBoard {
    role: Role;
    root: string | null;
    installationRepos: InstallationRepo[];
    repos: WorkspaceRepo[];
    executors: WorkspaceExecutorFull[];
    orgExecutors: (OrgExecutorFull & { suspended: boolean })[];
    connections: ConnectionView[];
}

const AT = '2026-09-01T00:00:00.000Z';
let nextId = 0;
const id = () => `00000000-0000-4000-8000-${(++nextId).toString().padStart(12, '0')}`;

export function settingsBoard(overrides: Partial<SettingsBoard> = {}): SettingsBoard {
    return {
        role: ADMIN_ROLE,
        root: '/workspaces/e2e',
        installationRepos: [],
        repos: [],
        executors: [],
        orgExecutors: [],
        connections: [],
        ...overrides,
    };
}

/** A loaded workspace read on a deployment with no workspace root: nothing checked out, nothing selected. */
export const rootlessWorkspace = (
    checkoutTotalBytes: number | null = null
): { loading: false; data: WorkspacePayload } => ({
    loading: false,
    data: {
        root: null,
        repos: [],
        orphaned: [],
        checkoutTotalBytes,
        executors: [],
        orgExecutors: [],
        defaultExecutor: null,
    },
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
    site,
    email: 'bot@example.com',
    access: 'read',
    scope: 'org',
    createdAt: AT,
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
        workspacePath: board.root,
        mode: 'github',
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
        root: board.root,
        repos: board.repos,
        orphaned: [],
        checkoutTotalBytes: null,
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
    if (method === 'GET' && path === '/api/connections') return { connections: board.connections };
    if (method === 'DELETE' && path.startsWith('/api/connections/')) {
        board.connections = board.connections.filter((row) => !path.endsWith(`/${row.id}`));
        return { status: 204 };
    }
    return undefined;
}

/** The board as a `stubFetch` handler; `override` answers first, and `undefined` falls through. */
export const boardHandler =
    (board: SettingsBoard, override: FetchHandler = () => undefined): FetchHandler =>
    (call) =>
        override(call) ?? routes(board, call);
