import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALLOW_COMMENTS_LABEL } from '../src/components/JiraConnectionDialog.js';
import { WRITE_CONSENT_TITLE } from '../src/components/JiraWriteConsentDialog.js';
import { commitDate } from '../src/format.js';
import { renderApp, stubFetch, type FetchHandler } from './dom.js';
import { boardHandler, connection, settingsBoard } from './settings-board.js';

/** One integration's page: found by provider and connection id, with the Jira lifecycle on it. */

const row = connection('acme-example.atlassian.net', { account: 'dev@acme-example.test', access: 'write' });

const board = (reply?: unknown): FetchHandler =>
    boardHandler(settingsBoard({ connections: [row] }), ({ method, url }) =>
        reply !== undefined && method === 'GET' && url === '/api/connections' ? (reply as never) : undefined
    );

describe('an integration page', () => {
    it('shows the site, account, what tasks may do, the connected date and the status', async () => {
        stubFetch(board());
        renderApp(`/settings/integrations/jira/${row.id}`);

        expect(await screen.findByRole('heading', { level: 1, name: /Jira/ })).toBeTruthy();
        const facts = document.querySelector('dl.kv') as HTMLElement;
        expect(within(facts).getByText('acme-example.atlassian.net')).toBeTruthy();
        expect(within(facts).getByText('dev@acme-example.test')).toBeTruthy();
        expect(within(facts).getByText('Tasks can look Jira up and add comments.')).toBeTruthy();
        expect(within(facts).getByText(commitDate(row.createdAt))).toBeTruthy();
        expect(within(facts).getByText('Connected')).toBeTruthy();
    });

    it('goes back to the overview', async () => {
        stubFetch(board());
        renderApp(`/settings/integrations/jira/${row.id}`);

        const back = await screen.findByRole('link', { name: 'Back to Integrations' });
        expect(back.getAttribute('href')).toBe('/settings/integrations');
    });

    it('says not found for an id the list does not hold', async () => {
        stubFetch(board());
        renderApp('/settings/integrations/jira/00000000-0000-4000-8000-999999999999');

        expect(await screen.findByText('Integration not found')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Back to Integrations' })).toBeTruthy();
    });

    it('says not found when the provider in the address is not the row provider', async () => {
        stubFetch(board());
        renderApp(`/settings/integrations/slack/${row.id}`);

        expect(await screen.findByText('Integration not found')).toBeTruthy();
    });

    it('shows the error, not not-found, when the read fails or the session expired', async () => {
        stubFetch(board({ status: 500, body: { error: 'database is down' } }));
        const first = renderApp(`/settings/integrations/jira/${row.id}`);
        expect((await screen.findByRole('alert')).textContent).toContain('database is down');
        expect(screen.queryByText('Integration not found')).toBeNull();
        first.unmount();

        stubFetch(board({ status: 401, body: { error: 'no session' } }));
        renderApp(`/settings/integrations/jira/${row.id}`);
        expect((await screen.findByRole('alert')).textContent).toContain('Your session expired');
        expect(screen.queryByText('Integration not found')).toBeNull();
    });
});

const CONSENT_URL = 'https://auth.example.test/authorize?state=stub';
const START = '/api/integrations/jira/authorizations';
const MENU = 'Actions for acme-example.atlassian.net for dev@acme-example.test';
const DETAIL = `/settings/integrations/jira/${row.id}`;

afterEach(() => vi.unstubAllGlobals());

/** jsdom cannot navigate; the page's `window.location.assign` is replaced by a spy for the test. */
const spyNavigation = () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    return assign;
};

const lifecycleBoard = (access: 'read' | 'write', deleteReply?: unknown): FetchHandler => {
    const mine = { ...row, access };
    return boardHandler(settingsBoard({ connections: [mine] }), ({ method, url }) => {
        if (method === 'POST' && url === START) return { status: 201, body: { authorizeUrl: CONSENT_URL } } as never;
        if (method === 'DELETE' && deleteReply !== undefined) return deleteReply as never;
    });
};

const pick = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(await screen.findByRole('button', { name: MENU }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name }));
};

