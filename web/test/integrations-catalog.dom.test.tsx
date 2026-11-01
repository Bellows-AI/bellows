import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsIntegrationsCatalogPage } from '../src/pages/SettingsIntegrationsCatalogPage.js';
import { renderApp, renderAt, stubFetch, type FetchHandler } from './dom.js';
import { boardHandler, connection, settingsBoard } from './settings-board.js';

/** The Browse integrations catalog on its real route over a stubbed board. */

const PATH = '/settings/integrations/available';
const CONSENT_URL = 'https://auth.example.test/authorize?state=s';

afterEach(() => vi.unstubAllGlobals());

const spyNavigation = () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    return assign;
};

/** The board with `GET /api/integrations` and/or `GET /api/connections` answered by hand. */
const board = (replies: { config?: unknown; connections?: unknown; start?: unknown } = {}): FetchHandler =>
    boardHandler(settingsBoard(), ({ method, url }) => {
        if (method === 'GET' && url === '/api/integrations' && replies.config !== undefined) return replies.config;
        if (method === 'GET' && url === '/api/connections' && replies.connections !== undefined) {
            return replies.connections as never;
        }
        if (method === 'POST' && url === '/api/integrations/jira/authorizations' && replies.start !== undefined) {
            return replies.start as never;
        }
    });

const card = async (name: string) => within(await screen.findByRole('listitem', { name }));

