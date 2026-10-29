import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
    deleteConnection,
    listConnections,
    startAuthorization,
    type ConnectionView,
    type StartAuthorizationInput,
} from '../api/connections.js';
import type { Session } from '../api/useSession.js';
import { integrationNotice, JiraConnectionsPanel } from './JiraConnectionsPanel.js';

/**
 * The member's Jira connections bound to their data (`MembersSection`'s shape): the section owns
 * the list, the start and the disconnect, the panel the markup. A start's refusal lands beside
 * the control that made it; a list or disconnect failure on this section's own error line. The
 * callback returns here with `?integration=jira&result=…`, which the panel shows as one sentence.
 * The start navigates away on success and leaves `saving` set: the page is gone.
 */
export function JiraConnectionsSection({ session }: { session: Session | null }) {
    const [connections, setConnections] = useState<ConnectionView[] | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [params] = useSearchParams();

    const refresh = useCallback(async () => {
        const result = await listConnections();
        if (!result.ok) {
            setError(result.error);
            return;
        }
        setConnections(result.connections);
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const start = async (input: StartAuthorizationInput): Promise<string | null> => {
        setError(null);
        setSaving(true);
        const started = await startAuthorization(input);
        if (started.ok) {
            window.location.assign(started.authorizeUrl);
            return null;
        }
        setSaving(false);
        return started.error;
    };

    const remove = async (connection: ConnectionView) => {
        setError(null);
        setSaving(true);
        const message = await deleteConnection(connection.id);
        if (message) setError(message);
        else await refresh();
        setSaving(false);
    };

    if (session === null) return null;

    return (
        <>
            {error ? <p className="status">{error}</p> : null}
            {connections === null ? (
                <section className="panel">
                    <h2>Jira connections</h2>
                    <p className="status">{error ? 'Connections unavailable.' : 'Loading connections…'}</p>
                </section>
            ) : (
                <JiraConnectionsPanel
                    connections={connections}
                    saving={saving}
                    notice={integrationNotice(params.get('integration'), params.get('result'))}
                    onStart={start}
                    onDisconnect={(connection) => void remove(connection)}
                />
            )}
        </>
    );
}
