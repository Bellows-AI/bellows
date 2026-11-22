import { canConnect, integrationProvider, LISTED_PROVIDERS } from '@factory-ai/core';
import { Link } from 'react-router-dom';
import { type ForgeGrantView, useForgeGrants } from '../api/forgeGrants.js';
import { useConnections } from '../api/useConnections.js';
import { IntegrationNoticeBanner } from '../components/IntegrationNoticeBanner.js';
import { PageHeader } from '../components/PageHeader.js';
import { ProviderMark } from '../components/ProviderMark.js';
import { connectionState, type ConnectionState } from '../settings/integration-providers.js';
import { useIntegrationNotice } from '../settings/useIntegrationNotice.js';
import { StateNote } from '../components/StateNote.js';

/** What a state is called, and the pill it wears: Connected is the ok lamp, Needs reconnect asks for the member. */
export const STATE_PILL: Record<ConnectionState, { text: string; className: string }> = {
    connected: { text: 'Connected', className: 'pill pill-ok' },
    'needs-reconnect': { text: 'Needs reconnect', className: 'pill pill-accent' },
    disconnected: { text: 'Disconnected', className: 'pill' },
};

/** `/settings/integrations/<provider>/<connection id>`: the one address of a connection's page. */
export const integrationPath = (provider: string, connectionId: string): string =>
    `/settings/integrations/${encodeURIComponent(provider)}/${encodeURIComponent(connectionId)}`;

/** The GitHub card's words by standing: what it says under the title, the pill, and the link that fixes it. */
const GITHUB_CARD: Record<
    ForgeGrantView['standing'],
    { sentence: (login: string) => string; pill: { text: string; className: string }; action: string | null }
> = {
    live: { sentence: (login) => `Connected as ${login}`, pill: STATE_PILL.connected, action: null },
    broken: {
        sentence: (login) => `Connected as ${login}, but GitHub needs you to sign in again.`,
        pill: STATE_PILL['needs-reconnect'],
        action: 'Reconnect GitHub',
    },
    missing: {
        sentence: () => 'Sign in with GitHub to let tasks act as you.',
        pill: { text: 'Not connected', className: 'pill' },
        action: 'Connect GitHub',
    },
};

/** The member's GitHub grant, in the card pattern of the connections: the sign-in round trip is its reconnect. */
function GitHubCard({ grant }: { grant: ForgeGrantView }) {
    const words = GITHUB_CARD[grant.standing];
    return (
        <li className="integration-card" aria-label="GitHub connection">
            <ProviderMark provider="github" />
            <span className="integration-card-text">
                <span className="integration-card-title">GitHub</span>
                <span className="integration-card-site">{words.sentence(grant.login)}</span>
                {words.action ? <a href={grant.connectPath}>{words.action}</a> : null}
            </span>
            <span className={words.pill.className}>{words.pill.text}</span>
        </li>
    );
}

const BROWSE_PATH = '/settings/integrations/available';
const PREVIEW_LIMIT = 4;

/**
 * Settings → Integrations: the member's own connections, one link card per connection, read from
 * `GET /api/connections` and nothing else, so a provider appears here only when the backend holds a row for it.
 * Loading, failure and empty are three different states; a failed read never reads as "nothing connected".
 */
export function SettingsIntegrationsPage() {
    const read = useConnections();
    const forge = useForgeGrants();
    const github = forge.state === 'ok' ? forge.grants.find((grant) => grant.forge === 'github') : undefined;
    const { notice } = useIntegrationNotice();
    const preview = LISTED_PROVIDERS.filter((provider) => !canConnect(provider)).slice(0, PREVIEW_LIMIT);
    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Integrations"
                description="The services your tasks can use as you."
                actions={<Link to={BROWSE_PATH}>Browse integrations</Link>}
            />
            {notice ? <IntegrationNoticeBanner notice={notice} /> : null}
            {read.state === 'loading' ? <StateNote state="loading">Loading integrations…</StateNote> : null}
            {read.state === 'error' ? (
                <p className="status error" role="alert">
                    {read.error}
                </p>
            ) : null}
            {forge.state === 'error' ? (
                <p className="status error" role="alert">
                    {forge.error}
                </p>
            ) : null}
            {github ? (
                <ul className="integration-list" aria-label="GitHub">
                    <GitHubCard grant={github} />
                </ul>
            ) : null}
            {read.state === 'ok' && read.connections.length === 0 && github?.standing !== 'live' ? (
                <section className="panel integration-empty">
                    <p className="muted">No integrations connected yet.</p>
                    <Link to={BROWSE_PATH}>Browse integrations</Link>
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
            <section className="integration-preview" aria-labelledby="integration-preview-title">
                <h2 id="integration-preview-title">Available</h2>
                <ul className="integration-list" aria-label="Available integrations">
                    {preview.map((provider) => (
                        <li key={provider.id} className="integration-card" aria-label={provider.label}>
                            <ProviderMark provider={provider.id} />
                            <span className="integration-card-text">
                                <span className="integration-card-title">{provider.label}</span>
                                <span className="integration-card-site">{provider.description}</span>
                            </span>
                            <span className="pill">Organization</span>
                        </li>
                    ))}
                </ul>
                <Link to={BROWSE_PATH}>Browse all</Link>
            </section>
        </>
    );
}
