import type { ExecutorType, ModelProvider } from '@factory-ai/core';
import { useCallback, useEffect, useRef } from 'react';
import type { VerifyAnswer } from '../model-setup/providers.js';
import { request } from './request.js';
import { useResource } from './useResource.js';

/** One scope's setup in `GET /api/model-setup` (server/src/routes/model-setup.ts), names only; null when it has none. */
export interface ModelScopeView {
    provider: string | null;
    keyNames: string[];
    /** The provider's base URL when the scope holds it as a plain variable. */
    baseUrl?: string;
    /** The scope holds the provider's base URL as a secret: set, its value withheld. */
    baseUrlSet?: true;
}

export type SetupScope = 'org' | 'personal';

/** The default executor in `GET /api/model-setup`: ids and names, the connection's safe metadata, never a credential. */
export interface SelectedExecutorView {
    scope: SetupScope;
    executorId: string;
    name: string;
    agentType: ExecutorType;
    model: string | null;
    suspended: boolean;
    /** The executor's revision: a save of this executor sends it back, so an older read cannot overwrite a newer save. */
    updatedAt: string;
    /** The connection the executor runs on, when the member may see it; null for the environment's keys. */
    connection: { id: string; name: string; provider: ModelProvider; scope: SetupScope; baseUrl: string | null } | null;
}

export interface ModelSetupView {
    org: ModelScopeView | null;
    personal: ModelScopeView | null;
    /** The configured default executor (the member's, else the organization's); absent when none is configured. */
    selected?: SelectedExecutorView;
    effective: 'executor' | 'personal' | 'org' | null;
}

/** What a setup does about the connection: seal a new one, select one, or replace one's key. */
export type ConnectionBody =
    | { intent: 'create'; provider: ModelProvider; key: string; baseUrl?: string; name: string }
    | { intent: 'reuse'; id: string }
    | { intent: 'rotate'; id: string; key: string; baseUrl?: string };

/** `PUT /api/model-setup` (the request id is the hook's): the connection intent and the executor it runs, made the default. */
export interface ModelSetupSave {
    scope: SetupScope;
    agentType: ExecutorType;
    model: string;
    connection: ConnectionBody;
    /** An edit names the executor by its stable id; a new one needs a name. */
    executor: { id?: string; name?: string; expectedUpdatedAt?: string };
}

/** What a save answers: the stable identities the next save carries. */
export interface SavedSetup {
    scope: SetupScope;
    executorId: string;
    executorName: string;
    connectionId: string | null;
    connectionName: string | null;
    replayed: boolean;
}

const SETUP_URL = '/api/model-setup';
const asView = (body: ModelSetupView) => body;

/** Every mounted read's refresh: a save re-reads the others, so the shell's banner follows a save without a reload. */
const readers = new Set<() => void>();

export interface UseModelSetup {
    data: ModelSetupView | null;
    loading: boolean;
    error: string | null;
    refresh: () => void;
    /** Writes the setup; the saved identities, or the refusal's sentence on failure. */
    save: (body: ModelSetupSave) => Promise<{ ok: true; saved: SavedSetup } | { ok: false; error: string }>;
    /** Re-reads the setup and settles once it has landed (or failed): a save hands over only after it. */
    reread: () => Promise<void>;
}

export function useModelSetup(): UseModelSetup {
    const { data, setData, loading, error, refresh } = useResource(SETUP_URL, asView);
    useEffect(() => {
        readers.add(refresh);
        return () => {
            readers.delete(refresh);
        };
    }, [refresh]);
    // The same body keeps one request id until it lands, so a retry after an unknown outcome replays instead of writing twice.
    const attempt = useRef<{ body: string; requestId: string } | null>(null);
    const save = useCallback(
        async (body: ModelSetupSave) => {
            const text = JSON.stringify(body);
            if (attempt.current?.body !== text) attempt.current = { body: text, requestId: crypto.randomUUID() };
            const result = await request<SavedSetup>(SETUP_URL, {
                method: 'PUT',
                body: { ...body, requestId: attempt.current.requestId },
                verb: 'Could not save the model',
            });
            if (!result.ok) return { ok: false, error: result.error } as const;
            attempt.current = null;
            for (const reader of readers) if (reader !== refresh) reader();
            return { ok: true, saved: result.value } as const;
        },
        [refresh]
    );
    const reread = useCallback(async () => {
        const result = await request<ModelSetupView>(SETUP_URL, { verb: 'Could not read the model setup' });
        if (result.ok) setData(result.value);
    }, [setData]);
    return { data, loading, error, refresh, save, reread };
}

/** `POST /api/model-setup/verify` (10 checks per member a minute): the check's answer, 200 either way. */
export const verifyKey = (body: { provider: ModelProvider; key: string; baseUrl?: string }, signal: AbortSignal) =>
    request<VerifyAnswer>(`${SETUP_URL}/verify`, { method: 'POST', body, signal, verb: 'Could not check the key' });
