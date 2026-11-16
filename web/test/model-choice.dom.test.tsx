import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspacePayload } from '../src/api/useWorkspace.js';
import type { ModelSetupView } from '../src/api/useModelSetup.js';
import { readReadyDraft, writeReadyDraft } from '../src/onboarding/ready-draft.js';
import { initialComposerState } from '../src/task-composer.js';
import { queuedTask } from '../src/use-composer-draft.js';
import {
    authoredBy,
    LOCAL_AUTHOR,
    missingSummaryThread,
    mockedActivityOf,
    type ThreadJob,
} from '../../e2e/fixtures/threads.js';
import { type FetchCall, OPEN_BOARD_SESSION, renderApp, stubFetch, stubObjectUrls } from './dom.js';

/**
 * The Model control on both composers: "Default" sends nothing, a pick or a typed name rides the body
 * as `model`; the follow-up starts from the thread's model and sends one only when it changed.
 */

const CREATED = '2026-01-01T00:00:00.000Z';
const LAUNCHED_ID = '11111111-1111-4111-8111-111111111111';
const SENT_ID = 'cccccccc-0000-4000-8000-000000000001';

const repos = {
    repos: [{ owner: 'acme', name: 'web', private: true, defaultBranch: 'main', pushedAt: null }],
    installation: null,
    meta: { fetchedAt: CREATED, error: null },
};

const profileWorkspace: WorkspacePayload = {
    executors: [
        {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'e2e-executor',
            suspended: false,
            type: 'claude-code',
            createdAt: CREATED,
            gateFixRounds: 3,
        },
    ],
    orgExecutors: [],
    defaultExecutor: { scope: 'user', name: 'e2e-executor' },
};

const agentDefaultWorkspace: WorkspacePayload = {
    executors: [],
    orgExecutors: [],
    defaultExecutor: null,
    agentDefault: { agentType: 'claude-code', model: 'claude-sonnet-5-5', from: 'personal' },
};

const setup: ModelSetupView = {
    platform: false,
    org: null,
    personal: { provider: 'anthropic', agentType: 'claude-code', model: 'claude-sonnet-5-5', keyNames: [] },
    effective: 'personal',
};

function openComposer(workspace: WorkspacePayload) {
    const calls = stubFetch((call) => {
        if (call.url === '/api/workspace') return workspace;
        if (call.url === '/api/repos') return repos;
        if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
        if (call.url === '/api/model-setup') return setup;
        if (call.method === 'POST' && call.url === '/api/jobs') {
            return { status: 201, body: { id: LAUNCHED_ID, status: 'queued' } };
        }
    });
    const view = renderApp('/tasks/new');
    const launched = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/jobs').map((c) => c.body);
    return { ...view, launched };
}

const modelPicker = () => screen.getByRole('combobox', { name: /^Model/ }) as HTMLInputElement;
const startEnabled = () =>
    waitFor(() =>
        expect((screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement).disabled).toBe(false)
    );

async function launch(user: ReturnType<typeof userEvent.setup>, text: string) {
    await user.type(await screen.findByLabelText('What should the agent do?'), text);
    await startEnabled();
    await user.click(screen.getByRole('button', { name: 'Start task' }));
}

