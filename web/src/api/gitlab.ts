import { ERROR_CODES, GITLAB_SETTINGS_PATH } from '@factory-ai/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request, type RequestResult } from './request.js';

/**
 * The GitLab settings page's wire calls (docs/gitlab.md): the admin's connection, activation and tracking routes and the
 * member's link. No token is ever in a response, so no type here has a field for one; the client secret only goes up.
 */

const CONNECTIONS = '/api/org/gitlab-connections';
const LINK = '/api/forge-grants/gitlab';
const HTTP_UNAVAILABLE = 503;

export type ActivationRefusal = 'version-too-old';

/** One row of `GET /api/org/gitlab-connections`: the stored state, never a secret (`hasCaBundle` only). */
export interface GitlabConnectionView {
    id: string;
    host: string;
    clientId: string;
    allowedGroups: string[];
    hasCaBundle: boolean;
    active: boolean;
    /** The instance version activation confirmed; null while pending. */
    version: string | null;
    activationRefusal: ActivationRefusal | null;
    probe: { status: 'reachable' | 'unreachable'; reason: string | null; at: string };
    createdAt: string;
}

/** What `POST /api/org/gitlab-connections` takes. */
export interface GitlabConnectionInput {
    host: string;
    clientId: string;
    clientSecret: string;
    allowedGroups: string[];
    caBundle?: string;
}

/** One project of the admin's listing; `listed: false` is a tracked path the listing no longer shows. */
export interface GitlabProjectView {
    path: string;
    defaultBranch: string | null;
    tracked: boolean;
    listed: boolean;
}

type Failure = { ok: false; error: string; code?: string };

const failure = (result: Extract<RequestResult<unknown>, { ok: false }>): Failure => ({
    ok: false,
    error: result.error,
    ...(result.code === undefined ? {} : { code: result.code }),
});

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

const isConnectionView = (row: unknown): row is GitlabConnectionView => {
    if (typeof row !== 'object' || row === null) return false;
    const view = row as GitlabConnectionView;
    return (
        typeof view.id === 'string' &&
        typeof view.host === 'string' &&
        typeof view.clientId === 'string' &&
        isStringArray(view.allowedGroups) &&
        typeof view.hasCaBundle === 'boolean' &&
        typeof view.active === 'boolean' &&
        typeof view.probe === 'object' &&
        view.probe !== null
    );
};

const isProjectView = (row: unknown): row is GitlabProjectView => {
    if (typeof row !== 'object' || row === null) return false;
    const view = row as GitlabProjectView;
    return typeof view.path === 'string' && typeof view.tracked === 'boolean' && typeof view.listed === 'boolean';
};

/** The org's connections (admin), or the refusal's message. */
export async function listGitlabConnections(): Promise<
    { ok: true; connections: GitlabConnectionView[] } | { ok: false; error: string }
> {
    const result = await request<{ connections: GitlabConnectionView[] }>(CONNECTIONS, {
        verb: 'Could not load the GitLab connections',
        guard: (body): body is { connections: GitlabConnectionView[] } => {
            const rows = (body as { connections?: unknown } | null)?.connections;
            return Array.isArray(rows) && rows.every(isConnectionView);
        },
        malformed: 'Could not load the GitLab connections: unexpected response shape.',
    });
    return result.ok ? { ok: true, connections: result.value.connections } : { ok: false, error: result.error };
}

/** Connects an instance, stored pending; a refusal keeps its code (`GITLAB_CONNECTION_EXISTS`, `INVALID_GITLAB_CONNECTION`). */
export async function createGitlabConnection(
    input: GitlabConnectionInput
): Promise<{ ok: true; connection: GitlabConnectionView } | Failure> {
    const result = await request<GitlabConnectionView>(CONNECTIONS, {
        method: 'POST',
        body: input,
        verb: 'Could not connect GitLab',
        guard: (body): body is GitlabConnectionView => isConnectionView(body),
        malformed: 'Could not connect GitLab: unexpected response shape.',
    });
    return result.ok ? { ok: true, connection: result.value } : failure(result);
}

