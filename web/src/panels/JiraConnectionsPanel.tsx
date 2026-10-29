import { useState } from 'react';
import type { ConnectionView, StartAuthorizationInput } from '../api/connections.js';
import { ALLOW_COMMENTS_LABEL, JiraConnectionDialog } from '../components/JiraConnectionDialog.js';
import { Icon } from '../components/Icon.js';
import { JiraWriteConsentDialog } from '../components/JiraWriteConsentDialog.js';
import { RowActions, type RowAction } from '../components/RowActions.js';
import { commitDate } from '../format.js';

/**
 * The member's own Jira connections: one row per connected site with its Atlassian account and
 * access, and its `RowActions`: Allow adding comments (a read row only) or Reconnect inline, the rest
 * in the overflow menu with Disconnect last. Presentational, like
 * `MembersPanel` — the section owns the list and the writes; Connect opens `JiraConnectionDialog`.
 * Every start is a reconnect or a connect through `onStart`, which resolves to a refusal or null
 * once the browser is leaving for Atlassian. No row has a place to show a credential.
 */

export { ALLOW_COMMENTS_LABEL };
export const CONNECT_JIRA_LABEL = 'Connect Jira';
export const NO_CONNECTIONS_NOTE = 'No Jira connections yet.';

/** A callback result: the sentence and the banner it is shown in (`banner-info` success, `banner-warn` declined, `banner-bad` failed). */
export interface IntegrationNotice {
    message: string;
    tone: 'info' | 'warn' | 'bad';
}

const RESULT_NOTICE: Record<string, IntegrationNotice> = {
    connected: { message: 'Jira connected.', tone: 'info' },
    denied: { message: 'Atlassian consent was denied; nothing was connected.', tone: 'warn' },
    'identity-mismatch': {
        message:
            'That Atlassian account is not the account this connection was made with. Reconnect with the original account, or disconnect and connect again.',
        tone: 'bad',
    },
    'site-mismatch': {
        message: 'The Atlassian account cannot reach that site, so nothing was connected.',
        tone: 'bad',
    },
};

/** The notice for the `?integration=…&result=…` the callback redirected back with, or null when there is none to show. */
export const integrationNotice = (integration: string | null, result: string | null): IntegrationNotice | null => {
    if (integration !== 'jira' || !result) return null;
    return RESULT_NOTICE[result] ?? { message: `Jira connection failed (${result}).`, tone: 'bad' };
};

const NOTICE_ICON = { info: 'info', warn: 'alert-triangle', bad: 'alert-circle' } as const;

export function JiraConnectionsPanel({
    connections,
    saving,
    notice,
    error,
    onStart,
    onDisconnect,
}: {
    /** The caller's rows, newest first. */
    connections: readonly ConnectionView[];
    saving: boolean;
    /** The callback's result sentence, when the page was returned to. */
    notice: IntegrationNotice | null;
    /** A list or disconnect failure, announced here beside the rows it concerns. */
    error: string | null;
    /** Resolves to the refusal message, or null when the browser is on its way to the consent screen. */
    onStart: (input: StartAuthorizationInput) => Promise<string | null>;
    onDisconnect: (connection: ConnectionView) => void;
}) {
    const [connecting, setConnecting] = useState(false);
    const [granting, setGranting] = useState<ConnectionView | null>(null);
    const [failure, setFailure] = useState<string | null>(null);

    const rowActions = (connection: ConnectionView) => {
        const reconnectNow = () => void reconnect({ connectionId: connection.id, access: connection.access });
        const allow = { label: ALLOW_COMMENTS_LABEL, onSelect: () => setGranting(connection) };
        const reconnectAction: RowAction = { label: 'Reconnect', onSelect: reconnectNow };
        const disconnect: RowAction = { label: 'Disconnect', onSelect: () => onDisconnect(connection), danger: true };
        // One inline action: Allow adding comments leads a read row (its Reconnect moves into the menu).
        return connection.access === 'read'
            ? { primary: allow, actions: [reconnectAction, disconnect] }
            : { primary: reconnectAction, actions: [disconnect] };
    };

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
                <div className={`banner-${notice.tone}`} role={notice.tone === 'info' ? undefined : 'alert'}>
                    <Icon name={NOTICE_ICON[notice.tone]} size={24} />
                    <p>{notice.message}</p>
                </div>
            ) : null}
            {failure || error ? (
                <p className="status" role="alert">
                    {failure ?? error}
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
                                    <td data-label="Actions">
                                        <RowActions
                                            rowName={`${connection.site} for ${connection.account}`}
                                            {...rowActions(connection)}
                                            disabled={saving}
                                        />
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
