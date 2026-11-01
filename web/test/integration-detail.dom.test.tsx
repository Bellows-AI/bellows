import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { commitDate } from '../src/format.js';
import { renderApp, stubFetch, type FetchHandler } from './dom.js';
import { boardHandler, connection, settingsBoard } from './settings-board.js';

/** One integration's page: read-only in this slice, found by provider and connection id. */

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
