import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSetupView, SelectedExecutorView } from '../src/api/useModelSetup.js';
import type { Session } from '../src/api/useSession.js';
import { ModelSetup } from '../src/model-setup/ModelSetupForm.js';
import { renderApp, renderAt, stubFetch, type FetchCall, type FetchReply } from './dom.js';
import { memberSession } from './fixtures.js';
import {
    modelSetupReads,
    NO_SETUP,
    setupCalls,
    setupReads,
    SETUP_URL,
    VERIFY_URL,
    verifyCalls,
} from './model-setup-reads.js';

/**
 * Connect a model (the onboarding step and Settings → Model share `ModelSetup`): the provider cards, the live key
 * check, the agent and model, who the key is for, the configured banners, and Save — against a mocked board.
 */

afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
});

const NOTHING = NO_SETUP;
const SAVED = {
    scope: 'personal',
    executorId: 'executor-1',
    executorName: 'Anthropic',
    connectionId: 'connection-1',
    connectionName: 'Anthropic',
    replayed: false,
};
type Setup = ModelSetupView;

/** Answers the setup reads with `setup`, the key check with `verify(call)`; the setup command answers saved. */
function board(
    setup: Setup | { status: number } = NOTHING,
    verify: (call: FetchCall) => FetchReply = () => ({ ok: true })
) {
    return stubFetch((call) => {
        const read = modelSetupReads(setup, call);
        if (read !== undefined) return read;
        if (call.method === 'POST' && call.url === SETUP_URL) return SAVED;
        if (call.url === VERIFY_URL) return verify(call);
    });
}

function mount(session: Partial<Session> = {}, onSaved = vi.fn(), saveExisting = false) {
    const view = renderAt(
        <ModelSetup
            session={memberSession(session)}
            labels={{ form: 'Save and continue', banner: 'Continue' }}
            onSaved={onSaved}
            footer={(primary) => primary}
            saveExisting={saveExisting}
        />
    );
    return { ...view, onSaved };
}

const keyInput = () => screen.findByLabelText('API key');
const saveButton = () => screen.getByRole('button', { name: /^(Save and continue|Continue)$/ });
const verifies = verifyCalls;
const puts = setupCalls;
const status = () => screen.getByRole('status', { name: 'Key check' });

describe('provider cards', () => {
    it('offers the subscription card self-hosted', async () => {
        board();
        mount();
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect(screen.getByRole('radio', { name: /^Claude subscription/ })).toBeTruthy();
    });

    it('offers the subscription card to a cloud org the operator allows', async () => {
        board();
        mount({ deploymentMode: 'cloud', subscriptionToken: true });
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect(screen.getByRole('radio', { name: /^Claude subscription/ })).toBeTruthy();
    });

    it('never offers the subscription card to any other cloud org', async () => {
        board();
        mount({ deploymentMode: 'cloud', subscriptionToken: false });
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect(screen.queryByRole('radio', { name: /^Claude subscription/ })).toBeNull();
        expect(screen.getByRole('radio', { name: /^Anthropic/ })).toBeTruthy();
    });

    it('a pasted OpenRouter key selects OpenRouter and OpenCode, with Claude Code still offered', async () => {
        board();
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-or-v1-abc' } });
        expect((screen.getByRole('radio', { name: /^OpenRouter/ }) as HTMLInputElement).checked).toBe(true);
        const agent = screen.getByLabelText('Agent') as HTMLSelectElement;
        expect(agent.value).toBe('opencode');
        expect([...agent.options].map((o) => o.value)).toEqual(['opencode', 'claude-code']);
        fireEvent.change(agent, { target: { value: 'claude-code' } });
        const models = [...(screen.getByLabelText('Model') as HTMLSelectElement).options].map((o) => o.value);
        expect(models.filter((m) => m !== '').every((m) => m.startsWith('anthropic/'))).toBe(true);
    });

    it('locks OpenAI to OpenCode with the Codex note, and a subscription to Claude Code', async () => {
        board();
        mount();
        await userEvent.setup().click(await screen.findByRole('radio', { name: /^OpenAI(?!-compatible)/ }));
        const agent = screen.getByLabelText('Agent') as HTMLSelectElement;
        expect([...agent.options].map((o) => o.value)).toEqual(['opencode']);
        expect(screen.getByText(/OpenAI keys run on OpenCode/).textContent).toContain('Codex');
        fireEvent.click(screen.getByRole('radio', { name: /^Claude subscription/ }));
        expect([...(screen.getByLabelText('Agent') as HTMLSelectElement).options].map((o) => o.value)).toEqual([
            'claude-code',
        ]);
        expect(screen.getByLabelText('Setup token')).toBeTruthy();
    });

    it('LiteLLM asks for the proxy URL with its help, and hides the Advanced base URL', async () => {
        board();
        mount();
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect(screen.getByLabelText(/^Base URL/)).toBeTruthy();
        fireEvent.click(screen.getByRole('radio', { name: /^LiteLLM/ }));
        const proxy = screen.getByLabelText('Proxy URL');
        expect(proxy.getAttribute('aria-describedby')).toBeTruthy();
        expect(document.getElementById(proxy.getAttribute('aria-describedby') ?? '')?.textContent).toContain(
            '/v1/models'
        );
        expect(screen.queryByLabelText(/^Base URL/)).toBeNull();
        fireEvent.change(screen.getByLabelText('Virtual key'), { target: { value: 'sk-virtual' } });
        expect(screen.getByText('Enter the proxy URL to continue.')).toBeTruthy();
    });

    it('a subscription token in a cloud org not allowed one is refused in the check line, with no call', async () => {
        const calls = board();
        mount({ deploymentMode: 'cloud', subscriptionToken: false });
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-oat01-abc' } });
        await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
        expect(status().textContent).toContain(
            'This is a Claude subscription token. This deployment accepts API keys only'
        );
        expect(verifies(calls)).toHaveLength(0);
    });

    it('a subscription token in a cloud org the operator allows picks the subscription card, refused nowhere', async () => {
        board();
        mount({ deploymentMode: 'cloud', subscriptionToken: true });
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-oat01-abc' } });
        await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
        expect((screen.getByRole('radio', { name: /^Claude subscription/ }) as HTMLInputElement).checked).toBe(true);
        expect(status().textContent).not.toContain('This deployment accepts API keys only');
    });
});

