import { INTEGRATION_CATALOG, type IntegrationProvider } from '@factory-ai/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionView } from '../src/api/connections.js';
import type { Session } from '../src/api/useSession.js';
import { ALLOW_COMMENTS_LABEL } from '../src/components/WriteConsentDialog.js';
import { ToolsStep } from '../src/onboarding/ToolsStep.js';
import { renderApp, renderAt, stubFetch, type FetchCall } from './dom.js';
import { memberSession } from './fixtures.js';
import { connection } from './settings-board.js';

/**
 * Setup step 3, Connect your issue tracker: GitHub is always connected, every configured OAuth provider of the
 * catalog gets a card, a connection is shown only from the connections read (never the callback's query), and an
 * unconfirmed read is an error with Retry, never "only GitHub".
 */

const PATH = '/onboarding/tools?returnTo=%2Ftasks';
const CONSENT_URL = 'https://auth.example.test/authorize?state=s';
const SITE = 'acme-example.atlassian.net';
const ACCOUNT = 'stub-account-a@example.com';

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
});

const spyNavigation = () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    return assign;
};

interface Replies {
    configured?: Record<string, boolean> | { status: number };
    connections?: ConnectionView[] | { status: number };
}

/** The step's board: an unfinished member, the two reads, the authorization start and the setup writes. */
function board({ configured = { jira: true }, connections = [] }: Replies = {}) {
    const state = { configured, connections };
    const setup: Session['setup'] = { completed: false, done: ['model'], skipped: [] };
    const calls = stubFetch((call: FetchCall) => {
        const { method, url } = call;
        if (url === '/api/auth/me') return memberSession({ setup });
        if (method === 'GET' && url === '/api/integrations') {
            const answer = state.configured;
            return 'status' in answer && typeof answer.status === 'number'
                ? answer
                : { integrations: Object.entries(answer).map(([provider, on]) => ({ provider, configured: on })) };
        }
        if (method === 'GET' && url === '/api/connections') {
            return Array.isArray(state.connections) ? { connections: state.connections } : state.connections;
        }
        if (method === 'POST' && url.endsWith('/authorizations')) {
            return { authorizationId: 'a-1', authorizeUrl: CONSENT_URL, expiresAt: '2026-11-15T12:00:00.000Z' };
        }
        if (method === 'DELETE' && url.startsWith('/api/connections/')) return { status: 204 };
        if (method === 'POST' && url === '/api/onboarding/setup') {
            const { action } = call.body as { action: 'done' | 'skip' };
            setup[action === 'done' ? 'done' : 'skipped'].push('tools');
            return { status: 204 };
        }
    });
    return { calls, state };
}

const card = async (name: string) => within(await screen.findByRole('listitem', { name }));

