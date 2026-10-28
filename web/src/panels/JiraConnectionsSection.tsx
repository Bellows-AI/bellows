import { ADMIN_ROLE } from '@factory-ai/core';
import { useCallback, useEffect, useState } from 'react';
import {
    createConnection,
    deleteConnection,
    listConnections,
    ORG_CONNECTION_SCOPE,
    type ConnectionScope,
    type ConnectionView,
    type NewConnectionInput,
} from '../api/connections.js';
import type { Session } from '../api/useSession.js';
import { JiraConnectionsPanel } from './JiraConnectionsPanel.js';

const ORG_HINT =
    'Legacy shared API-token connections. A task uses one only when it names it; none is bound by default. Only an admin adds or disconnects these.';
const PERSONAL_HINT =
    'Your own connections. A lone personal connection is bound to your tasks by default; with several, a task names the one it uses.';

/** The scope's own rows: the org's legacy ones, or the caller's personal ones (`self`, never another member's). */
const inScope = (scope: ConnectionScope, c: ConnectionView) =>
    scope === ORG_CONNECTION_SCOPE
        ? c.ownership === 'legacy-org'
        : c.ownership === 'personal' && c.principal === 'self';

/**
 * One scope of Jira connections bound to its data (`MembersSection`'s shape): the section owns the
 * list and the writes, the panel the markup. A create's refusals — `BAD_CONNECTION`, the 502 for
 * an unresolvable cloud id, `FORBIDDEN` — land in the add dialog as sent; a list or delete failure
 * on this section's own error line.
 *
 * A member sees the org list read-only; the personal scope is always the member's to manage. The
 * server is the gate either way (a forced org create answers 403).
 */
export function JiraConnectionsSection({ scope, session }: { scope: ConnectionScope; session: Session | null }) {
    const [connections, setConnections] = useState<ConnectionView[] | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

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

    // A refusal is the dialog's to show beside its fields, not this section's error line.
    const create = async (input: NewConnectionInput): Promise<string | null> => {
        setError(null);
        setSaving(true);
        const message = await createConnection(input);
        if (!message) await refresh();
        setSaving(false);
        return message;
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
                    <h2>Jira connection</h2>
                    <p className="status">{error ? 'Connections unavailable.' : 'Loading connections…'}</p>
                </section>
            ) : (
                <JiraConnectionsPanel
                    scope={scope}
                    hint={scope === ORG_CONNECTION_SCOPE ? ORG_HINT : PERSONAL_HINT}
                    connections={connections.filter((c) => inScope(scope, c))}
                    canManage={scope === ORG_CONNECTION_SCOPE ? session.role === ADMIN_ROLE : true}
                    saving={saving}
                    onCreate={create}
                    onDelete={(connection) => void remove(connection)}
                />
            )}
        </>
    );
}
