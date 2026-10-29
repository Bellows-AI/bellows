import { MEMBER_ROLE } from '@factory-ai/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CONNECT_DIALOG_TITLE, CONNECT_SUBMIT_LABEL, SITE_HELP } from '../src/components/JiraConnectionDialog.js';
import { ALLOW_COMMENTS_LABEL, CONNECT_JIRA_LABEL } from '../src/panels/JiraConnectionsPanel.js';
import { WRITE_CONSENT_TITLE } from '../src/components/JiraWriteConsentDialog.js';
import { renderApp, stubFetch } from './dom.js';
import { boardHandler, connection, settingsBoard } from './settings-board.js';

/**
 * The Jira connection panel mounted on its real settings page over a stubbed board: the Connect
 * form, the write-consent confirmation, the operator's not-configured message and the callback
 * result line. The start route's own answers are `server/test/routes.integrations.test.ts`'s.
 */

const CONSENT_URL = 'https://auth.example.test/authorize?state=stub';
const NOT_CONFIGURED = 'Jira OAuth is not configured on this deployment: the operator sets ATLASSIAN_CLIENT_ID.';
const START = '/api/integrations/jira/authorizations';

const startsWith = (reply: unknown) =>
    boardHandler(
        settingsBoard({ role: MEMBER_ROLE, connections: [connection('mine.atlassian.net')] }),
        ({ method, url }) => (method === 'POST' && url === START ? (reply as never) : undefined)
    );

/** jsdom cannot navigate; the page's `window.location.assign` is replaced by a spy for the test. */
function spyNavigation() {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    return assign;
}

const panel = () => screen.findByRole('region', { name: 'Jira connections' });