describe('the live key check', () => {
    it('debounces 350 ms into one call, then shows ✓ and the models it returned', async () => {
        vi.useFakeTimers();
        const calls = board(NOTHING, () => ({ ok: true, models: ['claude-sonnet-5-5', 'claude-opus-5-5'] }));
        mount();
        await act(() => vi.advanceTimersByTimeAsync(10));
        const key = screen.getByLabelText('API key');
        fireEvent.change(key, { target: { value: 'sk-ant-api03-a' } });
        await act(() => vi.advanceTimersByTimeAsync(200));
        fireEvent.change(key, { target: { value: 'sk-ant-api03-ab' } });
        await act(() => vi.advanceTimersByTimeAsync(349));
        expect(verifies(calls)).toHaveLength(0);
        await act(() => vi.advanceTimersByTimeAsync(1));
        await act(() => vi.advanceTimersByTimeAsync(10));
        expect(verifies(calls)).toHaveLength(1);
        expect(verifies(calls)[0]?.body).toEqual({ provider: 'anthropic', key: 'sk-ant-api03-ab' });
        expect(status().textContent).toContain('✓ Key works · 2 models available');
        const models = [...(screen.getByLabelText('Model') as HTMLSelectElement).options].map((o) => o.value);
        expect(models).toContain('claude-opus-5-5');
        expect(saveButton().getAttribute('aria-disabled')).toBeNull();
    });

    it('NO_CREDIT is ▲ and still allows Save; a refused key is ✕ with the server sentence and blocks it', async () => {
        board(NOTHING, (call) =>
            (call.body as { key: string }).key.includes('poor')
                ? { ok: false, code: 'NO_CREDIT', message: 'The account has no credit left' }
                : { ok: false, code: 'INVALID_KEY', message: 'OpenRouter refused this key' }
        );
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-or-v1-poor' } });
        await waitFor(() => expect(status().textContent).toContain('▲ '));
        expect(status().textContent).toContain('The account has no credit left');
        expect(saveButton().getAttribute('aria-disabled')).toBeNull();

        fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-or-v1-revoked' } });
        await waitFor(() => expect(status().textContent).toContain('✕ OpenRouter refused this key'));
        expect(saveButton().getAttribute('aria-disabled')).toBe('true');
        const why = document.getElementById(saveButton().getAttribute('aria-describedby') ?? '');
        expect(why?.textContent).toBe('Fix the key to continue.');
    });

    it("a check that could not run says it couldn't check, never that the key is invalid", async () => {
        board(NOTHING, () => ({ status: 500 }));
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-abc' } });
        await waitFor(() => expect(status().textContent).toMatch(/could not check/i));
        expect(status().textContent).not.toContain('✕');
        expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    });

    it('drops an answer for a key that changed while it was in flight', async () => {
        let release: (value: unknown) => void = () => undefined;
        const first = new Promise((resolve) => {
            release = resolve;
        });
        board(NOTHING, (call) =>
            (call.body as { key: string }).key.endsWith('old')
                ? first
                : { ok: false, code: 'INVALID_KEY', message: 'Anthropic refused this key' }
        );
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-old' } });
        await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
        fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-api03-new' } });
        await waitFor(() => expect(status().textContent).toContain('✕ Anthropic refused this key'));
        release({ ok: true, models: ['claude-stale'] });
        await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
        expect(status().textContent).toContain('✕ Anthropic refused this key');
    });
});

