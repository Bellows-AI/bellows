import type { ModelProvider } from '@factory-ai/core';
import { ProviderMark } from '../components/ProviderMark.js';
import { PROVIDER_META } from './providers.js';

/** The provider choice: one card per provider this deployment offers, a native radio in each, in one radiogroup. */
export function ProviderCards({
    ids,
    choices,
    value,
    onChange,
}: {
    ids: string;
    choices: readonly ModelProvider[];
    value: ModelProvider;
    onChange: (provider: ModelProvider) => void;
}) {
    return (
        <div className="picker-field">
            <span className="model-label" id={`${ids}-provider`}>
                Provider
            </span>
            <div className="model-providers" role="radiogroup" aria-labelledby={`${ids}-provider`}>
                {choices.map((provider) => {
                    const meta = PROVIDER_META[provider];
                    return (
                        <label key={provider} className="model-provider">
                            <span className="model-provider-head">
                                <input
                                    type="radio"
                                    name={`${ids}-provider`}
                                    value={provider}
                                    checked={provider === value}
                                    onChange={() => onChange(provider)}
                                />
                                <ProviderMark provider={provider} decorative />
                                {meta.label}
                                {meta.tag ? <span className="model-provider-tag">{meta.tag}</span> : null}
                            </span>
                            <span className="model-provider-sub">{meta.sub}</span>
                        </label>
                    );
                })}
            </div>
        </div>
    );
}
