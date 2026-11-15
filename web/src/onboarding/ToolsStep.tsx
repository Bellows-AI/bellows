import { canConnect, INTEGRATION_CATALOG, type IntegrationProvider } from '@factory-ai/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteConnection, type ConnectionView } from '../api/connections.js';
import { useConnections } from '../api/useConnections.js';
import { useIntegrationConfig } from '../api/useIntegrationConfig.js';
import { useSession } from '../api/useSession.js';
import { IntegrationNoticeBanner } from '../components/IntegrationNoticeBanner.js';
import { ProviderMark } from '../components/ProviderMark.js';
import { StateNote } from '../components/StateNote.js';
import { connectionState } from '../settings/integration-providers.js';
import { useIntegrationNotice } from '../settings/useIntegrationNotice.js';
import { SetupActions } from './SetupActions.js';
import { setupPath } from './steps.js';
import { TrackerCard } from './TrackerCard.js';
import { useSetupWalk } from './useSetupWalk.js';

const READ_FAILED = 'Could not check which issue trackers this deployment connects.';

/**
 * The issue-tracker step's body: GitHub, always connected through the organization's App, then one `TrackerCard` per
 * `oauth` provider of `catalog` this deployment configured (`GET /api/integrations`), the callback's notice, the
 * footer and the actions. Both reads must answer before a card list is drawn: a failed read is an alert with Retry,
 * never "only GitHub". Skip for now becomes Continue once a card is connected, and Continue records the step done.
 */
export function ToolsStep({ catalog = INTEGRATION_CATALOG }: { catalog?: readonly IntegrationProvider[] }) {
    const walk = useSetupWalk();
    const { session } = useSession();
    const config = useIntegrationConfig();
    const read = useConnections();
    const { notice, clear } = useIntegrationNotice(catalog);
    const [removing, setRemoving] = useState(false);
    const [disconnectError, setDisconnectError] = useState<string | null>(null);
    const here = setupPath('tools', walk.returnTo);

    const failed = config.state === 'error' || read.state === 'error';
    const ready = config.state === 'ok' && read.state === 'ok';
    const providers =
        config.state === 'ok' ? catalog.filter((entry) => canConnect(entry) && config.configured[entry.id]) : [];
    const rowsOf = (provider: string): ConnectionView[] =>
        read.state === 'ok'
            ? read.connections.filter((row) => row.provider === provider && connectionState(row) !== 'disconnected')
            : [];
    const connected =
        ready && providers.some((entry) => rowsOf(entry.id).some((row) => connectionState(row) === 'connected'));

    const retry = () => {
        if (config.state === 'error') config.retry();
        if (read.state === 'error') void read.reload();
    };
    const disconnect = async (connection: ConnectionView) => {
        clear();
        setDisconnectError(null);
        setRemoving(true);
        const result = await deleteConnection(connection.id);
        if (result.kind === 'failed') setDisconnectError(result.error);
        await read.reload();
        setRemoving(false);
    };

    return (
        <>
            {notice ? <IntegrationNoticeBanner notice={notice} /> : null}
            {disconnectError ? <StateNote state="error">{disconnectError}</StateNote> : null}
            <ul className="setup-tools" aria-label="Issue trackers">
                <li className="setup-tool" aria-label="GitHub" data-connected>
                    <ProviderMark provider="github" decorative />
                    <div className="setup-tool-body">
                        <span className="setup-tool-name">GitHub</span>
                        <span className="setup-tool-purpose">Repositories, issues and pull requests.</span>
                        <span className="setup-tool-state">
                            {session ? `Connected · ${session.organization.name}` : 'Connected'}
                        </span>
                    </div>
                </li>
                {ready
                    ? providers.map((provider) => (
                          <TrackerCard
                              key={provider.id}
                              provider={provider}
                              connections={rowsOf(provider.id)}
                              returnTo={here}
                              removing={removing}
                              onDisconnect={disconnect}
                          />
                      ))
                    : null}
            </ul>
            {failed ? (
                <div className="setup-tools-retry">
                    <StateNote state="error">{READ_FAILED}</StateNote>
                    <button type="button" className="tertiary" onClick={retry}>
                        Retry
                    </button>
                </div>
            ) : null}
            {!(failed || ready) ? <StateNote state="loading">Checking issue trackers…</StateNote> : null}
            {ready ? (
                <p className="setup-tools-more">
                    More in <Link to="/settings/integrations">Settings → Integrations</Link>
                </p>
            ) : null}
            <SetupActions
                back={
                    <Link className="setup-back" to={setupPath('model', walk.returnTo)}>
                        Back
                    </Link>
                }
                primary={connected ? 'Continue' : 'Skip for now'}
                busy={walk.busy}
                error={walk.error}
                onPrimary={() => (connected ? walk.done('tools') : walk.skip('tools'))}
            />
        </>
    );
}
