import { ProviderMark } from '../components/ProviderMark.js';

/** One provider card's copy: the provider's id, its name, its second line, and an optional tag. */
export interface ProviderCard {
    id: string;
    label: string;
    sub: string;
    tag?: string;
}

/**
 * The provider choice: one card per provider this deployment offers, a native radio in each, in one radiogroup.
 * The cards are handed in, so the model step and the executor's guided provider step (BEL-603) render the same
 * component over their own catalogs.
 */
export function ProviderCards({
    ids,
    choices,
    value,
    onChange,
}: {
    ids: string;
    choices: readonly ProviderCard[];
    value: string;
    onChange: (id: string) => void;
}) {
    return (
        <div className="picker-field">
            <span className="model-label" id={`${ids}-provider`}>
                Provider
            </span>
            <div className="model-providers" role="radiogroup" aria-labelledby={`${ids}-provider`}>
                {choices.map((provider) => {
                    return (
                        <label key={provider.id} className="model-provider">
                            <span className="model-provider-head">
                                <input
                                    type="radio"
                                    name={`${ids}-provider`}
                                    value={provider.id}
                                    checked={provider.id === value}
                                    onChange={() => onChange(provider.id)}
                                />
                                <ProviderMark provider={provider.id} decorative />
                                {provider.label}
                                {provider.tag ? <span className="model-provider-tag">{provider.tag}</span> : null}
                            </span>
                            <span className="model-provider-sub">{provider.sub}</span>
                        </label>
                    );
                })}
            </div>
        </div>
    );
}
