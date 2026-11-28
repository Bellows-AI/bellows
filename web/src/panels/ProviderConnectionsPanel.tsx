import { ADMIN_ROLE } from '@factory-ai/core';
import { type ReactNode, useState } from 'react';
import {
    type ConnectionModels as ModelsRead,
    type ConnectionRemoval,
    type ProviderConnectionMeta,
    removeProviderConnection,
} from '../api/providerConnections.js';
import type { Session } from '../api/useSession.js';
import { connectionsChanged, useConnectionModels, useProviderConnections } from '../api/useProviderConnections.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import { type ConnectionDialogMode, ProviderConnectionDialog } from '../components/ProviderConnectionDialog.js';
import { type RowAction, RowActions } from '../components/RowActions.js';
import { ScrollRegion } from '../components/ScrollRegion.js';
import { StateNote } from '../components/StateNote.js';
import { PROVIDER_META } from '../providers/providers.js';

/**
 * Settings → Model → Provider connections: the named provider keys executors can share. An organization connection is
 * an admin's to change and every member's to use; a personal one is the member's own. A key is never shown — a row
 * says whether one is stored — and rotation is its own action, so a rename never resends it. Removal is refused while an
 * executor selects the connection, naming the executors the member may see. The copy follows the organization
 * executors' panel: the sentence about who manages the rows leads.
 */

const SCOPE_LABEL = { org: 'Organization', personal: 'Personal' } as const;

/** The removal refusal's sentence: who still selects the connection, only as far as the caller may see them. */
export function inUseMessage(connection: string, removal: Extract<ConnectionRemoval, { inUse: true }>): string {
    const names = removal.executors.map(
        (executor) => `${executor.name} (${SCOPE_LABEL[executor.scope].toLowerCase()})`
    );
    const visible = names.length > 0 ? ` by ${names.join(', ')}` : '';
    const hidden = removal.otherReferences
        ? ' Executors you cannot see also use it, so ask the owners to switch them first.'
        : '';
    return `“${connection}” is still used${visible}. Switch those executors to another connection, then remove it.${hidden}`;
}

export function ProviderConnectionsPanel({ session }: { session: Session | null }) {
    const isAdmin = session?.role === ADMIN_ROLE;
    const list = useProviderConnections();
    const [dialog, setDialog] = useState<ConnectionDialogMode | null>(null);
    const [viewing, setViewing] = useState<string | null>(null);
    const [removing, setRemoving] = useState<ProviderConnectionMeta | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [saved, setSaved] = useState('');

    const connections = list.connections;
    const canManage = (row: ProviderConnectionMeta) => row.scope === 'personal' || isAdmin;

    const actions = (row: ProviderConnectionMeta): RowAction[] => [
        {
            label: viewing === row.id ? 'Hide models' : 'Show models',
            onSelect: () => setViewing(viewing === row.id ? null : row.id),
        },
        ...(canManage(row)
            ? [
                  { label: 'Replace key', onSelect: () => setDialog({ kind: 'rotate', connection: row }) },
                  { label: 'Remove', onSelect: () => confirmRemoval(row), danger: true },
              ]
            : []),
    ];

    const confirmRemoval = (row: ProviderConnectionMeta) => {
        setProblem(null);
        setRemoving(row);
    };

    const remove = async () => {
        if (!removing) return;
        setBusy(true);
        const result = await removeProviderConnection(removing.id);
        setBusy(false);
        const name = removing.name;
        setRemoving(null);
        if (result.ok) {
            if (viewing === removing.id) setViewing(null);
            connectionsChanged();
            setSaved(`Removed “${name}”.`);
        } else {
            setProblem('inUse' in result ? inUseMessage(name, result) : result.error);
        }
    };

    const viewed = connections?.find((row) => row.id === viewing) ?? null;

    return (
        <section className="panel" aria-labelledby="provider-connections-heading">
            <div className="panel-head">
                <h2 id="provider-connections-heading">
                    Provider connections
                    {connections ? <span className="count">{connections.length}</span> : null}
                </h2>
                <button
                    type="button"
                    className="provider-connection-add"
                    onClick={() => {
                        setSaved('');
                        setDialog({ kind: 'create' });
                    }}
                >
                    <Icon name="plus" />
                    Add connection
                </button>
            </div>
            <p className="muted">
                {isAdmin
                    ? 'As an admin you manage the organization’s connections; your personal ones are yours alone. Executors pick a connection by name, and several can share one.'
                    : 'Organization connections are managed by your admins and available to every executor; personal ones are yours alone. Executors pick a connection by name, and several can share one.'}{' '}
                Keys are stored in the secret store and never shown again.
            </p>
            <p className="muted" role="status">
                {saved}
            </p>
            {problem ? <StateNote state="error">{problem}</StateNote> : null}

            <ConnectionsRead error={list.error} rows={connections} onRetry={list.refresh}>
                {(rows) => (
                    <ScrollRegion className="table-wrap" aria-label="Connection list">
                        <table className="data data-compact table-cards">
                            <thead>
                                <tr>
                                    <th scope="col">Name</th>
                                    <th scope="col">Provider</th>
                                    <th scope="col">Scope</th>
                                    <th scope="col">Endpoint</th>
                                    <th scope="col">
                                        <span className="muted">Actions</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row) => (
                                    <tr key={row.id}>
                                        <td data-label="Name">{row.name}</td>
                                        <td data-label="Provider">
                                            <span className="pill">{PROVIDER_META[row.provider].label}</span>
                                        </td>
                                        <td data-label="Scope">{SCOPE_LABEL[row.scope]}</td>
                                        <td data-label="Endpoint" className="muted">
                                            {row.baseUrl ?? 'Default'}
                                        </td>
                                        <td data-label="Actions">
                                            <RowActions
                                                rowName={row.name}
                                                primary={
                                                    canManage(row)
                                                        ? {
                                                              label: 'Edit',
                                                              onSelect: () =>
                                                                  setDialog({ kind: 'edit', connection: row }),
                                                          }
                                                        : null
                                                }
                                                actions={actions(row)}
                                                disabled={busy}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </ScrollRegion>
                )}
            </ConnectionsRead>
            {viewed ? <ConnectionModels connection={viewed} /> : null}

            <ProviderConnectionDialog
                mode={dialog}
                open={dialog !== null}
                isAdmin={isAdmin}
                subscriptionAllowed={session?.subscriptionToken === true}
                onClose={() => setDialog(null)}
                onSaved={setSaved}
            />
            <ConfirmDialog
                open={removing !== null}
                busy={busy}
                title="Remove this connection?"
                confirmClassName="chat-remove"
                confirmText={busy ? 'Removing…' : 'Remove connection'}
                onClose={() => setRemoving(null)}
                onConfirm={() => void remove()}
            >
                <p>
                    {removing
                        ? `“${removing.name}” and its stored key are deleted. It is refused while an executor still uses it.`
                        : ''}
                </p>
            </ConfirmDialog>
        </section>
    );
}

