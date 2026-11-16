import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionView } from '../src/api/connections.js';
import type { ModelSetupView } from '../src/api/useModelSetup.js';
import type { Session } from '../src/api/useSession.js';
import type { WorkspacePayload } from '../src/api/useWorkspace.js';
import { type FetchCall, type FetchReply, renderApp, stubFetch } from './dom.js';
import { memberSession } from './fixtures.js';

/**
 * Setup's closing page, Ready: what was set up as a summary with lamps and a Change link per row, and
 * the first task started in place from the task composer. Start creates the task, marks setup complete,
 * re-reads `/api/auth/me` and only then opens the task; with no model confirmed, Start stays dark.
 */

const TASK_ID = '33333333-3333-4333-8333-333333333333';
const CREATED = '2026-01-01T00:00:00.000Z';

afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
});

const repo = (name: string) => ({ owner: 'acme', name, private: true, defaultBranch: 'main', pushedAt: null });

const personalModel: ModelSetupView = {
    platform: false,
    org: null,
    personal: { provider: 'anthropic', agentType: 'claude-code', model: 'claude-test-model', keyNames: ['K'] },
    effective: 'personal',
};

const workspace: WorkspacePayload = {
    executors: [],
    orgExecutors: [],
    defaultExecutor: null,
    agentDefault: { agentType: 'claude-code', model: 'claude-test-model', from: 'personal' },
};

const jiraConnection: ConnectionView = {
    id: 'c-1',
    provider: 'jira',
    site: 'acme-example.atlassian.net',
    account: 'stub@example.com',
    access: 'read',
    status: 'active',
    needsReconnect: false,
    createdAt: CREATED,
};

interface Replies {
    model?: ModelSetupView | { status: number };
    connections?: ConnectionView[];
    launch?: (call: FetchCall) => FetchReply;
    complete?: FetchReply;
}

/** Ready's board: an unfinished member with both steps answered, the summary's reads and the two writes. */
function board({ model = personalModel, connections = [], launch, complete }: Replies = {}) {
    const setup: Session['setup'] = { completed: false, done: ['model'], skipped: ['tools'] };
    const calls = stubFetch((call: FetchCall) => {
        const { method, url } = call;
        if (url === '/api/auth/me') return memberSession({ setup: { ...setup } });
        if (url === '/api/model-setup') return model;
        if (url === '/api/workspace') return workspace;
        if (url === '/api/repos') {
            return {
                repos: [repo('web'), repo('api')],
                installation: { id: '1', account: 'acme', repositorySelection: 'all' },
                meta: { fetchedAt: CREATED, error: null },
            };
        }
        if (url === '/api/connections') return { connections };
        if (method === 'POST' && url === '/api/jobs')
            return launch ? launch(call) : { status: 201, body: { id: TASK_ID } };
        if (method === 'POST' && url === '/api/onboarding/setup/complete') {
            if (complete !== undefined) return complete;
            setup.completed = true;
            return { status: 204 };
        }
    });
    return calls;
}

const row = async (name: string) => within(await screen.findByRole('listitem', { name }));
const startButton = () => screen.getByRole('button', { name: 'Start task' });
const prompt = () => screen.findByLabelText('What should the agent do?');

