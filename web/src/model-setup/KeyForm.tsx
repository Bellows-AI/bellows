import { ADMIN_ROLE, type ModelProvider, SELF_HOSTED } from '@factory-ai/core';
import { useState } from 'react';
import type { SetupScope, UseModelSetup } from '../api/useModelSetup.js';
import type { Session } from '../api/useSession.js';
import { StateNote } from '../components/StateNote.js';
import { AgentModelFields, useAgentModel } from './AgentModelFields.js';
import { AdvancedBase, KeyField, ProxyField, SecretNote } from './KeyField.js';
import { ProviderCards } from './ProviderCards.js';
import { agentLock, detectProvider, PROVIDER_META, providerAgents, providerChoices, saveReason } from './providers.js';
import { useSaveRun } from './SavePrimary.js';
import { ScopeControl } from './ScopeControl.js';
import { useKeyCheck } from './useKeyCheck.js';

const MODEL_HELP = 'Saved as your default agent and model. Change any time in Settings.';
const PROXY_MODEL_HELP = 'Read from the proxy after the check. Saved as your default agent and model.';

/** The base URL a provider sends: LiteLLM's proxy, the Advanced one for a hosted provider, none for a subscription. */
const baseFor = (provider: ModelProvider, proxy: string, base: string) =>
    provider === 'litellm' ? proxy : provider === 'subscription' ? '' : base;

/**
 * The key form's state: provider (moved by a pasted key's prefix), key and its live check, base URLs, agent and model,
 * and scope — an admin's preselection is the organization until they pick, or until "Use a personal key".
 */
export function useKeyForm(session: Session | null, setup: UseModelSetup, onSaved: () => void | Promise<void>) {
    const mode = session?.deploymentMode ?? SELF_HOSTED;
    const admin = session?.role === ADMIN_ROLE;
    const [provider, setProvider] = useState<ModelProvider>('anthropic');
    const [key, setKey] = useState('');
    const [proxy, setProxy] = useState('');
    const [base, setBase] = useState('');
    const [scopePick, setScopePick] = useState<SetupScope | null>(null);
    const scope = scopePick ?? (admin ? 'org' : 'personal');
    const baseUrl = baseFor(provider, proxy, base).trim();
    const check = useKeyCheck({ provider, key, baseUrl, mode });
    const choice = useAgentModel(provider, providerAgents(provider), check.models);
    const save = useSaveRun(setup, onSaved);
    const choose = (next: ModelProvider) => {
        if (next === provider) return;
        setProvider(next);
        choice.reset();
    };
    return {
        choices: providerChoices(mode),
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
        base,
        setBase,
        scope,
        setScope: setScopePick,
        check,
        choice,
        save,
        reason: saveReason({ provider, key, baseUrl, model: choice.model, check: check.kind }),
        press: () =>
            void save.run({
                scope,
                provider,
                key: key.trim(),
                ...(baseUrl ? { baseUrl } : {}),
                agentType: choice.agent,
                model: choice.model,
            }),
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
            {provider === 'litellm' ? <ProxyField ids={ids} value={form.proxy} onChange={form.setProxy} /> : null}
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
            {hosted ? <AdvancedBase ids={ids} provider={provider} value={form.base} onChange={form.setBase} /> : null}
            <SecretNote provider={provider} scope={form.scope} withBase={hosted && form.base.trim() !== ''} />
            {form.save.error ? <StateNote state="error">{form.save.error}</StateNote> : null}
        </>
    );
}
