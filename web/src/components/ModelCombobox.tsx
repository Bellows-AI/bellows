import { EXECUTOR_TYPES } from '@factory-ai/core';
import { useEffect, useRef } from 'react';
import type { AnchorSide } from '../anchor.js';
import { useConnectionModels } from '../api/useProviderConnections.js';
import {
    catalogModels,
    catalogNote,
    type ChipConnection,
    modelCatalogOf,
    normalizedChoices,
} from '../workspace/model-catalog.js';
import { type SearchRow, SearchSelect, type SearchVariant } from './SearchSelect.js';

const MODEL_HELP = 'The model the agent runs. Pick one the provider offers, or type any model name it serves.';

/**
 * The models a chip offers and the sentence that says where they came from: the selected executor's connection catalog,
 * with the curated suggestions only while the read cannot answer and nothing for a successful empty list. Without a
 * connection there is nothing to list, so only typing a model name is offered. Typing is open in every state.
 */
export function useModelChoices(
    agent: string | null,
    connection: ChipConnection | null
): {
    models: string[];
    note: string | null;
    pick: (model: string) => string;
    /** The selected connection; null without one. */
    connectionId: string | null;
    /** The connection's confirmed, non-empty list; null while loading, failed, unsupported, empty or without a connection. */
    listed: readonly string[] | null;
} {
    const read = useConnectionModels(connection?.id ?? null);
    if (connection === null)
        return { models: [], note: null, pick: (model) => model, connectionId: null, listed: null };
    const type = EXECUTOR_TYPES.find((candidate) => candidate === agent) ?? null;
    const catalog = modelCatalogOf(connection, type, read.models);
    // A typed or picked name goes through the same rule as the offered list, so a bare id is saved as the server accepts it.
    return {
        models: [...catalogModels(catalog)],
        note: catalogNote(catalog),
        pick: (model) => normalizedChoices(connection.provider, type, model),
        connectionId: connection.id,
        listed: catalog.kind === 'listed' ? catalog.models : null,
    };
}

/**
 * What a picked model becomes once a new connection's list is confirmed: kept when listed, else Default (''). Only a
 * confirmed non-empty list judges it — a read that is loading, failed, unsupported or empty never drops a model.
 */
export function modelAfterExecutorSwitch(picked: string, listed: readonly string[] | null): string {
    return listed === null || listed.includes(picked) ? picked : '';
}

/**
 * Resets a model picked under the previous executor's connection to Default when the executor moves to another
 * connection whose confirmed list lacks it. `choices` is the chip's `useModelChoices`; `reset` clears the pick.
 */
export function useStaleModelReset(
    choices: { connectionId: string | null; listed: readonly string[] | null },
    picked: string,
    reset: () => void
) {
    const { connectionId, listed } = choices;
    const previous = useRef(connectionId);
    const awaiting = useRef(false);
    useEffect(() => {
        if (previous.current !== connectionId) {
            previous.current = connectionId;
            awaiting.current = connectionId !== null;
        }
        if (!awaiting.current || listed === null) return;
        awaiting.current = false;
        if (picked !== '' && modelAfterExecutorSwitch(picked, listed) === '') reset();
    });
}

/**
 * The Model chip, on the new task and on a follow-up. '' is the default — `defaultLabel` names it, and the caller sends
 * nothing for it. The search filters the provider's models, and the text typed is offered as a model of its own, so any
 * model the provider serves can be used. A follow-up sits at the page's foot, so its list opens `up`.
 */
export function ModelCombobox({
    value,
    defaultLabel,
    models,
    note,
    disabled,
    side,
    variant,
    onChange,
}: {
    value: string;
    defaultLabel: string;
    models: readonly string[];
    /** Where the models came from, when that is a connection's live list: its loading, empty, unsupported or failed state. */
    note?: string | null;
    disabled?: boolean;
    side?: AnchorSide;
    /** The chip's skin; `form` inside a form. */
    variant?: SearchVariant;
    onChange: (model: string) => void;
}) {
    const options = models.map((model) => ({ value: model, label: model }));
    // Ahead of the matches, so Enter on typed text takes it; the default only while nothing is typed.
    const before = (query: string): SearchRow[] => {
        const typed = query.trim();
        if (typed === '') return [{ value: '', label: defaultLabel, highlight: false }];
        return models.includes(typed) ? [] : [{ value: typed, label: `Use “${typed}”`, highlight: false }];
    };
    return (
        <SearchSelect
            field="Model"
            icon="sparkles"
            valueLabel={value === '' ? defaultLabel : value}
            value={value}
            options={options}
            before={before}
            help={note ? `${MODEL_HELP} ${note}` : MODEL_HELP}
            side={side ?? 'down'}
            disabled={disabled ?? false}
            variant={variant ?? 'chip'}
            onChange={onChange}
        />
    );
}
