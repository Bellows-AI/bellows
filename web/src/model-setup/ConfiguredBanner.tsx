import { ADMIN_ROLE, isModelProvider, type ModelProvider } from '@factory-ai/core';
import type { ModelSetupView, SelectedExecutorView, UseModelSetup } from '../api/useModelSetup.js';
import type { Session } from '../api/useSession.js';
import { Icon } from '../components/Icon.js';
import { StateNote } from '../components/StateNote.js';
import { executorTypeLabel } from '../workspace/executors.js';
import { AgentModelFields, useAgentModel } from './AgentModelFields.js';
import { PROVIDER_META, providerAgents } from './providers.js';
import { useSaveRun } from './SavePrimary.js';
import { editBody } from './save-body.js';

/**
 * The model source the banner's agent and model choice runs on: the executor's connection, else what the scope's
 * environment holds, else Anthropic's list.
 */
function sourceOf(view: ModelSetupView | null): ModelProvider {
    const held = (view?.personal ?? view?.org)?.provider;
    return view?.selected?.connection?.provider ?? (isModelProvider(held) ? held : 'anthropic');
}

/** Whether the member may replace the selected executor's own key: its connection is in the executor's scope, which they may write. */
export const canRotate = (selected: SelectedExecutorView | undefined, admin: boolean): boolean =>
    selected?.connection != null &&
    selected.connection.scope === selected.scope &&
    (selected.scope === 'personal' || admin);

function ExecutorText({
    selected,
    orgName,
    onOwnKey,
    onRotate,
}: {
    selected: SelectedExecutorView;
    orgName: string;
    onOwnKey: () => void;
    onRotate: (() => void) | null;
}) {
    const { connection } = selected;
    const runs = [
        executorTypeLabel(selected.agentType),
        connection ? PROVIDER_META[connection.provider].label : 'the environment’s credentials',
        selected.model,
    ]
        .filter(Boolean)
        .join(' · ');
    return (
        <div className="banner-info">
            <Icon name="info" size={24} />
            <div className="model-banner-body">
                <p className="banner-title">
                    {selected.scope === 'org'
                        ? `${orgName} runs tasks on ${selected.name}.`
                        : `Your tasks run on ${selected.name}.`}
                </p>
                <p>
                    {runs}
                    {connection ? ` — connection ${connection.name}` : null}. You can start right away.
                </p>
                <p className="muted">
                    <button type="button" className="tertiary" onClick={onOwnKey}>
                        Connect another provider
                    </button>
                    {onRotate ? (
                        <>
                            {' · '}
                            <button type="button" className="tertiary" onClick={onRotate}>
                                Replace the key
                            </button>
                        </>
                    ) : null}
                </p>
            </div>
        </div>
    );
}

/**
 * The setup when a default executor is already there: the agent and model the member's tasks run on. Continue edits
 * that executor by id on its own connection (`editBody`: a model-only change never sends a key). A default saved in
 * onboarding (`saveExisting` false) is only recorded as the step, and so is an executor the member may not edit — the
 * organization's, for a member — or one on no connection of its own (the setup route takes no such save).
 */
export function useConfigured({
    session,
    view,
    setup,
    onSaved,
    saveExisting,
}: {
    session: Session | null;
    view: ModelSetupView | null;
    setup: UseModelSetup;
    onSaved: () => void | Promise<void>;
    saveExisting: boolean;
}) {
    const admin = session?.role === ADMIN_ROLE;
    const source = sourceOf(view);
    const choice = useAgentModel(
        source,
        providerAgents(source),
        undefined,
        view?.selected && {
            agent: view.selected.agentType,
            model: view.selected.model,
        }
    );
    const save = useSaveRun(setup, onSaved);
    const selected = view?.selected;
    const writes =
        selected !== undefined &&
        selected.connection !== null &&
        saveExisting &&
        (selected.scope === 'personal' || admin);
    return {
        choice,
        save,
        writes,
        reason: writes && !choice.model ? 'Choose a model to continue.' : null,
        press: () =>
            void save.run(
                writes && selected?.connection
                    ? editBody({
                          selected,
                          connectionId: selected.connection.id,
                          agentType: choice.agent,
                          model: choice.model,
                      })
                    : null
            ),
    };
}

export type ConfiguredState = ReturnType<typeof useConfigured>;

/** The banner, then — when Continue writes — the agent and model. */
export function ConfiguredView({
    ids,
    selected,
    state,
    orgName,
    onOwnKey,
    onRotate,
}: {
    ids: string;
    selected: SelectedExecutorView;
    state: ConfiguredState;
    orgName: string;
    onOwnKey: () => void;
    /** Replaces the selected executor's key; null when the member may not. */
    onRotate: (() => void) | null;
}) {
    return (
        <>
            <ExecutorText selected={selected} orgName={orgName} onOwnKey={onOwnKey} onRotate={onRotate} />
            {state.writes ? (
                <AgentModelFields
                    ids={ids}
                    state={state.choice}
                    help="Your tasks run on this agent unless you pick another."
                    lock={null}
                    modelHelp="Saves on your default executor. Change any time in Settings."
                />
            ) : null}
            {state.save.error ? <StateNote state="error">{state.save.error}</StateNote> : null}
        </>
    );
}
