import { request } from './request.js';

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
    /** The grant behind the connection is no longer active: the member has to connect again. */
    needsReconnect: boolean;
    createdAt: string;
}

/**
 * What the start sends: `connectionId` reconnects that connection, `site` narrows a new connect to one
 * site, and `jobId` binds the new connection to that task on consent. Where the browser lands (`returnTo`) is the
 * caller's, always: `startAuthorization` takes it as a required addition.
 */
export interface StartAuthorizationInput {
    access?: ConnectionAccess;
    site?: string;
    connectionId?: string;
    jobId?: string;
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
        typeof view.needsReconnect === 'boolean' &&
        typeof view.createdAt === 'string'
    );
};

/** The caller's visible connections, or the refusal's message. */
export const listConnections = async (): Promise<
    { ok: true; connections: ConnectionView[] } | { ok: false; error: string }
> => {
    const result = await request<{ connections: ConnectionView[] }>('/api/connections', {
        verb: 'Could not load the connections',
        guard: (body): body is { connections: ConnectionView[] } => {
            const rows = (body as { connections?: unknown } | null)?.connections;
            return Array.isArray(rows) && rows.every(isConnectionView);
        },
        malformed: 'Could not load the connections: unexpected response shape.',
    });
    return result.ok ? { ok: true, connections: result.value.connections } : { ok: false, error: result.error };
};

/**
 * Starts a provider's authorization. Resolves to the provider's consent URL, or the route's refusal
 * message as sent (the 503 names the operator's missing configuration). `returnTo` is a path on this
 * app, the page that reads the callback's result off the URL.
 */
export const startAuthorization = async (
    provider: string,
    input: StartAuthorizationInput & { returnTo: string }
): Promise<{ ok: true; authorizeUrl: string } | { ok: false; error: string }> => {
    const result = await request<{ authorizeUrl: string }>(
        `/api/integrations/${encodeURIComponent(provider)}/authorizations`,
        {
            method: 'POST',
            body: input,
            verb: 'Could not start the connection',
            guard: (body): body is { authorizeUrl: string } =>
                typeof (body as { authorizeUrl?: unknown } | null)?.authorizeUrl === 'string',
            malformed: 'Could not start the connection: unexpected response.',
        }
    );
    return result.ok ? { ok: true, authorizeUrl: result.value.authorizeUrl } : { ok: false, error: result.error };
};

/**
 * A disconnect's outcome. Only the route's 204 is `disconnected`; a 404 is `gone` (the row is not the caller's, or
 * is already disconnected: nothing was disconnected by this call); anything else is the refusal's message.
 */
export type DisconnectResult = { kind: 'disconnected' } | { kind: 'gone' } | { kind: 'failed'; error: string };

const HTTP_STATUS_NO_CONTENT = 204;
const HTTP_STATUS_NOT_FOUND = 404;

export const deleteConnection = async (id: string): Promise<DisconnectResult> => {
    const result = await request(`/api/connections/${id}`, {
        method: 'DELETE',
        verb: 'Could not disconnect the connection',
        empty: true,
    });
    if (!result.ok) {
        return result.status === HTTP_STATUS_NOT_FOUND ? { kind: 'gone' } : { kind: 'failed', error: result.error };
    }
    return result.status === HTTP_STATUS_NO_CONTENT
        ? { kind: 'disconnected' }
        : { kind: 'failed', error: 'Could not confirm the disconnect.' };
};

/** Returns the refusal's message, or null when the task's thread now holds the connection. */
export const bindTaskConnection = async (
    jobId: string,
    connectionId: string,
    bindingRevision: number
): Promise<string | null> => {
    const result = await request(`/api/jobs/${jobId}/connections`, {
        method: 'POST',
        body: { connectionId, bindingRevision },
        verb: 'Could not bind the connection',
        empty: true,
    });
    return result.ok ? null : result.error;
};

/** Returns the refusal's message, or null when the requirement is dismissed ("Continue without it"). */
export const dismissRequirement = async (jobId: string, provider: string): Promise<string | null> => {
    const result = await request(`/api/jobs/${jobId}/requirements/${encodeURIComponent(provider)}/dismiss`, {
        method: 'POST',
        body: {},
        verb: 'Could not continue without the connection',
        empty: true,
    });
    return result.ok ? null : result.error;
};
