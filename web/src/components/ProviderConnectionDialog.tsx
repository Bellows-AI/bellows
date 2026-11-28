import {
    MODEL_PROVIDERS,
    type ModelProvider,
    type ProviderConnectionScope,
    providerRequiresBaseUrl,
} from '@factory-ai/core';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { useId, useState } from 'react';
import {
    createProviderConnection,
    type ProviderConnectionMeta,
    updateProviderConnection,
} from '../api/providerConnections.js';
import { connectionsChanged } from '../api/useProviderConnections.js';
import { AdvancedBase, KeyField, ProxyField } from '../model-setup/KeyField.js';
import { ProviderCards } from '../model-setup/ProviderCards.js';
import { detectProvider, PROVIDER_META, providerChoices } from '../model-setup/providers.js';
import { useKeyCheck } from '../model-setup/useKeyCheck.js';
import { FieldError } from './executor-dialog-parts.js';

/**
 * Create, rename or rotate one provider connection (Settings → Model). Three modes, one dialog:
 *
 * - create: scope, name, provider, key and an optional endpoint. The key is checked with the existing model-setup
 *   verify first, the answer's model count shown, and Save waits for a working key.
 * - edit: the name and the endpoint only. No key field exists, and the write carries no `key`: renaming never resends
 *   or touches the stored credential.
 * - rotate: a new key, checked the same way against the connection's current endpoint, then replaced. Nothing else
 *   changes.
 *
 * A key lives in this dialog's state only while it is open — never in a URL, a draft store or browser storage.
 */

export type ConnectionDialogMode =
    | { kind: 'create' }
    | { kind: 'edit'; connection: ProviderConnectionMeta }
    | { kind: 'rotate'; connection: ProviderConnectionMeta };

const NAME_HELP = 'Shown wherever an executor picks a connection — for example, Team Anthropic.';

/** A hosted provider's endpoint is optional; a subscription has none, and LiteLLM's proxy is required. */
const takesEndpoint = (provider: ModelProvider) => provider !== 'subscription';

/** The title of each mode. */
const TITLES = { create: 'Add provider connection', edit: 'Edit provider connection', rotate: 'Replace key' } as const;

export function ProviderConnectionDialog({
    mode,
    open,
    isAdmin,
    subscriptionAllowed,
    onClose,
    onSaved,
}: {
    /** Null while closed. */
    mode: ConnectionDialogMode | null;
    open: boolean;
    isAdmin: boolean;
    /** Whether the org may configure a Claude subscription token: the provider is offered only then. */
    subscriptionAllowed: boolean;
    onClose: () => void;
    /** The success sentence, told just before the dialog closes. */
    onSaved: (message: string) => void;
}) {
    return (
        <Dialog open={open && mode !== null} onClose={onClose} className="dialog-layer">
            <div className="dialog-backdrop" aria-hidden="true" />
            <div className="dialog-position">
                <DialogPanel className="dialog picker">
                    {mode ? (
                        <ConnectionForm
                            // A different row or mode is a different form: nothing typed carries across.
                            key={mode.kind === 'create' ? 'create' : `${mode.kind}:${mode.connection.id}`}
                            mode={mode}
                            isAdmin={isAdmin}
                            subscriptionAllowed={subscriptionAllowed}
                            onClose={onClose}
                            onSaved={onSaved}
                        />
                    ) : null}
                </DialogPanel>
            </div>
        </Dialog>
    );
}

interface Values {
    scope: ProviderConnectionScope;
    name: string;
    provider: ModelProvider;
    key: string;
    baseUrl: string;
}

/** The write one mode makes: a create, a rotation (the key alone) or a metadata edit (never a key). */
function submit(mode: ConnectionDialogMode, isAdmin: boolean, values: Values) {
    const name = values.name.trim();
    const endpoint = values.baseUrl.trim();
    if (mode.kind === 'rotate') return updateProviderConnection(mode.connection.id, { key: values.key.trim() });
    if (mode.kind === 'edit')
        return updateProviderConnection(mode.connection.id, editBody(mode.connection, name, endpoint));
    return createProviderConnection({
        scope: isAdmin ? values.scope : 'personal',
        name,
        provider: values.provider,
        key: values.key.trim(),
        ...(takesEndpoint(values.provider) && endpoint ? { baseUrl: endpoint } : {}),
    });
}

function ScopeField({
    ids,
    isAdmin,
    scope,
    onChange,
}: {
    ids: string;
    isAdmin: boolean;
    scope: ProviderConnectionScope;
    onChange: (scope: ProviderConnectionScope) => void;
}) {
    return (
        <div className="picker-field">
            <label htmlFor={`${ids}-scope`}>Who can use it</label>
            <select
                id={`${ids}-scope`}
                className="field"
                value={isAdmin ? scope : 'personal'}
                disabled={!isAdmin}
                onChange={(event) => onChange(event.target.value as ProviderConnectionScope)}
            >
                <option value="personal">Only me</option>
                {isAdmin ? <option value="org">Everyone in the organization</option> : null}
            </select>
            <p className="picker-help">
                {isAdmin
                    ? 'An organization connection is managed by admins and can run any executor, yours or the organization’s.'
                    : 'Organization connections are added by admins.'}
            </p>
        </div>
    );
}

