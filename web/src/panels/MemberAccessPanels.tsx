import { useState } from 'react';
import type { Invitations, MemberView, RemovedMember } from '../api/orgMembers.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { commitDate } from '../format.js';

/**
 * An admin's member access controls beside the roster (docs/auth.md): the removal's confirmation, the removed list
 * with its restore, and the invitations. Presentational, like `MembersPanel`; `MembersSection` owns the reads and
 * the writes. Membership is GitHub's, so an invitation is the organization's sign-in link: the panel shows it and
 * lists GitHub's members who have not signed in yet, each with a copy of that link.
 */

/** The removal's confirmation: the consequence is the copy, and Cancel holds the first keypress. */
export function MemberRemoveDialog({
    member,
    busy,
    error,
    onClose,
    onConfirm,
}: {
    member: MemberView | null;
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onConfirm: () => void;
}) {
    return (
        <ConfirmDialog
            open={member !== null}
            busy={busy}
            title={`Remove ${member?.githubLogin ?? ''}?`}
            confirmClassName="chat-remove"
            confirmText={busy ? 'Removing…' : 'Remove member'}
            onClose={onClose}
            onConfirm={onConfirm}
        >
            <p>
                They lose access to this organization at once: their sessions end and their personal tokens are revoked.
                Signing in with GitHub again does not bring them back until an admin restores them.
            </p>
            {error !== null ? (
                <p className="status error" role="alert">
                    {error}
                </p>
            ) : null}
        </ConfirmDialog>
    );
}

/** The org's removals; nothing renders while there are none. */
export function RemovedMembersPanel({
    removed,
    saving,
    onRestore,
}: {
    removed: readonly RemovedMember[];
    saving: boolean;
    onRestore: (row: RemovedMember) => void;
}) {
    if (removed.length === 0) return null;
    return (
        <section className="panel">
            <h2>Removed members</h2>
            <p className="muted">
                Removed by an admin. GitHub may still list them, but signing in does not admit them until you restore
                them.
            </p>
            <section className="table-wrap" aria-label="Removed members">
                <table className="data table-cards">
                    <thead>
                        <tr>
                            <th scope="col">Login</th>
                            <th scope="col">Removed</th>
                            <th scope="col">Removed by</th>
                            <th scope="col">
                                <span className="visually-hidden">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {removed.map((row) => (
                            <tr key={row.userId}>
                                <td data-label="Login">
                                    <span className="member-login" title={row.githubLogin}>
                                        {row.githubLogin}
                                    </span>
                                </td>
                                <td data-label="Removed">{commitDate(row.removedAt)}</td>
                                <td data-label="Removed by">{row.removedBy ?? '—'}</td>
                                <td data-label="Actions">
                                    <button
                                        type="button"
                                        disabled={saving}
                                        aria-label={`Restore ${row.githubLogin}`}
                                        onClick={() => onRestore(row)}
                                    >
                                        Restore
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        </section>
    );
}

/** Copies the link, and says so on the button that was pressed; a refused clipboard leaves the link on screen. */
function useCopy(link: string) {
    const [copied, setCopied] = useState<string | null>(null);
    const copy = async (key: string) => {
        try {
            await navigator.clipboard.writeText(link);
            setCopied(key);
        } catch {
            setCopied(null);
        }
    };
    return { copied, copy };
}

/** The sign-in link and GitHub's members who have not used it; the list's absence is said, never guessed. */
export function InvitationsPanel({ invitations }: { invitations: Invitations }) {
    const { signInUrl, github } = invitations;
    const { copied, copy } = useCopy(signInUrl ?? '');
    if (signInUrl === null) return null;
    return (
        <section className="panel">
            <h2>Invite members</h2>
            <p className="muted">
                Membership follows GitHub: anyone in the GitHub organization joins by signing in. Share this link.
            </p>
            <p>
                <span className="mono">{signInUrl}</span>{' '}
                <button type="button" aria-label="Copy sign-in link" onClick={() => void copy('')}>
                    {copied === '' ? 'Copied' : 'Copy link'}
                </button>
            </p>
            {github.state === 'unavailable' ? (
                <p className="muted">GitHub's member list is unavailable: {github.reason}.</p>
            ) : github.people.length === 0 ? (
                <p className="muted">Everyone GitHub lists in this organization has signed in.</p>
            ) : (
                <section className="table-wrap" aria-label="Not signed in yet">
                    <table className="data table-cards">
                        <thead>
                            <tr>
                                <th scope="col">Not signed in yet</th>
                                <th scope="col">
                                    <span className="visually-hidden">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {github.people.map((person) => (
                                <tr key={person.githubUserId}>
                                    <td data-label="Login">
                                        <span className="member-login" title={person.login}>
                                            {person.login}
                                        </span>
                                    </td>
                                    <td data-label="Actions">
                                        <button
                                            type="button"
                                            aria-label={`Copy sign-in link for ${person.login}`}
                                            onClick={() => void copy(person.login)}
                                        >
                                            {copied === person.login ? 'Copied' : 'Copy link'}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
        </section>
    );
}
