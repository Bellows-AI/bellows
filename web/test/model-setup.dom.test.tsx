import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/api/useSession.js';
import { ModelSetup } from '../src/model-setup/ModelSetupForm.js';
import { renderApp, renderAt, stubFetch, type FetchCall, type FetchReply } from './dom.js';
import { memberSession } from './fixtures.js';

/**
 * Connect a model (the onboarding step and Settings → Model share `ModelSetup`): the provider cards, the live key
 * check, the agent and model, who the key is for, the configured banners, and Save — against a mocked board.
 */

afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
});

const NOTHING = { platform: false, org: null, personal: null, effective: null };
type Setup = Record<string, unknown>;

/** Answers the setup read with `setup`, the key check with `verify(call)`; the PUT answers saved. */
function board(
    setup: Setup | { status: number } = NOTHING,
    verify: (call: FetchCall) => FetchReply = () => ({ ok: true })
) {
    return stubFetch((call) => {
        if (call.url === '/api/model-setup' && call.method === 'GET') return setup;
        if (call.url === '/api/model-setup' && call.method === 'PUT') return { saved: true };
        if (call.url === '/api/model-setup/verify') return verify(call);
    });
}

function mount(session: Partial<Session> = {}, onSaved = vi.fn()) {
    const view = renderAt(
        <ModelSetup
            session={memberSession(session)}
            labels={{ form: 'Save and continue', banner: 'Continue' }}
            onSaved={onSaved}
            footer={(primary) => primary}
        />
    );
    return { ...view, onSaved };
}

const keyInput = () => screen.findByLabelText('API key');
const saveButton = () => screen.getByRole('button', { name: /^(Save and continue|Continue)$/ });
const verifies = (calls: FetchCall[]) => calls.filter((c) => c.url === '/api/model-setup/verify');
const puts = (calls: FetchCall[]) => calls.filter((c) => c.method === 'PUT');
const status = () => screen.getByRole('status', { name: 'Key check' });

