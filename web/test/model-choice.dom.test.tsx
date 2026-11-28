import { renderHook } from '@testing-library/react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStaleModelReset } from '../src/components/ModelCombobox.js';
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

const setup: ModelSetupView = {
    org: null,
    personal: { provider: 'anthropic', keyNames: [] },
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

const modelPicker = () => screen.getByRole('button', { name: /^Model/ }) as HTMLButtonElement;
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

    it('takes a typed model name the list does not offer', async () => {
        const user = userEvent.setup();
        const { launched } = openComposer(profileWorkspace);
        await screen.findByLabelText('What should the agent do?');
        await user.click(modelPicker());
        await user.type(screen.getByRole('combobox', { name: 'Search model' }), 'my-proxy/model-7{Enter}');
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
        await user.type(await screen.findByRole('combobox', { name: 'Search model' }), 'claude-opus-5-5{Enter}');
        await send(user);
        await waitFor(() => expect(sent()).toHaveLength(1));
        expect((sent()[0] as { model?: string }).model).toBe('claude-opus-5-5');
    });

    it('offers no curated models on a thread without a connection', async () => {
        const user = userEvent.setup();
        thread({ executor: null, agentModel: 'claude-sonnet-5-5' });
        await screen.findByLabelText('Ask for a follow-up');
        await user.click(modelPicker());
        const options = within(await screen.findByRole('listbox')).queryAllByRole('option');
        expect(options.map((option) => option.textContent)).not.toContain('claude-opus-5-5');
    });
});

