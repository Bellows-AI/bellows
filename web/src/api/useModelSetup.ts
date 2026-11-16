import type { ExecutorType, ModelProvider } from '@factory-ai/core';
import { useCallback, useEffect } from 'react';
import type { VerifyAnswer } from '../model-setup/providers.js';
import { request } from './request.js';
import { useResource } from './useResource.js';

/** One scope's setup in `GET /api/model-setup` (server/src/routes/model-setup.ts), names only; null when it has none. */
export interface ModelScopeView {
    provider: string | null;
    agentType: ExecutorType | null;
    model: string | null;
    keyNames: string[];
    /** The provider's base URL when the scope holds it as a plain variable. */
    baseUrl?: string;
    /** The scope holds the provider's base URL as a secret: set, its value withheld. */
    baseUrlSet?: true;
}

export interface ModelSetupView {
    /** The deployment supplies a model (`PLATFORM_MODEL_PROVIDED`). */
    platform: boolean;
    org: ModelScopeView | null;
    personal: ModelScopeView | null;
    effective: 'personal' | 'org' | 'platform' | null;
}

export type SetupScope = 'org' | 'personal';

/** `PUT /api/model-setup`: a key with its agent default, or the agent default alone on the platform or a held key. */
export type ModelSetupSave = { scope: SetupScope; agentType: ExecutorType; model: string } & (
    | { provider: ModelProvider; key: string; baseUrl?: string; keepBaseUrl?: true }
    | { provider: 'platform' | 'existing' }
);

const SETUP_URL = '/api/model-setup';
const asView = (body: ModelSetupView) => body;

/** Every mounted read's refresh: a save re-reads the others, so the shell's banner follows a save without a reload. */
const readers = new Set<() => void>();

export interface UseModelSetup {
    data: ModelSetupView | null;
    loading: boolean;
    error: string | null;
    refresh: () => void;
    /** Writes the setup; the refusal's sentence on failure. */
    save: (body: ModelSetupSave) => Promise<{ ok: true } | { ok: false; error: string }>;
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
    const save = useCallback(
        async (body: ModelSetupSave) => {
            const result = await request(SETUP_URL, { method: 'PUT', body, verb: 'Could not save the model' });
            if (!result.ok) return { ok: false, error: result.error } as const;
            for (const reader of readers) if (reader !== refresh) reader();
            return { ok: true } as const;
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