/** Removes a connection: null on success, else the sentence to show. */
export async function deleteGitlabConnection(id: string): Promise<string | null> {
    const result = await request(`${CONNECTIONS}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        verb: 'Could not remove the GitLab connection',
        empty: true,
    });
    return result.ok ? null : result.error;
}

type Start = { ok: true; authorizeUrl: string } | Failure;

async function start(path: string, verb: string): Promise<Start> {
    const result = await request<{ authorizeUrl: string }>(path, {
        method: 'POST',
        body: { returnTo: GITLAB_SETTINGS_PATH },
        verb,
        guard: (body): body is { authorizeUrl: string } =>
            typeof (body as { authorizeUrl?: unknown } | null)?.authorizeUrl === 'string',
        malformed: `${verb}: unexpected response shape.`,
    });
    return result.ok ? { ok: true, authorizeUrl: result.value.authorizeUrl } : failure(result);
}

/** The admin's consent round trip that activates a pending connection: where to send the browser. */
export const startGitlabActivation = (id: string): Promise<Start> =>
    start(`${CONNECTIONS}/${encodeURIComponent(id)}/activation`, 'Could not start the GitLab activation');

/** The member's own link (or reconnect) round trip: where to send the browser. */
export const startGitlabLink = (id: string): Promise<Start> =>
    start(`${LINK}/${encodeURIComponent(id)}/link`, 'Could not start the GitLab link');

/** The admin's project listing. A 503 is `retry`: the board could not confirm the list, which is never an empty one. */
export async function listGitlabProjects(
    id: string
): Promise<{ ok: true; projects: GitlabProjectView[] } | (Failure & { retry: boolean })> {
    const result = await request<{ projects: GitlabProjectView[] }>(
        `${CONNECTIONS}/${encodeURIComponent(id)}/projects`,
        {
            verb: 'Could not list the GitLab projects',
            guard: (body): body is { projects: GitlabProjectView[] } => {
                const rows = (body as { projects?: unknown } | null)?.projects;
                return Array.isArray(rows) && rows.every(isProjectView);
            },
            malformed: 'Could not list the GitLab projects: unexpected response shape.',
        }
    );
    if (result.ok) return { ok: true, projects: result.value.projects };
    if (result.status === HTTP_UNAVAILABLE) {
        return { ok: false, retry: true, error: 'Could not list the GitLab projects just now. Retry in a moment.' };
    }
    return { ...failure(result), retry: false };
}

/** Saves the picked paths (replacing only this host's rows). A collision keeps its code, `TRACKED_PATH_CONFLICT`. */
export async function saveGitlabTracked(id: string, paths: string[]): Promise<{ ok: true } | Failure> {
    const result = await request(`${CONNECTIONS}/${encodeURIComponent(id)}/tracked-repos`, {
        method: 'PUT',
        body: { paths },
        verb: 'Could not save the tracked projects',
        empty: true,
    });
    return result.ok ? { ok: true } : failure(result);
}

export const GITLAB_ERROR = {
    exists: ERROR_CODES.GITLAB_CONNECTION_EXISTS,
    pathConflict: ERROR_CODES.TRACKED_PATH_CONFLICT,
    changed: ERROR_CODES.GITLAB_CONNECTION_CHANGED,
} as const;

/** The org's connections for an admin, read once per mount and again on `reload`; a member never asks (the route is admin-only). */
type GitlabConnectionsRead =
    | { state: 'idle' | 'loading' }
    | { state: 'error'; error: string }
    | { state: 'ok'; connections: GitlabConnectionView[] };
export type UseGitlabConnections = GitlabConnectionsRead & { reload: () => Promise<void> };

export function useGitlabConnections(enabled: boolean): UseGitlabConnections {
    const [result, setResult] = useState<GitlabConnectionsRead>({ state: 'idle' });
    const mounted = useRef(true);

    const reload = useCallback(async () => {
        if (!enabled) return;
        const read = await listGitlabConnections();
        if (!mounted.current) return;
        setResult(read.ok ? { state: 'ok', connections: read.connections } : { state: 'error', error: read.error });
    }, [enabled]);

    useEffect(() => {
        mounted.current = true;
        if (enabled) setResult({ state: 'loading' });
        void reload();
        return () => {
            mounted.current = false;
        };
    }, [enabled, reload]);

    return { ...result, reload };
}