describe('who the key is for', () => {
    it('a member gets only "Only me" with the note; the secret note names the connection and the scope', async () => {
        board();
        mount();
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect(screen.queryByRole('radio', { name: /^Everyone in/ })).toBeNull();
        expect(screen.getByText(/Only an admin can add a key for everyone in Bellows AI/)).toBeTruthy();
        const note = screen.getByText(/Saved as your personal provider connection/);
        expect(note.textContent).toContain('Nobody — admins included — can read the key back');
        expect(note.textContent).not.toContain('ANTHROPIC_API_KEY');
    });

    it('an admin chooses, the organization by default', async () => {
        board();
        mount({ role: 'admin' });
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect((screen.getByRole('radio', { name: 'Everyone in Bellows AI' }) as HTMLInputElement).checked).toBe(true);
        expect(screen.getByText(/Saved as an organization provider connection/)).toBeTruthy();
        fireEvent.click(screen.getByRole('radio', { name: 'Only me' }));
        expect(screen.getByText(/Saved as your personal provider connection/)).toBeTruthy();
    });
});

describe('Save', () => {
    it('waits with its reason, then creates the connection and executor and hands over once the setup is re-read', async () => {
        const calls = board(NOTHING, () => ({ ok: true, models: ['claude-sonnet-5-5'] }));
        const { onSaved } = mount();
        await keyInput();
        expect(saveButton().getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByText('Paste a key to continue.')).toBeTruthy();
        fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-api03-abc' } });
        await waitFor(() => expect(saveButton().getAttribute('aria-disabled')).toBeNull());
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
        expect(puts(calls)[0]?.body).toEqual({
            scope: 'personal',
            requestId: expect.any(String),
            connection: { intent: 'create', provider: 'anthropic', key: 'sk-ant-api03-abc', name: 'Anthropic' },
            executor: { name: 'Anthropic', agentType: 'claude-code', model: 'claude-sonnet-5-5' },
            makeDefault: true,
        });
        const put = calls.findIndex((c) => c.url === SETUP_URL);
        expect(calls.slice(put).some((c) => c.url === '/api/workspace' && c.method === 'GET')).toBe(true);
    });

    it('names the connection and executor by the Name field, and waits while it is empty', async () => {
        const calls = board(NOTHING, () => ({ ok: true, models: ['claude-sonnet-5-5'] }));
        const { onSaved } = mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-abc' } });
        await waitFor(() => expect(saveButton().getAttribute('aria-disabled')).toBeNull());
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' ' } });
        expect(saveButton().getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByText('Give the connection a name.')).toBeTruthy();
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team Anthropic' } });
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts(calls)[0]?.body).toMatchObject({
            connection: { intent: 'create', name: 'Team Anthropic' },
            executor: { name: 'Team Anthropic' },
        });
    });

    it('a name already in use is refused with its sentence, nothing handed over, and the same body retries with one request id', async () => {
        const bodies: { requestId: string }[] = [];
        stubFetch((call) => {
            const read = modelSetupReads(NOTHING, call);
            if (read !== undefined) return read;
            if (call.url === VERIFY_URL) return { ok: true, models: ['claude-sonnet-5-5'] };
            if (call.url === SETUP_URL) {
                bodies.push(call.body as { requestId: string });
                return {
                    status: 409,
                    body: {
                        code: 'NAME_TAKEN',
                        error: 'A connection with that name already exists in this scope; choose another name',
                    },
                };
            }
        });
        const { onSaved } = mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-abc' } });
        await waitFor(() => expect(saveButton().getAttribute('aria-disabled')).toBeNull());
        fireEvent.click(saveButton());
        expect(await screen.findByText(/already exists in this scope/)).toBeTruthy();
        fireEvent.click(saveButton());
        await waitFor(() => expect(bodies).toHaveLength(2));
        expect(bodies[1]?.requestId).toBe(bodies[0]?.requestId);
        expect(onSaved).not.toHaveBeenCalled();
    });

    it('an aria-disabled Save writes nothing', async () => {
        const calls = board();
        const { onSaved } = mount();
        await keyInput();
        fireEvent.click(saveButton());
        await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
        expect(puts(calls)).toHaveLength(0);
        expect(onSaved).not.toHaveBeenCalled();
    });

    it('a failed setup read is an error with retry, never the empty form', async () => {
        const calls = board({ status: 503 });
        mount();
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByRole('radiogroup', { name: 'Provider' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(setupReads(calls)).toBe(2));
    });
});

