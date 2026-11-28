import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderApp, stubFetch } from './dom.js';
import { board, orgDefault, setupCalls, verifyCalls } from './provider-fixtures.js';

/**
 * Setup step 2, Connect a provider: the provider connection (part 1) and the default executor on it (part 2), against a
 * mocked board. The executor card waits for the key check, its name follows the agent and model until edited, and
 * Create and continue is one setup command with both names.
 */

afterEach(() => {
    window.history.replaceState(null, '', '/');
});

const PATH = '/onboarding/provider?returnTo=%2F';
const WAITING = 'Check the key first — the models come from the provider.';

/** A board whose `/api/auth/me` answers 500. */
const stubFetchSessionDown = () => stubFetch((call) => (call.url === '/api/auth/me' ? { status: 500 } : undefined));

const mount = () => renderApp(PATH);
const keyInput = () => screen.findByLabelText('API key');
const card = () => screen.getByRole('group', { name: 'Default executor' });
const primary = () => screen.getByRole('button', { name: /^(Create and continue|Continue|Replace key)$/ });
const status = () => screen.getByRole('status', { name: 'Key check' });

/** Pastes a key and waits for the check to answer ✓. */
async function pasteGoodKey(value = 'sk-ant-api03-good') {
    fireEvent.change(await keyInput(), { target: { value } });
    await waitFor(() => expect(status().textContent).toContain('✓'));
}