function NameInput({ ids, value, onChange }: { ids: string; value: string; onChange: (name: string) => void }) {
    return (
        <div className="picker-field">
            <label htmlFor={`${ids}-name`}>Name</label>
            <input
                id={`${ids}-name`}
                className="field"
                type="text"
                value={value}
                placeholder="Team Anthropic"
                aria-describedby={`${ids}-name-help`}
                onChange={(event) => onChange(event.target.value)}
            />
            <p className="picker-help" id={`${ids}-name-help`}>
                {NAME_HELP}
            </p>
        </div>
    );
}

/** The endpoint control a mode and provider call for: LiteLLM's proxy, a hosted provider's optional base URL, or none. */
function EndpointFields({
    ids,
    mode,
    provider,
    baseUrl,
    onChange,
}: {
    ids: string;
    mode: ConnectionDialogMode['kind'];
    provider: ModelProvider;
    baseUrl: string;
    onChange: (baseUrl: string) => void;
}) {
    if (mode === 'rotate' || !takesEndpoint(provider)) return null;
    if (mode === 'create') {
        return providerRequiresBaseUrl(provider) ? (
            <ProxyField ids={ids} provider={provider} value={baseUrl} hidden={false} onChange={onChange} />
        ) : (
            <AdvancedBase ids={ids} name="the connection" value={baseUrl} hidden={false} onChange={onChange} />
        );
    }
    return (
        <div className="picker-field">
            <label htmlFor={`${ids}-endpoint`}>
                {provider === 'litellm'
                    ? 'Proxy URL'
                    : provider === 'openai-compatible'
                      ? 'Endpoint URL'
                      : 'Base URL (optional)'}
            </label>
            <input
                id={`${ids}-endpoint`}
                className="field"
                type="url"
                value={baseUrl}
                aria-describedby={`${ids}-endpoint-help`}
                onChange={(event) => onChange(event.target.value)}
            />
            <p className="picker-help" id={`${ids}-endpoint-help`}>
                Only the name and endpoint change here; the stored key stays as it is. Use Replace key to rotate it.
            </p>
        </div>
    );
}

/** The provider (chosen on a create, fixed afterwards) and the key field the mode calls for, with its live check. */
function ProviderAndKey({
    ids,
    mode,
    provider,
    choices,
    subscriptionAllowed,
    keyValue,
    check,
    onProvider,
    onKey,
}: {
    ids: string;
    mode: ConnectionDialogMode['kind'];
    provider: ModelProvider;
    choices: readonly ModelProvider[];
    subscriptionAllowed: boolean;
    keyValue: string;
    check: Parameters<typeof KeyField>[0]['check'];
    onProvider: (provider: ModelProvider) => void;
    onKey: (key: string) => void;
}) {
    return (
        <>
            {mode === 'create' ? (
                <ProviderCards
                    ids={ids}
                    choices={choices.map((id) => ({ id, ...PROVIDER_META[id] }))}
                    value={provider}
                    onChange={(id) => onProvider(id as ModelProvider)}
                />
            ) : (
                <p className="picker-help">
                    Provider: {PROVIDER_META[provider].label}. A connection’s provider and scope cannot change; add
                    another connection instead.
                </p>
            )}
            {mode === 'edit' ? null : (
                <KeyField
                    ids={ids}
                    meta={PROVIDER_META[provider]}
                    value={keyValue}
                    onChange={(value) => {
                        onKey(value);
                        // A pasted key's prefix names its provider, on a create only.
                        if (mode === 'create') onProvider(detectProvider(value.trim(), provider, subscriptionAllowed));
                    }}
                    check={check}
                />
            )}
        </>
    );
}

/** Cancel and the save, with the reason Save waits on the leading edge. */
function FormActions({
    ids,
    kind,
    reason,
    saving,
    onCancel,
    onSave,
}: {
    ids: string;
    kind: ConnectionDialogMode['kind'];
    reason: string | null;
    saving: boolean;
    onCancel: () => void;
    onSave: () => void;
}) {
    return (
        <div className="picker-actions">
            {reason && !saving ? (
                <p className="picker-save-hint" id={`${ids}-hint`}>
                    {reason}
                </p>
            ) : null}
            <button type="button" onClick={onCancel} disabled={saving}>
                Cancel
            </button>
            <button
                type="button"
                className="primary"
                disabled={reason !== null || saving}
                aria-describedby={reason ? `${ids}-hint` : undefined}
                onClick={onSave}
            >
                {saving ? 'Saving…' : kind === 'rotate' ? 'Replace key' : 'Save'}
            </button>
        </div>
    );
}

