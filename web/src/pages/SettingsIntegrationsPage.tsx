import { Link } from 'react-router-dom';
import { useConnections } from '../api/useConnections.js';
import { PageHeader } from '../components/PageHeader.js';
import { ProviderMark } from '../components/ProviderMark.js';
import { connectionState, integrationProvider, type ConnectionState } from '../settings/integration-providers.js';

/** What a state is called, and the pill it wears: Connected is the ok lamp, Needs reconnect asks for the member. */
export const STATE_PILL: Record<ConnectionState, { text: string; className: string }> = {
    connected: { text: 'Connected', className: 'pill pill-ok' },
    'needs-reconnect': { text: 'Needs reconnect', className: 'pill pill-accent' },
    disconnected: { text: 'Disconnected', className: 'pill' },
};

/** `/settings/integrations/<provider>/<connection id>`: the one address of a connection's page. */
export const integrationPath = (provider: string, connectionId: string): string =>
    `/settings/integrations/${encodeURIComponent(provider)}/${encodeURIComponent(connectionId)}`;

/**
 * Settings → Integrations: the member's own connections, one link card per connection, read from
 * `GET /api/connections` and nothing else, so a provider appears here only when the backend holds a row for it.
 * Loading, failure and empty are three different states; a failed read never reads as "nothing connected".
 */
export function SettingsIntegrationsPage() {
    const read = useConnections();
    return (
        <>
            <PageHeader eyebrow="Settings" title="Integrations" description="The services your tasks can use as you." />
            {read.state === 'loading' ? <p className="status">Loading integrations…</p> : null}
            {read.state === 'error' ? (
                <p className="status error" role="alert">
                    {read.error}
                </p>
            ) : null}
            {read.state === 'ok' && read.connections.length === 0 ? (
                <section className="panel integration-empty">
                    <p className="muted">No integrations connected yet.</p>
                    <Link to="/settings/workspace">Connect Jira in Workspace</Link>
                </section>
            ) : null}
            {read.state === 'ok' && read.connections.length > 0 ? (
                <ul className="integration-list" aria-label="Connected integrations">
                    {read.connections.map((connection) => {
                        const label = integrationProvider(connection.provider)?.label ?? connection.provider;
                        const pill = STATE_PILL[connectionState(connection)];
                        return (
                            <li key={connection.id}>
                                <Link
                                    className="integration-card"
                                    to={integrationPath(connection.provider, connection.id)}
                                >
                                    <ProviderMark provider={connection.provider} />
                                    <span className="integration-card-text">
                                        <span className="integration-card-title">{label}</span>
                                        <span className="integration-card-site">{connection.site}</span>
                                        <span className="integration-card-account">{connection.account}</span>
                                    </span>
                                    <span className={pill.className}>{pill.text}</span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </>
    );
}