describe('the Connect a provider step', () => {
    it('renders the provider connection and the default executor as two parts under the Provider step', async () => {
        board();
        mount();
        expect(await screen.findByRole('heading', { level: 1, name: 'Connect a provider' })).toBeTruthy();
        const steps = screen.getByRole('list', { name: 'Setup progress' });
        const labels = within(steps)
            .getAllByRole('listitem')
            .map((li) => /Repositories|Provider|Tools/.exec(li.textContent ?? '')?.[0]);
        expect(labels).toEqual(['Repositories', 'Provider', 'Tools']);
        expect(within(steps).getByText('Provider').closest('li')?.getAttribute('aria-current')).toBe('step');
        expect(screen.getByRole('heading', { level: 2, name: 'Provider connection' })).toBeTruthy();
        expect(screen.getByRole('heading', { level: 2, name: 'Default executor' })).toBeTruthy();
        expect(screen.getByRole('radiogroup', { name: 'Provider' })).toBeTruthy();
        expect(screen.getByLabelText('Connection name')).toBeTruthy();
        expect(screen.getByText('Skip for now')).toBeTruthy();
    });

    it('keeps the executor card dimmed with its reason until the key check answers ok', async () => {
        board();
        mount();
        await keyInput();
        expect(card().getAttribute('aria-disabled')).toBe('true');
        expect(within(card()).getByText(WAITING)).toBeTruthy();
        expect((within(card()).getByLabelText('Executor name') as HTMLInputElement).disabled).toBe(true);
        expect(primary().getAttribute('aria-disabled')).toBe('true');

        await pasteGoodKey();
        expect(card().getAttribute('aria-disabled')).toBeNull();
        expect(within(card()).queryByText(WAITING)).toBeNull();
        expect((within(card()).getByLabelText('Executor name') as HTMLInputElement).disabled).toBe(false);
    });

    it('a check that cannot run is "could not check", never "the key was refused", and the card stays dimmed', async () => {
        board({ verify: () => ({ status: 503, body: { error: 'down' } }) });
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-ant-api03-x' } });
        await waitFor(() => expect(status().textContent).toContain('could not check'));
        expect(status().textContent).not.toMatch(/refused/i);
        expect(card().getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByText('The key could not be checked. Try again.')).toBeTruthy();
    });

    it('names the executor "<Agent> · <Model family>", following the choices until the member edits it', async () => {
        const user = userEvent.setup();
        board();
        mount();
        await pasteGoodKey();
        const name = () => (within(card()).getByLabelText('Executor name') as HTMLInputElement).value;
        expect(name()).toBe('Claude Code · Sonnet');

        await user.click(within(card()).getByRole('button', { name: /^Default model: / }));
        await user.click(screen.getByRole('option', { name: 'claude-opus-5-5' }));
        expect(name()).toBe('Claude Code · Opus');

        await user.clear(within(card()).getByLabelText('Executor name'));
        await user.type(within(card()).getByLabelText('Executor name'), 'Mine');
        await user.click(within(card()).getByRole('button', { name: /^Default model: / }));
        await user.click(screen.getByRole('option', { name: 'claude-sonnet-5-5' }));
        expect(name()).toBe('Mine');
    });

    it('offers the model the member types as its own row', async () => {
        const user = userEvent.setup();
        const calls = board();
        mount();
        await pasteGoodKey();
        await user.click(within(card()).getByRole('button', { name: /^Default model: / }));
        await user.type(screen.getByRole('combobox', { name: 'Search default model' }), 'claude-haiku-5-5');
        await user.click(screen.getByRole('option', { name: 'Use “claude-haiku-5-5”' }));
        await user.click(primary());
        await waitFor(() => expect(setupCalls(calls)).toHaveLength(1));
        expect(setupCalls(calls)[0]?.body).toMatchObject({ executor: { model: 'claude-haiku-5-5' } });
    });

    it('Create and continue posts one setup command with both names and makeDefault, then records the step', async () => {
        const user = userEvent.setup();
        const calls = board();
        const { router } = mount();
        await pasteGoodKey();
        fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'Team Anthropic' } });
        await user.click(screen.getByRole('radio', { name: /^Everyone in/ }));
        expect(screen.getByText(/Creates the Team Anthropic connection and makes Claude Code · Sonnet/)).toBeTruthy();
        await user.click(primary());

        await waitFor(() => expect(router.state.location.pathname).toBe('/onboarding/tools'));
        expect(setupCalls(calls)).toHaveLength(1);
        const body = setupCalls(calls)[0]?.body as { requestId: string };
        expect(body).toEqual({
            scope: 'org',
            requestId: body.requestId,
            connection: { intent: 'create', provider: 'anthropic', key: 'sk-ant-api03-good', name: 'Team Anthropic' },
            executor: { name: 'Claude Code · Sonnet', agentType: 'claude-code', model: 'claude-sonnet-5-5' },
            makeDefault: true,
        });
        const recorded = calls.filter((c) => c.method === 'POST' && c.url === '/api/onboarding/setup');
        expect(recorded.map((c) => c.body)).toEqual([{ step: 'provider', action: 'done' }]);
    });

    it('repeats the request id when a refused submission is retried, and a new one after a change', async () => {
        const user = userEvent.setup();
        const calls = board({ setup: { status: 409, body: { error: 'That name is taken.' } } });
        mount();
        await pasteGoodKey();
        await user.click(primary());
        expect((await screen.findByRole('alert')).textContent).toContain('That name is taken.');
        await user.click(primary());
        await waitFor(() => expect(setupCalls(calls)).toHaveLength(2));
        const ids = setupCalls(calls).map((c) => (c.body as { requestId: string }).requestId);
        expect(ids[1]).toBe(ids[0]);
        fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'Other' } });
        await user.click(primary());
        await waitFor(() => expect(setupCalls(calls)).toHaveLength(3));
        const third = setupCalls(calls)[2]?.body as { requestId: string };
        expect(third.requestId).not.toBe(ids[0]);
    });

    it('Skip for now records a skip and sends no setup command', async () => {
        const user = userEvent.setup();
        const calls = board();
        const { router } = mount();
        await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/onboarding/tools'));
        expect(setupCalls(calls)).toHaveLength(0);
        expect(calls.find((c) => c.method === 'POST' && c.url === '/api/onboarding/setup')?.body).toEqual({
            step: 'provider',
            action: 'skip',
        });
    });
});

