import { JSON_HEADERS } from '@factory-ai/core';
import { refusalOf } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/**
 * The connections' client half: the caller's own list and the disconnect (a `DELETE`) of
 * `/api/connections`, the OAuth start of `POST /api/integrations/<provider>/authorizations`, and
 * a task's bind and dismiss of its connection requirements. No credential is ever in a response,
 * so no type here has a field for one.
 */

export const CONNECTION_ACCESS = ['read', 'write'] as const;
export type ConnectionAccess = (typeof CONNECTION_ACCESS)[number];

/** One row of `GET /api/connections`: the caller's own active OAuth connection, newest first. */
export interface ConnectionView {
    id: string;
    provider: string;
    site: string;
    /** The connected Atlassian account's label (its email, else its display name). */
    account: string;
    access: ConnectionAccess;
    status: 'active' | 'disconnected';
    createdAt: string;
}

/**
 * What the start sends: `connectionId` reconnects that connection, `site` narrows a new connect to one
 * site, `jobId` binds the new connection to that task on consent, and `returnTo` is where the browser lands.
 */
export interface StartAuthorizationInput {
    access?: ConnectionAccess;
    site?: string;
    connectionId?: string;
    jobId?: string;
    returnTo?: string;
}

const isConnectionView = (row: unknown): row is ConnectionView => {
    if (typeof row !== 'object' || row === null) return false;
    const view = row as ConnectionView;
    return (
        typeof view.id === 'string' &&
        typeof view.site === 'string' &&
        typeof view.provider === 'string' &&
        typeof view.account === 'string' &&
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

/** Where the consent returns the browser to: this settings page, which then reads the result off the URL. */
export const CONNECTIONS_RETURN_PATH = '/settings/workspace';

/**
 * Starts a provider's authorization. Resolves to the provider's consent URL, or the route's refusal
 * message as sent (the 503 names the operator's missing configuration). `returnTo` defaults to the
 * settings page.
 */
export const startAuthorization = async (
    provider: string,
    input: StartAuthorizationInput
): Promise<{ ok: true; authorizeUrl: string } | { ok: false; error: string }> => {
    try {
        const response = await fetch(`/api/integrations/${encodeURIComponent(provider)}/authorizations`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ returnTo: CONNECTIONS_RETURN_PATH, ...input }),
        });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false, error: SESSION_EXPIRED };
        }
        if (!response.ok)
            return { ok: false, error: (await refusalOf(response, 'Could not start the connection')).error };
        const { authorizeUrl } = (await response.json()) as { authorizeUrl?: unknown };
        if (typeof authorizeUrl !== 'string')
            return { ok: false, error: 'Could not start the connection: unexpected response.' };
        return { ok: true, authorizeUrl };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
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

/** Returns the refusal's message, or null when the task's thread now holds the connection. */
export const bindTaskConnection = async (
    jobId: string,
    connectionId: string,
    bindingRevision: number
): Promise<string | null> => {
    try {
        const response = await fetch(`/api/jobs/${jobId}/connections`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ connectionId, bindingRevision }),
        });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return SESSION_EXPIRED;
        }
        if (!response.ok) return (await refusalOf(response, 'Could not bind the connection')).error;
        return null;
    } catch (e) {
        return (e as Error).message;
    }
};

/** Returns the refusal's message, or null when the requirement is dismissed ("Continue without it"). */
export const dismissRequirement = async (jobId: string, provider: string): Promise<string | null> => {
    try {
        const response = await fetch(`/api/jobs/${jobId}/requirements/${encodeURIComponent(provider)}/dismiss`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: '{}',
        });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return SESSION_EXPIRED;
        }
        if (!response.ok) return (await refusalOf(response, 'Could not continue without the connection')).error;
        return null;
    } catch (e) {
        return (e as Error).message;
    }
};
