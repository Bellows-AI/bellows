import {
    ADMIN_ROLE,
    CLAUDE_CODE,
    type ExecutorType,
    isModelProvider,
    type ModelProvider,
    OPENCODE,
} from '@factory-ai/core';
import { useState } from 'react';
import type { ModelScopeView, ModelSetupView, SetupScope, UseModelSetup } from '../api/useModelSetup.js';
import type { Session } from '../api/useSession.js';
import { Icon } from '../components/Icon.js';
import { StateNote } from '../components/StateNote.js';
import { executorTypeLabel } from '../workspace/executors.js';
import { AgentModelFields, useAgentModel } from './AgentModelFields.js';
import { type ModelSource, PROVIDER_META, providerAgents } from './providers.js';
import { useSaveRun } from './SavePrimary.js';
import { ScopeControl } from './ScopeControl.js';

/** A model is already there: the deployment's (`platform`), or a key an admin connected for the org (`org`). */
export type BannerKind = 'platform' | 'org';

/** The banner a setup read calls for; null when the member holds a key of their own or nothing is there. */
export function bannerOf(view: ModelSetupView): BannerKind | null {
    if (view.personal?.keyNames.length) return null;
    if (view.org?.keyNames.length) return 'org';
    return view.platform ? 'platform' : null;
}

const BOTH_AGENTS: readonly ExecutorType[] = [CLAUDE_CODE, OPENCODE];

const orgSource = (org: ModelScopeView | null): ModelProvider => {
    const provider = org?.provider;
    return isModelProvider(provider) ? provider : 'anthropic';
};

/** The default already saved, the member's own first. */
const savedDefault = (view: ModelSetupView) => {
    const own = view.personal?.agentType ? view.personal : view.org;
    return { agent: own?.agentType ?? null, model: own?.model ?? null };
};

function BannerText({
    kind,
    view,
    orgName,
    onOwnKey,
}: {
    kind: BannerKind;
    view: ModelSetupView;
    orgName: string;
    onOwnKey: () => void;
}) {
    const org = view.org;
    const runs = org?.agentType && org.model ? ` for ${executorTypeLabel(org.agentType)} · ${org.model}` : '';
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
 * Continue saves the agent default alone — on the platform, or on the org's key (`existing`) — except on the org's key
 * with a default already saved in onboarding (`saveExisting` false), where it only records the step.
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
    const source: ModelSource = kind === 'org' ? orgSource(view?.org ?? null) : 'platform';
    const agents = source === 'platform' ? BOTH_AGENTS : providerAgents(source);
    const choice = useAgentModel(source, agents, undefined, view ? savedDefault(view) : undefined);
    const [scopePick, setScopePick] = useState<SetupScope | null>(null);
    const scope = scopePick ?? (kind === 'platform' && admin ? 'org' : 'personal');
    const save = useSaveRun(setup, onSaved);
    const writes = kind === 'platform' || saveExisting || !(view?.org?.agentType || view?.personal?.agentType);
    const provider = kind === 'platform' ? 'platform' : 'existing';
    return {
        admin,
        choice,
        scope,
        setScope: setScopePick,
        save,
        writes,
        reason: writes && !choice.model ? 'Choose a model to continue.' : null,
        press: () => void save.run(writes ? { scope, provider, agentType: choice.agent, model: choice.model } : null),
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
}: {
    ids: string;
    kind: BannerKind;
    view: ModelSetupView;
    state: ConfiguredState;
    orgName: string;
    onOwnKey: () => void;
}) {
    return (
        <>
            <BannerText kind={kind} view={view} orgName={orgName} onOwnKey={onOwnKey} />
            {state.writes ? (
                <AgentModelFields
                    ids={ids}
                    state={state.choice}
                    help="Your tasks run on this agent unless you pick another."
                    lock={null}
                    modelHelp="Saved as your default agent and model. Change any time in Settings."
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