describe('the provider cards', () => {
    it('shows the subscription card only to an org allowed a subscription token', async () => {
        board({ session: { subscriptionToken: false } });
        mount();
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect(screen.queryByRole('radio', { name: /^Claude subscription/ })).toBeNull();
        expect(screen.getByRole('radio', { name: /^Anthropic/ })).toBeTruthy();
    });

    it('offers it to an org that is allowed', async () => {
        board({ session: { subscriptionToken: true } });
        mount();
        expect(await screen.findByRole('radio', { name: /^Claude subscription/ })).toBeTruthy();
    });

    it('the OpenAI-compatible card needs an endpoint URL and locks the agent to OpenCode', async () => {
        const user = userEvent.setup();
        const calls = board();
        mount();
        await user.click(await screen.findByRole('radio', { name: /^OpenAI-compatible/ }));
        fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-endpoint' } });
        expect(screen.getByText('Enter the endpoint URL to continue.')).toBeTruthy();
        expect(verifyCalls(calls)).toHaveLength(0);

        fireEvent.change(screen.getByLabelText('Endpoint URL'), {
            target: { value: 'https://models.example.test/v1' },
        });
        await waitFor(() => expect(status().textContent).toContain('✓'));
        const agent = within(card()).getByRole('button', { name: 'Agent: OpenCode' }) as HTMLButtonElement;
        expect(agent.disabled).toBe(true);
        expect(within(card()).getByText(/a custom endpoint runs on OpenCode/)).toBeTruthy();
        await user.click(primary());
        await waitFor(() => expect(setupCalls(calls)).toHaveLength(1));
        expect(setupCalls(calls)[0]?.body).toMatchObject({
            connection: { provider: 'openai-compatible', baseUrl: 'https://models.example.test/v1' },
            executor: { agentType: 'opencode' },
        });
    });

    it('a pasted key moves the choice to the provider its prefix names', async () => {
        board();
        mount();
        fireEvent.change(await keyInput(), { target: { value: 'sk-or-v1-abc' } });
        expect((screen.getByRole('radio', { name: /^OpenRouter/ }) as HTMLInputElement).checked).toBe(true);
        expect((screen.getByLabelText('Connection name') as HTMLInputElement).value).toBe('OpenRouter');
    });
});

describe('an org that is already set up', () => {
    const set = orgDefault();

    it('names the executor, then the connection, and Continue records the step with no write', async () => {
        const user = userEvent.setup();
        const calls = board({ workspace: set.workspace, connections: { connections: set.connections } });
        const { router } = mount();
        expect(await screen.findByText(/runs tasks on Claude Code · Sonnet\./)).toBeTruthy();
        expect(await screen.findByText(/claude-sonnet-5-5/)).toBeTruthy();
        expect(screen.getByText('Anthropic', { selector: 'b' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Add another provider' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Replace the key' })).toBeTruthy();
        expect(screen.queryByRole('radiogroup', { name: 'Provider' })).toBeNull();
        await user.click(primary());
        await waitFor(() => expect(router.state.location.pathname).toBe('/onboarding/tools'));
        expect(setupCalls(calls)).toHaveLength(0);
    });

    it('Add another provider opens the form', async () => {
        const user = userEvent.setup();
        board({ workspace: set.workspace, connections: { connections: set.connections } });
        mount();
        await user.click(await screen.findByRole('button', { name: 'Add another provider' }));
        expect(screen.getByRole('radiogroup', { name: 'Provider' })).toBeTruthy();
        expect(primary().textContent).toBe('Create and continue');
    });

    it('Replace the key rotates the connection under the executor’s id', async () => {
        const user = userEvent.setup();
        const calls = board({ workspace: set.workspace, connections: { connections: set.connections } });
        mount();
        await user.click(await screen.findByRole('button', { name: 'Replace the key' }));
        await pasteGoodKey('sk-ant-api03-new');
        await user.click(primary());
        await waitFor(() => expect(setupCalls(calls)).toHaveLength(1));
        expect(setupCalls(calls)[0]?.body).toMatchObject({
            scope: 'org',
            connection: { intent: 'rotate', id: 'connection-org', key: 'sk-ant-api03-new' },
            executor: { id: 'executor-org', agentType: 'claude-code', model: 'claude-sonnet-5-5' },
        });
    });

    it('a failed workspace read shows neither the set-up banner nor the empty form', async () => {
        board({ workspace: { status: 500, body: { error: 'down' } } });
        mount();
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
        expect(screen.queryByRole('radiogroup', { name: 'Provider' })).toBeNull();
        expect(screen.queryByText(/runs tasks on/)).toBeNull();
    });

    it('a default that names no row in the list is two reads that disagree: an error with Retry, never the empty form', async () => {
        board({
            workspace: { executors: [], orgExecutors: [], defaultExecutor: { scope: 'org', name: 'Ghost' } },
            connections: { connections: [] },
        });
        mount();
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
        expect(screen.queryByRole('radiogroup', { name: 'Provider' })).toBeNull();
    });

    it('a failed session read is one error with Retry, not a loading line', async () => {
        const calls = stubFetchSessionDown();
        mount();
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
        expect(screen.queryByText('Loading the provider setup…')).toBeNull();
        expect(calls.length).toBeGreaterThan(0);
    });
});
