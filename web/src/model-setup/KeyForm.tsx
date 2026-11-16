import { ADMIN_ROLE, isModelProvider, type ModelProvider, SELF_HOSTED } from '@factory-ai/core';
import { useState } from 'react';
import type { ModelScopeView, SetupScope, UseModelSetup } from '../api/useModelSetup.js';
import type { Session } from '../api/useSession.js';
import { StateNote } from '../components/StateNote.js';
import { AgentModelFields, useAgentModel } from './AgentModelFields.js';
import { AdvancedBase, KeyField, ProxyField, SecretNote } from './KeyField.js';
import { ProviderCards } from './ProviderCards.js';
import { agentLock, detectProvider, PROVIDER_META, providerAgents, providerChoices, saveReason } from './providers.js';
import { useSaveRun } from './SavePrimary.js';
import { keyBody } from './save-body.js';
import { ScopeControl } from './ScopeControl.js';
import { useKeyCheck } from './useKeyCheck.js';

const MODEL_HELP = 'Saved as your default agent and model. Change any time in Settings.';
const PROXY_MODEL_HELP = 'Read from the proxy after the check. Saved as your default agent and model.';

/** The base URL a provider sends: LiteLLM's proxy, the Advanced one for a hosted provider, none for a subscription. */
const baseFor = (provider: ModelProvider, proxy: string, base: string) =>
    provider === 'litellm' ? proxy : provider === 'subscription' ? '' : base;

/** A scope's saved provider, when it is one this deployment offers. */
const savedProvider = (scopeView: ModelScopeView | null | undefined, choices: readonly ModelProvider[]) => {
    const provider = scopeView?.provider;
    return isModelProvider(provider) && choices.includes(provider) ? provider : null;
};

/**
 * The proxy and base URLs the form shows: the member's edit, else the URL the scope holds for this provider. A base URL
 * stored as a secret has no value to show, so it is kept (`keepBase`) until the member types one; a secret LiteLLM proxy
 * must be entered again, since the key check needs it (`hiddenProxy`).
 */
function urlsOf(
    scopeView: ModelScopeView | null | undefined,
    provider: ModelProvider,
    proxyEdit: string | null,
    baseEdit: string | null
) {
    const saved = scopeView?.provider === provider ? scopeView : null;
    const hosted = provider !== 'litellm' && provider !== 'subscription';
    return {
        proxy: proxyEdit ?? (provider === 'litellm' ? saved?.baseUrl : undefined) ?? '',
        base: baseEdit ?? (hosted ? saved?.baseUrl : undefined) ?? '',
        keepBase: hosted && baseEdit === null && saved?.baseUrlSet === true,
        hiddenProxy: provider === 'litellm' && proxyEdit === null && saved?.baseUrlSet === true,
    };
}

/**
 * The key form's state: provider (moved by a pasted key's prefix), key and its live check, base URLs, agent and model,
 * and scope. Until the member picks, each starts from what is saved: the scope holding the member's own key (else an
 * admin's organization), that scope's provider, and its agent default while the provider is the saved one — an
 * unlisted saved model included — and its proxy or base URL (`urlsOf`), so a save never swaps a saved value for a
 * preselection the member did not see.
 */
export function useKeyForm(session: Session | null, setup: UseModelSetup, onSaved: () => void | Promise<void>) {
    const mode = session?.deploymentMode ?? SELF_HOSTED;
    const admin = session?.role === ADMIN_ROLE;
    const view = setup.data;
    const choices = providerChoices(mode);
    const [scopePick, setScopePick] = useState<SetupScope | null>(null);
    const scope = scopePick ?? (admin && !view?.personal?.keyNames.length ? 'org' : 'personal');
    const scopeView = view?.[scope];
    const [providerPick, setProviderPick] = useState<ModelProvider | null>(null);
    const provider = providerPick ?? savedProvider(scopeView, choices) ?? 'anthropic';
    const [key, setKey] = useState('');
    const [proxyEdit, setProxy] = useState<string | null>(null);
    const [baseEdit, setBase] = useState<string | null>(null);
    const { proxy, base, keepBase, hiddenProxy } = urlsOf(scopeView, provider, proxyEdit, baseEdit);
    const baseUrl = baseFor(provider, proxy, base).trim();
    const check = useKeyCheck({ provider, key, baseUrl, mode });
    const saved =
        scopeView && scopeView.provider === provider
            ? { agent: scopeView.agentType, model: scopeView.model }
            : undefined;
    const choice = useAgentModel(provider, providerAgents(provider), check.models, saved);
    const save = useSaveRun(setup, onSaved);
    const choose = (next: ModelProvider) => {
        if (next === provider) return;
        setProviderPick(next);
        choice.reset();
    };
    return {
        choices,
        admin,
        provider,
        choose,
        key,
        onKey: (value: string) => {
            setKey(value);
            choose(detectProvider(value.trim(), provider, mode));
        },
        proxy,
        setProxy,
        hiddenProxy,
        base,
        setBase,
        keepBase,
        scope,
        setScope: setScopePick,
        check,
        choice,
        save,
        reason: saveReason({ provider, key, baseUrl, model: choice.model, check: check.kind }),
        press: () =>
            void save.run(
                keyBody({ scope, provider, key, baseUrl, keepBase, agentType: choice.agent, model: choice.model })
            ),
    };
}

export type KeyFormState = ReturnType<typeof useKeyForm>;

/** The key form: provider, key and its live check, agent and model, who it is for, and where the secret goes. */
export function KeyFormView({ ids, form, orgName }: { ids: string; form: KeyFormState; orgName: string }) {
    const { provider } = form;
    const hosted = provider !== 'litellm' && provider !== 'subscription';
    return (
        <>
            <ProviderCards ids={ids} choices={form.choices} value={provider} onChange={form.choose} />
            {provider === 'litellm' ? (
                <ProxyField ids={ids} value={form.proxy} hidden={form.hiddenProxy} onChange={form.setProxy} />
            ) : null}
            <KeyField ids={ids} provider={provider} value={form.key} check={form.check} onChange={form.onKey} />
            <AgentModelFields
                ids={ids}
                state={form.choice}
                help={PROVIDER_META[provider].agentHelp}
                lock={agentLock(provider)}
                modelHelp={provider === 'litellm' ? PROXY_MODEL_HELP : MODEL_HELP}
            />
            <ScopeControl
                ids={ids}
                legend="Who uses this key"
                orgName={orgName}
                admin={form.admin}
                value={form.scope}
                onChange={form.setScope}
            />
            {hosted ? (
                <AdvancedBase
                    ids={ids}
                    provider={provider}
                    value={form.base}
                    hidden={form.keepBase}
                    onChange={form.setBase}
                />
            ) : null}
            <SecretNote
                provider={provider}
                scope={form.scope}
                withBase={hosted && (form.keepBase || form.base.trim() !== '')}
            />
            {form.save.error ? <StateNote state="error">{form.save.error}</StateNote> : null}
        </>
    );
}
