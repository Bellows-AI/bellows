import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './request.js';

/**
 * The member's forge grants' client half: `GET /api/forge-grants`, where the member stands on the GitHub grant the
 * sign-in keeps. No token is ever in a response, so no type here has a field for one.
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
