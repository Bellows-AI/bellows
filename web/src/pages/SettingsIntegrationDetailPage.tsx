import { integrationProvider } from '@factory-ai/core';
import { useState, type ComponentType } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deleteConnection, type ConnectionView, type StartAuthorizationInput } from '../api/connections.js';
import { useAuthorizationStart } from '../api/useAuthorizationStart.js';
import { useConnections } from '../api/useConnections.js';
import { IntegrationNoticeBanner } from '../components/IntegrationNoticeBanner.js';
import { KeyValues } from '../components/KeyValues.js';
import { PageHeader } from '../components/PageHeader.js';
import { ProviderMark } from '../components/ProviderMark.js';
import { commitDate } from '../format.js';
import { JiraConnectionActions, type ConnectionActionsProps } from '../panels/JiraConnectionActions.js';
import { accessSentence, connectionState } from '../settings/integration-providers.js';
import { DISCONNECTED_STATE, useIntegrationNotice } from '../settings/useIntegrationNotice.js';
import { integrationPath, STATE_PILL } from './SettingsIntegrationsPage.js';

const OVERVIEW = '/settings/integrations';
const ALREADY_DISCONNECTED = 'That connection was already disconnected.';

/** The action set each provider mounts on its page; a provider with none renders none. */
const PROVIDER_ACTIONS: Record<string, ComponentType<ConnectionActionsProps>> = { jira: JiraConnectionActions };

const BACK_LABEL = 'Back to Integrations';

function BackLink() {
    return (
        <Link className="integration-back" to="/settings/integrations">
            {BACK_LABEL}
        </Link>
    );
}

/**
 * The page's writes behind one in-flight guard. A start leaves `busy` set on success (the browser is leaving); a
 * refusal and every disconnect outcome but success read the list again. Only the route's 204 is a disconnect.
 */
function useLifecycle(provider: string, connectionId: string, reload: () => Promise<void>, clearNotice: () => void) {
    const navigate = useNavigate();
    const authorization = useAuthorizationStart(provider, integrationPath(provider, connectionId));
    const [removing, setRemoving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const start = async (input: StartAuthorizationInput) => {
        setError(null);
        clearNotice();
        const message = await authorization.start(input);
        if (message !== null) {
            setError(message);
            await reload();
        }
        return message;
    };

    const disconnect = async (connection: ConnectionView) => {
        setError(null);
        clearNotice();
        setRemoving(true);
        const result = await deleteConnection(connection.id);
        if (result.kind === 'disconnected') {
            await navigate(OVERVIEW, { replace: true, state: { [DISCONNECTED_STATE]: connection.site } });
            return;
        }
        setError(result.kind === 'gone' ? ALREADY_DISCONNECTED : result.error);
        await reload();
        setRemoving(false);
    };

    return { busy: authorization.saving || removing, error, start, disconnect };
}

/**
 * One connection's page: the facts and the provider's actions. Found by provider AND connection id in the caller's own
 * list, read again on every visit and after every action (router state is never trusted), so a foreign id, a stale
 * link or a provider that does not match the row is "not found", while a failed read is an error, never "not found".
 */
export function SettingsIntegrationDetailPage() {
    const { provider = '', connectionId = '' } = useParams();
    const read = useConnections();
    const { notice, clear } = useIntegrationNotice();
    const lifecycle = useLifecycle(provider, connectionId, read.reload, clear);
    const connection =
        read.state === 'ok'
            ? read.connections.find((row) => row.id === connectionId && row.provider === provider)
            : undefined;
    const label = integrationProvider(provider)?.label ?? provider;
    const Actions = PROVIDER_ACTIONS[provider];

    return (
        <>
            <PageHeader
                eyebrow="Integrations"
                title={connection ? label : 'Integration'}
                description={connection ? <ProviderMark provider={connection.provider} /> : undefined}
                actions={<BackLink />}
            />
            {notice ? <IntegrationNoticeBanner notice={notice} /> : null}
            {lifecycle.error ? (
                <p className="status error" role="alert">
                    {lifecycle.error}
                </p>
            ) : null}
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
                            ['Site', <span className="mono">{connection.site}</span>],
                            ['Account', <span className="mono">{connection.account}</span>],
                            ['Access', accessSentence(label, connection.access)],
                            ['Connected on', commitDate(connection.createdAt)],
                            ['Status', STATE_PILL[connectionState(connection)].text],
                        ]}
                    />
                    {Actions ? (
                        <div className="integration-actions">
                            <Actions
                                connection={connection}
                                busy={lifecycle.busy}
                                onStart={lifecycle.start}
                                onDisconnect={lifecycle.disconnect}
                            />
                        </div>
                    ) : null}
                </section>
            ) : null}
        </>
    );
}
