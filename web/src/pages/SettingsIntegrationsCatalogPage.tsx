import {
    INTEGRATION_CATEGORIES,
    LISTED_PROVIDERS,
    type IntegrationCategory,
    type IntegrationProvider,
} from '@factory-ai/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthorizationStart } from '../api/useAuthorizationStart.js';
import { useConnections, type UseConnections } from '../api/useConnections.js';
import { useIntegrationConfig, type UseIntegrationConfig } from '../api/useIntegrationConfig.js';
import { JiraConnectionDialog } from '../components/JiraConnectionDialog.js';
import { PageHeader } from '../components/PageHeader.js';
import { ProviderMark } from '../components/ProviderMark.js';
import { connectionState } from '../settings/integration-providers.js';
import { STATE_PILL } from './SettingsIntegrationsPage.js';

const ALL = 'All';
const RETURN_TO = '/settings/integrations';

type Config = UseIntegrationConfig & { retry: () => void };

/** What the Jira card says and offers, from two independent reads: the deployment's configuration and the member's rows. */
function JiraState({
    config,
    connections,
    onConnect,
}: {
    config: Config;
    connections: UseConnections;
    onConnect: () => void;
}) {
    const rows =
        connections.state === 'ok' ? connections.connections.filter((c) => connectionState(c) !== 'disconnected') : [];
    const healthy = rows.some((row) => connectionState(row) === 'connected');
    const pill = rows.length > 0 ? STATE_PILL[healthy ? 'connected' : 'needs-reconnect'] : null;
    const label = rows.length > 0 ? 'Connect another' : 'Connect';
    // An answer that names no Jira entry did not answer the question: it reads as a failed check, never "not configured".
    const jira = config.state === 'ok' ? config.configured.jira : undefined;
    const state = config.state === 'ok' && jira === undefined ? 'error' : config.state;
    return (
        <>
            {pill ? <span className={pill.className}>{pill.text}</span> : null}
            {rows.length > 0 ? <Link to={RETURN_TO}>Manage</Link> : null}
            {state === 'loading' ? (
                <button type="button" className="tertiary" disabled>
                    Checking…
                </button>
            ) : null}
            {state === 'error' ? (
                <>
                    <span className="muted">Could not check whether Jira is available</span>
                    <button type="button" className="tertiary" onClick={config.retry}>
                        Retry
                    </button>
                </>
            ) : null}
            {jira === false ? <span className="muted">Not configured on this deployment</span> : null}
            {jira === true ? (
                <button type="button" onClick={onConnect}>
                    {label}
                </button>
            ) : null}
        </>
    );
}

function CardState({
    provider,
    config,
    connections,
    onConnect,
}: {
    provider: IntegrationProvider;
    config: Config;
    connections: UseConnections;
    onConnect: () => void;
}) {
    if (provider.availability === 'organization') {
        return (
            <>
                <span className="pill">Organization</span>
                <Link to="/settings/repos">Manage repositories</Link>
            </>
        );
    }
    return <JiraState config={config} connections={connections} onConnect={onConnect} />;
}

/**
 * Browse integrations: every listed provider (planned ones stay hidden), filed by category, each in the state it is really in. A
 * provider is Connected only on the connections read, connectable only on the configuration read, and a failed
 * read of either is said as such. The filter is local state; there is no search.
 */
export function SettingsIntegrationsCatalogPage({
    providers = LISTED_PROVIDERS,
}: {
    providers?: readonly IntegrationProvider[];
}) {
    const connections = useConnections();
    const config = useIntegrationConfig();
    const [filter, setFilter] = useState<IntegrationCategory | typeof ALL>(ALL);
    const [open, setOpen] = useState(false);
    const { saving, start } = useAuthorizationStart('jira', RETURN_TO);
    const shown = providers.filter((provider) => filter === ALL || provider.category === filter);
    const categories = INTEGRATION_CATEGORIES.filter((category) => providers.some((p) => p.category === category));

    return (
        <>
            <PageHeader
                eyebrow="Integrations"
                title="Browse integrations"
                description="Services your tasks can use."
                actions={
                    <Link className="integration-back" to={RETURN_TO}>
                        Back to Integrations
                    </Link>
                }
            />
            {connections.state === 'error' ? (
                <p className="status error" role="alert">
                    {connections.error}
                </p>
            ) : null}
            <div className="catalog-filters">
                {[ALL, ...categories].map((name) => (
                    <button
                        key={name}
                        type="button"
                        className="catalog-filter"
                        aria-pressed={filter === name}
                        onClick={() => setFilter(name as IntegrationCategory | typeof ALL)}
                    >
                        {name}
                    </button>
                ))}
            </div>
            {shown.length > 0 ? (
                <ul className="integration-list" aria-label="Available integrations">
                    {shown.map((provider) => (
                        <li key={provider.id} className="integration-card catalog-card" aria-label={provider.label}>
                            <ProviderMark provider={provider.id} />
                            <span className="integration-card-text">
                                <span className="integration-card-title">{provider.label}</span>
                                <span className="integration-card-site">{provider.description}</span>
                                <span className="integration-card-account">{provider.category}</span>
                            </span>
                            <span className="catalog-card-state">
                                <CardState
                                    provider={provider}
                                    config={config}
                                    connections={connections}
                                    onConnect={() => setOpen(true)}
                                />
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}
            <JiraConnectionDialog open={open} saving={saving} onClose={() => setOpen(false)} onStart={start} />
        </>
    );
}
