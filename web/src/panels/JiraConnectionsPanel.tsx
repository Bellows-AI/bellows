import { useState } from 'react';
import type { ConnectionView, StartAuthorizationInput } from '../api/connections.js';
import { ALLOW_COMMENTS_LABEL, JiraConnectionDialog } from '../components/JiraConnectionDialog.js';
import { JiraWriteConsentDialog } from '../components/JiraWriteConsentDialog.js';
import { commitDate } from '../format.js';

/**
 * The member's own Jira connections: one row per connected site with its Atlassian account and
 * access, Reconnect, Allow adding comments (a read row only) and Disconnect. Presentational, like
 * `MembersPanel` — the section owns the list and the writes; Connect opens `JiraConnectionDialog`.
 * Every start is a reconnect or a connect through `onStart`, which resolves to a refusal or null
 * once the browser is leaving for Atlassian. No row has a place to show a credential.
 */

export { ALLOW_COMMENTS_LABEL };
export const CONNECT_JIRA_LABEL = 'Connect Jira';
export const NO_CONNECTIONS_NOTE = 'No Jira connections yet.';

const RESULT_SENTENCE: Record<string, string> = {
    connected: 'Jira connected.',
    denied: 'Atlassian consent was denied; nothing was connected.',
    'identity-mismatch':
        'That Atlassian account is not the account this connection was made with. Reconnect with the original account, or disconnect and connect again.',
    'site-mismatch': 'The Atlassian account cannot reach that site, so nothing was connected.',
};

/** The sentence for the `?integration=…&result=…` the callback redirected back with, or null when there is none to show. */
export const integrationNotice = (integration: string | null, result: string | null): string | null => {
    if (integration !== 'jira' || !result) return null;
    return RESULT_SENTENCE[result] ?? `Jira connection failed (${result}).`;
};

export function JiraConnectionsPanel({
    connections,
    saving,
    notice,
    onStart,
    onDisconnect,
}: {
    /** The caller's rows, newest first. */
    connections: readonly ConnectionView[];
    saving: boolean;
    /** The callback's result sentence, when the page was returned to. */
    notice: string | null;
    /** Resolves to the refusal message, or null when the browser is on its way to the consent screen. */
    onStart: (input: StartAuthorizationInput) => Promise<string | null>;
    onDisconnect: (connection: ConnectionView) => void;
}) {
    const [connecting, setConnecting] = useState(false);
    const [granting, setGranting] = useState<ConnectionView | null>(null);
    const [failure, setFailure] = useState<string | null>(null);

    const reconnect = async (input: StartAuthorizationInput) => {
        setFailure(null);
        const message = await onStart(input);
        setFailure(message);
        if (message !== null) setGranting(null);
    };

    return (
        <section className="panel" aria-label="Jira connections">
            <div className="panel-head">
                <h2>Jira connections</h2>
                <button
                    type="button"
                    className="primary jira-connection-add"
                    disabled={saving}
                    onClick={() => setConnecting(true)}
                >
                    {CONNECT_JIRA_LABEL}
                </button>
            </div>
            <p className="muted">
                Your own Atlassian accounts. A lone connection is bound to your tasks by default; with several, a task
                names the one it uses. Tasks can only add comments through a connection that allows it.
            </p>
            {notice ? (
                <p className="status" role="status">
                    {notice}
                </p>
            ) : null}
            {failure ? (
                <p className="status" role="alert">
                    {failure}
                </p>
            ) : null}
            {connections.length === 0 ? (
                <p className="muted">{NO_CONNECTIONS_NOTE}</p>
            ) : (
                <section className="table-wrap">
                    <table className="data table-cards">
                        <thead>
                            <tr>
                                <th scope="col">Site</th>
                                <th scope="col">Account</th>
                                <th scope="col">Access</th>
                                <th scope="col">Connected</th>
                                <th scope="col">
                                    <span className="visually-hidden">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {connections.map((connection) => (
                                <tr key={connection.id}>
                                    <td data-label="Site">{connection.site}</td>
                                    <td data-label="Account">{connection.account}</td>
                                    <td data-label="Access">{connection.access}</td>
                                    <td data-label="Connected">{commitDate(connection.createdAt)}</td>
                                    <td>
                                        <div className="row-actions">
                                            <button
                                                type="button"
                                                disabled={saving}
                                                aria-label={`Reconnect ${connection.site} for ${connection.account}`}
                                                onClick={() =>
                                                    void reconnect({
                                                        connectionId: connection.id,
                                                        access: connection.access,
                                                    })
                                                }
                                            >
                                                Reconnect
                                            </button>
                                            {connection.access === 'read' ? (
                                                <button
                                                    type="button"
                                                    disabled={saving}
                                                    aria-label={`${ALLOW_COMMENTS_LABEL} on ${connection.site} for ${connection.account}`}
                                                    onClick={() => setGranting(connection)}
                                                >
                                                    {ALLOW_COMMENTS_LABEL}
                                                </button>
                                            ) : null}
                                            <button
                                                type="button"
                                                disabled={saving}
                                                aria-label={`Disconnect ${connection.site} for ${connection.account}`}
                                                onClick={() => onDisconnect(connection)}
                                            >
                                                Disconnect
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
            <JiraConnectionDialog
                open={connecting}
                saving={saving}
                onClose={() => setConnecting(false)}
                onStart={onStart}
            />
            <JiraWriteConsentDialog
                connection={granting}
                busy={saving}
                onClose={() => setGranting(null)}
                onConfirm={() => {
                    if (granting) void reconnect({ connectionId: granting.id, access: 'write' });
                }}
            />
        </section>
    );
}
