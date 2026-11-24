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

const repo = (name: string) => ({
    id: `acme/${name}`,
    forge: 'github',
    host: 'github.com',
    path: `acme/${name}`,
    private: true,
    defaultBranch: 'main',
    pushedAt: null,
});

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
    mode?: Session['deploymentMode'];
    space?: WorkspacePayload;
    /** `/api/repos`, answered afresh on each read. */
    repos?: () => FetchReply;
    connectionsReply?: () => FetchReply;
}

/** Ready's board: an unfinished member with both steps answered, the summary's reads and the two writes. */
function board({
    model = personalModel,
    connections = [],
    launch,
    complete,
    mode = 'self-hosted',
    space = workspace,
    repos,
    connectionsReply,
}: Replies = {}) {
    const setup: Session['setup'] = { completed: false, done: ['model'], skipped: ['tools'] };
    const calls = stubFetch((call: FetchCall) => {
        const { method, url } = call;
        if (url === '/api/auth/me') return memberSession({ setup: { ...setup }, deploymentMode: mode });
        if (url === '/api/model-setup') return model;
        if (url === '/api/workspace') return space;
        if (url === '/api/repos') {
            if (repos) return repos();
            return {
                repos: [repo('web'), repo('api')],
                installation: { id: '1', account: 'acme', repositorySelection: 'all' },
                meta: { fetchedAt: CREATED, error: null },
            };
        }
        if (url === '/api/connections') return connectionsReply ? connectionsReply() : { connections };
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

    it('the composer asks for a task in the chosen repository, the starters right under the prompt, inline in a wide column', async () => {
        board();
        const { container } = renderApp('/onboarding/ready');
        const field = (await prompt()) as HTMLTextAreaElement;
        expect(field.placeholder).toBe('Describe a task for acme/web…');
        // The starters sit inside the chat input, between the prompt and the control bar.
        const chat = field.closest('.chat-input');
        const starters = screen.getByRole('button', { name: 'Fix a flaky test' }).closest('.ready-starters');
        expect(starters?.parentElement).toBe(chat);
        expect(starters?.nextElementSibling?.classList.contains('chat-input-bar')).toBe(true);
        // The inline composer does not fill the page the way /tasks/new does, in the wider setup column.
        expect(container.querySelector('.task-compose')?.classList.contains('task-compose-inline')).toBe(true);
        expect(container.querySelector('main.onboarding')?.classList.contains('onboarding-wide')).toBe(true);
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
        expect(launch.body).toMatchObject({
            command: 'fix the login crash',
            repo: { forge: 'github', host: 'github.com', path: 'acme/web' },
        });
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

    const NO_KEY: ModelSetupView = { platform: false, org: null, personal: null, effective: null };
    const BARE: WorkspacePayload = { executors: [], orgExecutors: [], defaultExecutor: null, agentDefault: null };

    it("self-hosted with no key but an agent default: You're set, the default in the Model row, Start live", async () => {
        board({ model: NO_KEY });
        renderApp('/onboarding/ready');
        expect(await screen.findByRole('heading', { level: 1, name: "You're set" })).toBeTruthy();
        expect(await (await row('Model')).findByText('Claude Code · claude-test-model')).toBeTruthy();
        expect(await prompt()).toBeTruthy();
        expect(document.querySelector('.ready-no-model')).toBeNull();
    });

    for (const [where, mode, space] of [
        ['cloud, even with an agent default', 'cloud', workspace],
        ['self-hosted with nothing to run on', 'self-hosted', BARE],
    ] as const) {
        it(`with no model (${where}), says Almost set, and Start is aria-disabled behind a warning that links to the model step`, async () => {
            const user = userEvent.setup();
            const calls = board({ model: NO_KEY, mode, space });
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
    }
});

describe('the Ready summary on a read it could not confirm', () => {
    const listing = (names: string[], error: string | null) => ({
        repos: names.map(repo),
        installation: { id: '1', account: 'acme', repositorySelection: 'selected' },
        meta: { fetchedAt: CREATED, error },
    });

    it('an empty listing that came with an error is not "0 selected": it says so, and Retry re-reads', async () => {
        const user = userEvent.setup();
        let answer = listing([], 'GitHub is unreachable');
        const calls = board({ repos: () => answer });
        renderApp('/onboarding/ready');
        const repos = await row('Repositories');
        expect(await repos.findByText("Couldn't load repositories")).toBeTruthy();
        expect(repos.queryByText(/0 selected/)).toBeNull();
        expect(document.querySelector('[aria-label="Repositories"] .ready-lamp')?.getAttribute('data-state')).toBe(
            'idle'
        );

        answer = listing(['web'], null);
        await user.click(repos.getByRole('button', { name: 'Retry repositories' }));
        expect(await repos.findByText('acme · 1 selected')).toBeTruthy();
        expect(calls.filter((c) => c.url === '/api/repos').length).toBeGreaterThanOrEqual(2);
    });

    it('a failed model or tracker read offers Retry, never a verdict', async () => {
        const user = userEvent.setup();
        let connectionsFail = true;
        board({
            model: { status: 500 },
            connectionsReply: () => (connectionsFail ? { status: 503 } : { connections: [] }),
        });
        renderApp('/onboarding/ready');
        const model = await row('Model');
        expect(await model.findByText('Could not check the model.')).toBeTruthy();
        expect(model.getByRole('button', { name: 'Retry model' })).toBeTruthy();
        const tracker = await row('Issue tracker');
        expect(await tracker.findByText('Could not check the issue trackers.')).toBeTruthy();
        expect(tracker.queryByText(/Not connected/)).toBeNull();
        connectionsFail = false;
        await user.click(tracker.getByRole('button', { name: 'Retry issue tracker' }));
        expect(await tracker.findByText('Not connected — optional')).toBeTruthy();
    });
});

describe("the Ready composer's draft", () => {
    const typeDraft = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(await prompt(), 'fix the login crash');
        await user.click(await screen.findByRole('button', { name: 'Repository: acme/web' }));
        await user.click(await screen.findByRole('option', { name: 'acme/api' }));
        expect(await screen.findByRole('button', { name: 'Repository: acme/api' })).toBeTruthy();
    };
    const expectDraft = async () => {
        await waitFor(async () => expect(((await prompt()) as HTMLTextAreaElement).value).toBe('fix the login crash'));
        expect(await screen.findByRole('button', { name: 'Repository: acme/api' })).toBeTruthy();
    };

    it('survives a Change to the model step and back', async () => {
        const user = userEvent.setup();
        board();
        const { router } = renderApp('/onboarding/ready');
        await typeDraft(user);
        await user.click((await row('Model')).getByRole('link', { name: /Change/ }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/onboarding/model'));
        await router.navigate('/onboarding/ready');
        await expectDraft();
    });

    it('survives a reload (the reselect round trip is a full page load)', async () => {
        const user = userEvent.setup();
        board();
        const first = renderApp('/onboarding/ready');
        await typeDraft(user);
        first.unmount();
        renderApp('/onboarding/ready');
        await expectDraft();
    });

    it('is gone after a successful Start', async () => {
        const user = userEvent.setup();
        board();
        const first = renderApp('/onboarding/ready');
        await typeDraft(user);
        await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
        await user.click(startButton());
        await waitFor(() => expect(first.router.state.location.pathname).toBe(`/tasks/${TASK_ID}`));
        first.unmount();
        renderApp('/onboarding/ready');
        expect(await screen.findByRole('button', { name: 'Repository: acme/web' })).toBeTruthy();
        expect(((await prompt()) as HTMLTextAreaElement).value).toBe('');
    });
});
