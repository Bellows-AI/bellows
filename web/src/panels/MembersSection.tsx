import { ADMIN_ROLE, type Role } from '@factory-ai/core';
import { useCallback, useEffect, useState } from 'react';
import {
    type Invitations,
    listMembers,
    listRemovedMembers,
    type MemberView,
    readInvitations,
    type RemovedMember,
    removeMember,
    restoreMember,
    setMemberRole,
} from '../api/orgMembers.js';
import { reportUnauthenticated } from '../api/unauthenticated.js';
import type { Session } from '../api/useSession.js';
import { InvitationsPanel, MemberRemoveDialog, RemovedMembersPanel } from './MemberAccessPanels.js';
import { MembersPanel } from './MembersPanel.js';
import { StateNote } from '../components/StateNote.js';

/**
 * The members section's interactive half (issue 410): the roster read, the role write, an admin's
 * removal, restore and invitations (`MemberAccessPanels`), and the
 * audience split — the table is an administrator's surface because the roster read is
 * admin-gated server-side, so a member's browser renders the muted sentence and issues no fetch
 * at all. Split out of `SettingsOrganizationPage` so the page stays a composition; the section
 * owns its state because its CRUD is member-rows, not the polls the layout publishes.
 *
 * Nothing renders for no session or `AUTH_MODE=none`: that mode has no session and no role, and
 * every gate there is already open — a role table for a stand-in account would be theater (the
 * tokens-section precedent).
 */
export function MembersSection({ session }: { session: Session | null }) {
    const isAdmin = session?.mode === 'github' && session.role === ADMIN_ROLE;
    const [members, setMembers] = useState<MemberView[] | null>(null);
    const [removed, setRemoved] = useState<RemovedMember[]>([]);
    const [invitations, setInvitations] = useState<Invitations | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [removing, setRemoving] = useState<MemberView | null>(null);
    const [removeError, setRemoveError] = useState<string | null>(null);

    /** The roster, the removals and the invitations, read together; the first refusal is the section's error. */
    const refresh = useCallback(async () => {
        const [roster, blocked, invited] = await Promise.all([listMembers(), listRemovedMembers(), readInvitations()]);
        const refused = [roster, blocked, invited].find((result) => !result.ok);
        if (refused && !refused.ok) setError(refused.error);
        if (roster.ok) setMembers(roster.members);
        if (blocked.ok) setRemoved(blocked.removed);
        if (invited.ok) setInvitations(invited.value);
    }, []);

    useEffect(() => {
        if (!isAdmin) return;
        void refresh();
    }, [isAdmin, refresh]);

    /**
     * The row's role write: refused means the message on this section's own error line. When the
     * write itself lands but the refetch fails, `members` still shows the pre-write roles beside
     * that error — the selects snap back until a reload refetches; the server holds the truth.
     *
     * A write that demotes the signed-in admin is the one success that must not refetch: the
     * roster read is admin-gated server-side, so the GET would paint this section with the 403
     * the next write would meet, over a table that no longer works. The broadcast re-checks
     * `/api/auth/me` in every mounted `useSession`; the fresh session carries the member role,
     * `isAdmin` flips, and the member sentence replaces the table — here and on the page's
     * "Your role" and the shell's user menu, which read the same stale prop otherwise.
     */
    const changeRole = async (member: MemberView, role: Role) => {
        setError(null);
        setSaving(true);
        const message = await setMemberRole(member.userId, role);
        setSaving(false);
        if (message) {
            setError(message);
            return;
        }
        if (session?.user.id === member.userId && role !== ADMIN_ROLE) {
            reportUnauthenticated();
            return;
        }
        await refresh();
    };

    /**
     * The confirmed removal: a refusal stays in the open dialog. Removing yourself ends your own access, so the
     * session is re-checked instead of refetching a roster this browser may no longer read.
     */
    const confirmRemove = async () => {
        if (removing === null) return;
        setSaving(true);
        const message = await removeMember(removing.userId);
        setSaving(false);
        if (message) {
            setRemoveError(message);
            return;
        }
        const self = session?.user.id === removing.userId;
        setRemoving(null);
        if (self) {
            reportUnauthenticated();
            return;
        }
        await refresh();
    };

    const restore = async (row: RemovedMember) => {
        setError(null);
        setSaving(true);
        const message = await restoreMember(row.userId);
        setSaving(false);
        if (message) {
            setError(message);
            return;
        }
        await refresh();
    };

    if (session === null || session.mode !== 'github') return null;

    return (
        <>
            {error ? <StateNote state="error">{error}</StateNote> : null}
            {isAdmin ? (
                members === null ? (
                    <section className="panel">
                        <h2>Members</h2>
                        <StateNote state="loading">Loading members…</StateNote>
                    </section>
                ) : (
                    <>
                        <MembersPanel
                            members={members}
                            saving={saving}
                            onChange={(member, role) => void changeRole(member, role)}
                            onRemove={(member) => {
                                setRemoveError(null);
                                setRemoving(member);
                            }}
                        />
                        <RemovedMembersPanel removed={removed} saving={saving} onRestore={(row) => void restore(row)} />
                        {invitations ? <InvitationsPanel invitations={invitations} /> : null}
                        <MemberRemoveDialog
                            member={removing}
                            busy={saving}
                            error={removeError}
                            onClose={() => {
                                if (!saving) setRemoving(null);
                            }}
                            onConfirm={() => void confirmRemove()}
                        />
                    </>
                )
            ) : (
                <p className="muted">Member roles are managed by your organization&rsquo;s admins.</p>
            )}
        </>
    );
}
