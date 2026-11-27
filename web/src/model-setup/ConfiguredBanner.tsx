import {
    ADMIN_ROLE,
    CLAUDE_CODE,
    type ExecutorType,
    isModelProvider,
    type ModelProvider,
    OPENCODE,
} from '@factory-ai/core';
import { useState } from 'react';
import type {
    ModelScopeView,
    ModelSetupView,
    SelectedExecutorView,
    SetupScope,
    UseModelSetup,
} from '../api/useModelSetup.js';
import type { Session } from '../api/useSession.js';
import { Icon } from '../components/Icon.js';
import { StateNote } from '../components/StateNote.js';
import { executorTypeLabel } from '../workspace/executors.js';
import { AgentModelFields, useAgentModel } from './AgentModelFields.js';
import { type ModelSource, PROVIDER_META, providerAgents } from './providers.js';
import { useSaveRun } from './SavePrimary.js';
import { adoptBody, editBody } from './save-body.js';
import { ScopeControl } from './ScopeControl.js';

/**
 * A model is already there: a default executor (`executor`), the deployment's model (`platform`), or a key an admin
 * connected for the org in the environment (`org`) — the last two are the legacy setups, which keep running and may
 * adopt a real executor on request.
 */
export type BannerKind = 'executor' | 'platform' | 'org';

/** The banner a setup read calls for; null when the member holds a key of their own or nothing is there. */
export function bannerOf(view: ModelSetupView): BannerKind | null {
    if (view.selected) return 'executor';
    if (view.personal?.keyNames.length) return null;
    if (view.org?.keyNames.length) return 'org';
    return view.platform ? 'platform' : null;
}

const BOTH_AGENTS: readonly ExecutorType[] = [CLAUDE_CODE, OPENCODE];

const orgSource = (org: ModelScopeView | null): ModelProvider => {
    const provider = org?.provider;
    return isModelProvider(provider) ? provider : 'anthropic';
};

/** The model source the banner's agent and model choice runs on: the executor's connection, else what the legacy setup holds. */
function sourceOf(view: ModelSetupView | null, kind: BannerKind | null): ModelSource {
    if (kind === 'executor') return view?.selected?.connection?.provider ?? 'platform';
    return kind === 'org' ? orgSource(view?.org ?? null) : 'platform';
}

/** The name a legacy setup's adopted executor takes: the deployment's model, or the organization's environment key. */
const adoptedName = (kind: BannerKind | null, source: ModelSource) =>
    kind === 'org' && source !== 'platform' ? `${PROVIDER_META[source].label} (organization key)` : 'Platform model';

/** Whether the member may replace the selected executor's own key: its connection is in the executor's scope, which they may write. */
export const canRotate = (selected: SelectedExecutorView | undefined, admin: boolean): boolean =>
    selected?.connection != null &&
    selected.connection.scope === selected.scope &&
    (selected.scope === 'personal' || admin);

/** The default a scope's save starts from: the org scope's own; for personal, the member's own, else the org's. */
const savedDefault = (view: ModelSetupView, scope: SetupScope) => {
    if (view.selected) return { agent: view.selected.agentType, model: view.selected.model };
    const own = scope === 'org' || !view.personal?.agentType ? view.org : view.personal;
    return { agent: own?.agentType ?? null, model: own?.model ?? null };
};

/**
 * The scope a banner's save preselects: the one already holding a default (an admin's org default, else the member's
 * own), so a save never moves a default to the other scope; with none, an admin's platform save is for everyone.
 */
const savedScope = (view: ModelSetupView | null, kind: BannerKind | null, admin: boolean): SetupScope => {
    if (view?.selected) return view.selected.scope;
    if (kind !== 'platform' || !admin || view?.personal?.agentType) return 'personal';
    return 'org';
};

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

