import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './request.js';

/**
 * The member's forge grants' client half: `GET /api/forge-grants`, where the member stands on the GitHub grant the
 * sign-in keeps, and `GET /api/forge-grants/gitlab`, where they stand on each active GitLab connection. No token is
 * ever in a response, so no type here has a field for one.
 */

export const FORGE_STANDINGS = ['live', 'broken', 'missing'] as const;
export type ForgeStanding = (typeof FORGE_STANDINGS)[number];

/** One row of `GET /api/forge-grants`. */
export interface ForgeGrantView {
    forge: string;
    /** Who the grant is the member's: their login on the forge. */
    login: string;
    standing: ForgeStanding;
    /** The sign-in round trip that makes the grant live again; a path on this board. */
    connectPath: string;
}

const isForgeGrantView = (row: unknown): row is ForgeGrantView => {
    if (typeof row !== 'object' || row === null) return false;
    const view = row as ForgeGrantView;
    return (
        typeof view.forge === 'string' &&
        typeof view.login === 'string' &&
        FORGE_STANDINGS.includes(view.standing) &&
        typeof view.connectPath === 'string'
    );
};

/** The caller's forge grants, or the refusal's message. */
export const listForgeGrants = async (): Promise<
    { ok: true; grants: ForgeGrantView[] } | { ok: false; error: string }
> => {
    const result = await request<{ grants: ForgeGrantView[] }>('/api/forge-grants', {
        verb: 'Could not load the GitHub connection',
        guard: (body): body is { grants: ForgeGrantView[] } => {
            const rows = (body as { grants?: unknown } | null)?.grants;
            return Array.isArray(rows) && rows.every(isForgeGrantView);
        },
        malformed: 'Could not load the GitHub connection: unexpected response shape.',
    });
    return result.ok ? { ok: true, grants: result.value.grants } : { ok: false, error: result.error };
};

/** One active GitLab connection and where the caller stands on it (`GET /api/forge-grants/gitlab`). */
export interface GitlabGrantView {
    id: string;
    host: string;
    standing: ForgeStanding;
}

const isGitlabGrantView = (row: unknown): row is GitlabGrantView => {
    if (typeof row !== 'object' || row === null) return false;
    const view = row as GitlabGrantView;
    return typeof view.id === 'string' && typeof view.host === 'string' && FORGE_STANDINGS.includes(view.standing);
};

/** The active GitLab connections with the caller's standing on each, or the refusal's message. */
export const listGitlabGrants = async (): Promise<
    { ok: true; connections: GitlabGrantView[] } | { ok: false; error: string }
> => {
    const result = await request<{ connections: GitlabGrantView[] }>('/api/forge-grants/gitlab', {
        verb: 'Could not load the GitLab connections',
        guard: (body): body is { connections: GitlabGrantView[] } => {
            const rows = (body as { connections?: unknown } | null)?.connections;
            return Array.isArray(rows) && rows.every(isGitlabGrantView);
        },
        malformed: 'Could not load the GitLab connections: unexpected response shape.',
    });
    return result.ok ? { ok: true, connections: result.value.connections } : { ok: false, error: result.error };
};

/** The caller's GitLab standings: `loading` until the read lands, then the rows or the sentence; `reload` asks again. */
type GitlabGrantRead =
    | { state: 'loading' }
    | { state: 'error'; error: string }
    | { state: 'ok'; connections: GitlabGrantView[] };
export type UseGitlabGrants = GitlabGrantRead & { reload: () => Promise<void> };

export function useGitlabGrants(): UseGitlabGrants {
    const [result, setResult] = useState<GitlabGrantRead>({ state: 'loading' });
    const mounted = useRef(true);

    const reload = useCallback(async () => {
        const read = await listGitlabGrants();
        if (!mounted.current) return;
        setResult(read.ok ? { state: 'ok', connections: read.connections } : { state: 'error', error: read.error });
    }, []);

    useEffect(() => {
        mounted.current = true;
        void reload();
        return () => {
            mounted.current = false;
        };
    }, [reload]);

    return { ...result, reload };
}

/** The caller's forge grants: `loading` until the read lands, then `ok` with the rows or `error` with the sentence. */
export type UseForgeGrants =
    | { state: 'loading' }
    | { state: 'error'; error: string }
    | { state: 'ok'; grants: ForgeGrantView[] };

/** One read per mount, so each navigation to the page that shows the card asks again. */
export function useForgeGrants(): UseForgeGrants {
    const [result, setResult] = useState<UseForgeGrants>({ state: 'loading' });
    const mounted = useRef(true);

    const load = useCallback(async () => {
        const read = await listForgeGrants();
        if (!mounted.current) return;
        setResult(read.ok ? { state: 'ok', grants: read.grants } : { state: 'error', error: read.error });
    }, []);

    useEffect(() => {
        mounted.current = true;
        void load();
        return () => {
            mounted.current = false;
        };
    }, [load]);

    return result;
}