describe('an integration page: the Jira lifecycle', () => {
    it('Reconnect on a write row posts the connection, write access and its own path as returnTo', async () => {
        const calls = stubFetch(lifecycleBoard('write'));
        const assign = spyNavigation();
        const user = userEvent.setup();
        renderApp(DETAIL);

        await user.click(await screen.findByRole('button', { name: 'Reconnect' }));

        await waitFor(() => expect(assign).toHaveBeenCalledWith(CONSENT_URL));
        expect(calls.find((call) => call.url === START)?.body).toEqual({
            connectionId: row.id,
            access: 'write',
            returnTo: DETAIL,
        });
    });

    it('Allow adding comments on a read row asks first, then upgrades to write; Cancel sends nothing', async () => {
        const calls = stubFetch(lifecycleBoard('read'));
        const assign = spyNavigation();
        const user = userEvent.setup();
        renderApp(DETAIL);

        await user.click(await screen.findByRole('button', { name: ALLOW_COMMENTS_LABEL }));
        const dialog = await screen.findByRole('dialog', { name: WRITE_CONSENT_TITLE });
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(calls.some((call) => call.url === START)).toBe(false);

        await user.click(await screen.findByRole('button', { name: ALLOW_COMMENTS_LABEL }));
        await user.click(
            within(await screen.findByRole('dialog', { name: WRITE_CONSENT_TITLE })).getByRole('button', {
                name: 'Continue to Atlassian',
            })
        );
        await waitFor(() => expect(assign).toHaveBeenCalledWith(CONSENT_URL));
        expect(calls.find((call) => call.url === START)?.body).toEqual({
            connectionId: row.id,
            access: 'write',
            returnTo: DETAIL,
        });
    });

    it('Disconnect asks first, sends nothing before the confirm, then returns to the overview with a notice', async () => {
        const calls = stubFetch(lifecycleBoard('write'));
        const user = userEvent.setup();
        const { router } = renderApp(DETAIL);

        await pick(user, 'Disconnect');
        const dialog = await screen.findByRole('dialog', { name: /Disconnect acme-example\.atlassian\.net/ });
        expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
        await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

        expect(await screen.findByText('Disconnected acme-example.atlassian.net.')).toBeTruthy();
        expect(router.state.location.pathname).toBe('/settings/integrations');
        expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
        // The sentence is read once: the state it rode in on is replaced with null.
        await waitFor(() => expect(router.state.location.state).toBeNull());
    });

    it('Cancel on the disconnect confirmation sends nothing', async () => {
        const calls = stubFetch(lifecycleBoard('write'));
        const user = userEvent.setup();
        renderApp(DETAIL);

        await pick(user, 'Disconnect');
        await user.click(
            within(await screen.findByRole('dialog', { name: /Disconnect/ })).getByRole('button', { name: 'Cancel' })
        );
        expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    });

    it('a failed disconnect is an alert and the connection stays', async () => {
        stubFetch(lifecycleBoard('write', { status: 500, body: { error: 'Could not disconnect right now.' } }));
        const user = userEvent.setup();
        const { router } = renderApp(DETAIL);

        await pick(user, 'Disconnect');
        await user.click(
            within(await screen.findByRole('dialog', { name: /Disconnect/ })).getByRole('button', {
                name: 'Disconnect',
            })
        );

        expect((await screen.findByRole('alert')).textContent).toContain('Could not disconnect right now.');
        expect(router.state.location.pathname).toBe(DETAIL);
        expect(await screen.findByRole('region', { name: 'Jira connection' })).toBeTruthy();
    });

    it('a 404 on disconnect reads the list again instead of claiming a disconnect', async () => {
        const calls = stubFetch(lifecycleBoard('write', { status: 404, body: { error: 'No such connection' } }));
        const user = userEvent.setup();
        const { router } = renderApp(DETAIL);

        await pick(user, 'Disconnect');
        const reads = () => calls.filter((call) => call.method === 'GET' && call.url === '/api/connections').length;
        const before = reads();
        await user.click(
            within(await screen.findByRole('dialog', { name: /Disconnect/ })).getByRole('button', {
                name: 'Disconnect',
            })
        );

        expect((await screen.findByRole('alert')).textContent).toMatch(/already disconnected/);
        await waitFor(() => expect(reads()).toBeGreaterThan(before));
        expect(screen.queryByText(/^Disconnected /)).toBeNull();
        expect(router.state.location.pathname).toBe(DETAIL);
    });

    it('re-reads the list after a refused start', async () => {
        const calls = stubFetch(
            boardHandler(settingsBoard({ connections: [row] }), ({ method, url }) =>
                method === 'POST' && url === START ? { status: 503, body: { error: 'Not configured' } } : undefined
            )
        );
        const user = userEvent.setup();
        renderApp(DETAIL);

        await user.click(await screen.findByRole('button', { name: 'Reconnect' }));
        expect((await screen.findByRole('alert')).textContent).toContain('Not configured');
        const reads = calls.filter((call) => call.method === 'GET' && call.url === '/api/connections');
        expect(reads.length).toBeGreaterThan(1);
    });

    it('shows a mismatch result once as a bad banner, drops it from the URL and keeps the row', async () => {
        stubFetch(lifecycleBoard('write'));
        const { router } = renderApp(`${DETAIL}?integration=jira&result=identity-mismatch`);

        const banner = (await screen.findByText(/not the account this connection was made with/)).closest(
            '.banner-bad'
        );
        expect(banner?.getAttribute('role')).toBe('alert');
        await waitFor(() => expect(router.state.location.search).toBe(''));
        expect(document.querySelectorAll('.banner-bad')).toHaveLength(1);
        expect(screen.getByRole('region', { name: 'Jira connection' })).toBeTruthy();
    });

    it('shows a denied result as a warning banner', async () => {
        stubFetch(lifecycleBoard('write'));
        renderApp(`${DETAIL}?integration=jira&result=denied`);

        const banner = (await screen.findByText(/consent was denied/)).closest('.banner-warn');
        expect(banner).not.toBeNull();
    });

    it('reaches every action by keyboard, each with a role and a name', async () => {
        stubFetch(lifecycleBoard('write'));
        const user = userEvent.setup();
        renderApp(DETAIL);
        await screen.findByRole('button', { name: 'Reconnect' });

        const name = () => {
            const active = document.activeElement as HTMLElement;
            return active.getAttribute('aria-label') ?? active.textContent;
        };
        for (let i = 0; i < 60 && name() !== 'Reconnect'; i++) await user.tab();
        expect(name()).toBe('Reconnect');
        await user.tab();
        expect(name()).toBe(MENU);
        expect(document.activeElement?.tagName).toBe('BUTTON');
    });

    it('gives the Workspace and Organization pages no Jira connections', async () => {
        stubFetch(boardHandler(settingsBoard({ connections: [row] })));
        const first = renderApp('/settings/workspace');
        await screen.findByRole('heading', { level: 1, name: 'Workspace' });
        expect(screen.queryByRole('region', { name: 'Jira connections' })).toBeNull();
        expect(screen.queryByText(/Jira connection/)).toBeNull();
        first.unmount();

        renderApp('/settings/organization');
        await screen.findByRole('heading', { name: 'Members' });
        expect(screen.queryByRole('region', { name: /Jira/ })).toBeNull();
    });
});
