import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MembersPanel } from '../src/panels/MembersPanel.js';
import type { MemberView } from '../src/api/orgMembers.js';
import { expectNoPlaceholder } from './fixtures.js';

const member = (login: string, role: MemberView['role'], userId = `00000000-0000-4000-8000-${login}`): MemberView => ({
    githubLogin: login,
    userId,
    role,
    invitedAt: null,
    claimedAt: '2026-09-01T00:00:00.000Z',
    lastLoginAt: '2026-10-01T00:00:00.000Z',
});

/** An admin and a member, nothing saving; overrides name the difference. */
const renderPanel = (overrides: Partial<ComponentProps<typeof MembersPanel>> = {}) =>
    renderToStaticMarkup(
        <MembersPanel
            members={[member('admin-cat', 'admin'), member('octocat', 'member')]}
            saving={false}
            onChange={() => {}}
            {...overrides}
        />
    );

describe('the members panel', () => {
    it('renders a row per member: login, role, joined', () => {
        const html = renderPanel();
        expect(html).toContain('admin-cat');
        expect(html).toContain('octocat');
        expect(html).toContain('data-label="Login"');
        expect(html).toContain('data-label="Role"');
        expect(html).toContain('data-label="Joined"');
        // The joined date is rendered, not the raw ISO string's shadow of itself.
        expect(html).not.toContain('2026-09-01T00:00:00.000Z');
    });

    it('gives an admin a role control per row', () => {
        const html = renderPanel();
        expect(html.match(/<select /g)?.length).toBe(2);
        expect(html).toContain('aria-label="Role for admin-cat"');
        expect(html).toContain('aria-label="Role for octocat"');
    });

    it('disables the Member option on a sole admin — the last-admin refusal, visible before the click', () => {
        const html = renderPanel();
        // Exactly one disabled option in the whole table: the sole admin's Member choice.
        expect(html.match(/disabled/g)?.length).toBe(1);
        const adminRow = html.slice(html.indexOf('Role for admin-cat'));
        expect(adminRow).toMatch(/<option[^>]*disabled[^>]*>Member<\/option>/);
    });

    it('leaves every option open once a second admin exists', () => {
        const html = renderPanel({
            members: [member('admin-cat', 'admin'), member('second-cat', 'admin'), member('octocat', 'member')],
        });
        expect(html.match(/<option[^>]*disabled/g)?.length ?? 0).toBe(0);
    });

    it('disables the controls while a save is in flight', () => {
        const html = renderPanel({ members: [member('octocat', 'member')], saving: true });
        expect(html).toContain('disabled');
    });

    it('labels every cell for the narrow-viewport card reflow', () => {
        const html = renderPanel({ members: [member('octocat', 'member')] });
        expect(html).toContain('table-cards');
        for (const label of ['Login', 'Role', 'Joined']) {
            expect(html, label).toContain(`data-label="${label}"`);
        }
    });

    it('keeps the panel legible with no placeholder values', () => {
        const html = renderPanel({ members: [member('admin-cat', 'admin'), member('unclaimed-cat', 'member')] });
        expectNoPlaceholder(html);
    });
});