describe('the Jira connection panel on the workspace page', () => {
    it('shows the connected account and site with Reconnect and Disconnect, for a member', async () => {
        stubFetch(startsWith({ status: 201, body: { authorizeUrl: CONSENT_URL } }));
        renderApp('/settings/workspace');

        const row = await within(await panel()).findByRole('row', { name: /mine\.atlassian\.net/ });
        expect(row.textContent).toContain('stub-account-a@example.com');
        expect(row.textContent).toContain('read');
        expect(within(row).getByRole('button', { name: /^Reconnect/ })).toBeTruthy();
        expect(within(row).getByRole('button', { name: /^Disconnect/ })).toBeTruthy();
        expect(within(await panel()).queryAllByRole('textbox')).toHaveLength(0);
    });

    it('Connect posts {access, site} and navigates to the consent URL', async () => {
        const calls = stubFetch(startsWith({ status: 201, body: { authorizeUrl: CONSENT_URL } }));
        const assign = spyNavigation();
        const user = userEvent.setup();
        renderApp('/settings/workspace');

        await user.click(await within(await panel()).findByRole('button', { name: CONNECT_JIRA_LABEL }));
        const dialog = await screen.findByRole('dialog', { name: CONNECT_DIALOG_TITLE });
        expect(dialog.textContent).toContain(SITE_HELP);
        await user.type(within(dialog).getByLabelText('Jira site (optional)'), 'e2e-site.atlassian.net');
        await user.click(within(dialog).getByRole('checkbox', { name: ALLOW_COMMENTS_LABEL }));
        await user.click(within(dialog).getByRole('button', { name: CONNECT_SUBMIT_LABEL }));

        await waitFor(() => expect(assign).toHaveBeenCalledWith(CONSENT_URL));
        const post = calls.find((call) => call.method === 'POST' && call.url === START);
        expect(post?.body).toEqual({
            access: 'write',
            site: 'e2e-site.atlassian.net',
            returnTo: '/settings/workspace',
        });
    });

    it('a blank site and an unchecked box connect with read access and no site', async () => {
        const calls = stubFetch(startsWith({ status: 201, body: { authorizeUrl: CONSENT_URL } }));
        spyNavigation();
        const user = userEvent.setup();
        renderApp('/settings/workspace');

        await user.click(await within(await panel()).findByRole('button', { name: CONNECT_JIRA_LABEL }));
        const dialog = await screen.findByRole('dialog', { name: CONNECT_DIALOG_TITLE });
        await user.click(within(dialog).getByRole('button', { name: CONNECT_SUBMIT_LABEL }));
        await waitFor(() => expect(calls.some((call) => call.url === START)).toBe(true));
        expect(calls.find((call) => call.url === START)?.body).toEqual({
            access: 'read',
            returnTo: '/settings/workspace',
        });
    });

    it('"Allow adding comments" warns about read-bound tasks, then reconnects with access=write', async () => {
        const calls = stubFetch(startsWith({ status: 201, body: { authorizeUrl: CONSENT_URL } }));
        const assign = spyNavigation();
        const user = userEvent.setup();
        renderApp('/settings/workspace');

        const row = await within(await panel()).findByRole('row', { name: /mine\.atlassian\.net/ });
        await user.click(within(row).getByRole('button', { name: new RegExp(`^${ALLOW_COMMENTS_LABEL}`) }));
        const confirm = await screen.findByRole('dialog', { name: WRITE_CONSENT_TITLE });
        expect(confirm.textContent).toMatch(/read-bound tasks of this account will be refused/);
        expect(calls.some((call) => call.url === START)).toBe(false);

        await user.click(within(confirm).getByRole('button', { name: 'Continue to Atlassian' }));
        await waitFor(() => expect(assign).toHaveBeenCalledWith(CONSENT_URL));
        expect(calls.find((call) => call.url === START)?.body).toEqual({
            connectionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            access: 'write',
            returnTo: '/settings/workspace',
        });
    });

    it('a 503 INTEGRATION_NOT_CONFIGURED shows the operator message and does not navigate', async () => {
        stubFetch(startsWith({ status: 503, body: { error: NOT_CONFIGURED, code: 'INTEGRATION_NOT_CONFIGURED' } }));
        const assign = spyNavigation();
        const user = userEvent.setup();
        renderApp('/settings/workspace');

        await user.click(await within(await panel()).findByRole('button', { name: CONNECT_JIRA_LABEL }));
        const dialog = await screen.findByRole('dialog', { name: CONNECT_DIALOG_TITLE });
        await user.click(within(dialog).getByRole('button', { name: CONNECT_SUBMIT_LABEL }));
        expect((await within(dialog).findByRole('alert')).textContent).toContain(NOT_CONFIGURED);
        expect(assign).not.toHaveBeenCalled();
    });

    it('?integration=jira&result=identity-mismatch renders the mismatch sentence', async () => {
        stubFetch(startsWith({ status: 201, body: { authorizeUrl: CONSENT_URL } }));
        renderApp('/settings/workspace?integration=jira&result=identity-mismatch');
        const status = await screen.findByText(/not the account this connection was made with/);
        expect(status.getAttribute('role')).toBe('status');
    });

    it('disconnects a row', async () => {
        const calls = stubFetch(startsWith({ status: 201, body: { authorizeUrl: CONSENT_URL } }));
        const user = userEvent.setup();
        renderApp('/settings/workspace');
        const row = await within(await panel()).findByRole('row', { name: /mine\.atlassian\.net/ });
        await user.click(within(row).getByRole('button', { name: /^Disconnect/ }));
        await waitFor(() =>
            expect(
                within(screen.getByRole('region', { name: 'Jira connections' })).queryByRole('row', {
                    name: /mine\.atlassian\.net/,
                })
            ).toBeNull()
        );
        expect(calls.some((call) => call.method === 'DELETE' && call.url.startsWith('/api/connections/'))).toBe(true);
    });
});

describe('the Organization page', () => {
    it('has no Jira panel', async () => {
        stubFetch(boardHandler(settingsBoard({ connections: [connection('mine.atlassian.net')] })));
        renderApp('/settings/organization');
        await screen.findByRole('heading', { name: 'Members' });
        expect(screen.queryByRole('region', { name: /Jira/ })).toBeNull();
        expect(screen.queryByText(/Jira connection/)).toBeNull();
    });
});