describe('the Model chip follows the selected executor connection', () => {
    const CONNECTION = '33333333-3333-4333-8333-333333333333';
    const connected = {
        providerConnectionId: CONNECTION,
        providerConnectionName: 'Team key',
        providerConnectionProvider: 'anthropic' as const,
        providerConnectionScope: 'org' as const,
        configOverridesConnection: false,
    };
    const routedWorkspace: WorkspacePayload = {
        executors: [
            { ...profileWorkspace.executors[0]!, id: '44444444-4444-4444-8444-444444444444', name: 'plain' },
            { ...profileWorkspace.executors[0]!, name: 'routed', ...connected },
        ],
        orgExecutors: [],
        defaultExecutor: { scope: 'user', name: 'plain' },
    };

    function board(models: unknown, workspace: WorkspacePayload = routedWorkspace) {
        const calls = stubFetch((call) => {
            if (call.url === '/api/workspace') return workspace;
            if (call.url === '/api/repos') return repos;
            if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
            if (call.url === '/api/model-setup') return setup;
            if (call.url === `/api/provider-connections/${CONNECTION}/models`) return models;
            if (call.method === 'POST' && call.url === '/api/jobs') {
                return { status: 201, body: { id: LAUNCHED_ID, status: 'queued' } };
            }
        });
        return {
            calls,
            modelReads: () => calls.filter((c) => c.url.endsWith('/models')),
            launched: () => calls.filter((c) => c.method === 'POST' && c.url === '/api/jobs').map((c) => c.body),
        };
    }

    const pickExecutor = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
        await user.click(await screen.findByRole('button', { name: /^Executor/ }));
        await user.click(await within(await screen.findByRole('listbox')).findByRole('option', { name }));
    };
    const offeredModels = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(modelPicker());
        const list = await screen.findByRole('listbox');
        return within(list)
            .getAllByRole('option')
            .map((option) => option.textContent);
    };

    beforeEach(() => {
        stubObjectUrls();
    });

    it('selected executor determines model source', async () => {
        const user = userEvent.setup();
        const { modelReads } = board({ state: 'listed', models: ['claude-live-1', 'claude-live-2'] });
        renderApp('/tasks/new');
        await screen.findByLabelText('What should the agent do?');

        // The default executor has no connection: typing only, no curated list, and no connection read at all.
        expect(await offeredModels(user)).toEqual(['Default']);
        expect(modelReads()).toHaveLength(0);
        await user.keyboard('{Escape}');

        // The connection's executor offers that connection's live models instead.
        await pickExecutor(user, 'routed');
        await user.click(modelPicker());
        const list = await screen.findByRole('listbox');
        await waitFor(() => {
            const models = within(list)
                .getAllByRole('option')
                .map((option) => option.textContent);
            expect(models).toEqual(expect.arrayContaining(['claude-live-1', 'claude-live-2']));
            expect(models).not.toContain('claude-opus-5-5');
        });
        expect(modelReads()).toHaveLength(1);
    });

    it('offers no curated models without a connection, only typing', async () => {
        const user = userEvent.setup();
        board({ state: 'listed', models: [] });
        renderApp('/tasks/new');
        await screen.findByLabelText('What should the agent do?');
        expect(await offeredModels(user)).toEqual(['Default']);
        await user.type(screen.getByRole('combobox', { name: 'Search model' }), 'typed-model');
        expect(await screen.findByRole('option', { name: 'Use “typed-model”' })).toBeTruthy();
    });

    it('manual model entry survives unsupported or failed discovery', async () => {
        const user = userEvent.setup();
        const { launched } = board({ state: 'failed', code: 'UPSTREAM', message: 'The provider is unreachable.' });
        renderApp('/tasks/new');
        await screen.findByLabelText('What should the agent do?');
        await pickExecutor(user, 'routed');

        // A failed read says so (never "no models"), keeps the curated suggestions and still takes a typed name.
        await user.click(modelPicker());
        await screen.findByText(/Could not list the models Team key offers: The provider is unreachable\./);
        expect(
            within(await screen.findByRole('listbox'))
                .getAllByRole('option')
                .map((option) => option.textContent)
        ).toContain('claude-opus-5-5');
        await user.type(screen.getByRole('combobox', { name: 'Search model' }), 'my-hand-typed-model{Enter}');
        expect(modelPicker().getAttribute('aria-label')).toBe('Model: my-hand-typed-model');
        await launch(user, 'fix the login crash');
        await waitFor(() => expect(launched()).toHaveLength(1));
        expect(launched()[0]).toMatchObject({ model: 'my-hand-typed-model' });
    });

    it('says a successful empty list apart from an unsupported one', async () => {
        const user = userEvent.setup();
        board({ state: 'listed', models: [] });
        renderApp('/tasks/new');
        await screen.findByLabelText('What should the agent do?');
        await pickExecutor(user, 'routed');
        await user.click(modelPicker());
        await screen.findByText(/Team key lists no models\. Type the name of the model to use\./);
        expect(screen.queryByText(/Could not list/)).toBeNull();
        await user.keyboard('{Escape}');
    });

    describe('switching to an executor on another connection', () => {
        const OTHER = '55555555-5555-4555-8555-555555555555';
        const other = {
            providerConnectionId: OTHER,
            providerConnectionName: 'Other key',
            providerConnectionProvider: 'anthropic' as const,
            providerConnectionScope: 'org' as const,
            configOverridesConnection: false,
        };
        const twoConnections: WorkspacePayload = {
            ...routedWorkspace,
            executors: [
                ...routedWorkspace.executors,
                {
                    ...profileWorkspace.executors[0]!,
                    id: '66666666-6666-4666-8666-666666666666',
                    name: 'other',
                    ...other,
                },
            ],
        };
        const answers = (lists: Record<string, unknown>) => {
            const calls = stubFetch((call) => {
                if (call.url === '/api/workspace') return twoConnections;
                if (call.url === '/api/repos') return repos;
                if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
                if (call.url === '/api/model-setup') return setup;
                for (const [id, body] of Object.entries(lists)) {
                    if (call.url === `/api/provider-connections/${id}/models`) return body;
                }
                if (call.method === 'POST' && call.url === '/api/jobs') {
                    return { status: 201, body: { id: LAUNCHED_ID, status: 'queued' } };
                }
            });
            return () => calls.filter((c) => c.method === 'POST' && c.url === '/api/jobs').map((c) => c.body);
        };
        const pickOn = async (user: ReturnType<typeof userEvent.setup>, executor: string, model: string) => {
            await pickExecutor(user, executor);
            await user.click(modelPicker());
            await user.type(screen.getByRole('combobox', { name: 'Search model' }), `${model}{Enter}`);
            expect(modelPicker().getAttribute('aria-label')).toBe(`Model: ${model}`);
        };

        it('resets to Default when the new connection does not list the picked model', async () => {
            const user = userEvent.setup();
            const launched = answers({
                [CONNECTION]: { state: 'listed', models: ['claude-live-1'] },
                [OTHER]: { state: 'listed', models: ['claude-other-1'] },
            });
            renderApp('/tasks/new');
            await screen.findByLabelText('What should the agent do?');
            await pickOn(user, 'routed', 'claude-live-1');
            await pickExecutor(user, 'other');
            await waitFor(() => expect(modelPicker().getAttribute('aria-label')).toBe('Model: Default'));
            await launch(user, 'fix the login crash');
            await waitFor(() => expect(launched()).toHaveLength(1));
            expect(launched()[0]).not.toHaveProperty('model');
        });

        it('keeps the model when the new connection lists it too', async () => {
            const user = userEvent.setup();
            answers({
                [CONNECTION]: { state: 'listed', models: ['claude-live-1'] },
                [OTHER]: { state: 'listed', models: ['claude-live-1', 'claude-other-1'] },
            });
            renderApp('/tasks/new');
            await screen.findByLabelText('What should the agent do?');
            await pickOn(user, 'routed', 'claude-live-1');
            await pickExecutor(user, 'other');
            await screen.findByRole('button', { name: /^Executor.*other/ });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(modelPicker().getAttribute('aria-label')).toBe('Model: claude-live-1');
        });

        it('keeps a typed model when the new connection does not list models', async () => {
            const user = userEvent.setup();
            answers({
                [CONNECTION]: { state: 'listed', models: ['claude-live-1'] },
                [OTHER]: { state: 'unsupported' },
            });
            renderApp('/tasks/new');
            await screen.findByLabelText('What should the agent do?');
            await pickOn(user, 'routed', 'my-hand-typed-model');
            await pickExecutor(user, 'other');
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(modelPicker().getAttribute('aria-label')).toBe('Model: my-hand-typed-model');
        });
    });

    it('offers a follow-up on a connection thread that connection’s models', async () => {
        const user = userEvent.setup();
        board({ state: 'listed', models: ['claude-live-1'] });
        const jobs = authoredBy(missingSummaryThread, LOCAL_AUTHOR).map((j) => ({
            ...j,
            executor: 'routed',
            executorScope: 'user' as const,
            agentModel: null,
        }));
        stubFetch((call: FetchCall) => {
            if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
            if (call.url === '/api/model-setup') return setup;
            if (call.url === '/api/workspace') return routedWorkspace;
            if (call.url === `/api/provider-connections/${CONNECTION}/models`) {
                return { state: 'listed', models: ['claude-live-1'] };
            }
            const match = /\/api\/jobs\/([^/]+)\/(thread|activity)/.exec(call.url);
            if (match && jobs.some((j) => j.id === match[1])) {
                return match[2] === 'thread' ? { jobs } : mockedActivityOf(jobs);
            }
        });
        renderApp(`/tasks/${jobs[0]!.id}`);
        await screen.findByLabelText('Ask for a follow-up');
        await user.click(modelPicker());
        const list = await screen.findByRole('listbox');
        await waitFor(() =>
            expect(
                within(list)
                    .getAllByRole('option')
                    .map((option) => option.textContent)
            ).toContain('claude-live-1')
        );
    });
});

