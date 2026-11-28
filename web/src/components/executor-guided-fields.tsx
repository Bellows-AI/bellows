import type { ExecutorProvider, ExecutorType } from '@factory-ai/core';
import { KeyField } from '../providers/KeyField.js';
import { ProviderCards, type ProviderCard } from '../providers/ProviderCards.js';
import type { ProviderMeta } from '../providers/providers.js';
import type { KeyCheck } from '../providers/useKeyCheck.js';
import { FieldError } from './executor-dialog-parts.js';
import { EXECUTOR_TYPE_META } from '../workspace/executors.js';
import {
    EXECUTOR_PROVIDER_META,
    guidedProvidersFor,
    GUIDED_COPY,
    type GuidedChoice,
} from '../workspace/executor-guided.js';

/** The key step: on the member's own endpoint, paste-or-name-a-secret; on a catalog provider, the
 * provider step's key field with the live check, and the note that says what an empty field means. */
function GuidedKeySource({
    ids,
    provider,
    meta,
    choice,
    check,
    onKey,
    onKeySource,
    onReference,
}: {
    ids: string;
    provider: ExecutorProvider;
    meta: ProviderMeta;
    choice: GuidedChoice;
    check: KeyCheck & { retry: () => void };
    onKey: (value: string) => void;
    onKeySource: (reference: boolean) => void;
    onReference: (name: string) => void;
}) {
    if (provider !== 'openai-compatible') {
        return (
            <div className="picker-field">
                <KeyField
                    ids={ids}
                    meta={meta}
                    value={choice.key.kind === 'key' ? choice.key.value : ''}
                    check={check}
                    onChange={onKey}
                />
                {choice.key.kind === 'key' && choice.key.value.startsWith('stored-credential:') ? (
                    <p className="picker-help">{GUIDED_COPY.KEY_KEEP_NOTE}</p>
                ) : (
                    <p className="picker-help">{GUIDED_COPY.KEY_CONNECTED_NOTE}</p>
                )}
            </div>
        );
    }
    const pasting = choice.key.kind !== 'reference';
    return (
        <fieldset className="picker-field" aria-describedby={`${ids}-key-help`}>
            <legend>{GUIDED_COPY.KEY_SOURCE_LABEL}</legend>
            <label className="settings-toggle">
                <input type="radio" name={`${ids}-key-source`} checked={pasting} onChange={() => onKeySource(false)} />
                {GUIDED_COPY.KEY_PASTE_LABEL}
            </label>
            <label className="settings-toggle">
                <input type="radio" name={`${ids}-key-source`} checked={!pasting} onChange={() => onKeySource(true)} />
                {GUIDED_COPY.KEY_REFERENCE_LABEL}
            </label>
            {pasting ? (
                <>
                    <KeyField
                        ids={ids}
                        meta={meta}
                        value={choice.key.kind === 'key' ? choice.key.value : ''}
                        check={check}
                        onChange={onKey}
                    />
                    <p className="picker-help">{GUIDED_COPY.KEY_KEEP_NOTE}</p>
                </>
            ) : (
                <>
                    <label htmlFor={`${ids}-key`}>{meta.keyLabel}</label>
                    <input
                        id={`${ids}-key`}
                        className="field"
                        type="text"
                        value={choice.key.kind === 'reference' ? choice.key.name : ''}
                        placeholder="GATEWAY_KEY"
                        aria-describedby={`${ids}-key-help`}
                        onChange={(event) => onReference(event.target.value)}
                    />
                    <p className="picker-help" id={`${ids}-key-help`}>
                        {GUIDED_COPY.KEY_REFERENCE_HELP}
                    </p>
                </>
            )}
        </fieldset>
    );
}

/**
 * The guided provider step, the fields of onboarding's Connect a provider over an executor
 * profile: the provider cards the provider step renders, its key field with the live check, the base
 * URL, and the model. Picking a provider writes the generated configuration the Advanced editor
 * shows; removing the provider settings puts back what a pick started from. Presentational only —
 * ExecutorDialog owns the choice, the check and the configuration text.
 */

