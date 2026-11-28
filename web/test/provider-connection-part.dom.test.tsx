import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from './dom.js';
import { board, orgDefault, setupCalls, verifyCalls } from './provider-fixtures.js';

/**
 * The provider connection part of the Connect a provider step: which cards a deployment offers, how a pasted key moves
 * the choice, the live key check, and who the connection is for — against a mocked board.
 */

afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
});

const mount = () => renderApp('/onboarding/provider?returnTo=%2F');
const keyInput = () => screen.findByLabelText('API key');
const status = () => screen.getByRole('status', { name: 'Key check' });
const card = () => screen.getByRole('group', { name: 'Default executor' });
const primary = () => screen.getByRole('button', { name: 'Create and continue' });
const settle = (ms = 400) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe('provider cards', () => {
    it('offers the subscription card self-hosted, and to a cloud org the operator allows', async () => {
        board({ session: { deploymentMode: 'cloud', subscriptionToken: true } });
        mount();
        expect(await screen.findByRole('radio', { name: /^Claude subscription/ })).toBeTruthy();
    });

    it('never offers the subscription card to a cloud org that is not allowed one', async () => {
        board({ session: { deploymentMode: 'cloud', subscriptionToken: false } });
        mount();
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect(screen.queryByRole('radio', { name: /^Claude subscription/ })).toBeNull();
    });

    it('a pasted OpenRouter key selects OpenRouter and OpenCode, with Claude Code still offered and Anthropic-only', async () => {
        const user = userEvent.setup();
        board({ verify: () => ({ ok: true, models: ['anthropic/claude-sonnet-5.5', 'openai/gpt-5.1'] }) });
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-or-v1-abc' } });
        expect((screen.getByRole('radio', { name: /^OpenRouter/ }) as HTMLInputElement).checked).toBe(true);
        await waitFor(() => expect(status().textContent).toContain('✓'));
        const agent = within(card()).getByRole('button', { name: 'Agent: OpenCode' });
        await user.click(agent);
        expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['OpenCode', 'Claude Code']);
        await user.click(screen.getByRole('option', { name: 'Claude Code' }));
        await user.click(within(card()).getByRole('button', { name: /^Default model: / }));
        expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['anthropic/claude-sonnet-5.5']);
    });

    it('locks OpenAI to OpenCode with the Codex note, and a subscription to Claude Code', async () => {
        const user = userEvent.setup();
        board();
        mount();
        await user.click(await screen.findByRole('radio', { name: /^OpenAI(?!-compatible)/ }));
        expect(within(card()).getByRole('button', { name: 'Agent: OpenCode' }).hasAttribute('disabled')).toBe(true);
        expect(within(card()).getByText(/OpenAI keys run on OpenCode/).textContent).toContain('Codex');
        await user.click(screen.getByRole('radio', { name: /^Claude subscription/ }));
        expect(within(card()).getByRole('button', { name: 'Agent: Claude Code' }).hasAttribute('disabled')).toBe(true);
        expect(screen.getByLabelText('Setup token')).toBeTruthy();
    });

    it('LiteLLM asks for the proxy URL with its help, and hides the Advanced base URL', async () => {
        board();
        mount();
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect(screen.getByLabelText(/^Base URL/)).toBeTruthy();
        fireEvent.click(screen.getByRole('radio', { name: /^LiteLLM/ }));
        const proxy = screen.getByLabelText('Proxy URL');
        expect(document.getElementById(proxy.getAttribute('aria-describedby') ?? '')?.textContent).toContain(
            '/v1/models'
        );
        expect(screen.queryByLabelText(/^Base URL/)).toBeNull();
        fireEvent.change(screen.getByLabelText('Virtual key'), { target: { value: 'sk-virtual' } });
        expect(screen.getByText('Enter the proxy URL to continue.')).toBeTruthy();
    });

    it('sends the Advanced base URL of a hosted provider with the connection', async () => {
        const user = userEvent.setup();
        const calls = board();
        mount();
        await user.click(await screen.findByText('Advanced'));
        fireEvent.change(screen.getByLabelText(/^Base URL/), { target: { value: 'https://gateway.example.test' } });
        fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-api03-gw' } });
        await waitFor(() => expect(status().textContent).toContain('✓'));
        await user.click(primary());
        await waitFor(() => expect(setupCalls(calls)).toHaveLength(1));
        expect(setupCalls(calls)[0]?.body).toMatchObject({
            connection: { provider: 'anthropic', baseUrl: 'https://gateway.example.test' },
        });
    });

    it('a subscription token in a cloud org not allowed one is refused in the check line, with no call', async () => {
        const calls = board({ session: { deploymentMode: 'cloud', subscriptionToken: false } });
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-oat01-abc' } });
        await waitFor(() => expect(status().textContent).toContain('This deployment accepts API keys only'));
        expect(verifyCalls(calls)).toHaveLength(0);
        expect(card().getAttribute('aria-disabled')).toBe('true');
    });

    it('a subscription token in a cloud org that is allowed one picks the subscription card, refused nowhere', async () => {
        board({ session: { deploymentMode: 'cloud', subscriptionToken: true } });
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-oat01-abc' } });
        await settle();
        expect((screen.getByRole('radio', { name: /^Claude subscription/ }) as HTMLInputElement).checked).toBe(true);
        expect(status().textContent).not.toContain('This deployment accepts API keys only');
    });
});