describe('provider cards', () => {
    it('offers the subscription card self-hosted, never in cloud', async () => {
        board();
        const selfHosted = mount();
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect(screen.getByRole('radio', { name: /^Claude subscription/ })).toBeTruthy();
        selfHosted.unmount();

        board();
        mount({ deploymentMode: 'cloud' });
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
        await userEvent.setup().click(await screen.findByRole('radio', { name: /^OpenAI/ }));
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

    it('a subscription token in cloud is refused in the check line, with no call', async () => {
        const calls = board();
        mount({ deploymentMode: 'cloud' });
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-oat01-abc' } });
        await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
        expect(status().textContent).toContain(
            'This is a Claude subscription token. This deployment accepts API keys only'
        );
        expect(verifies(calls)).toHaveLength(0);
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
    it('a member gets only "Only me" with the note; the secret note names the env and the scope', async () => {
        board();
        mount();
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect(screen.queryByRole('radio', { name: /^Everyone in/ })).toBeNull();
        expect(screen.getByText(/Only an admin can add a key for everyone in Bellows AI/)).toBeTruthy();
        const note = screen.getByText(/Saved as your personal secret/);
        expect(note.textContent).toContain('ANTHROPIC_API_KEY');
    });

    it('an admin chooses, the organization by default', async () => {
        board();
        mount({ role: 'admin' });
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect((screen.getByRole('radio', { name: 'Everyone in Bellows AI' }) as HTMLInputElement).checked).toBe(true);
        expect(screen.getByText(/Saved as an organization secret/).textContent).toContain('ANTHROPIC_API_KEY');
        fireEvent.click(screen.getByRole('radio', { name: 'Only me' }));
        expect(screen.getByText(/Saved as your personal secret/)).toBeTruthy();
    });
});

describe('Save', () => {
    it('waits with its reason, then saves the key and default and hands over once the setup is re-read', async () => {
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
            provider: 'anthropic',
            key: 'sk-ant-api03-abc',
            agentType: 'claude-code',
            model: 'claude-sonnet-5-5',
        });
        const put = calls.findIndex((c) => c.method === 'PUT');
        expect(calls.slice(put).some((c) => c.url === '/api/model-setup' && c.method === 'GET')).toBe(true);
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
        await waitFor(() => expect(calls.filter((c) => c.url === '/api/model-setup').length).toBe(2));
    });
});

describe('the configured banners', () => {
    it('the platform banner saves the chosen agent and model on the platform', async () => {
        const calls = board({ platform: true, org: null, personal: null, effective: 'platform' });
        const { onSaved } = mount({ platformModel: true });
        expect(await screen.findByText('This deployment provides a model.')).toBeTruthy();
        expect((screen.getByLabelText('Agent') as HTMLSelectElement).value).toBe('claude-code');
        expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('claude-sonnet-5-5');
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts(calls)[0]?.body).toEqual({
            scope: 'personal',
            provider: 'platform',
            agentType: 'claude-code',
            model: 'claude-sonnet-5-5',
        });
    });

    it('"Use a personal key" opens the form at Only me', async () => {
        board({ platform: true, org: null, personal: null, effective: 'platform' });
        mount({ platformModel: true, role: 'admin' });
        fireEvent.click(await screen.findByRole('button', { name: 'Use a personal key' }));
        expect(screen.getByRole('radiogroup', { name: 'Provider' })).toBeTruthy();
        expect((screen.getByRole('radio', { name: 'Only me' }) as HTMLInputElement).checked).toBe(true);
    });

    const orgKey = { provider: 'anthropic', agentType: null, model: null, keyNames: ['ANTHROPIC_API_KEY'] };

    it("the org banner saves the agent alone on the org's key when no default exists", async () => {
        const calls = board({ platform: false, org: orgKey, personal: null, effective: 'org' });
        const { onSaved } = mount();
        expect(await screen.findByText('Bellows AI already has a model.')).toBeTruthy();
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts(calls)[0]?.body).toEqual({
            scope: 'personal',
            provider: 'existing',
            agentType: 'claude-code',
            model: 'claude-sonnet-5-5',
        });
    });

    it('with a default already set, Continue only records the step', async () => {
        const org = { ...orgKey, agentType: 'claude-code', model: 'claude-opus-5-5' };
        const calls = board({ platform: false, org, personal: null, effective: 'org' });
        const { onSaved } = mount();
        const banner = await screen.findByText('Bellows AI already has a model.');
        expect(within(banner.closest('div') as HTMLElement).getByText(/Anthropic/)).toBeTruthy();
        fireEvent.click(saveButton());
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(puts(calls)).toHaveLength(0);
    });
});

describe('the pages', () => {
    it('the onboarding step saves, records the step done, re-reads /me and moves on', async () => {
        let setup: Session['setup'] = { completed: false, done: [], skipped: [] };
        const calls = stubFetch((call) => {
            if (call.url === '/api/auth/me') return memberSession({ setup });
            if (call.url === '/api/model-setup' && call.method === 'GET') return NOTHING;
            if (call.url === '/api/model-setup' && call.method === 'PUT') return { saved: true };
            if (call.url === '/api/model-setup/verify') return { ok: true, models: ['claude-sonnet-5-5'] };
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
        const put = calls.findIndex((c) => c.method === 'PUT');
        const post = calls.findIndex((c) => c.url === '/api/onboarding/setup');
        expect(put).toBeGreaterThan(-1);
        expect(post).toBeGreaterThan(put);
        expect(calls[post]?.body).toEqual({ step: 'model', action: 'done' });
        expect(screen.getByRole('link', { name: 'Back' })).toBeTruthy();
    });

    it('Settings → Model renders the same setup under its own heading', async () => {
        stubFetch((call) => {
            if (call.url === '/api/auth/me') return memberSession();
            if (call.url === '/api/model-setup') return NOTHING;
        });
        renderApp('/settings/model');
        expect(await screen.findByRole('heading', { level: 1, name: 'Model' })).toBeTruthy();
        expect(await screen.findByRole('radiogroup', { name: 'Provider' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    });
});
