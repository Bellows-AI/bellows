import { useState } from 'react';
import type { ConnectionView, StartAuthorizationInput } from '../api/connections.js';
import { ConnectionDisconnectDialog } from '../components/ConnectionDisconnectDialog.js';
import { ALLOW_COMMENTS_LABEL } from '../components/JiraConnectionDialog.js';
import { RowActions, type RowAction } from '../components/RowActions.js';
import { WriteConsentDialog } from '../components/WriteConsentDialog.js';

export { ALLOW_COMMENTS_LABEL };

/** What the detail page lends an action set: the connection, the one in-flight guard and the two writes. */
export interface ConnectionActionsProps {
    connection: ConnectionView;
    /** Whose consent screen a reconnect goes to, as the write-consent copy names it. */
    authority: string;
    busy: boolean;
    /** Resolves to the refusal message, or null when the browser is on its way to the consent screen. */
    onStart: (input: StartAuthorizationInput) => Promise<string | null>;
    onDisconnect: (connection: ConnectionView) => Promise<void>;
}

/**
 * An OAuth connection's actions, whatever the provider: Allow adding comments (a read row only) or Reconnect inline,
 * the rest in the overflow menu with Disconnect last. Allow adding comments asks first (`WriteConsentDialog`),
 * Disconnect asks first (`ConnectionDisconnectDialog`); nothing is sent before a confirm.
 */
export function OAuthConnectionActions({ connection, authority, busy, onStart, onDisconnect }: ConnectionActionsProps) {
    const [granting, setGranting] = useState(false);
    const [disconnecting, setDisconnecting] = useState(false);

    const reconnect = async (access: ConnectionView['access']) => {
        const message = await onStart({ connectionId: connection.id, access });
        if (message !== null) setGranting(false);
    };
    const reconnectAction: RowAction = { label: 'Reconnect', onSelect: () => void reconnect(connection.access) };
    const disconnect: RowAction = { label: 'Disconnect', onSelect: () => setDisconnecting(true), danger: true };
    const allow = { label: ALLOW_COMMENTS_LABEL, onSelect: () => setGranting(true) };
    // One inline action: Allow adding comments leads a read row (its Reconnect moves into the menu).
    const shape =
        connection.access === 'read'
            ? { primary: allow, actions: [reconnectAction, disconnect] }
            : { primary: reconnectAction, actions: [disconnect] };

    return (
        <>
            <RowActions rowName={`${connection.site} for ${connection.account}`} {...shape} disabled={busy} />
            <WriteConsentDialog
                connection={granting ? connection : null}
                authority={authority}
                busy={busy}
                onClose={() => setGranting(false)}
                onConfirm={() => void reconnect('write')}
            />
            <ConnectionDisconnectDialog
                connection={disconnecting ? connection : null}
                busy={busy}
                onClose={() => setDisconnecting(false)}
                onConfirm={() => void onDisconnect(connection).then(() => setDisconnecting(false))}
            />
        </>
    );
}
