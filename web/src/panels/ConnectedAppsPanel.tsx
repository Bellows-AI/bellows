import { useEffect, useRef, useState } from 'react';
import { useOAuthGrants, type OAuthGrantView } from '../api/useOAuthGrants.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { StateNote } from '../components/StateNote.js';
import { taskTime } from '../format.js';
import { clientIdentity, scopeLabel } from '../oauth-client.js';

const identityOf = (grant: OAuthGrantView) => clientIdentity({ ...grant.client });

function GrantRow({ grant, busy, onRevoke }: { grant: OAuthGrantView; busy: boolean; onRevoke: () => void }) {
    const identity = identityOf(grant);
    return (
        <tr>
            <td data-label="App">
                {identity.label}
                {grant.client.kind === 'dcr' ? <span className="muted"> (unverified name)</span> : null}
            </td>
            <td data-label="Org">{grant.org.name}</td>
            <td data-label="Access">{grant.scopes.map(scopeLabel).join('; ')}</td>
            <td data-label="Connected">{taskTime(grant.createdAt)}</td>
            <td data-label="Last token issued">{taskTime(grant.lastIssuedAt)}</td>
            <td data-label="Disconnect">
                <button type="button" disabled={busy} aria-label={`Disconnect ${identity.label}`} onClick={onRevoke}>
                    Disconnect
                </button>
            </td>
        </tr>
    );
}

export interface ConnectedAppsPanelProps {
    /** Null while unread or after a failed read; `error` says which. */
    grants: readonly OAuthGrantView[] | null;
    loading: boolean;
    error: string | null;
    onRevoke: (id: string) => Promise<string | null>;
}

/**
 * The apps the member has connected to MCP, each ended with Disconnect (BEL-103). A failed read is an error line,
 * never "no connected apps"; the list shows only after the server has said what it holds.
 */
export function ConnectedAppsPanel({ grants, loading, error, onRevoke }: ConnectedAppsPanelProps) {
    const [pending, setPending] = useState<OAuthGrantView | null>(null);
    const [revoking, setRevoking] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    // The disconnected row loses its button on the refetch, so focus moves to the heading, which outlives it.
    const headingRef = useRef<HTMLHeadingElement>(null);
    const [focusHeading, setFocusHeading] = useState(false);
    useEffect(() => {
        if (!focusHeading) return;
        const timer = setTimeout(() => {
            headingRef.current?.focus();
            setFocusHeading(false);
        }, 0);
        return () => clearTimeout(timer);
    }, [focusHeading]);

    const confirm = async () => {
        if (pending === null) return;
        setRevoking(true);
        setFailure(null);
        try {
            const reason = await onRevoke(pending.id);
            if (reason) setFailure(reason);
            else setFocusHeading(true);
        } finally {
            setRevoking(false);
            setPending(null);
        }
    };

    return (
        <section className="panel" aria-labelledby="connected-apps-title">
            <div className="panel-head">
                <h2 id="connected-apps-title" ref={headingRef} tabIndex={-1}>
                    Connected apps
                </h2>
            </div>
            <p className="muted">
                Apps you allowed to act as you over MCP. Disconnecting ends their access at once; the app can ask again.
            </p>
            {error ? <StateNote state="error">{error}</StateNote> : null}
            {failure ? <StateNote state="error">{failure}</StateNote> : null}
            {loading && grants === null ? <StateNote state="loading">Loading…</StateNote> : null}
            {grants !== null && grants.length === 0 && !error ? (
                <StateNote state="empty">No apps are connected.</StateNote>
            ) : null}
            {grants !== null && grants.length > 0 ? (
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable
                <section className="table-wrap" tabIndex={0} aria-label="Connected apps list">
                    <table className="data table-cards" aria-label="Connected apps">
                        <thead>
                            <tr>
                                <th scope="col">App</th>
                                <th scope="col">Org</th>
                                <th scope="col">Access</th>
                                <th scope="col">Connected</th>
                                <th scope="col">Last token issued</th>
                                <th scope="col">
                                    <span className="visually-hidden">Disconnect</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {grants.map((grant) => (
                                <GrantRow
                                    key={grant.id}
                                    grant={grant}
                                    busy={revoking}
                                    onRevoke={() => setPending(grant)}
                                />
                            ))}
                        </tbody>
                    </table>
                </section>
            ) : null}
            <ConfirmDialog
                open={pending !== null}
                busy={revoking}
                title={`Disconnect ${pending ? identityOf(pending).label : ''}?`}
                confirmClassName="chat-remove"
                confirmText={revoking ? 'Disconnecting…' : 'Disconnect'}
                onClose={() => setPending(null)}
                onConfirm={() => void confirm()}
            >
                <p>
                    {pending ? identityOf(pending).label : 'This app'} stops working at once. It can ask for access
                    again, and you will be asked to allow it.
                </p>
            </ConfirmDialog>
        </section>
    );
}

/** The panel bound to the caller's grants; mounted only where the board serves MCP. */
export function ConnectedAppsSection() {
    const { grants, loading, error, revoke } = useOAuthGrants();
    return <ConnectedAppsPanel grants={grants} loading={loading} error={error} onRevoke={revoke} />;
}