const REVISION = '2026-01-02T03:04:05.678Z';

describe('a default executor', () => {
    const selected = (over: Partial<SelectedExecutorView> = {}): SelectedExecutorView => ({
        scope: 'personal',
        executorId: 'executor-1',
        name: 'Anthropic',
        agentType: 'claude-code',
        model: 'claude-sonnet-5-5',
        suspended: false,
        updatedAt: REVISION,
        connection: { id: 'connection-1', name: 'Anthropic', provider: 'anthropic', scope: 'personal', baseUrl: null },
        ...over,
    });
    const view = (over: Partial<SelectedExecutorView> = {}): ModelSetupView => ({
        platform: false,
        org: null,
        personal: null,
        selected: selected(over),
        effective: 'executor',
    });

    it('shows the executor and its connection, recovered from the read alone', async () => {
        board(view());
        mount();
        expect(await screen.findByText('Your tasks run on Anthropic.')).toBeTruthy();
        expect(screen.getByText(/Claude Code · Anthropic · claude-sonnet-5-5/).textContent).toContain(
            'connection Anthropic'
        );
        expect(screen.queryByRole('radiogroup', { name: 'Provider' })).toBeNull();
    });

    it('a model-only change edits the executor by id on its connection and never sends a key', async () => {
        const calls = board(view());
        const { onSaved } = mount({}, vi.fn(), true);
        await screen.findByText('Your tasks run on Anthropic.');
        expect(screen.queryByLabelText('API key')).toBeNull();
        fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5-5' } });
        fireEvent.click(screen.getByRole('button', { name: /^(Save and continue|Continue)$/ }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts(calls)[0]?.body).toEqual({
            scope: 'personal',
            requestId: expect.any(String),
            connection: { intent: 'reuse', id: 'connection-1' },
            executor: {
                id: 'executor-1',
                agentType: 'claude-code',
                model: 'claude-opus-5-5',
                expectedUpdatedAt: REVISION,
            },
            makeDefault: true,
        });
        expect(JSON.stringify(puts(calls)[0]?.body)).not.toContain('"key"');
    });

    it('onboarding Continue only records the step on an executor already there', async () => {
        const calls = board(view());
        const { onSaved } = mount();
        await screen.findByText('Your tasks run on Anthropic.');
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts(calls)).toHaveLength(0);
    });

    it('explicit rotation sends the new key for the executor’s own connection and nothing else changes', async () => {
        const calls = board(view(), () => ({ ok: true }));
        const { onSaved } = mount();
        fireEvent.click(await screen.findByRole('button', { name: 'Replace the key' }));
        expect(screen.getByText(/Replace the key of/).textContent).toContain('Anthropic');
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-new' } });
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Replace key' }).getAttribute('aria-disabled')).toBeNull()
        );
        fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts(calls)[0]?.body).toEqual({
            scope: 'personal',
            requestId: expect.any(String),
            connection: { intent: 'rotate', id: 'connection-1', key: 'sk-ant-api03-new' },
            executor: {
                id: 'executor-1',
                agentType: 'claude-code',
                model: 'claude-sonnet-5-5',
                expectedUpdatedAt: REVISION,
            },
            makeDefault: true,
        });
    });

    it('offers no rotation of a connection the member does not own: the organization’s, for a member', async () => {
        board(
            view({
                scope: 'org',
                connection: { id: 'c', name: 'Team', provider: 'anthropic', scope: 'org', baseUrl: null },
            })
        );
        mount();
        await screen.findByText('Bellows AI runs tasks on Anthropic.');
        expect(screen.queryByRole('button', { name: 'Replace the key' })).toBeNull();
        expect(screen.queryByLabelText('Model')).toBeNull();
    });

    it('lets an admin replace the organization executor’s key', async () => {
        board(
            view({
                scope: 'org',
                connection: { id: 'c', name: 'Team', provider: 'anthropic', scope: 'org', baseUrl: null },
            })
        );
        mount({ role: 'admin' });
        expect(await screen.findByRole('button', { name: 'Replace the key' })).toBeTruthy();
    });

    it('"Connect another provider" starts a member in personal scope even when the organization default is inherited', async () => {
        const calls = board(
            view({
                scope: 'org',
                connection: { id: 'c', name: 'Team', provider: 'anthropic', scope: 'org', baseUrl: null },
            }),
            () => ({ ok: true, models: ['claude-sonnet-5-5'] })
        );
        const { onSaved } = mount();
        fireEvent.click(await screen.findByRole('button', { name: 'Connect another provider' }));
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-mine' } });
        await waitFor(() => expect(saveButton().getAttribute('aria-disabled')).toBeNull());
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts(calls)[0]?.body).toMatchObject({ scope: 'personal', connection: { intent: 'create' } });
    });

    it('"Connect another provider" lets an admin inherit the organization scope', async () => {
        const calls = board(
            view({
                scope: 'org',
                connection: { id: 'c', name: 'Team', provider: 'anthropic', scope: 'org', baseUrl: null },
            }),
            () => ({ ok: true, models: ['claude-sonnet-5-5'] })
        );
        const { onSaved } = mount({ role: 'admin' });
        fireEvent.click(await screen.findByRole('button', { name: 'Connect another provider' }));
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-team' } });
        await waitFor(() => expect(saveButton().getAttribute('aria-disabled')).toBeNull());
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts(calls)[0]?.body).toMatchObject({ scope: 'org' });
    });

    it('"Connect another provider" opens the key form for a second connection and executor', async () => {
        const calls = board(view(), () => ({ ok: true, models: ['claude-sonnet-5-5'] }));
        const { onSaved } = mount();
        fireEvent.click(await screen.findByRole('button', { name: 'Connect another provider' }));
        fireEvent.click(screen.getByRole('radio', { name: /^OpenRouter/ }));
        fireEvent.change(await keyInput(), { target: { value: 'sk-or-v1-abc' } });
        await waitFor(() => expect(saveButton().getAttribute('aria-disabled')).toBeNull());
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts(calls)[0]?.body).toMatchObject({
            connection: { intent: 'create', provider: 'openrouter', name: 'OpenRouter' },
            executor: { name: 'OpenRouter', agentType: 'opencode' },
        });
    });
});

