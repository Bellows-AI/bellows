import { EXECUTOR_TYPES, type ExecutorType, isModelProvider } from '@factory-ai/core';
import type { AnchorSide } from '../anchor.js';
import { type ModelSetupView, useModelSetup } from '../api/useModelSetup.js';
import { type ModelSource, modelOptions } from '../model-setup/providers.js';
import { type SearchRow, SearchSelect } from './SearchSelect.js';

const MODEL_HELP = 'The model the agent runs. Pick one the provider offers, or type any model name it serves.';

/** The source the effective model setup names: a key provider, the platform, or none known. */
function sourceOf(setup: ModelSetupView | null): ModelSource | null {
    if (setup === null || setup.effective === null) return null;
    if (setup.effective === 'platform') return 'platform';
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
 * The Model chip, on the new task and on a follow-up. '' is the default — `defaultLabel` names it, and the caller sends
 * nothing for it. The search filters the provider's models, and the text typed is offered as a model of its own, so any
 * model the provider serves can be used. A follow-up sits at the page's foot, so its list opens `up`.
 */
export function ModelCombobox({
    value,
    defaultLabel,
    models,
    disabled,
    side,
    onChange,
}: {
    value: string;
    defaultLabel: string;
    models: readonly string[];
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
            help={MODEL_HELP}
            side={side ?? 'down'}
            disabled={disabled ?? false}
            onChange={onChange}
        />
    );
}