function BannerText({
    kind,
    view,
    orgName,
    onOwnKey,
    onRotate,
}: {
    kind: BannerKind;
    view: ModelSetupView;
    orgName: string;
    onOwnKey: () => void;
    onRotate: (() => void) | null;
}) {
    const org = view.org;
    const runs = org?.agentType && org.model ? ` for ${executorTypeLabel(org.agentType)} · ${org.model}` : '';
    if (kind === 'executor' && view.selected) {
        return <ExecutorText selected={view.selected} orgName={orgName} onOwnKey={onOwnKey} onRotate={onRotate} />;
    }
    return (
        <div className="banner-info">
            <Icon name="info" size={24} />
            <div className="model-banner-body">
                {kind === 'platform' ? (
                    <>
                        <p className="banner-title">This deployment provides a model.</p>
                        <p>Choose the agent and model your tasks run on. Nothing else to do here.</p>
                    </>
                ) : (
                    <>
                        <p className="banner-title">{orgName} already has a model.</p>
                        <p>
                            An admin connected <b>{PROVIDER_META[orgSource(org)].label}</b>
                            {runs}. You can start right away.
                        </p>
                    </>
                )}
                <p className="muted">
                    {kind === 'platform' ? 'Prefer your own key? ' : 'Want your own key instead? '}
                    <button type="button" className="tertiary" onClick={onOwnKey}>
                        Use a personal key
                    </button>
                    {kind === 'platform' ? ' — it wins over the deployment’s.' : null}
                </p>
            </div>
        </div>
    );
}

/**
 * The setup when a model is already there: the agent and model the member's tasks run on, and who the default is for.
 * On a default executor, Continue edits that executor by id on its own connection (`editBody`: a model-only change
 * never sends a key). On a legacy setup it adopts a real executor on no connection (`adoptBody`), leaving the
 * environment's credentials as they are. Either way a default saved in onboarding (`saveExisting` false) is only
 * recorded as the step, and an executor the member may not edit — the organization's, for a member — is too.
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
    const kind = view ? bannerOf(view) : null;
    const source = sourceOf(view, kind);
    const agents = source === 'platform' ? BOTH_AGENTS : providerAgents(source);
    const [scopePick, setScopePick] = useState<SetupScope | null>(null);
    const scope = scopePick ?? savedScope(view, kind, admin);
    const choice = useAgentModel(source, agents, undefined, view ? savedDefault(view, scope) : undefined);
    const save = useSaveRun(setup, onSaved);
    const selected = view?.selected;
    const writes = selected
        ? saveExisting && (selected.scope === 'personal' || admin)
        : kind === 'platform' || saveExisting || !(view?.org?.agentType || view?.personal?.agentType);
    const body = () =>
        selected
            ? editBody({ selected, agentType: choice.agent, model: choice.model })
            : adoptBody({
                  scope,
                  name: adoptedName(kind, source),
                  source,
                  agentType: choice.agent,
                  model: choice.model,
              });
    return {
        admin,
        choice,
        scope,
        setScope: setScopePick,
        save,
        writes,
        reason: writes && !choice.model ? 'Choose a model to continue.' : null,
        press: () => void save.run(writes ? body() : null),
    };
}

export type ConfiguredState = ReturnType<typeof useConfigured>;

/** The banner, then — when Continue writes — the agent and model, and for an admin on the platform, the scope. */
export function ConfiguredView({
    ids,
    kind,
    view,
    state,
    orgName,
    onOwnKey,
    onRotate,
}: {
    ids: string;
    kind: BannerKind;
    view: ModelSetupView;
    state: ConfiguredState;
    orgName: string;
    onOwnKey: () => void;
    /** Replaces the selected executor's key; null when the member may not. */
    onRotate: (() => void) | null;
}) {
    return (
        <>
            <BannerText kind={kind} view={view} orgName={orgName} onOwnKey={onOwnKey} onRotate={onRotate} />
            {state.writes ? (
                <AgentModelFields
                    ids={ids}
                    state={state.choice}
                    help="Your tasks run on this agent unless you pick another."
                    lock={null}
                    modelHelp="Saves on your default executor. Change any time in Settings."
                />
            ) : null}
            {state.writes && kind === 'platform' && state.admin ? (
                <ScopeControl
                    ids={ids}
                    legend="Who this default is for"
                    orgName={orgName}
                    admin
                    value={state.scope}
                    onChange={state.setScope}
                />
            ) : null}
            {state.save.error ? <StateNote state="error">{state.save.error}</StateNote> : null}
        </>
    );
}