describe('after a save in Settings', () => {
    const mine: SelectedExecutorView = {
        scope: 'personal',
        executorId: 'executor-1',
        name: 'Anthropic',
        agentType: 'claude-code',
        model: 'claude-sonnet-5-5',
        suspended: false,
        updatedAt: '2026-01-02T03:04:05.678Z',
        connection: { id: 'connection-1', name: 'Anthropic', provider: 'anthropic', scope: 'personal', baseUrl: null },
    };
    const router: SelectedExecutorView = {
        ...mine,
        executorId: 'executor-2',
        name: 'OpenRouter',
        agentType: 'opencode',
        model: 'openai/gpt-5.1',
        connection: {
            id: 'connection-2',
            name: 'OpenRouter',
            provider: 'openrouter',
            scope: 'personal',
            baseUrl: null,
        },
    };
    const viewOf = (selected: SelectedExecutorView): ModelSetupView => ({
        platform: false,
        org: null,
        personal: null,
        selected,
        effective: 'executor',
    });

    /** A board whose read follows the saves: each setup command moves the default to `after`. */
    function followingBoard(after: SelectedExecutorView) {
        let current = mine;
        return stubFetch((call) => {
            const read = modelSetupReads(viewOf(current), call);
            if (read !== undefined) return read;
            if (call.url === SETUP_URL) {
                current = after;
                return { ...SAVED, executorId: after.executorId, executorName: after.name };
            }
            if (call.url === VERIFY_URL) return { ok: true, models: ['openai/gpt-5.1'] };
        });
    }

    it('a created connection returns to the banner with the key cleared, and a second save edits it', async () => {
        const calls = followingBoard(router);
        const { onSaved } = mount({}, vi.fn(), true);
        fireEvent.click(await screen.findByRole('button', { name: 'Connect another provider' }));
        fireEvent.click(screen.getByRole('radio', { name: /^OpenRouter/ }));
        fireEvent.change(await keyInput(), { target: { value: 'sk-or-v1-abc' } });
        await waitFor(() => expect(saveButton().getAttribute('aria-disabled')).toBeNull());
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSaved).toHaveBeenCalled());

        // The banner of the new executor, not the create form.
        expect(await screen.findByText('Your tasks run on OpenRouter.')).toBeTruthy();
        expect(screen.queryByLabelText('API key')).toBeNull();

        // Saving again edits that executor by id; it never creates the named connection a second time.
        fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'openai/gpt-5.1' } });
        fireEvent.click(saveButton());
        await waitFor(() => expect(puts(calls)).toHaveLength(2));
        expect(puts(calls)[1]?.body).toMatchObject({
            connection: { intent: 'reuse', id: 'connection-2' },
            executor: { id: 'executor-2' },
        });

        // Opening the form again starts without the key just saved.
        fireEvent.click(await screen.findByRole('button', { name: 'Connect another provider' }));
        expect(((await keyInput()) as HTMLInputElement).value).toBe('');
    });

    it('a replaced key is cleared, and replacing again starts from an empty field', async () => {
        const calls = followingBoard(mine);
        const { onSaved } = mount({}, vi.fn(), true);
        fireEvent.click(await screen.findByRole('button', { name: 'Replace the key' }));
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-new' } });
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Replace key' }).getAttribute('aria-disabled')).toBeNull()
        );
        fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts(calls)).toHaveLength(1);

        expect(await screen.findByText('Your tasks run on Anthropic.')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Replace the key' }));
        expect(((await keyInput()) as HTMLInputElement).value).toBe('');
    });
});