describe('the new-task Model control', () => {
    beforeEach(() => {
        stubObjectUrls();
    });

    it('reads Default on a profile task and sends no model when left alone', async () => {
        const user = userEvent.setup();
        const { router, launched } = openComposer(profileWorkspace);
        await screen.findByLabelText('What should the agent do?');
        expect(modelPicker().getAttribute('aria-label')).toBe('Model: Default');
        await launch(user, 'fix the login crash');
        await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${LAUNCHED_ID}`));
        expect(launched()).toHaveLength(1);
        expect(launched()[0]).not.toHaveProperty('model');
    });

    it("is prefilled from the agent default's model and offers the provider's models", async () => {
        const user = userEvent.setup();
        const { launched } = openComposer(agentDefaultWorkspace);
        await screen.findByLabelText('What should the agent do?');
        await waitFor(() =>
            expect(modelPicker().getAttribute('aria-label')).toBe('Model: Default (claude-sonnet-5-5)')
        );
        await user.click(modelPicker());
        const list = await screen.findByRole('listbox');
        await user.click(await within(list).findByRole('option', { name: 'claude-opus-5-5' }));
        expect(modelPicker().getAttribute('aria-label')).toBe('Model: claude-opus-5-5');
        await launch(user, 'fix the login crash');
        await waitFor(() => expect(launched()).toHaveLength(1));
        expect((launched()[0] as { model?: string }).model).toBe('claude-opus-5-5');
    });

    it('takes a typed model name the list does not offer', async () => {
        const user = userEvent.setup();
        const { launched } = openComposer(profileWorkspace);
        await screen.findByLabelText('What should the agent do?');
        await user.click(modelPicker());
        await user.type(modelPicker(), 'my-proxy/model-7{Enter}');
        expect(modelPicker().getAttribute('aria-label')).toBe('Model: my-proxy/model-7');
        await launch(user, 'fix the login crash');
        await waitFor(() => expect(launched()).toHaveLength(1));
        expect((launched()[0] as { model?: string }).model).toBe('my-proxy/model-7');
    });
});

describe('the draft carries the model', () => {
    const lists = { repos: [{ owner: 'acme', name: 'web' }], executors: [], defaultExecutor: null };

    it('starts at Default, sends a chosen model trimmed, and nothing for Default', () => {
        const fresh = initialComposerState(null, lists);
        expect(fresh.model).toBe('');
        expect(queuedTask({ ...fresh, draft: 'go' }, [], {})).not.toHaveProperty('model');
        expect(queuedTask({ ...fresh, draft: 'go', model: ' gpt-x ' }, [], {}).model).toBe('gpt-x');
    });

    it("keeps the model in Ready's stored draft, and an older stored draft reads Default", () => {
        const owner = 'org-1:user-1';
        const state = { ...initialComposerState(null, lists), draft: 'go', model: 'gpt-x' };
        writeReadyDraft(owner, { owner, ...state });
        expect(readReadyDraft(owner)?.model).toBe('gpt-x');
        const { model: _model, ...older } = state;
        window.sessionStorage.setItem(`ready-draft:${owner}`, JSON.stringify(older));
        expect(readReadyDraft(owner)?.model).toBe('');
        writeReadyDraft(owner, null);
    });
});

describe('the follow-up Model control', () => {
    beforeEach(() => {
        stubObjectUrls();
    });

    function thread(over: Partial<ThreadJob>, answers: { setup?: ModelSetupView; workspace?: WorkspacePayload } = {}) {
        const jobs = authoredBy(missingSummaryThread, LOCAL_AUTHOR).map((j) => ({ ...j, ...over }));
        const calls = stubFetch((call: FetchCall) => {
            if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
            if (call.url === '/api/model-setup') return answers.setup ?? setup;
            if (call.url === '/api/workspace' && answers.workspace) return answers.workspace;
            if (call.method === 'POST' && /\/follow-up$/.test(call.url)) return { status: 201, body: { id: SENT_ID } };
            const match = /\/api\/jobs\/([^/]+)\/(thread|activity)/.exec(call.url);
            if (match && jobs.some((j) => j.id === match[1]))
                return match[2] === 'thread' ? { jobs } : mockedActivityOf(jobs);
        });
        renderApp(`/tasks/${jobs[0]!.id}`);
        return () => calls.filter((c) => c.method === 'POST' && /\/follow-up$/.test(c.url)).map((c) => c.body);
    }

    const send = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.type(await screen.findByLabelText('Ask for a follow-up'), 'one more pass');
        await user.click(screen.getByRole('button', { name: 'Send follow-up' }));
    };

    it("starts from the thread's model and sends none when unchanged", async () => {
        const user = userEvent.setup();
        const sent = thread({ agentModel: 'claude-sonnet-5-5', resolvedModel: 'claude-sonnet-5-5' });
        await screen.findByLabelText('Ask for a follow-up');
        expect(modelPicker().getAttribute('aria-label')).toBe('Model: claude-sonnet-5-5');
        await send(user);
        await waitFor(() => expect(sent()).toHaveLength(1));
        expect(sent()[0]).not.toHaveProperty('model');
    });

    it('starts from the model the run got when none was requested, and sends a changed one', async () => {
        const user = userEvent.setup();
        const sent = thread({ agentModel: null, resolvedModel: 'claude-haiku-5-5' });
        await screen.findByLabelText('Ask for a follow-up');
        expect(modelPicker().getAttribute('aria-label')).toBe('Model: claude-haiku-5-5');
        await user.click(modelPicker());
        await user.click(
            await within(await screen.findByRole('listbox')).findByRole('option', { name: 'claude-opus-5-5' })
        );
        await send(user);
        await waitFor(() => expect(sent()).toHaveLength(1));
        expect((sent()[0] as { model?: string }).model).toBe('claude-opus-5-5');
    });

    /** An OpenRouter key: Claude Code runs its Anthropic models only, OpenCode any. */
    const openRouter: ModelSetupView = {
        ...setup,
        personal: {
            provider: 'openrouter',
            agentType: 'claude-code',
            model: 'anthropic/claude-sonnet-5.5',
            keyNames: [],
        },
    };
    const offered = async (user: ReturnType<typeof userEvent.setup>) => {
        await screen.findByLabelText('Ask for a follow-up');
        await user.click(modelPicker());
        const options = within(await screen.findByRole('listbox')).getAllByRole('option');
        return options.map((option) => option.textContent);
    };

    it("offers only the thread's agent's models: a Claude Code agent default on OpenRouter", async () => {
        const user = userEvent.setup();
        thread(
            { executor: null, agentType: 'claude-code', agentModel: 'anthropic/claude-sonnet-5.5' },
            { setup: openRouter }
        );
        const models = await offered(user);
        expect(models).toContain('anthropic/claude-opus-5.5');
        expect(models).not.toContain('openai/gpt-5.1');
    });

    it("offers only the profile's agent's models on a profile thread", async () => {
        const user = userEvent.setup();
        thread(
            { executor: 'e2e-executor', executorScope: 'user', agentType: null, agentModel: null },
            { setup: openRouter, workspace: profileWorkspace }
        );
        await screen.findByLabelText('Ask for a follow-up');
        await user.click(modelPicker());
        const list = await screen.findByRole('listbox');
        await within(list).findByRole('option', { name: 'anthropic/claude-opus-5.5' });
        // The profile's type lands with the workspace poll; the open list follows it.
        await waitFor(() => expect(within(list).queryByRole('option', { name: 'openai/gpt-5.1' })).toBeNull());
    });
});
