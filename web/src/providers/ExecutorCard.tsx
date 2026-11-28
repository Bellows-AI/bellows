import type { ExecutorType, ModelProvider, ProviderConnectionScope } from '@factory-ai/core';
import { useId, useState } from 'react';
import { ProviderMark } from '../components/ProviderMark.js';
import { type SearchRow, SearchSelect } from '../components/SearchSelect.js';
import { normalizedChoices } from '../workspace/model-catalog.js';
import { executorTypeLabel } from '../workspace/executors.js';
import { generatedExecutorName } from './executor-name.js';
import { agentLock, modelOptions, PROVIDER_META, providerAgents } from './providers.js';
import type { CheckKind } from './providers.js';

/** The card's reason while the provider's models are not known: they come from the key check. */
const WAITING = 'Check the key first — the models come from the provider.';
const CHECKING = 'Checking the key… the models come from the provider.';

/** The reason the card waits, or null once the key check passed (✓, or ▲ for a key that works without credit). */
export const executorWait = (check: CheckKind): string | null =>
    check === 'ok' || check === 'warn' ? null : check === 'wait' ? CHECKING : WAITING;

/** The agent and model a member picked for one provider; a pick made under another provider never carries over. */
interface Pick {
    provider: ModelProvider;
    agent: ExecutorType | null;
    model: string | null;
}

/**
 * Part 2's draft: the agent (the provider's first until another is picked), the default model (the provider's first
 * until one is picked or typed) and the executor's name, which follows the two until the member edits it. `models` is
 * what the key check returned.
 */
export function useExecutorDraft(provider: ModelProvider, models: readonly string[] | undefined) {
    const [pick, setPick] = useState<Pick>({ provider, agent: null, model: null });
    const [nameEdit, setNameEdit] = useState<string | null>(null);
    const agents = providerAgents(provider);
    const own = pick.provider === provider ? pick : { agent: null, model: null };
    const agent = own.agent !== null && agents.includes(own.agent) ? own.agent : (agents[0] as ExecutorType);
    const options = modelOptions(provider, agent, models).map((id) => normalizedChoices(provider, agent, id));
    const model = own.model ?? options[0] ?? '';
    return {
        provider,
        agents,
        agent,
        setAgent: (next: ExecutorType) => setPick({ provider, agent: next, model: null }),
        options,
        model,
        /** A picked or typed model, stored the way the server accepts it (`normalizedChoices`). */
        setModel: (next: string) => setPick({ provider, agent, model: normalizedChoices(provider, agent, next) }),
        name: nameEdit ?? generatedExecutorName(agent, model),
        setName: setNameEdit,
    };
}

export type ExecutorDraft = ReturnType<typeof useExecutorDraft>;

/**
 * The default executor card: Default and scope chips, Agent (locked when the provider runs one), Default model — the
 * provider's models plus a row for any name typed — and the executor's name. `wait` is why it is dimmed (the models are
 * not known yet); it stays inert until null.
 */
export function ExecutorCard({
    draft,
    scope,
    wait,
}: {
    draft: ExecutorDraft;
    scope: ProviderConnectionScope;
    wait: string | null;
}) {
    const ids = useId();
    const { provider, agent, model } = draft;
    const locked = wait !== null;
    const lock = agentLock(provider);
    const typed = (query: string): SearchRow[] => {
        const text = query.trim();
        return text === '' || draft.options.includes(text)
            ? []
            : [{ value: text, label: `Use “${text}”`, highlight: false }];
    };
    return (
        <fieldset className="executor-card" aria-label="Default executor" aria-disabled={locked || undefined}>
            <div className="executor-card-head">
                <ProviderMark provider={provider} decorative />
                <span className="name">{draft.name || 'Unnamed executor'}</span>
                <span className="chip default">Default</span>
                <span className="chip">{scope === 'org' ? 'Organization' : 'Personal'}</span>
            </div>
            {wait === null ? null : <p className="wait-note">{wait}</p>}
            <div className="model-fields">
                <div className="picker-field">
                    <span className="model-label">Agent</span>
                    <SearchSelect
                        field="Agent"
                        icon="terminal"
                        valueLabel={executorTypeLabel(agent)}
                        value={agent}
                        options={draft.agents.map((id) => ({ value: id, label: executorTypeLabel(id) }))}
                        variant="form"
                        disabled={locked || draft.agents.length === 1}
                        onChange={(next) => draft.setAgent(next as ExecutorType)}
                    />
                    <p className="picker-help">{lock ?? PROVIDER_META[provider].agentHelp}</p>
                </div>
                <div className="picker-field">
                    <span className="model-label">Default model</span>
                    <SearchSelect
                        field="Default model"
                        icon="sparkles"
                        valueLabel={model === '' ? 'Choose a model' : model}
                        value={model}
                        options={draft.options.map((id) => ({ value: id, label: id }))}
                        before={typed}
                        variant="form"
                        disabled={locked}
                        help="Pick one the provider offers, or type any model name it serves."
                        onChange={draft.setModel}
                    />
                    <p className="picker-help">
                        What tasks run on by default. A task can still pick another model from this provider.
                    </p>
                </div>
            </div>
            <div className="picker-field">
                <label htmlFor={`${ids}-name`}>Executor name</label>
                <input
                    id={`${ids}-name`}
                    className="field"
                    type="text"
                    value={draft.name}
                    disabled={locked}
                    onChange={(event) => draft.setName(event.target.value)}
                />
            </div>
        </fieldset>
    );
}
