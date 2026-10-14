import { ADMIN_ROLE, MEMBER_ROLE, type Role } from '@factory-ai/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MemberView } from '../src/api/orgMembers.js';
import { type FetchCall, OPEN_BOARD_SESSION, renderApp, stubFetch } from './dom.js';
import { boardHandler, type SettingsBoard, settingsBoard } from './settings-board.js';

/**
 * The members section on /settings/organization over a stubbed board: the admin-only roster, the
 * refetch after a role write, and the self-demotion that re-checks the session instead. The routes'
 * admin gate is `server/test/routes.org-members.test.ts`'s.
 */

const MEMBER_SENTENCE = /Member roles are managed by your organization/;

const member = (userId: string, githubLogin: string, role: Role): MemberView => ({
    githubLogin,
    userId,
    role,
    invitedAt: null,
    claimedAt: null,
    lastLoginAt: null,
});

/** The board plus a roster; a role write changes the roster, and the signed-in row's role the session's. */
function stubMembers(board: SettingsBoard, roster: MemberView[]): FetchCall[] {
    return stubFetch(
        boardHandler(board, ({ method, url, body }) => {
            if (method === 'GET' && url === '/api/org/members') return { members: roster };
            const write = /^\/api\/org\/members\/([^/]+)\/role$/.exec(url);
            if (method !== 'PUT' || !write) return;
            const row = roster.find((entry) => entry.userId === write[1])!;
            row.role = (body as { role: Role }).role;
            if (row.userId === 'u1') board.role = row.role;
            return { status: 204 };
        })
    );
}

const gets = (calls: FetchCall[], url: string) => calls.filter((call) => call.method === 'GET' && call.url === url);
const roleSelect = (login: string) => screen.findByRole<HTMLSelectElement>('combobox', { name: `Role for ${login}` });

describe('the members section', () => {
    it('renders nothing on an open board, where there is no role to manage', async () => {
        const calls = stubFetch(
            boardHandler(settingsBoard(), ({ url }) => (url === '/api/auth/me' ? OPEN_BOARD_SESSION : undefined))
        );
        renderApp('/settings/organization');

        await screen.findByText('Your role');
        expect(screen.queryByText(MEMBER_SENTENCE)).toBeNull();
        expect(gets(calls, '/api/org/members')).toEqual([]);
    });

    it('gives a member the sentence and never reads the roster', async () => {
        const calls = stubMembers(settingsBoard({ role: MEMBER_ROLE }), []);
        renderApp('/settings/organization');

        await screen.findByText(MEMBER_SENTENCE);
        expect(screen.queryByRole('region', { name: 'Organization members' })).toBeNull();
        expect(gets(calls, '/api/org/members')).toEqual([]);
    });

    it('shows an admin the table and refetches it after a role write', async () => {
        const calls = stubMembers(settingsBoard(), [
            member('u1', 'e2e-member', ADMIN_ROLE),
            member('u2', 'teammate', MEMBER_ROLE),
        ]);
        const user = userEvent.setup();
        renderApp('/settings/organization');

        await screen.findByRole('region', { name: 'Organization members' });
        expect(screen.queryByText(MEMBER_SENTENCE)).toBeNull();
        expect(gets(calls, '/api/org/members')).toHaveLength(1);

        await user.selectOptions(await roleSelect('teammate'), ADMIN_ROLE);
        await waitFor(() => expect(gets(calls, '/api/org/members')).toHaveLength(2));
        expect((await roleSelect('teammate')).value).toBe(ADMIN_ROLE);
    });

    it('re-checks the session instead of refetching when the signed-in admin demotes themself', async () => {
        const calls = stubMembers(settingsBoard(), [
            member('u1', 'e2e-member', ADMIN_ROLE),
            member('u2', 'teammate', ADMIN_ROLE),
        ]);
        const user = userEvent.setup();
        renderApp('/settings/organization');

        const table = await screen.findByRole('region', { name: 'Organization members' });
        const sessionReads = gets(calls, '/api/auth/me').length;
        await user.selectOptions(within(table).getByRole('combobox', { name: 'Role for e2e-member' }), MEMBER_ROLE);

        await screen.findByText(MEMBER_SENTENCE);
        expect(gets(calls, '/api/auth/me').length).toBeGreaterThan(sessionReads);
        expect(gets(calls, '/api/org/members')).toHaveLength(1);
        expect(screen.queryByRole('region', { name: 'Organization members' })).toBeNull();
    });
});
