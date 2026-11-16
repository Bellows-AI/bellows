import { EXECUTOR_TYPES, type ExecutorType, isModelProvider } from '@factory-ai/core';
import { Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions } from '@headlessui/react';
import { useRef, useState } from 'react';
import { useDownwardAnchor } from '../anchor.js';
import { type ModelSetupView, useModelSetup } from '../api/useModelSetup.js';
import { type ModelSource, modelOptions } from '../model-setup/providers.js';
import { Icon } from './Icon.js';

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
 * The Model chip, on the new task and on a follow-up: the base-branch chip's frame around a glyph button and a field.
 * '' is the default — `defaultLabel` names it, and the caller sends nothing for it. The field is a search over the
 * provider's models, and the text typed is offered as a model of its own, so any model the provider serves can be used.
 */
export function ModelCombobox({
    value,
    defaultLabel,
    models,
    disabled,
    onChange,
}: {
    value: string;
    defaultLabel: string;
    models: readonly string[];
    disabled?: boolean;
    onChange: (model: string) => void;
}) {
    const anchor = useDownwardAnchor('start');
    const [query, setQuery] = useState('');
    const toggle = useRef<HTMLButtonElement | null>(null);
    const label = value === '' ? defaultLabel : value;
    const typed = query.trim();
    const matches = models.filter((model) => model.toLowerCase().includes(typed.toLowerCase()));
    return (
        <Combobox
            immediate
            value={value}
            disabled={disabled ?? false}
            onChange={(next: string | null) => {
                if (next !== null) onChange(next);
            }}
            onClose={() => setQuery('')}
        >
            {({ open }) => (
                <>
                    <div ref={anchor.setReference} className="select-trigger composer-model" title={label}>
                        <ComboboxButton ref={toggle} className="composer-model-toggle" aria-label="Show models">
                            <Icon name="sparkles" />
                        </ComboboxButton>
                        <ComboboxInput
                            className="composer-model-input"
                            aria-label={`Model: ${label}`}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={label}
                            // The text field holds only the search; the chosen model is its placeholder.
                            displayValue={() => ''}
                            onChange={(e) => setQuery(e.target.value)}
                            onClick={() => {
                                if (!open) toggle.current?.click();
                            }}
                        />
                    </div>
                    <ComboboxOptions ref={anchor.setFloating} style={anchor.floatingStyles} portal className="popover">
                        <p className="composer-note" role="presentation">
                            {MODEL_HELP}
                        </p>
                        {/* First, so Enter on typed text takes it. */}
                        {typed !== '' && !models.includes(typed) ? (
                            <ComboboxOption value={typed} className="popover-option">
                                Use “{typed}”
                            </ComboboxOption>
                        ) : null}
                        {typed === '' ? (
                            <ComboboxOption value="" className="popover-option">
                                {defaultLabel}
                            </ComboboxOption>
                        ) : null}
                        {matches.map((model) => (
                            <ComboboxOption key={model} value={model} className="popover-option">
                                {model}
                            </ComboboxOption>
                        ))}
                    </ComboboxOptions>
                </>
            )}
        </Combobox>
    );
}
