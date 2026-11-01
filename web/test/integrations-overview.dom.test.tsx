import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OPEN_BOARD_SESSION, renderApp, stubFetch, type FetchHandler } from './dom.js';
import { boardHandler, connection, settingsBoard } from './settings-board.js';

/** The Integrations overview mounted on its real route over a stubbed board. */

const PATH = '/settings/integrations';

const withConnections = (reply: unknown): FetchHandler =>
    boardHandler(settingsBoard(), ({ method, url }) =>
        method === 'GET' && url === '/api/connections' ? (reply as never) : undefined
    );

describe('the Integrations overview', () => {
    it('lists each connection as a link to its own page, distinguishing two sites of one provider', async () => {
        const first = connection('acme-example.atlassian.net', { account: 'dev@acme-example.test' });
        const second = connection('beta-example.atlassian.net', { account: 'ops@beta-example.test' });
        stubFetch(withConnections({ connections: [first, second] }));
        renderApp(PATH);

        expect(await screen.findByRole('heading', { level: 1, name: 'Integrations' })).toBeTruthy();
        const one = await screen.findByRole('link', {
            name: /Jira.*acme-example\.atlassian\.net.*dev@acme-example\.test/,
        });
        const two = await screen.findByRole('link', {
            name: /Jira.*beta-example\.atlassian\.net.*ops@beta-example\.test/,
        });
        expect(one.getAttribute('href')).toBe(`/settings/integrations/jira/${first.id}`);
        expect(two.getAttribute('href')).toBe(`/settings/integrations/jira/${second.id}`);
        expect(within(one).getByText('Connected')).toBeTruthy();
        expect(within(two).getByText('Connected')).toBeTruthy();
    });

    it('says Needs reconnect for a connection whose grant needs reconnecting', async () => {
        stubFetch(
            withConnections({ connections: [connection('acme-example.atlassian.net', { needsReconnect: true })] })
        );
        renderApp(PATH);

        const link = await screen.findByRole('link', { name: /acme-example\.atlassian\.net/ });
        expect(within(link).getByText('Needs reconnect')).toBeTruthy();
        expect(within(link).queryByText('Connected')).toBeNull();
    });

    it('announces a failed read as an alert, with no empty-state sentence', async () => {
        stubFetch(withConnections({ status: 500, body: { error: 'database is down' } }));
        renderApp(PATH);

        expect((await screen.findByRole('alert')).textContent).toContain('database is down');
        expect(screen.queryByText('No integrations connected yet.')).toBeNull();
    });

    it('treats a malformed row as an error, not as an empty list', async () => {
        stubFetch(withConnections({ connections: [{ id: 'x', provider: 'jira' }] }));
        renderApp(PATH);

        expect((await screen.findByRole('alert')).textContent).toMatch(/unexpected response shape/);
        expect(screen.queryByText('No integrations connected yet.')).toBeNull();
    });

    it('treats a row without needsReconnect as malformed', async () => {
        const { needsReconnect: _needsReconnect, ...old } = connection('acme-example.atlassian.net');
        stubFetch(withConnections({ connections: [old] }));
        renderApp(PATH);

        expect((await screen.findByRole('alert')).textContent).toMatch(/unexpected response shape/);
    });

    it('says the session expired on a 401, not that nothing is connected', async () => {
        stubFetch(withConnections({ status: 401, body: { error: 'no session' } }));
        renderApp(PATH);

        expect((await screen.findByRole('alert')).textContent).toContain('Your session expired');
        expect(screen.queryByText('No integrations connected yet.')).toBeNull();
    });

    it('offers Browse as the way to connect when nothing is connected', async () => {
        stubFetch(withConnections({ connections: [] }));
        renderApp(PATH);

        expect(await screen.findByText('No integrations connected yet.')).toBeTruthy();
        const links = screen.getAllByRole('link', { name: /Browse integrations/ });
        expect(links.length).toBeGreaterThan(1);
        for (const link of links) expect(link.getAttribute('href')).toBe('/settings/integrations/available');
    });

    it('has a Browse integrations call to action in the header', async () => {
        stubFetch(withConnections({ connections: [connection('acme-example.atlassian.net')] }));
        renderApp(PATH);

        await screen.findByRole('link', { name: /acme-example\.atlassian\.net/ });
        const browse = screen.getByRole('link', { name: 'Browse integrations' });
        expect(browse.getAttribute('href')).toBe('/settings/integrations/available');
    });

    it('previews the organization providers read-only, and never a planned one', async () => {
        stubFetch(withConnections({ connections: [connection('acme-example.atlassian.net')] }));
        renderApp(PATH);

        await screen.findByRole('link', { name: /acme-example\.atlassian\.net/ });
        const preview = within(screen.getByRole('list', { name: 'Available integrations' }));
        expect(preview.getAllByRole('listitem').map((item) => item.getAttribute('aria-label'))).toEqual(['GitHub']);
        expect(preview.getByText('Organization')).toBeTruthy();
        expect(screen.queryByText('Planned')).toBeNull();
        expect(preview.queryByRole('button')).toBeNull();
        expect(preview.queryByRole('link')).toBeNull();
    });

    it('shows the connected sentence once for a successful callback, then drops it from the URL', async () => {
        stubFetch(withConnections({ connections: [] }));
        const { router } = renderApp(`${PATH}?integration=jira&result=connected`);

        expect(await screen.findByText('Jira connected.')).toBeTruthy();
        await waitFor(() => expect(router.state.location.search).toBe(''));
        expect(screen.getAllByText('Jira connected.')).toHaveLength(1);
    });

    it.each(['error', 'state-mismatch'])('shows a failed callback (%s) in the bad banner', async (result) => {
        stubFetch(withConnections({ connections: [] }));
        renderApp(`${PATH}?integration=jira&result=${result}`);

        const banner = await screen.findByText(`Jira connection failed (${result}).`);
        expect(banner.closest('.banner-bad')).not.toBeNull();
    });

    it('reads and renders the list for the open-mode local caller', async () => {
        const row = connection('acme-example.atlassian.net');
        const calls = stubFetch(
            boardHandler(settingsBoard({ connections: [row] }), ({ method, url }) =>
                method === 'GET' && url === '/api/auth/me' ? (OPEN_BOARD_SESSION as never) : undefined
            )
        );
        renderApp(PATH);

        expect(await screen.findByRole('link', { name: /acme-example\.atlassian\.net/ })).toBeTruthy();
        await waitFor(() => expect(calls.some((call) => call.url === '/api/connections')).toBe(true));
    });
});