describe('the Ready step', () => {
    it("says You're set over a summary row per part, each Change going back to its step", async () => {
        board({ connections: [jiraConnection] });
        renderApp('/onboarding/ready');

        expect(await screen.findByRole('heading', { level: 1, name: "You're set" })).toBeTruthy();
        expect((await row('GitHub')).getByText('Signed in as octocat')).toBeTruthy();

        const repos = await row('Repositories');
        expect(await repos.findByText('acme · all 2, including future ones')).toBeTruthy();
        expect(repos.getByRole('link', { name: /Change/ }).getAttribute('href')).toBe(
            '/api/auth/github?reselect=1&returnTo=%2Fonboarding%2Fready'
        );

        const model = await row('Model');
        expect(await model.findByText('Claude Code · Anthropic · claude-test-model · only you')).toBeTruthy();
        expect(model.getByRole('link', { name: /Change/ }).getAttribute('href')).toMatch(/^\/onboarding\/model\b/);

        const tracker = await row('Issue tracker');
        expect(await tracker.findByText('Jira · acme-example.atlassian.net')).toBeTruthy();
        expect(tracker.getByRole('link', { name: /Change/ }).getAttribute('href')).toMatch(/^\/onboarding\/tools\b/);
        expect(document.querySelectorAll('.ready-lamp[data-state="ok"]').length).toBe(4);
    });

    it('says the model is provided by this deployment, with the chosen agent and model', async () => {
        board({
            model: {
                platform: true,
                org: null,
                personal: { provider: 'platform', agentType: 'opencode', model: 'platform-model', keyNames: [] },
                effective: 'platform',
            },
        });
        renderApp('/onboarding/ready');
        const model = await row('Model');
        expect(await model.findByText('OpenCode · platform-model · provided by this deployment')).toBeTruthy();
    });

    it('a tracker never connected is optional, and a failed model read never says Not connected', async () => {
        board({ model: { status: 500 } });
        renderApp('/onboarding/ready');
        const tracker = await row('Issue tracker');
        expect(await tracker.findByText('Not connected — optional')).toBeTruthy();
        const model = await row('Model');
        expect(await model.findByText('Could not check the model.')).toBeTruthy();
        expect(model.queryByText('Not connected')).toBeNull();
        expect(screen.getByRole('heading', { level: 1, name: "You're set" })).toBeTruthy();
        // An unconfirmed read never blocks Start: the composer is there.
        expect(await prompt()).toBeTruthy();
    });

    it('preselects the first tracked repository and fills the prompt from a starter', async () => {
        const user = userEvent.setup();
        board();
        renderApp('/onboarding/ready');
        expect(await screen.findByRole('button', { name: 'Repository: acme/web' })).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Fix a flaky test' }));
        expect(((await prompt()) as HTMLTextAreaElement).value).toBe(
            'Find and fix one flaky test. Explain the cause in the pull request.'
        );
    });

    it('Start creates the task on the agent default, completes setup, re-reads the session, then opens the task', async () => {
        const user = userEvent.setup();
        const calls = board();
        const { router } = renderApp('/onboarding/ready?returnTo=%2Fsettings');
        await user.type(await prompt(), 'fix the login crash');
        await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
        await user.click(startButton());

        await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${TASK_ID}`));
        const launch = calls.find((c) => c.method === 'POST' && c.url === '/api/jobs')!;
        expect(launch.body).toMatchObject({ command: 'fix the login crash', repo: 'acme/web' });
        expect(launch.body).not.toHaveProperty('executor');
        expect(launch.headers['idempotency-key']).toMatch(/^[\w.:-]{8,128}$/);
        const completeAt = calls.findIndex((c) => c.method === 'POST' && c.url === '/api/onboarding/setup/complete');
        expect(completeAt).toBeGreaterThan(calls.indexOf(launch));
        expect(calls.slice(completeAt).some((c) => c.url === '/api/auth/me')).toBe(true);
    });

    it('a refused start keeps the draft, leaves setup open, and the retry carries the same key', async () => {
        const user = userEvent.setup();
        let refusals = 1;
        const calls = board({
            launch: () =>
                refusals-- > 0
                    ? { status: 500, body: { error: 'The board is busy.' } }
                    : { status: 201, body: { id: TASK_ID } },
        });
        const { router } = renderApp('/onboarding/ready');
        await user.type(await prompt(), 'fix the login crash');
        await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
        await user.click(startButton());

        expect(await screen.findByText(/The board is busy/)).toBeTruthy();
        expect(router.state.location.pathname).toBe('/onboarding/ready');
        expect(((await prompt()) as HTMLTextAreaElement).value).toBe('fix the login crash');
        expect(calls.some((c) => c.url === '/api/onboarding/setup/complete')).toBe(false);

        await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
        await user.click(startButton());
        await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${TASK_ID}`));
        const [refused, accepted] = calls.filter((c) => c.method === 'POST' && c.url === '/api/jobs');
        expect(accepted!.headers['idempotency-key']).toBe(refused!.headers['idempotency-key']);
    });

    it('a complete that fails after the task exists still opens the task, and the next Ready load retries it', async () => {
        const user = userEvent.setup();
        const calls = board({ complete: { status: 500, body: { error: 'down' } } });
        const first = renderApp('/onboarding/ready');
        // The task page sends the still-unfinished member straight back here, so record every place it went.
        const visited: string[] = [];
        first.router.subscribe((state) => visited.push(state.location.pathname));
        await user.type(await prompt(), 'fix the login crash');
        await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
        await user.click(startButton());
        await waitFor(() => expect(visited).toContain(`/tasks/${TASK_ID}`));
        // Back on Ready, the held task is finished, never offered again: no composer, Try again instead.
        expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
        expect(screen.queryByLabelText('What should the agent do?')).toBeNull();
        first.unmount();

        vi.unstubAllGlobals();
        const again = board();
        const second = renderApp('/onboarding/ready');
        await waitFor(() => expect(second.router.state.location.pathname).toBe(`/tasks/${TASK_ID}`));
        expect(again.some((c) => c.method === 'POST' && c.url === '/api/onboarding/setup/complete')).toBe(true);
        expect(again.some((c) => c.method === 'POST' && c.url === '/api/jobs')).toBe(false);
        expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/jobs')).toHaveLength(1);
    });

    it('Go to the dashboard instead completes setup and goes to returnTo', async () => {
        const user = userEvent.setup();
        const calls = board();
        const { router } = renderApp('/onboarding/ready?returnTo=%2Fsettings');
        await user.click(await screen.findByRole('button', { name: 'Go to the dashboard instead' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
        expect(calls.some((c) => c.method === 'POST' && c.url === '/api/onboarding/setup/complete')).toBe(true);
        expect(calls.some((c) => c.method === 'POST' && c.url === '/api/jobs')).toBe(false);
    });

    it('with no model, says Almost set, and Start is aria-disabled behind a warning that links to the model step', async () => {
        const user = userEvent.setup();
        const calls = board({ model: { platform: false, org: null, personal: null, effective: null } });
        renderApp('/onboarding/ready');

        expect(await screen.findByRole('heading', { level: 1, name: 'Almost set' })).toBeTruthy();
        const model = await row('Model');
        expect(model.getByText('Not connected')).toBeTruthy();
        const warning = document.querySelector('.ready-no-model')!;
        expect(warning.textContent).toContain('No model yet — tasks will wait until one is connected');
        expect(
            within(warning as HTMLElement)
                .getByRole('link', { name: 'Connect a model' })
                .getAttribute('href')
        ).toMatch(/^\/onboarding\/model\b/);
        const start = startButton();
        expect(start.getAttribute('aria-disabled')).toBe('true');
        expect(start.getAttribute('aria-describedby')).toBe(warning.id);
        await user.click(start);
        expect(calls.some((c) => c.method === 'POST' && c.url === '/api/jobs')).toBe(false);
        expect(document.querySelectorAll('button.primary')).toHaveLength(1);
    });
});