/** Why a provider's base URL field renders at all, and how. */
function baseUrlField(provider: ExecutorProvider): 'required' | 'optional' | null {
    if (provider === 'litellm' || provider === 'openai-compatible') return 'required';
    // Claude Code can send its Anthropic traffic to a gateway of the member's own; OpenCode's
    // built-in providers read no custom host here — that is what the OpenAI-compatible card is for.
    return provider === 'anthropic' ? 'optional' : null;
}

export function GuidedProviderFields(props: {
    ids: string;
    agent: ExecutorType;
    choice: GuidedChoice;
    /** The model ids the key check returned, beside the provider's own suggestions. */
    suggestions?: readonly string[];
    check: KeyCheck & { retry: () => void };
    error: string | null;
    onProvider: (provider: ExecutorProvider) => void;
    onKey: (value: string) => void;
    onKeySource: (reference: boolean) => void;
    onReference: (name: string) => void;
    onBaseUrl: (value: string) => void;
    onModel: (value: string) => void;
    onRemove: () => void;
}) {
    const { ids, choice } = props;
    const meta = EXECUTOR_PROVIDER_META[choice.provider];
    const cards: ProviderCard[] = guidedProvidersFor(props.agent).map((id) => ({ id, ...EXECUTOR_PROVIDER_META[id] }));
    const base = baseUrlField(choice.provider);
    const suggestions = props.suggestions ?? [];
    return (
        <>
            <ProviderCards
                ids={ids}
                choices={cards}
                value={choice.provider}
                onChange={(id) => props.onProvider(id as ExecutorProvider)}
            />
            <GuidedKeySource
                ids={ids}
                provider={choice.provider}
                meta={meta}
                choice={choice}
                onKey={props.onKey}
                onKeySource={props.onKeySource}
                onReference={props.onReference}
                check={props.check}
            />
            {base !== null ? (
                <div className="picker-field">
                    <label htmlFor={`${ids}-base-url`}>
                        {choice.provider === 'litellm' ? 'Proxy URL' : 'Base URL'}
                    </label>
                    <input
                        id={`${ids}-base-url`}
                        className="field"
                        type="url"
                        value={choice.baseUrl}
                        placeholder={
                            choice.provider === 'litellm'
                                ? 'https://litellm.example.internal'
                                : 'https://vllm.internal:8000/v1'
                        }
                        aria-describedby={`${ids}-base-url-help`}
                        onChange={(event) => props.onBaseUrl(event.target.value)}
                    />
                    <p className="picker-help" id={`${ids}-base-url-help`}>
                        {choice.provider === 'openai-compatible'
                            ? 'The endpoint the runner sends its model requests to, /v1 included. Carried in the configuration.'
                            : choice.provider === 'litellm'
                              ? 'Your LiteLLM proxy. Carried in the configuration.'
                              : 'Only for a gateway you run. Carried in the configuration.'}
                    </p>
                </div>
            ) : null}
            {choice.provider === 'openai-compatible' ? (
                <p className="picker-help">{GUIDED_COPY.NO_CHECK_NOTE}</p>
            ) : null}
            <div className="picker-field">
                <label htmlFor={`${ids}-guided-model`}>Model</label>
                <input
                    id={`${ids}-guided-model`}
                    className="field"
                    type="text"
                    value={choice.model}
                    list={suggestions.length > 0 ? `${ids}-guided-models` : undefined}
                    placeholder={EXECUTOR_TYPE_META[props.agent].modelExample}
                    aria-describedby={`${ids}-guided-model-help`}
                    onChange={(event) => props.onModel(event.target.value)}
                />
                {suggestions.length > 0 ? (
                    <datalist id={`${ids}-guided-models`}>
                        {suggestions.map((id) => (
                            <option key={id} value={id} />
                        ))}
                    </datalist>
                ) : null}
                <p className="picker-help" id={`${ids}-guided-model-help`}>
                    {EXECUTOR_TYPE_META[props.agent].modelHelp}
                </p>
            </div>
            <div className="picker-field-actions">
                <button type="button" className="tertiary" onClick={props.onRemove}>
                    {GUIDED_COPY.REMOVE_PROVIDER_LABEL}
                </button>
            </div>
            <FieldError id={`${ids}-guided-error`} error={props.error} />
        </>
    );
}
