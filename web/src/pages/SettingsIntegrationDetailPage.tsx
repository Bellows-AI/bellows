import { Link, useParams } from 'react-router-dom';
import { useConnections } from '../api/useConnections.js';
import { KeyValues } from '../components/KeyValues.js';
import { PageHeader } from '../components/PageHeader.js';
import { ProviderMark } from '../components/ProviderMark.js';
import { commitDate } from '../format.js';
import { accessSentence, connectionState, integrationProvider } from '../settings/integration-providers.js';
import { STATE_PILL } from './SettingsIntegrationsPage.js';

const BACK_LABEL = 'Back to Integrations';

function BackLink() {
    return (
        <Link className="integration-back" to="/settings/integrations">
            {BACK_LABEL}
        </Link>
    );
}

/**
 * One connection's page, read-only: found by provider AND connection id in the caller's own list, so a
 * foreign id, a stale link or a provider that does not match the row is "not found", while a failed read is
 * an error, never "not found".
 */
export function SettingsIntegrationDetailPage() {
    const { provider = '', connectionId = '' } = useParams();
    const read = useConnections();
    const connection =
        read.state === 'ok'
            ? read.connections.find((row) => row.id === connectionId && row.provider === provider)
            : undefined;
    const label = integrationProvider(provider)?.label ?? provider;

    return (
        <>
            <PageHeader
                eyebrow="Integrations"
                title={connection ? label : 'Integration'}
                actions={<BackLink />}
                meta={connection ? <ProviderMark provider={connection.provider} /> : undefined}
            />
            {read.state === 'loading' ? <p className="status">Loading integration…</p> : null}
            {read.state === 'error' ? (
                <p className="status error" role="alert">
                    {read.error}
                </p>
            ) : null}
            {read.state === 'ok' && !connection ? (
                <section className="panel">
                    <h2>Integration not found</h2>
                    <p className="muted">It may have been disconnected, or it is not one of yours.</p>
                </section>
            ) : null}
            {connection ? (
                <section className="panel" aria-label={`${label} connection`}>
                    <KeyValues
                        pairs={[
                            ['Site', connection.site],
                            ['Account', connection.account],
                            ['Access', accessSentence(label, connection.access)],
                            ['Connected on', commitDate(connection.createdAt)],
                            ['Status', STATE_PILL[connectionState(connection)].text],
                        ]}
                    />
                </section>
            ) : null}
        </>
    );
}
