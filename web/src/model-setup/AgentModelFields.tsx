import { type ExecutorType, type ModelProvider, normalizeModelId } from '@factory-ai/core';
import { useState } from 'react';
import { executorTypeLabel } from '../workspace/executors.js';
import { modelOptions } from './providers.js';

/** The model select's "Other…" choice: its value is empty, so it is never a model id. */
const OTHER = '';

export interface AgentModel {
    agents: readonly ExecutorType[];
    agent: ExecutorType;
    setAgent: (agent: ExecutorType) => void;
    options: string[];
    /** The model a save sends: the picked option, or the free text under "Other…". */
    model: string;
    /** Whether the model is free text: "Other…" picked, or no option to pick. */
    freeText: boolean;
    custom: string;
    pick: (value: string) => void;
    setCustom: (value: string) => void;
    /** Back to the source's preselection, when the source changes. */
    reset: () => void;
}

/**
 * Where a saved model lands among the options: the option it names once both are normalized the way core stores ids
 * (`normalizeModelId`), else "Other…" with the saved id as its free text. Never the first option in its place.
 */
export function savedModelChoice(
    source: ModelProvider,
    agent: ExecutorType,
    options: readonly string[],
    saved: string
): { option: string } | { free: string } {
    const stored = normalizeModelId(source, agent, saved);
    const option = options.find((id) => normalizeModelId(source, agent, id) === stored);
    return option === undefined ? { free: saved } : { option };
}

/** The model while the saved one stands: its option, or its id as the "Other…" text. */
const keptModel = (kept: { option: string } | { free: string }) =>
    'free' in kept
        ? { freeText: true, text: kept.free, model: kept.free }
        : { freeText: false, text: '', model: kept.option };

/** The model the member picked: an option (the first until one is picked), or the "Other…" text. */
function pickedModel(options: readonly string[], pick: string | null, other: boolean, custom: string) {
    const freeText = other || options.length === 0;
    if (freeText) return { freeText, text: custom, model: custom.trim() };
    return { freeText, text: custom, model: pick !== null && options.includes(pick) ? pick : (options[0] ?? '') };
}

/**
 * The agent and model choice for a source: the agent preselected per source (the first it runs), the models the key
 * check returned or the curated ones, and "Other…" for any id. `saved` is a default already saved: shown as it is —
 * an unlisted id as "Other…" text — until the member changes the agent or the model, whenever it arrives. Only a
 * change the member makes (`reset`, a new agent) may drop it.
 */
export function useAgentModel(
    source: ModelProvider,
    agents: readonly ExecutorType[],
    checked: readonly string[] | undefined,
    saved?: { agent: ExecutorType | null; model: string | null }
): AgentModel {
    const [touched, setTouched] = useState(false);
    const [agentPick, setAgentPick] = useState<ExecutorType | null>(null);
    const [modelPick, setModelPick] = useState<string | null>(null);
    const [other, setOther] = useState(false);
    const [custom, setCustomText] = useState('');
    const offered = (pick: ExecutorType | null | undefined): pick is ExecutorType =>
        pick != null && agents.includes(pick);
    const savedAgent = saved?.agent;
    const agent = offered(agentPick) ? agentPick : offered(savedAgent) ? savedAgent : (agents[0] as ExecutorType);
    const options = modelOptions(source, agent, checked);
    const savedModel = saved?.model;
    const kept = !touched && savedModel ? savedModelChoice(source, agent, options, savedModel) : null;
    const { freeText, text, model } = kept ? keptModel(kept) : pickedModel(options, modelPick, other, custom);
    return {
        agents,
        agent,
        setAgent: (next) => {
            setTouched(true);
            setAgentPick(next);
            setModelPick(null);
            setOther(false);
        },
        options,
        model,
        freeText,
        custom: text,
        pick: (value) => {
            // Leaving the saved state starts from what it showed: the saved id stays as the "Other…" text.
            setTouched(true);
            setCustomText(text);
            setOther(value === OTHER);
            if (value !== OTHER) setModelPick(value);
        },
        setCustom: (value) => {
            setTouched(true);
            setOther(true);
            setCustomText(value);
        },
        reset: () => {
            setTouched(true);
            setAgentPick(null);
            setModelPick(null);
            setOther(false);
            setCustomText('');
        },
    };
}

/** The Agent and Model fields, side by side; `lock` replaces the agent's help when the source runs one agent. */
export function AgentModelFields({
    ids,
    state,
    help,
    lock,
    modelHelp,
}: {
    ids: string;
    state: AgentModel;
    help: string;
    lock: string | null;
    modelHelp: string;
}) {
    return (
        <div className="model-fields">
            <div className="picker-field">
                <label htmlFor={`${ids}-agent`}>Agent</label>
                <select
                    id={`${ids}-agent`}
                    className="field"
                    value={state.agent}
                    aria-describedby={`${ids}-agent-help`}
                    onChange={(event) => state.setAgent(event.target.value as ExecutorType)}
                >
                    {state.agents.map((agent) => (
                        <option key={agent} value={agent}>
                            {executorTypeLabel(agent)}
                        </option>
                    ))}
                </select>
                <p className="picker-help" id={`${ids}-agent-help`}>
                    {lock ?? help}
                </p>
            </div>
            <ModelField ids={ids} state={state} help={modelHelp} />
        </div>
    );
}

function ModelField({ ids, state, help }: { ids: string; state: AgentModel; help: string }) {
    const listed = state.options.length > 0;
    return (
        <div className="picker-field">
            <label htmlFor={listed ? `${ids}-model` : `${ids}-model-id`}>Model</label>
            {listed ? (
                <select
                    id={`${ids}-model`}
                    className="field"
                    value={state.freeText ? OTHER : state.model}
                    aria-describedby={`${ids}-model-help`}
                    onChange={(event) => state.pick(event.target.value)}
                >
                    {state.options.map((id) => (
                        <option key={id} value={id}>
                            {id}
                        </option>
                    ))}
                    <option value={OTHER}>Other…</option>
                </select>
            ) : null}
            {state.freeText ? (
                <input
                    id={`${ids}-model-id`}
                    className="field"
                    type="text"
                    value={state.custom}
                    placeholder="Model id"
                    aria-label={listed ? 'Model id' : undefined}
                    aria-describedby={`${ids}-model-help`}
                    onChange={(event) => state.setCustom(event.target.value)}
                />
            ) : null}
            <p className="picker-help" id={`${ids}-model-help`}>
                {help}
            </p>
        </div>
    );
}