describe('the integrations catalog', () => {
    it('has the page heading, a Back link and a pressed-state filter per category', async () => {
        stubFetch(board());
        renderApp(PATH);

        expect(await screen.findByRole('heading', { level: 1, name: 'Browse integrations' })).toBeTruthy();
        expect(screen.getByRole('link', { name: /Back/ }).getAttribute('href')).toBe('/settings/integrations');
        for (const name of ['All', 'Issue tracking', 'Communication', 'Agent tools', 'CI / DevOps']) {
            expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe(
                name === 'All' ? 'true' : 'false'
            );
        }
    });

    it('filters to one category and marks the pressed button', async () => {
        const user = userEvent.setup();
        stubFetch(board());
        renderApp(PATH);

        await user.click(await screen.findByRole('button', { name: 'Communication' }));
        const list = within(screen.getByRole('list', { name: 'Available integrations' }));
        const names = list.getAllByRole('listitem').map((item) => item.getAttribute('aria-label'));
        expect(names).toEqual(['Slack', 'Discord']);
        expect(screen.getByRole('button', { name: 'Communication' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('false');
    });

    it('marks planned providers Planned and gives them no Connect', async () => {
        stubFetch(board());
        renderApp(PATH);

        for (const name of ['Slack', 'Discord', 'GitLab', 'MCP servers']) {
            const planned = await card(name);
            expect(planned.getByText('Planned')).toBeTruthy();
            expect(planned.queryByRole('button', { name: /Connect/ })).toBeNull();
        }
    });

    it('offers Connect for a configured Jira with no connection, and posts the integrations page as returnTo', async () => {
        const user = userEvent.setup();
        const assign = spyNavigation();
        const calls = stubFetch(board({ start: { status: 201, body: { authorizeUrl: CONSENT_URL } } }));
        renderApp(PATH);

        await user.click((await card('Jira')).getByRole('button', { name: 'Connect' }));
        const dialog = await screen.findByRole('dialog', { name: 'Connect Jira' });
        await user.click(within(dialog).getByRole('button', { name: 'Continue to Atlassian' }));

        await waitFor(() => expect(assign).toHaveBeenCalledWith(CONSENT_URL));
        const post = calls.find((call) => call.method === 'POST');
        expect(post?.url).toBe('/api/integrations/jira/authorizations');
        expect(post?.body).toMatchObject({ access: 'read', returnTo: '/settings/integrations' });
    });

    it('shows Connected, a Manage link to the overview and Connect another for a provider with rows', async () => {
        stubFetch(
            boardHandler(
                settingsBoard({
                    connections: [connection('acme-example.atlassian.net'), connection('beta-example.atlassian.net')],
                })
            )
        );
        renderApp(PATH);

        const jira = await card('Jira');
        expect(await jira.findByText('Connected')).toBeTruthy();
        expect(jira.getByRole('link', { name: /Manage/ }).getAttribute('href')).toBe('/settings/integrations');
        expect(jira.getByRole('button', { name: 'Connect another' })).toBeTruthy();
    });

    it('says Not configured on this deployment, with no Connect, when Jira is not configured', async () => {
        stubFetch(boardHandler(settingsBoard({ jiraConfigured: false })));
        renderApp(PATH);

        const jira = await card('Jira');
        expect(await jira.findByText('Not configured on this deployment')).toBeTruthy();
        expect(jira.queryByRole('button', { name: /Connect/ })).toBeNull();
    });

    it.each([
        ['a 500', { status: 500, body: { error: 'database is down' } }],
        ['a 404', { status: 404, body: { error: 'No such route' } }],
        ['a 401', { status: 401, body: { error: 'no session' } }],
        ['a malformed body', { integrations: [{ provider: 'jira', configured: 'yes' }] }],
        ['a body that is not a list', { integrations: 'nope' }],
    ])(
        'says it could not check, with a retry and neither Connect nor Not configured, after %s',
        async (_name, config) => {
            const user = userEvent.setup();
            stubFetch(board({ config }));
            renderApp(PATH);

            const jira = await card('Jira');
            expect(await jira.findByText('Could not check whether Jira is available')).toBeTruthy();
            expect(jira.queryByRole('button', { name: /Connect/ })).toBeNull();
            expect(jira.queryByText('Not configured on this deployment')).toBeNull();
            expect(jira.getByRole('button', { name: 'Retry' })).toBeTruthy();
            // The retry asks again.
            stubFetch(board());
            await user.click(jira.getByRole('button', { name: 'Retry' }));
            expect(await jira.findByRole('button', { name: 'Connect' })).toBeTruthy();
        }
    );

    it('shows neither Connected nor Manage when the connections read fails', async () => {
        stubFetch(board({ connections: { status: 500, body: { error: 'database is down' } } }));
        renderApp(PATH);

        const jira = await card('Jira');
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('database is down'));
        expect(jira.queryByText('Connected')).toBeNull();
        expect(jira.queryByRole('link', { name: /Manage/ })).toBeNull();
    });

    it('says a category with nothing in it is empty', async () => {
        const user = userEvent.setup();
        stubFetch(board());
        const { INTEGRATION_PROVIDERS } = await import('../src/settings/integration-providers.js');
        renderAt(
            <SettingsIntegrationsCatalogPage providers={INTEGRATION_PROVIDERS.filter((p) => p.id === 'jira')} />,
            PATH
        );

        await user.click(await screen.findByRole('button', { name: 'Communication' }));
        expect(screen.getByText('Nothing in this category yet.')).toBeTruthy();
    });

    it('lists GitHub as an organization integration linking to Repositories, never connectable or Connected', async () => {
        stubFetch(boardHandler(settingsBoard({ connections: [connection('acme-example.atlassian.net')] })));
        renderApp(PATH);

        const github = await card('GitHub');
        expect(github.getByText('Organization')).toBeTruthy();
        expect(github.getByRole('link').getAttribute('href')).toBe('/settings/repos');
        expect(github.queryByRole('button', { name: /Connect/ })).toBeNull();
        expect(github.queryByText('Connected')).toBeNull();
    });

    it('shows a start refusal beside the control and lets the member try again', async () => {
        const user = userEvent.setup();
        spyNavigation();
        stubFetch(
            board({ start: { status: 503, body: { error: 'Jira OAuth is not configured on this deployment' } } })
        );
        renderApp(PATH);

        await user.click((await card('Jira')).getByRole('button', { name: 'Connect' }));
        const dialog = await screen.findByRole('dialog', { name: 'Connect Jira' });
        await user.click(within(dialog).getByRole('button', { name: 'Continue to Atlassian' }));

        expect((await within(dialog).findByRole('alert')).textContent).toContain('not configured on this deployment');
        expect(
            (within(dialog).getByRole('button', { name: 'Continue to Atlassian' }) as HTMLButtonElement).disabled
        ).toBe(false);
    });
});