describe('the stale-model reset the follow-up shares with the composer', () => {
    const listed = (...models: string[]) => ({ connectionId: 'b', listed: models });
    const run = (initial: { connectionId: string | null; listed: readonly string[] | null }, picked: string) => {
        const reset = vi.fn();
        const hook = renderHook(({ choices }) => useStaleModelReset(choices, picked, reset), {
            initialProps: { choices: initial },
        });
        return { reset, change: (choices: typeof initial) => hook.rerender({ choices }) };
    };

    it('resets once the new connection’s confirmed list lacks the pick, not while it loads', () => {
        const { reset, change } = run({ connectionId: 'a', listed: ['m1'] }, 'm1');
        change({ connectionId: 'b', listed: null });
        expect(reset).not.toHaveBeenCalled();
        change(listed('m2'));
        expect(reset).toHaveBeenCalledTimes(1);
    });

    it('keeps a pick the new list has, and one never judged on the same connection', () => {
        const kept = run({ connectionId: 'a', listed: ['m1'] }, 'm1');
        kept.change({ connectionId: 'b', listed: null });
        kept.change(listed('m1', 'm2'));
        const same = run({ connectionId: 'a', listed: ['m2'] }, 'm1');
        same.change({ connectionId: 'a', listed: ['m3'] });
        expect(kept.reset).not.toHaveBeenCalled();
        expect(same.reset).not.toHaveBeenCalled();
    });

    it('treats a read that failed or is unsupported as unconfirmed', () => {
        const { reset, change } = run({ connectionId: 'a', listed: ['m1'] }, 'typed');
        change({ connectionId: 'b', listed: null });
        expect(reset).not.toHaveBeenCalled();
    });
});
