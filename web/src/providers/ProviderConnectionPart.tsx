import {
    ADMIN_ROLE,
    type ModelProvider,
    type ProviderConnectionScope,
    providerRequiresBaseUrl,
} from '@factory-ai/core';
import { useId, useState } from 'react';
import type { SetupConnection } from '../api/providerConnections.js';
import type { Session } from '../api/useSession.js';
import { AdvancedBase, KeyField, ProxyField } from './KeyField.js';
import { ProviderCards } from './ProviderCards.js';
import { connectionReason, detectProvider, PROVIDER_META, providerChoices } from './providers.js';
import { ScopeControl } from './ScopeControl.js';
import { useKeyCheck } from './useKeyCheck.js';

/**
 * Part 1 of a provider setup, shared by onboarding and the settings page: the provider cards, the key with its live
 * check, who uses the connection, its name and, for a gateway, its base URL. `useProviderConnection` holds the draft;
 * the part renders it. Nothing here saves: the caller sends `create()` with the executor that runs on it.
 */
export function useProviderConnection(session: Session | null) {
    // Absent (no session yet) is never allowed; the server refuses a token either way.
    const subscriptionAllowed = session?.subscriptionToken === true;
    const admin = session?.role === ADMIN_ROLE;
    const choices = providerChoices(subscriptionAllowed);
    const [providerPick, setProviderPick] = useState<ModelProvider>('anthropic');
    const provider = choices.includes(providerPick) ? providerPick : (choices[0] ?? 'anthropic');
    const [key, setKey] = useState('');
    const [nameEdit, setNameEdit] = useState<string | null>(null);
    const name = nameEdit ?? PROVIDER_META[provider].label;
    const [baseUrl, setBaseUrl] = useState('');
    const [scopePick, setScopePick] = useState<ProviderConnectionScope | null>(null);
    // Only an admin may share a connection with the organization: a member's setup there is refused.
    const scope = admin ? (scopePick ?? 'org') : 'personal';
    const base = provider === 'subscription' ? '' : baseUrl.trim();
    const check = useKeyCheck({ provider, key, baseUrl: base, subscriptionAllowed });

    const choose = (next: ModelProvider) => {
        if (next === provider) return;
        setProviderPick(next);
        // The URL belongs to the provider it was typed for.
        setBaseUrl('');
    };
    return {
        choices,
        admin,
        provider,
        choose,
        key,
        onKey: (value: string) => {
            setKey(value);
            choose(detectProvider(value.trim(), provider, subscriptionAllowed));
        },
        baseUrl,
        setBaseUrl,
        name,
        setName: setNameEdit,
        scope,
        setScope: setScopePick,
        check,
        /** Why the connection cannot be created yet; null once it may. */
        reason: connectionReason({ provider, key, baseUrl: base, name, check: check.kind }),
        /** The connection a setup creates: the key as pasted, a base URL only where one is given. */
        create: (): SetupConnection => ({
            intent: 'create',
            provider,
            key: key.trim(),
            ...(base ? { baseUrl: base } : {}),
            name: name.trim(),
        }),
    };
}

export type ProviderConnectionDraft = ReturnType<typeof useProviderConnection>;

export function ProviderConnectionPart({ draft, orgName }: { draft: ProviderConnectionDraft; orgName: string }) {
    const ids = useId();
    const { provider } = draft;
    const needsBase = providerRequiresBaseUrl(provider);
    return (
        <>
            <ProviderCards
                ids={ids}
                choices={draft.choices.map((id) => ({ id, ...PROVIDER_META[id] }))}
                value={provider}
                onChange={(id) => draft.choose(id as ModelProvider)}
            />
            {needsBase ? (
                <ProxyField
                    ids={ids}
                    provider={provider}
                    value={draft.baseUrl}
                    hidden={false}
                    onChange={draft.setBaseUrl}
                />
            ) : null}
            <KeyField
                ids={ids}
                meta={PROVIDER_META[provider]}
                value={draft.key}
                check={draft.check}
                onChange={draft.onKey}
            />
            <ScopeControl
                ids={ids}
                legend="Who uses this connection"
                orgName={orgName}
                admin={draft.admin}
                value={draft.scope}
                onChange={draft.setScope}
            />
            <div className="picker-field">
                <label htmlFor={`${ids}-name`}>Connection name</label>
                <input
                    id={`${ids}-name`}
                    className="field"
                    type="text"
                    value={draft.name}
                    aria-describedby={`${ids}-name-help`}
                    onChange={(event) => draft.setName(event.target.value)}
                />
                <p className="picker-help" id={`${ids}-name-help`}>
                    A name already in use is refused, never overwritten.
                </p>
            </div>
            <p className="picker-help">
                {draft.scope === 'org'
                    ? 'Saved as an organization connection. '
                    : 'Saved as your personal connection. '}
                Nobody — admins included — can read the key back; you can only replace it.
            </p>
            {!needsBase && provider !== 'subscription' ? (
                <AdvancedBase
                    ids={ids}
                    name="the connection"
                    value={draft.baseUrl}
                    hidden={false}
                    onChange={draft.setBaseUrl}
                />
            ) : null}
        </>
    );
}
