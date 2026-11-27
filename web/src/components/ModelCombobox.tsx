import { EXECUTOR_TYPES, type ExecutorType, isModelProvider } from '@factory-ai/core';
import type { AnchorSide } from '../anchor.js';
import { type ModelSetupView, useModelSetup } from '../api/useModelSetup.js';
import { useConnectionModels } from '../api/useProviderConnections.js';
import {
    catalogModels,
    catalogNote,
    type ChipConnection,
    modelCatalogOf,
    normalizedChoices,
} from '../workspace/model-catalog.js';
import { type ModelSource, modelOptions } from '../model-setup/providers.js';
import { type SearchRow, SearchSelect } from './SearchSelect.js';

const MODEL_HELP = 'The model the agent runs. Pick one the provider offers, or type any model name it serves.';

/** The source the effective model setup names: a key provider, the platform, or none known. */
function sourceOf(setup: ModelSetupView | null): ModelSource | null {
    if (setup === null || setup.effective === null) return null;
    if (setup.effective === 'platform') return 'platform';
    if (setup.effective === 'executor') {
        // A default executor on a connection names its provider; on none, the platform model or what the env holds.
        const provider = setup.selected?.connection?.provider ?? (setup.personal ?? setup.org)?.provider;
        if (setup.selected?.connection == null && setup.platform) return 'platform';
        return isModelProvider(provider) ? provider : null;
    }
    const provider = setup[setup.effective]?.provider;
    return isModelProvider(provider) ? provider : null;
}

/** The provider's curated models for one agent, or for either when the agent is not known; none without a provider. */
export function knownModels(setup: ModelSetupView | null, agent: ExecutorType | null): string[] {
    const source = sourceOf(setup);
    if (source === null) return [];
    const agents = agent === null ? EXECUTOR_TYPES : [agent];
    return [...new Set(agents.flatMap((type) => modelOptions(source, type, undefined)))];
}

/** `knownModels` over the member's `GET /api/model-setup`; an agent name it does not know counts as unknown. */
export function useKnownModels(agent: string | null): string[] {
    return knownModels(useModelSetup().data, EXECUTOR_TYPES.find((type) => type === agent) ?? null);
}

/**
 * The models a chip offers and the sentence that says where they came from. With a selected connection that is its live
 * catalog — the curated suggestions only while the read cannot answer, and nothing for a successful empty list — and
 * without one, `useKnownModels`'s answer as it always was. Typing a model name is open in every state.
 */
export function useModelChoices(
    agent: string | null,
    connection: ChipConnection | null
): { models: string[]; note: string | null; pick: (model: string) => string } {
    const known = useKnownModels(agent);
    const read = useConnectionModels(connection?.id ?? null);
    if (connection === null) return { models: known, note: null, pick: (model) => model };
    const type = EXECUTOR_TYPES.find((candidate) => candidate === agent) ?? null;
    const catalog = modelCatalogOf(connection, type, read.models);
    // A typed or picked name goes through the same rule as the offered list, so a bare id is saved as the server accepts it.
    return {
        models: [...catalogModels(catalog)],
        note: catalogNote(catalog),
        pick: (model) => normalizedChoices(connection.provider, type, model),
    };
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
    onChange,
}: {
    value: string;
    defaultLabel: string;
    models: readonly string[];
    /** Where the models came from, when that is a connection's live list: its loading, empty, unsupported or failed state. */
    note?: string | null;
    disabled?: boolean;
    side?: AnchorSide;
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
            onChange={onChange}
        />
    );
}