describe('the issue-tracker step', () => {
    it('shows GitHub connected for the org and a card per configured provider, with its purpose', async () => {
        board();
        renderApp(PATH);

        expect(await screen.findByRole('heading', { level: 1, name: 'Connect your issue tracker' })).toBeTruthy();
        const github = await card('GitHub');
        expect(github.getByText('Connected · Bellows AI')).toBeTruthy();
        const jira = await card('Jira');
        expect(jira.getByText('Let tasks look up and comment on your Jira issues.')).toBeTruthy();
        expect(jira.getByRole('button', { name: 'Connect Jira' })).toBeTruthy();
        expect(jira.getByRole('checkbox', { name: ALLOW_COMMENTS_LABEL })).toBeTruthy();
        expect(screen.getByText('More in Settings → Integrations, once setup is done.')).toBeTruthy();
        expect(screen.queryByRole('link', { name: /Settings → Integrations/ })).toBeNull();
        expect(screen.getByRole('button', { name: 'Skip for now' }).className).toBe('primary');
    });

    it('shows only GitHub and the footer when no provider is configured here', async () => {
        board({ configured: { jira: false } });
        renderApp(PATH);

        expect(await screen.findByText(/More in/)).toBeTruthy();
        await card('GitHub');
        const trackers = within(screen.getByRole('list', { name: 'Issue trackers' })).getAllByRole('listitem');
        expect(trackers.map((item) => item.getAttribute('aria-label'))).toEqual(['GitHub']);
        expect(screen.queryByRole('button', { name: /Connect/ })).toBeNull();
    });

    it('shows a provider added to the catalog, with no change to the step', async () => {
        const acme: IntegrationProvider = {
            id: 'acme',
            label: 'Acme Tracker',
            category: 'Issue tracking',
            availability: 'oauth',
            description: 'Let tasks read Acme issues.',
        };
        board({ configured: { jira: false, acme: true } });
        renderAt(<ToolsStep catalog={[...INTEGRATION_CATALOG, acme]} />, PATH);

        const tracker = await card('Acme Tracker');
        expect(tracker.getByText('Let tasks read Acme issues.')).toBeTruthy();
        expect(tracker.getByRole('button', { name: 'Connect Acme Tracker' })).toBeTruthy();
        expect(screen.queryByRole('listitem', { name: 'Jira' })).toBeNull();
    });

    it('starts the OAuth flow back to this step, asking for write only when comments are allowed', async () => {
        const { calls } = board();
        const assign = spyNavigation();
        const user = userEvent.setup();
        renderApp(PATH);

        const jira = await card('Jira');
        await user.click(jira.getByRole('checkbox', { name: ALLOW_COMMENTS_LABEL }));
        await user.click(jira.getByRole('button', { name: 'Connect Jira' }));

        await waitFor(() => expect(assign).toHaveBeenCalledWith(CONSENT_URL));
        const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/authorizations'));
        expect(post?.url).toBe('/api/integrations/jira/authorizations');
        expect(post?.body).toEqual({ access: 'write', returnTo: PATH });
    });

    it('asks for read access when comments are not allowed', async () => {
        const { calls } = board();
        spyNavigation();
        const user = userEvent.setup();
        renderApp(PATH);

        await user.click((await card('Jira')).getByRole('button', { name: 'Connect Jira' }));
        await waitFor(() => expect(calls.some((call) => call.url.endsWith('/authorizations'))).toBe(true));
        expect(calls.find((call) => call.url.endsWith('/authorizations'))?.body).toMatchObject({ access: 'read' });
    });

    it('on return shows the notice and the connection, with Disconnect, and Continue records the step done', async () => {
        const { calls } = board({ connections: [connection(SITE)] });
        const user = userEvent.setup();
        const { router } = renderApp(`${PATH}&integration=jira&result=connected`);

        expect(await screen.findByText('Jira connected.')).toBeTruthy();
        const jira = await card('Jira');
        expect(await jira.findByText(`Connected as ${ACCOUNT} · ${SITE}`)).toBeTruthy();
        expect(jira.queryByRole('button', { name: 'Connect Jira' })).toBeNull();
        await user.click(jira.getByRole('button', { name: `Actions for ${SITE} for ${ACCOUNT}` }));
        expect(await screen.findByRole('menuitem', { name: 'Disconnect' })).toBeTruthy();
        await user.keyboard('{Escape}');

        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(calls.some((call) => call.url === '/api/onboarding/setup')).toBe(true));
        expect(calls.find((call) => call.url === '/api/onboarding/setup')?.body).toEqual({
            step: 'tools',
            action: 'done',
        });
        await waitFor(() => expect(router.state.location.pathname).toBe('/onboarding/ready'));
    });

    it('disconnects after the confirmation and reads the connections again', async () => {
        const { calls, state } = board({ connections: [connection(SITE, { id: 'c-9' })] });
        const user = userEvent.setup();
        renderApp(PATH);

        const jira = await card('Jira');
        await user.click(await jira.findByRole('button', { name: `Actions for ${SITE} for ${ACCOUNT}` }));
        state.connections = [];
        await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));

        await waitFor(() =>
            expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/connections/c-9')).toBe(true)
        );
        expect(await jira.findByRole('button', { name: 'Connect Jira' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Skip for now' })).toBeTruthy();
    });

    it('trusts the connections read, not the query: a result with no row is not shown connected', async () => {
        board();
        renderApp(`${PATH}&integration=jira&result=connected`);

        const jira = await card('Jira');
        expect(await jira.findByRole('button', { name: 'Connect Jira' })).toBeTruthy();
        expect(jira.queryByText(/Connected as/)).toBeNull();
        expect(screen.getByRole('button', { name: 'Skip for now' })).toBeTruthy();
    });

    it('Skip for now records the step skipped', async () => {
        const { calls } = board();
        const user = userEvent.setup();
        renderApp(PATH);

        await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
        await waitFor(() => expect(calls.some((call) => call.url === '/api/onboarding/setup')).toBe(true));
        expect(calls.find((call) => call.url === '/api/onboarding/setup')?.body).toEqual({
            step: 'tools',
            action: 'skip',
        });
    });

    it.each([
        ['the configuration', { configured: { status: 500 } }],
        ['the connections', { connections: { status: 500 } }],
    ] as const)('says a failed read of %s with Retry, never "only GitHub"', async (_what, replies) => {
        const { state } = board(replies);
        const user = userEvent.setup();
        renderApp(PATH);

        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByText(/More in/)).toBeNull();
        expect(screen.queryByRole('listitem', { name: 'Jira' })).toBeNull();
        state.configured = { jira: true };
        state.connections = [];
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByRole('listitem', { name: 'Jira' })).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
