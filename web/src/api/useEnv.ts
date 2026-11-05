import { useCallback, useState } from 'react';
import { mutate } from './mutate.js';
import { useResource } from './useResource.js';

/** What a list read echoes. A secret's `value` is null for every caller — the write-only contract. */
export interface EnvVarView {
    name: string;
    value: string | null;
    isSecret: boolean;
    updatedAt: string;
}

export interface EnvRepoScope {
    owner: string;
    name: string;
    vars: EnvVarView[];
}

export interface EnvPayload {
    org: EnvVarView[];
    workspace: EnvVarView[];
    repos: EnvRepoScope[];
}

export interface EnvVarInput {
    name: string;
    value: string | null;
    isSecret: boolean;
}

/**
 * What a save resolves to. On success `vars` is the scope's stored rows — the PUT's own response —
 * so the editor can adopt exactly what is stored without a remount wiping its "Saved." confirmation
 * mid-render.
 */
export interface EnvSaveResult {
    error: string | null;
    vars: EnvVarView[];
}

export interface UseEnv {
    data: EnvPayload | null;
    loading: boolean;
    error: string | null;
    saving: boolean;
    refresh: () => void;
    saveOrg: (vars: EnvVarInput[]) => Promise<EnvSaveResult>;
    saveWorkspace: (vars: EnvVarInput[]) => Promise<EnvSaveResult>;
    saveRepo: (repo: { owner: string; name: string }, vars: EnvVarInput[]) => Promise<EnvSaveResult>;
}

const selectEnv = (body: EnvPayload) => body;

/** The repo scopes with one scope's rows replaced (or added, for a repository with no stored row yet). */
function withRepoVars(repos: EnvRepoScope[], repo: { owner: string; name: string }, vars: EnvVarView[]) {
    const known = repos.some((r) => r.owner === repo.owner && r.name === repo.name);
    return known
        ? repos.map((r) => (r.owner === repo.owner && r.name === repo.name ? { ...r, vars } : r))
        : [...repos, { ...repo, vars }];
}

/**
 * The runner environment, fetched once and refetched after each save.
 *
 * No polling, unlike `useWorkspace`: this list only changes when somebody edits it, and the editor
 * that edits it is the page holding this hook. A two-second poll would also race the draft state in
 * the editors, remounting them under a typing hand.
 */
export function useEnv(): UseEnv {
    const { data, setData, loading, error, refresh } = useResource('/api/env', selectEnv);
    const [saving, setSaving] = useState(false);

    const put = useCallback(async (url: string, body: unknown): Promise<EnvSaveResult> => {
        setSaving(true);
        try {
            const result = await mutate(
                url,
                { method: 'PUT', body, verb: 'Could not save' },
                async (response) => ((await response.json()) as { vars: EnvVarView[] }).vars
            );
            return result.ok ? { error: null, vars: result.value } : { error: result.error, vars: [] };
        } finally {
            setSaving(false);
        }
    }, []);

    // A successful save adopts the PUT's own rows as the scope's current rows at once, then
    // refetches so the rest of the page (the repository select's options) tracks the store. The
    // adoption is what the next dialog seeds from: waiting on the refetch would let a held or
    // failed read hand the next whole-list PUT a list without the row just saved. The refetch
    // aborts any older read, so none can land afterwards with pre-save rows.
    const saveOrg = useCallback(
        async (vars: EnvVarInput[]) => {
            const result = await put('/api/env/org', { vars });
            if (result.error === null) {
                setData((prev) => prev && { ...prev, org: result.vars });
                refresh();
            }
            return result;
        },
        [put, refresh, setData]
    );

    const saveWorkspace = useCallback(
        async (vars: EnvVarInput[]) => {
            const result = await put('/api/env/workspace', { vars });
            if (result.error === null) {
                setData((prev) => prev && { ...prev, workspace: result.vars });
                refresh();
            }
            return result;
        },
        [put, refresh, setData]
    );

    const saveRepo = useCallback(
        async (repo: { owner: string; name: string }, vars: EnvVarInput[]) => {
            const result = await put('/api/env/repo', { repo, vars });
            if (result.error === null) {
                setData((prev) => prev && { ...prev, repos: withRepoVars(prev.repos, repo, result.vars) });
                refresh();
            }
            return result;
        },
        [put, refresh, setData]
    );

    return { data, loading, error, saving, refresh, saveOrg, saveWorkspace, saveRepo };
}
