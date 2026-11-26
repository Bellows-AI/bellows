import { useEffect, useState } from 'react';
import type { ExecutorScope, ProviderConnectionMeta } from '@factory-ai/core';
import { useConnectionModels, useProviderConnections } from '../api/useProviderConnections.js';
import { connectionOptions, modelNeedsReselection } from '../workspace/executor-connections.js';
import { type ExecutorDraft, parseExecutorConfig, withModel } from '../workspace/executors.js';
import { type ModelCatalog, modelCatalogOf } from '../workspace/model-catalog.js';

/**
 * The executor dialog's connection step: the visible connections, the selected one's live models, and the switch that
 * clears a model the board knows belongs to another provider. Kept beside `executor-guided-step.ts`, which owns the
 * other way to give an executor a key — the connection is the shared credential, the guided step the profile's own.
 */

type Unavailable = { connection: ProviderConnectionMeta; reason: string };

/** What the dialog's connection field and Model control render, and the callbacks they call. */
export interface ConnectionStep {
    offered: readonly ProviderConnectionMeta[];
    unavailable: readonly Unavailable[];
    /** The selected connection's name, for the override notice; null when it is not in the visible list. */
    name: string | null;
    listError: string | null;
    onRetry: () => void;
    onChange: (id: string) => void;
    catalog: ModelCatalog;
    /** The model dropped by the last switch, until the member chooses again. */
    reselect: string | null;
    onRetryModels: () => void;
}

export function useConnectionStep(input: {
    open: boolean;
    draft: ExecutorDraft;
    setDraft: (draft: ExecutorDraft) => void;
    scope: ExecutorScope;
}) {
    const { open, draft, setDraft, scope } = input;
    const visible = useProviderConnections(open);
    const [reselect, setReselect] = useState<string | null>(null);
    // A dialog opened again starts without the last session's note.
    useEffect(() => {
        if (open) setReselect(null);
    }, [open]);
    const connections = visible.connections;
    const choices = connections === null ? null : { connections, scope };
    const selected = connections?.find((row) => row.id === draft.providerConnectionId);
    // A guided provider choice owns its own model field: no catalog is read for it.
    const read = useConnectionModels(draft.providerConnectionId || null, open && draft.guided[draft.type] === null);
    const options = choices === null ? { offered: [], unavailable: [] } : connectionOptions(choices, draft.type);

    /** A switch of connection or agent: the model the board knows belongs to another provider is cleared, to be chosen again. */
    const switchTo = (next: ExecutorDraft) => {
        const connection = connections?.find((row) => row.id === next.providerConnectionId);
        const config = parseExecutorConfig(next.configs[next.type]);
        const stale = config.ok ? modelNeedsReselection(connection, next.type, config.value) : null;
        setReselect(stale);
        if (stale === null || !config.ok) return setDraft(next);
        setDraft({
            ...next,
            configs: { ...next.configs, [next.type]: JSON.stringify(withModel(config.value, null), null, 2) },
            customModel: { ...next.customModel, [next.type]: true },
        });
    };

    const connection: ConnectionStep = {
        ...options,
        name: selected?.name ?? null,
        listError: visible.error,
        onRetry: visible.refresh,
        onChange: (id) => switchTo({ ...draft, providerConnectionId: id }),
        catalog: modelCatalogOf(selected, draft.type, read.models),
        reselect,
        onRetryModels: read.retry,
    };
    return {
        choices,
        connection,
        pickAgent: (type: ExecutorDraft['type']) => switchTo({ ...draft, type }),
        clearReselect: () => setReselect(null),
    };
}