function ConnectionForm({
    mode,
    isAdmin,
    subscriptionAllowed,
    onClose,
    onSaved,
}: {
    mode: ConnectionDialogMode;
    isAdmin: boolean;
    subscriptionAllowed: boolean;
    onClose: () => void;
    onSaved: (message: string) => void;
}) {
    const ids = useId();
    const existing = mode.kind === 'create' ? null : mode.connection;
    const choices = providerChoices(subscriptionAllowed);
    const [scope, setScope] = useState<ProviderConnectionScope>('personal');
    const [name, setName] = useState(existing?.name ?? '');
    const [provider, setProvider] = useState<ModelProvider>(existing?.provider ?? choices[0] ?? MODEL_PROVIDERS[0]);
    const [key, setKey] = useState('');
    const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
    const [failure, setFailure] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // Rotation checks the new key against the connection's own endpoint, so the check answers what a task will reach.
    const checkedBase = mode.kind === 'rotate' ? (existing?.baseUrl ?? '') : baseUrl;
    const keyed = mode.kind !== 'edit';
    const check = useKeyCheck({ provider, key: keyed ? key : '', baseUrl: checkedBase, subscriptionAllowed });
    const reason = connectionSaveReason({
        mode: mode.kind,
        name,
        provider,
        baseUrl,
        checked: check.kind === 'ok' || check.kind === 'warn',
        check: check.kind,
    });

    const save = async () => {
        if (reason !== null || saving) return;
        setSaving(true);
        setFailure(null);
        const result = await submit(mode, isAdmin, { scope, name, provider, key, baseUrl });
        setSaving(false);
        if (!result.ok) {
            setFailure(result.error);
            return;
        }
        connectionsChanged();
        onSaved(savedMessage(mode.kind, result.connection.name));
        onClose();
    };

    return (
        <>
            <DialogTitle as="h2">{TITLES[mode.kind]}</DialogTitle>
            {mode.kind === 'rotate' ? (
                <p className="muted">
                    Replace the key for {existing?.name}. The old key stops working for new tasks once this saves; a
                    task already running keeps the key it started with.
                </p>
            ) : null}
            {mode.kind === 'create' ? (
                <ScopeField ids={ids} isAdmin={isAdmin} scope={scope} onChange={setScope} />
            ) : null}
            {mode.kind === 'rotate' ? null : <NameInput ids={ids} value={name} onChange={setName} />}
            <ProviderAndKey
                ids={ids}
                mode={mode.kind}
                provider={provider}
                choices={choices}
                subscriptionAllowed={subscriptionAllowed}
                keyValue={key}
                check={check}
                onProvider={setProvider}
                onKey={setKey}
            />
            <EndpointFields ids={ids} mode={mode.kind} provider={provider} baseUrl={baseUrl} onChange={setBaseUrl} />

            <FieldError id={`${ids}-failure`} error={failure} />
            <FormActions
                ids={ids}
                kind={mode.kind}
                reason={reason}
                saving={saving}
                onCancel={onClose}
                onSave={() => void save()}
            />
        </>
    );
}

/** What an edit sends: only what changed, and never a key. */
function editBody(connection: ProviderConnectionMeta, name: string, endpoint: string) {
    return {
        ...(name !== connection.name ? { name } : {}),
        ...(endpoint !== (connection.baseUrl ?? '') ? { baseUrl: endpoint === '' ? null : endpoint } : {}),
    };
}

function savedMessage(kind: ConnectionDialogMode['kind'], name: string): string {
    if (kind === 'rotate') return `Replaced the key for “${name}”.`;
    return kind === 'edit' ? `Saved changes to “${name}”.` : `Added provider connection “${name}”.`;
}

/** A provider with no default endpoint, saved without one. */
const missingEndpoint = (provider: ModelProvider, baseUrl: string) =>
    providerRequiresBaseUrl(provider) && baseUrl.trim() === '';

/** Why Save waits, or null when it may run. */
function connectionSaveReason(input: {
    mode: ConnectionDialogMode['kind'];
    name: string;
    provider: ModelProvider;
    baseUrl: string;
    checked: boolean;
    check: string;
}): string | null {
    if (input.mode !== 'rotate' && input.name.trim() === '') return 'Give the connection a name.';
    if (input.mode !== 'rotate' && missingEndpoint(input.provider, input.baseUrl)) {
        return `Enter the ${input.provider === 'litellm' ? 'proxy' : 'endpoint'} URL to continue.`;
    }
    if (input.mode === 'edit') return null;
    if (input.checked) return null;
    return input.check === 'wait'
        ? 'Checking the key…'
        : input.check === 'bad' || input.check === 'error'
          ? 'Fix the key to continue.'
          : 'Paste a key to continue.';
}
