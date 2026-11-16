import type { ExecutorType } from '@factory-ai/core';
import { useState } from 'react';
import { executorTypeLabel } from '../workspace/executors.js';
import { type ModelSource, modelOptions } from './providers.js';

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
 * The agent and model choice for a source: the agent preselected per source (the first it runs), the models the key
 * check returned or the curated ones, and "Other…" for any id. `saved` is a default already saved: preselected until
 * the member picks, whenever it arrives.
 */
export function useAgentModel(
    source: ModelSource,
    agents: readonly ExecutorType[],
    checked: readonly string[] | undefined,
    saved?: { agent: ExecutorType | null; model: string | null }
): AgentModel {
    const [agentPick, setAgentPick] = useState<ExecutorType | null>(null);
    const [modelPick, setModelPick] = useState<string | null>(null);
    const [other, setOther] = useState(false);
    const [custom, setCustom] = useState('');
    const offered = (pick: ExecutorType | null | undefined): pick is ExecutorType =>
        pick != null && agents.includes(pick);
    const savedAgent = saved?.agent;
    const agent = offered(agentPick) ? agentPick : offered(savedAgent) ? savedAgent : (agents[0] as ExecutorType);
    const options = modelOptions(source, agent, checked);
    const freeText = other || options.length === 0;
    const preferred = modelPick ?? (agentPick === null ? saved?.model : null) ?? null;
    const picked = preferred !== null && options.includes(preferred) ? preferred : (options[0] ?? '');
    return {
        agents,
        agent,
        setAgent: (next) => {
            setAgentPick(next);
            setModelPick(null);
        },
        options,
        model: freeText ? custom.trim() : picked,
        freeText,
        custom,
        pick: (value) => {
            setOther(value === OTHER);
            if (value !== OTHER) setModelPick(value);
        },
        setCustom,
        reset: () => {
            setAgentPick(null);
            setModelPick(null);
            setOther(false);
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
