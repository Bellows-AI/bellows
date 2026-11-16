import type { IntegrationProvider } from '@factory-ai/core';
import { useId, useState } from 'react';
import type { ConnectionView } from '../api/connections.js';
import { useAuthorizationStart } from '../api/useAuthorizationStart.js';
import { ProviderMark } from '../components/ProviderMark.js';
import { ALLOW_COMMENTS_LABEL, commentsHelp } from '../components/WriteConsentDialog.js';
import { OAuthConnectionActions } from '../panels/OAuthConnectionActions.js';
import { connectionState, consentAuthority } from '../settings/integration-providers.js';

/** What one connection row says: who it acts as and where, or that its grant needs reconnecting. */
const rowText = (connection: ConnectionView): string =>
    connectionState(connection) === 'connected'
        ? `Connected as ${connection.account} · ${connection.site}`
        : `Reconnect needed · ${connection.account} · ${connection.site}`;

/**
 * One OAuth provider of the catalog on the setup step: name, mark and purpose from the catalog entry, never a
 * provider-specific branch. Not connected, it offers the comment-access choice and Connect, which starts the
 * provider's OAuth flow back to `returnTo`; connected (from the connections read, never the callback's query), it
 * names each connection with the shared `OAuthConnectionActions` (Allow adding comments, Reconnect, Disconnect).
 */
export function TrackerCard({
    provider,
    connections,
    returnTo,
    removing,
    onDisconnect,
}: {
    provider: IntegrationProvider;
    /** The member's live rows for this provider. */
    connections: readonly ConnectionView[];
    returnTo: string;
    removing: boolean;
    onDisconnect: (connection: ConnectionView) => Promise<void>;
}) {
    const authorization = useAuthorizationStart(provider.id, returnTo);
    const [comments, setComments] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const ids = useId();
    const busy = authorization.saving || removing;
    const connected = connections.some((row) => connectionState(row) === 'connected');

    const start = async (input: Parameters<typeof authorization.start>[0]) => {
        if (busy) return null;
        setFailure(null);
        const message = await authorization.start(input);
        setFailure(message);
        return message;
    };

    return (
        <li className="setup-tool" aria-label={provider.label} data-connected={connected || undefined}>
            <ProviderMark provider={provider.id} decorative />
            <div className="setup-tool-body">
                <span className="setup-tool-name">{provider.label}</span>
                <span className="setup-tool-purpose">{provider.description}</span>
                {connections.map((row) => (
                    <div className="setup-tool-connection" key={row.id}>
                        <span className="setup-tool-state">{rowText(row)}</span>
                        <OAuthConnectionActions
                            connection={row}
                            authority={consentAuthority(provider)}
                            busy={busy}
                            onStart={start}
                            onDisconnect={onDisconnect}
                        />
                    </div>
                ))}
                {connected ? null : (
                    <>
                        <label className="settings-toggle" htmlFor={`${ids}-comments`}>
                            <input
                                id={`${ids}-comments`}
                                type="checkbox"
                                checked={comments}
                                aria-describedby={`${ids}-comments-help`}
                                onChange={(e) => setComments(e.target.checked)}
                            />
                            {ALLOW_COMMENTS_LABEL}
                        </label>
                        <p className="picker-help" id={`${ids}-comments-help`}>
                            {commentsHelp(provider.label)}
                        </p>
                    </>
                )}
                {failure ? (
                    <p className="status error" role="alert">
                        {failure}
                    </p>
                ) : null}
            </div>
            {connected ? null : (
                <button
                    type="button"
                    aria-disabled={busy || undefined}
                    onClick={() => void start({ access: comments ? 'write' : 'read' })}
                >
                    {authorization.saving ? `Opening ${consentAuthority(provider)}…` : `Connect ${provider.label}`}
                </button>
            )}
        </li>
    );
}
