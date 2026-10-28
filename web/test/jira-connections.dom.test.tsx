import { MEMBER_ROLE } from '@factory-ai/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
    CONNECTION_DIALOG_TITLE,
    SAVE_CONNECTION_LABEL,
    SCOPED_TOKEN_HINT,
} from '../src/components/JiraConnectionDialog.js';
import { unsavedDialogTitle } from '../src/components/UnsavedChangesDialog.js';
import { ADD_CONNECTION_LABEL, DEFAULT_CONNECTION_CAPTION } from '../src/panels/JiraConnectionsPanel.js';
import { renderApp, stubFetch } from './dom.js';
import { boardHandler, connection, settingsBoard } from './settings-board.js';

/**
 * The Jira connection panels mounted on their real settings pages over a stubbed board: the add
 * dialog's focus, refusal and unsaved-change guard, and the personal panel on the workspace page.
 * The route's own refusal (the 502 for an unresolvable site) and the never-echoed token are
 * `server/test/routes.connections.test.ts`'s.
 */

const SITE = 'seeded-site.atlassian.net';
const UNRESOLVABLE_SITE = 'no-such-site-567.atlassian.net';
const REFUSAL = `Could not resolve the Jira cloud id of ${UNRESOLVABLE_SITE}`;

const field = (label: string) => within(dialog()).getByLabelText<HTMLInputElement>(label);
const dialog = () => screen.getByRole('dialog', { name: CONNECTION_DIALOG_TITLE });
const closed = (name: string) => waitFor(() => expect(screen.queryByRole('dialog', { name })).toBeNull());

describe('the organization Jira connections, as an admin', () => {
    it('labels the legacy row, carries the refusal into the dialog, guards typed fields, and disconnects', async () => {
        const board = settingsBoard({
            connections: [
                connection(SITE),
                connection('mine.atlassian.net', { ownership: 'personal', principal: 'self' }),
                connection('theirs.atlassian.net', { ownership: 'personal', principal: null }),
            ],
        });
        const calls = stubFetch(
            boardHandler(board, ({ method, url }) =>
                method === 'POST' && url === '/api/connections' ? { status: 502, body: { error: REFUSAL } } : undefined
            )
        );
        const user = userEvent.setup();
        renderApp('/settings/organization');

        const panel = await screen.findByRole('region', { name: 'Organization Jira connections' });
        const row = await within(panel).findByRole('row', { name: new RegExp(SITE) });
        expect(row.textContent).toContain('Legacy API token');
        expect(row.textContent).toContain('Shared (legacy)');
        expect(row.textContent).toContain('bot@example.com');
        expect(row.textContent).not.toContain(DEFAULT_CONNECTION_CAPTION);
        // Personal rows belong to the workspace page, never the organization's list.
        expect(within(panel).queryByRole('row', { name: /mine\.atlassian\.net/ })).toBeNull();
        expect(within(panel).queryByRole('row', { name: /theirs\.atlassian\.net/ })).toBeNull();
        expect(within(panel).queryAllByRole('textbox')).toHaveLength(0);

        const add = within(panel).getByRole<HTMLButtonElement>('button', { name: ADD_CONNECTION_LABEL });
        await user.click(add);
        expect(dialog().textContent).toContain(SCOPED_TOKEN_HINT);
        await waitFor(() => expect(document.activeElement).toBe(field('Jira site')));
        const save = () => within(dialog()).getByRole<HTMLButtonElement>('button', { name: SAVE_CONNECTION_LABEL });
        expect(save().disabled).toBe(true);

        // The route's refusal lands in the dialog as sent, and the dialog keeps every field.
        await user.type(field('Jira site'), UNRESOLVABLE_SITE);
        await user.type(field('Jira email'), 'bot@example.com');
        await user.type(field('Jira API token'), 'typed-token-never-echoed');
        await user.click(save());
        expect((await within(dialog()).findByRole('alert')).textContent).toContain(REFUSAL);
        expect(field('Jira site').value).toBe(UNRESOLVABLE_SITE);
        expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);

        // Dismissing typed fields asks first; the safe answer keeps them.
        await user.keyboard('{Escape}');
        const confirm = await screen.findByRole('dialog', { name: unsavedDialogTitle() });
        await user.click(within(confirm).getByRole('button', { name: 'Continue editing' }));
        await closed(unsavedDialogTitle());
        expect(field('Jira email').value).toBe('bot@example.com');

        // Cancel asks too; Discard closes and hands focus back to the trigger.
        await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
        const again = await screen.findByRole('dialog', { name: unsavedDialogTitle() });
        await user.click(within(again).getByRole('button', { name: 'Discard changes' }));
        await closed(CONNECTION_DIALOG_TITLE);
        await waitFor(() => expect(document.activeElement).toBe(add));

        // A blank dialog closes without asking.
        await user.click(add);
        await screen.findByRole('dialog', { name: CONNECTION_DIALOG_TITLE });
        await user.keyboard('{Escape}');
        await closed(CONNECTION_DIALOG_TITLE);
        expect(screen.queryByRole('dialog', { name: unsavedDialogTitle() })).toBeNull();

        await user.click(within(row).getByRole('button', { name: /^Disconnect/ }));
        await waitFor(() => expect(within(panel).queryByRole('row', { name: new RegExp(SITE) })).toBeNull());
        expect(calls.some((call) => call.method === 'DELETE' && call.url.startsWith('/api/connections/'))).toBe(true);
    });
});

describe('the personal Jira connections', () => {
    it("list only the caller's own rows, never the organization's or another member's", async () => {
        stubFetch(
            boardHandler(
                settingsBoard({
                    role: MEMBER_ROLE,
                    connections: [
                        connection('shared.atlassian.net'),
                        connection('mine.atlassian.net', { ownership: 'personal', principal: 'self' }),
                        connection('theirs.atlassian.net', { ownership: 'personal', principal: null }),
                    ],
                })
            )
        );
        renderApp('/settings/workspace');

        const personal = await screen.findByRole('region', { name: 'Personal Jira connections' });
        await within(personal).findByRole('row', { name: /mine\.atlassian\.net/ });
        expect(within(personal).queryByRole('row', { name: /shared\.atlassian\.net/ })).toBeNull();
        expect(within(personal).queryByRole('row', { name: /theirs\.atlassian\.net/ })).toBeNull();
    });

    it('sit on the workspace page with their override note and an add button, for a member too', async () => {
        stubFetch(boardHandler(settingsBoard({ role: MEMBER_ROLE })));
        renderApp('/settings/workspace');

        const personal = await screen.findByRole('region', { name: 'Personal Jira connections' });
        expect(personal.textContent).toContain('bound to your tasks by default');
        expect(within(personal).getByRole('button', { name: ADD_CONNECTION_LABEL })).toBeTruthy();
    });
});