describe('the pages', () => {
    it('the onboarding step saves, records the step done, re-reads /me and moves on', async () => {
        let setup: Session['setup'] = { completed: false, done: [], skipped: [] };
        const calls = stubFetch((call) => {
            if (call.url === '/api/auth/me') return memberSession({ setup });
            const read = modelSetupReads(NOTHING, call);
            if (read !== undefined) return read;
            if (call.url === SETUP_URL) return SAVED;
            if (call.url === VERIFY_URL) return { ok: true, models: ['claude-sonnet-5-5'] };
            if (call.url === '/api/onboarding/setup') {
                setup = { completed: false, done: ['model'], skipped: [] };
                return { status: 204 };
            }
        });
        const { router } = renderApp('/onboarding/model?returnTo=%2Ftasks');
        expect(screen.getByRole('heading', { level: 1, name: 'Connect a model' })).toBeTruthy();
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-abc' } });
        await waitFor(() => expect(saveButton().getAttribute('aria-disabled')).toBeNull());
        fireEvent.click(saveButton());
        await waitFor(() => expect(router.state.location.pathname).toBe('/onboarding/tools'));
        const put = calls.findIndex((c) => c.url === SETUP_URL);
        const post = calls.findIndex((c) => c.url === '/api/onboarding/setup');
        expect(put).toBeGreaterThan(-1);
        expect(post).toBeGreaterThan(put);
        expect(calls[post]?.body).toEqual({ step: 'model', action: 'done' });
        expect(screen.getByRole('link', { name: 'Back' })).toBeTruthy();
    });

    it('Settings → Model renders the same setup under its own heading', async () => {
        stubFetch((call) => {
            if (call.url === '/api/auth/me') return memberSession();
            return modelSetupReads(NOTHING, call);
        });
        renderApp('/settings/model');
        expect(await screen.findByRole('heading', { level: 1, name: 'Model' })).toBeTruthy();
        expect(await screen.findByRole('radiogroup', { name: 'Provider' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    });
});
