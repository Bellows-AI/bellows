import { JSON_HEADERS } from '@factory-ai/core';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/**
 * The Jira connections' client half: the list, the create and the disconnect (a `DELETE`) of `/api/connections`.
 * The token goes out on create and is in no response, so no type here has a field for it.
 */

export const CONNECTION_ACCESS = ['read', 'write'] as const;
export type ConnectionAccess = (typeof CONNECTION_ACCESS)[number];

/** The create's `scope` (wire value, both ways): `org` makes a legacy shared connection, `user` a personal one. */
export const ORG_CONNECTION_SCOPE = 'org';
export const USER_CONNECTION_SCOPE = 'user';
export type ConnectionScope = typeof ORG_CONNECTION_SCOPE | typeof USER_CONNECTION_SCOPE;

export const CONNECTION_CREDENTIALS = ['legacy_api_token', 'oauth_grant'] as const;
export type ConnectionCredential = (typeof CONNECTION_CREDENTIALS)[number];
export const CONNECTION_OWNERSHIPS = ['personal', 'legacy-org'] as const;
export type ConnectionOwnership = (typeof CONNECTION_OWNERSHIPS)[number];

/**
 * One row of `GET /api/connections`: the caller's own active connections plus the org's legacy ones,
 * newest first. `principal` is `self` for the caller's own row and null for a legacy org one.
 */
export interface ConnectionView {
    id: string;
    provider: string;
    credential: ConnectionCredential;
    ownership: ConnectionOwnership;
    principal: 'self' | null;
    site: string;
    account: string;
    access: ConnectionAccess;
    status: 'active' | 'disconnected';
    createdAt: string;
}

export interface NewConnectionInput {
    scope: ConnectionScope;
    site: string;
    email: string;
    apiToken: string;
    access: ConnectionAccess;
}

const isConnectionView = (row: unknown): row is ConnectionView => {
    if (typeof row !== 'object' || row === null) return false;
    const view = row as ConnectionView;
    return (
        typeof view.id === 'string' &&
        typeof view.site === 'string' &&
        typeof view.provider === 'string' &&
        typeof view.account === 'string' &&
        CONNECTION_CREDENTIALS.includes(view.credential) &&
        CONNECTION_OWNERSHIPS.includes(view.ownership) &&
        (view.principal === 'self' || view.principal === null) &&
        CONNECTION_ACCESS.includes(view.access) &&
        (view.status === 'active' || view.status === 'disconnected') &&
        typeof view.createdAt === 'string'
    );
};

const SESSION_EXPIRED = 'Your session expired';

/** The caller's visible connections, or the refusal's message. */
export const listConnections = async (): Promise<
    { ok: true; connections: ConnectionView[] } | { ok: false; error: string }
> => {
    try {
        const response = await fetch('/api/connections');
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false, error: SESSION_EXPIRED };
        }
        if (!response.ok) {
            return { ok: false, error: (await refusalOf(response, 'Could not load the connections')).error };
        }
        const rows: unknown = ((await response.json()) as { connections?: unknown }).connections;
        if (!Array.isArray(rows) || !rows.every(isConnectionView)) {
            return { ok: false, error: 'Could not load the connections: unexpected response shape.' };
        }
        return { ok: true, connections: rows };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
};

/** Returns the route's refusal message as-is, or null when the connection was saved. */
export const createConnection = async (input: NewConnectionInput): Promise<string | null> => {
    try {
        const response = await fetch('/api/connections', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(input),
        });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return SESSION_EXPIRED;
        }
        if (!response.ok) return (await refusalOf(response, 'Could not save the connection')).error;
        return null;
    } catch (e) {
        return (e as Error).message;
    }
};

/** Returns the refusal's message, or null when the connection is disconnected. */
export const deleteConnection = async (id: string): Promise<string | null> => {
    try {
        const response = await fetch(`/api/connections/${id}`, { method: 'DELETE' });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return SESSION_EXPIRED;
        }
        if (!response.ok) return (await refusalOf(response, 'Could not disconnect the connection')).error;
        return null;
    } catch (e) {
        return (e as Error).message;
    }
};