/**
 * One connection's live models, read through the board with its stored key. Four answers, never conflated: a catalog,
 * a catalog with nothing in it, a provider that has none to list, and a read that failed.
 */
function ConnectionModels({ connection }: { connection: ProviderConnectionMeta }) {
    const { models, retry } = useConnectionModels(connection.id);
    const heading = `Models from ${connection.name}`;
    return (
        <section className="provider-connection-models-view" aria-label={heading}>
            <h3>{heading}</h3>
            <ModelsBody connection={connection} models={models} onRetry={retry} />
        </section>
    );
}

function ModelsBody({
    connection,
    models,
    onRetry,
}: {
    connection: ProviderConnectionMeta;
    models: ModelsRead | null;
    onRetry: () => void;
}): ReactNode {
    if (models === null || models.state === 'loading') {
        return <StateNote state="loading">Loading the models {connection.name} offers…</StateNote>;
    }
    if (models.state === 'failed') {
        return (
            <>
                <StateNote state="error">
                    Could not list the models {connection.name} offers: {models.message}
                </StateNote>
                <button type="button" className="tertiary" onClick={onRetry}>
                    Try again
                </button>
            </>
        );
    }
    if (models.state === 'unsupported') {
        return (
            <p className="muted">
                {PROVIDER_META[connection.provider].label} does not list its models, so there is nothing to show here.
                Type any model name it serves when you pick one for an executor.
            </p>
        );
    }
    if (models.models.length === 0) {
        return (
            <p className="muted">
                {connection.name} answered, and it lists no models. Type the name of the model to use when you pick one
                for an executor.
            </p>
        );
    }
    return (
        <>
            <p className="muted">
                {models.models.length} {models.models.length === 1 ? 'model' : 'models'} available.
            </p>
            <ul className="provider-connection-models">
                {models.models.map((model) => (
                    <li key={model} className="mono">
                        {model}
                    </li>
                ))}
            </ul>
        </>
    );
}

/**
 * The list read's verdicts, in one place. A failed read is said whatever rows are held — they are the last true answer,
 * never a verdict — with its Retry; "none yet" is said only while the latest read succeeded.
 */
function ConnectionsRead({
    error,
    rows,
    onRetry,
    children,
}: {
    error: string | null;
    rows: ProviderConnectionMeta[] | null;
    onRetry: () => void;
    children: (rows: ProviderConnectionMeta[]) => ReactNode;
}) {
    let body: ReactNode = null;
    if (rows === null) body = error ? null : <StateNote state="loading">Loading provider connections…</StateNote>;
    else if (rows.length > 0) body = children(rows);
    else if (!error) {
        body = (
            <p className="muted">
                No provider connections yet. Add one to share a key between executors without pasting it into each.
            </p>
        );
    }
    return (
        <>
            {error ? (
                <>
                    <StateNote state="error">{error}</StateNote>
                    <button type="button" className="tertiary" onClick={onRetry}>
                        Retry
                    </button>
                </>
            ) : null}
            {body}
        </>
    );
}
