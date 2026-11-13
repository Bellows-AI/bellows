import { ADMIN_ROLE, MEMBER_ROLE, type Role } from '@factory-ai/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Invitations, MemberView, RemovedMember } from '../src/api/orgMembers.js';
import { type FetchCall, renderApp, stubFetch } from './dom.js';
import { boardHandler, settingsBoard } from './settings-board.js';

/**
 * An admin's member access controls on /settings/organization over a stubbed board: remove behind a confirmation,
 * the removed list and its restore, and the invitations — the org's sign-in link beside GitHub's members who have
 * not signed in. The routes' contract is `server/test/routes.org-member-access.test.ts`'s.
 */

const SIGN_IN = 'https://board.example.test/api/auth/github?org=999999';

const member = (userId: string, githubLogin: string, role: Role): MemberView => ({
    githubLogin,
    userId,
    role,
    invitedAt: null,
    claimedAt: null,
    lastLoginAt: null,
});

interface Org {
    members: MemberView[];
    removed: RemovedMember[];
    invitations: Invitations;
}

/** The board plus one org's members, removals and invitations; remove and restore move a row between them. */
function stubOrg(org: Org): FetchCall[] {
    return stubFetch(
        boardHandler(settingsBoard(), ({ method, url }) => {
            if (method === 'GET' && url === '/api/org/members') return { members: org.members };
            if (method === 'GET' && url === '/api/org/members/removed') return { removed: org.removed };
            if (method === 'GET' && url === '/api/org/members/invitations') return org.invitations;
            const restore = /^\/api\/org\/members\/removed\/([^/]+)$/.exec(url);
            if (method === 'DELETE' && restore) {
                org.removed = org.removed.filter((row) => row.userId !== restore[1]);
                return { userId: restore[1], restored: true };
            }
            const remove = /^\/api\/org\/members\/([^/]+)$/.exec(url);
            if (method === 'DELETE' && remove) {
                const row = org.members.find((entry) => entry.userId === remove[1])!;
                org.members = org.members.filter((entry) => entry !== row);
                org.removed.push({
                    userId: row.userId,
                    githubLogin: row.githubLogin,
                    removedAt: '2026-11-01T00:00:00.000Z',
                    removedBy: 'e2e-member',
                });
                return { userId: row.userId, removed: true };
            }
        })
    );
}

const deletes = (calls: FetchCall[]) => calls.filter((call) => call.method === 'DELETE').map((call) => call.url);

describe('an admin’s member access controls', () => {
    it('removes a member only after the confirmation, and lists them as removed', async () => {
        const calls = stubOrg({
            members: [member('u1', 'e2e-member', ADMIN_ROLE), member('u2', 'teammate', MEMBER_ROLE)],
            removed: [],
            invitations: { signInUrl: SIGN_IN, github: { state: 'listed', people: [] } },
        });
        const user = userEvent.setup();
        renderApp('/settings/organization');

        const table = await screen.findByRole('region', { name: 'Organization members' });
        // The sole admin's row cannot be removed: the last-admin refusal, visible before the click.
        expect(within(table).getByRole<HTMLButtonElement>('button', { name: 'Remove e2e-member' }).disabled).toBe(true);
        await user.click(within(table).getByRole('button', { name: 'Remove teammate' }));
        const dialog = await screen.findByRole('dialog', { name: /Remove teammate/ });
        expect(deletes(calls)).toEqual([]);
        await user.click(within(dialog).getByRole('button', { name: 'Remove member' }));

        const removed = await screen.findByRole('region', { name: 'Removed members' });
        expect(within(removed).getByText('teammate')).toBeTruthy();
        expect(deletes(calls)).toEqual(['/api/org/members/u2']);
        await waitFor(() => expect(within(table).queryByRole('combobox', { name: 'Role for teammate' })).toBeNull());
    });

    it('restores a removed member, which empties the removed list', async () => {
        const calls = stubOrg({
            members: [member('u1', 'e2e-member', ADMIN_ROLE)],
            removed: [
                {
                    userId: 'u3',
                    githubLogin: 'gone-cat',
                    removedAt: '2026-10-01T00:00:00.000Z',
                    removedBy: 'e2e-member',
                },
            ],
            invitations: { signInUrl: SIGN_IN, github: { state: 'listed', people: [] } },
        });
        const user = userEvent.setup();
        renderApp('/settings/organization');

        const removed = await screen.findByRole('region', { name: 'Removed members' });
        await user.click(within(removed).getByRole('button', { name: 'Restore gone-cat' }));
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Removed members' })).toBeNull());
        expect(deletes(calls)).toEqual(['/api/org/members/removed/u3']);
    });

    it('offers the sign-in link, and lists GitHub’s members who have not signed in, each with a copy of it', async () => {
        stubOrg({
            members: [member('u1', 'e2e-member', ADMIN_ROLE)],
            removed: [],
            invitations: {
                signInUrl: SIGN_IN,
                github: { state: 'listed', people: [{ githubUserId: 7, login: 'new-cat' }] },
            },
        });
        const user = userEvent.setup();
        renderApp('/settings/organization');

        const invites = await screen.findByRole('region', { name: 'Not signed in yet' });
        expect(within(invites).getByText('new-cat')).toBeTruthy();
        expect(screen.getByText(SIGN_IN)).toBeTruthy();
        await user.click(within(invites).getByRole('button', { name: 'Copy sign-in link for new-cat' }));
        expect(await navigator.clipboard.readText()).toBe(SIGN_IN);
        expect(await within(invites).findByText('Copied')).toBeTruthy();
    });

    it('says GitHub’s member list is unavailable, and still offers the link', async () => {
        stubOrg({
            members: [member('u1', 'e2e-member', ADMIN_ROLE)],
            removed: [],
            invitations: { signInUrl: SIGN_IN, github: { state: 'unavailable', reason: 'member list answered 403' } },
        });
        renderApp('/settings/organization');

        expect(await screen.findByText(/GitHub's member list is unavailable: member list answered 403/)).toBeTruthy();
        expect(screen.getByText(SIGN_IN)).toBeTruthy();
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Copy sign-in link' }).disabled).toBe(false);
        expect(screen.queryByRole('region', { name: 'Not signed in yet' })).toBeNull();
    });
});