describe('the live key check', () => {
    it('debounces 350 ms into one call, then shows ✓ and the models it returned', async () => {
        vi.useFakeTimers();
        const calls = board();
        mount();
        await act(() => vi.advanceTimersByTimeAsync(10));
        const key = screen.getByLabelText('API key');
        fireEvent.change(key, { target: { value: 'sk-ant-api03-a' } });
        await act(() => vi.advanceTimersByTimeAsync(200));
        fireEvent.change(key, { target: { value: 'sk-ant-api03-ab' } });
        await act(() => vi.advanceTimersByTimeAsync(349));
        expect(verifyCalls(calls)).toHaveLength(0);
        await act(() => vi.advanceTimersByTimeAsync(1));
        await act(() => vi.advanceTimersByTimeAsync(10));
        expect(verifyCalls(calls)).toHaveLength(1);
        expect(verifyCalls(calls)[0]?.body).toEqual({ provider: 'anthropic', key: 'sk-ant-api03-ab' });
        expect(status().textContent).toContain('✓ Key works · 2 models available');
        expect(primary().getAttribute('aria-disabled')).toBeNull();
    });

    it('NO_CREDIT is ▲ and still allows the setup; a refused key is ✕ with the server sentence and blocks it', async () => {
        board({
            verify: (call) =>
                (call.body as { key: string }).key.includes('poor')
                    ? { ok: false, code: 'NO_CREDIT', message: 'The account has no credit left' }
                    : { ok: false, code: 'INVALID_KEY', message: 'OpenRouter refused this key' },
        });
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-or-v1-poor' } });
        await waitFor(() => expect(status().textContent).toContain('▲ '));
        expect(status().textContent).toContain('The account has no credit left');
        expect(card().getAttribute('aria-disabled')).toBeNull();
        expect(primary().getAttribute('aria-disabled')).toBeNull();

        fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-or-v1-revoked' } });
        await waitFor(() => expect(status().textContent).toContain('✕ OpenRouter refused this key'));
        expect(primary().getAttribute('aria-disabled')).toBe('true');
        expect(document.getElementById(primary().getAttribute('aria-describedby') ?? '')?.textContent).toBe(
            'Fix the key to continue.'
        );
    });

    it('drops an answer for a key that changed while it was in flight', async () => {
        let release: (value: unknown) => void = () => undefined;
        const first = new Promise((resolve) => {
            release = resolve;
        });
        board({
            verify: (call) =>
                (call.body as { key: string }).key.endsWith('old')
                    ? first
                    : { ok: false, code: 'INVALID_KEY', message: 'Anthropic refused this key' },
        });
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-old' } });
        await settle();
        fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-api03-new' } });
        await waitFor(() => expect(status().textContent).toContain('✕ Anthropic refused this key'));
        release({ ok: true, models: ['claude-stale'] });
        await settle(30);
        expect(status().textContent).toContain('✕ Anthropic refused this key');
    });
});

describe('who the connection is for', () => {
    it('a member gets only "Only me" with the note, and the setup is personal', async () => {
        const user = userEvent.setup();
        const calls = board({ session: { role: 'member' } });
        mount();
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect(screen.queryByRole('radio', { name: /^Everyone in/ })).toBeNull();
        expect(screen.getByText(/Only an admin can add a key for everyone in Bellows AI/)).toBeTruthy();
        expect(screen.getByText(/Saved as your personal connection/).textContent).toContain(
            'Nobody — admins included — can read the key back'
        );
        expect(within(card()).getByText('Personal')).toBeTruthy();
        fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-api03-mine' } });
        await waitFor(() => expect(status().textContent).toContain('✓'));
        await user.click(primary());
        await waitFor(() => expect(setupCalls(calls)).toHaveLength(1));
        expect(setupCalls(calls)[0]?.body).toMatchObject({ scope: 'personal' });
    });

    it('an admin chooses, the organization by default, and the card follows the choice', async () => {
        const user = userEvent.setup();
        board();
        mount();
        const everyone = (await screen.findByRole('radio', { name: /^Everyone in/ })) as HTMLInputElement;
        expect(everyone.checked).toBe(true);
        expect(within(card()).getByText('Organization')).toBeTruthy();
        await user.click(screen.getByRole('radio', { name: 'Only me' }));
        expect(within(card()).getByText('Personal')).toBeTruthy();
    });
});

describe('what the setup waits for', () => {
    it('an empty connection name or executor name waits with its reason, and an aria-disabled press writes nothing', async () => {
        const user = userEvent.setup();
        const calls = board();
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-ok' } });
        await waitFor(() => expect(status().textContent).toContain('✓'));
        fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: ' ' } });
        expect(screen.getByText('Give the connection a name.')).toBeTruthy();
        fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'Anthropic' } });
        fireEvent.change(within(card()).getByLabelText('Executor name'), { target: { value: '' } });
        expect(screen.getByText('Give the executor a name.')).toBeTruthy();
        await user.click(primary());
        expect(setupCalls(calls)).toHaveLength(0);
    });
});

describe('an org that is already set up, per role', () => {
    const set = orgDefault();

    it('offers a member no key replacement on the organization’s connection, and "Add another provider" starts personal', async () => {
        const user = userEvent.setup();
        board({ session: { role: 'member' }, workspace: set.workspace, connections: { connections: set.connections } });
        mount();
        await screen.findByText(/runs tasks on Claude Code · Sonnet\./);
        expect(screen.queryByRole('button', { name: 'Replace the key' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Add another provider' }));
        expect(screen.queryByRole('radio', { name: /^Everyone in/ })).toBeNull();
        expect(within(card()).getByText('Personal')).toBeTruthy();
    });
});
