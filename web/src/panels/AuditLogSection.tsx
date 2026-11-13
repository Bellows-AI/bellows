import { ADMIN_ROLE } from '@factory-ai/core';
import { useEffect, useId, useState } from 'react';
import { type AuditEvent, type AuditLog, readAuditLog, saveAuditLog } from '../api/audit.js';
import type { Session } from '../api/useSession.js';
import { StateNote } from '../components/StateNote.js';
import { taskTime } from '../format.js';

/**
 * The organization's audit log on the Organization settings page: who signed in, minted or revoked a token, changed a
 * role, removed or restored a member, wrote variables, changed a connection or acted on another member's task. An
 * admin picks the days, reads the newest rows here and exports the whole range as NDJSON. Like the roster, nothing
 * renders for a member or under `AUTH_MODE=none`.
 */

/** The rows shown on the page; the export carries the whole range. */
const PREVIEW = 200;
const DAY_MS = 86_400_000;
const WEEK_DAYS = 6;

const ACTION_LABELS: Readonly<Record<string, string>> = {
    'auth.sign_in': 'Signed in',
    'token.personal.mint': 'Created a personal token',
    'token.personal.revoke': 'Revoked a personal token',
    'token.org.mint': 'Created an organization token',
    'token.org.revoke': 'Revoked an organization token',
    'member.role': 'Changed a role',
    'member.remove': 'Removed a member',
    'member.restore': 'Restored a member',
    'env.write': 'Saved variables',
    'connection.connect': 'Connected',
    'connection.disconnect': 'Disconnected',
    'connection.access': 'Changed connection access',
    'task.admin_action': 'Acted on a member’s task',
};

const ACTOR_LABELS: Readonly<Record<AuditEvent['actorKind'], string>> = {
    user: 'A member',
    org_token: 'Organization token',
    operator: 'Operator',
    system: 'Bellows',
};

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

const actorOf = (event: AuditEvent): string => event.actorLogin ?? ACTOR_LABELS[event.actorKind] ?? event.actorKind;

export function AuditLogSection({ session }: { session: Session | null }) {
    const isAdmin = session?.mode === 'github' && session.role === ADMIN_ROLE;
    const ids = useId();
    const [to, setTo] = useState(() => dayOf(Date.now()));
    const [from, setFrom] = useState(() => dayOf(Date.now() - WEEK_DAYS * DAY_MS));
    /** The answer and the days it was read for: an export saves exactly that, under those days' name. */
    const [loaded, setLoaded] = useState<{ log: AuditLog; from: string; to: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const backwards = from !== '' && to !== '' && from > to;
    const incomplete = from === '' || to === '';
    const log = loaded?.log ?? null;

    useEffect(() => {
        if (!isAdmin || from === '' || to === '' || from > to) return;
        const controller = new AbortController();
        setLoading(true);
        void readAuditLog(from, to, controller.signal).then((result) => {
            if (result.ok) {
                setLoaded({ log: result.log, from, to });
                setError(null);
            } else if (!result.aborted) {
                setLoaded(null);
                setError(result.error);
            }
            if (!controller.signal.aborted) setLoading(false);
        });
        return () => controller.abort();
    }, [isAdmin, from, to]);

    if (!isAdmin) return null;

    return (
        <section className="panel" aria-labelledby={`${ids}-title`}>
            <h2 id={`${ids}-title`}>Audit log</h2>
            <p className="muted">
                Sign-ins, tokens, roles, removals, variables, connections and admin actions on members’ tasks. Values of
                secrets and tokens are never recorded.
            </p>
            <div className="picker-field">
                <label htmlFor={`${ids}-from`}>From</label>
                <input
                    id={`${ids}-from`}
                    className="field"
                    type="date"
                    value={from}
                    max={to || undefined}
                    onChange={(e) => setFrom(e.target.value)}
                />
            </div>
            <div className="picker-field">
                <label htmlFor={`${ids}-to`}>To</label>
                <input
                    id={`${ids}-to`}
                    className="field"
                    type="date"
                    value={to}
                    min={from || undefined}
                    onChange={(e) => setTo(e.target.value)}
                />
            </div>
            <p>
                <button
                    type="button"
                    className="tertiary"
                    // A cleared or reversed range has no rows of its own: the loaded ones belong to other days.
                    disabled={!loaded || loading || incomplete || backwards}
                    onClick={() => loaded && saveAuditLog(loaded.log.file, `audit-${loaded.from}-to-${loaded.to}`)}
                >
                    Export
                </button>
            </p>
            <AuditBody backwards={backwards} error={error} loading={loading} log={log} />
        </section>
    );
}

/** What the picked days came to: a refusal, the loading line, the empty line, or the newest rows. */
function AuditBody({
    backwards,
    error,
    loading,
    log,
}: {
    backwards: boolean;
    error: string | null;
    loading: boolean;
    log: AuditLog | null;
}) {
    if (backwards) return <StateNote state="error">The start date is after the end date.</StateNote>;
    if (error) return <StateNote state="error">{error}</StateNote>;
    if (!log) return loading ? <StateNote state="loading">Loading the audit log…</StateNote> : null;
    if (log.events.length === 0) return <StateNote state="empty">Nothing was recorded in these days.</StateNote>;
    const newest = [...log.events].reverse().slice(0, PREVIEW);
    return (
        <>
            {log.events.length > PREVIEW ? (
                <p className="muted">
                    Showing the newest {PREVIEW} of {log.events.length}. Export for all of them.
                </p>
            ) : null}
            <section className="table-wrap" aria-label="Audit events">
                <table className="data table-cards">
                    <thead>
                        <tr>
                            <th scope="col">When</th>
                            <th scope="col">Who</th>
                            <th scope="col">What</th>
                            <th scope="col">Target</th>
                        </tr>
                    </thead>
                    <tbody>
                        {newest.map((event) => (
                            <tr key={event.id}>
                                <td data-label="When">{taskTime(event.at)}</td>
                                <td data-label="Who">
                                    <span className="member-login" title={actorOf(event)}>
                                        {actorOf(event)}
                                    </span>
                                </td>
                                <td data-label="What">{ACTION_LABELS[event.action] ?? event.action}</td>
                                <td data-label="Target">
                                    <span className="mono">{event.target ?? '—'}</span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        </>
    );
}
