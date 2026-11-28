import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSetupView, SelectedExecutorView } from '../src/api/useModelSetup.js';
import type { Session } from '../src/api/useSession.js';
import { ModelSetup } from '../src/model-setup/ModelSetupForm.js';
import { type FetchCall, renderAt, stubFetch } from './dom.js';
import { memberSession } from './fixtures.js';
import { modelSetupReads, SETUP_URL, setupCalls, VERIFY_URL } from './model-setup-reads.js';

/**
 * What is saved survives a save the member did not change: a saved model the list does not name stays as "Other…"
 * text and goes back in the setup command as it was, on the executor's own connection.
 */

afterEach(() => {
    window.history.replaceState(null, '', '/');
});

const SAVED = {
    scope: 'personal',
    executorId: 'executor-1',
    executorName: 'Mine',
    connectionId: 'connection-1',
    connectionName: 'Mine',
    replayed: false,
};

/** A default executor of the member's, on a connection of `provider`, saved with `model`. */
const executorView = (
    provider: 'anthropic' | 'openrouter' | 'litellm',
    agentType: 'claude-code' | 'opencode',
    model: string
): ModelSetupView => {
    const selected: SelectedExecutorView = {
        scope: 'personal',
        executorId: 'executor-1',
        name: 'Mine',
        agentType,
        model,
        suspended: false,
        updatedAt: '2026-01-02T03:04:05.678Z',
        connection: { id: 'connection-1', name: 'Mine', provider, scope: 'personal', baseUrl: null },
    };
    return { org: null, personal: null, selected, effective: 'executor' };
};

function board(setup: ModelSetupView) {
    return stubFetch((call: FetchCall) => {
        if (call.url === '/api/auth/me') return memberSession();
        const read = modelSetupReads(setup, call);
        if (read !== undefined) return read;
        if (call.method === 'POST' && call.url === SETUP_URL) return SAVED;
        if (call.url === VERIFY_URL) return { ok: true };
    });
}

/** Settings-style mount: Save writes the banner's default every time. */
function mount(session: Partial<Session> = {}) {
    const onSaved = vi.fn();
    renderAt(
        <ModelSetup
            session={memberSession(session)}
            labels={{ form: 'Save', banner: 'Save' }}
            saveExisting
            onSaved={onSaved}
            footer={(primary) => primary}
        />
    );
    return onSaved;
}

const modelSelect = () => screen.getByLabelText('Model') as HTMLSelectElement;
const executorOf = (calls: FetchCall[]) =>
    ((setupCalls(calls)[0] as FetchCall).body as { executor: Record<string, unknown> }).executor;

async function saveUnchanged(calls: FetchCall[], onSaved: ReturnType<typeof vi.fn>) {
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    return setupCalls(calls)[0]?.body;
}

describe('a saved model the list does not name', () => {
    it('survives a no-op Save: Other… with the saved id, sent back as it was on the same connection', async () => {
        const calls = board(executorView('openrouter', 'opencode', 'openrouter/mistralai/devstral'));
        const onSaved = mount();
        await screen.findByText('Your tasks run on Mine.');
        expect(modelSelect().value).toBe('');
        expect((screen.getByLabelText('Model id') as HTMLInputElement).value).toBe('openrouter/mistralai/devstral');
        expect(await saveUnchanged(calls, onSaved)).toEqual({
            scope: 'personal',
            requestId: expect.any(String),
            connection: { intent: 'reuse', id: 'connection-1' },
            executor: {
                id: 'executor-1',
                agentType: 'opencode',
                model: 'openrouter/mistralai/devstral',
                expectedUpdatedAt: '2026-01-02T03:04:05.678Z',
            },
            makeDefault: true,
        });
    });

    it('matches a listed model after normalization instead of replacing it', async () => {
        const calls = board(executorView('openrouter', 'opencode', 'openrouter/openai/gpt-5.1'));
        const onSaved = mount();
        await screen.findByText('Your tasks run on Mine.');
        expect(modelSelect().value).toBe('openai/gpt-5.1');
        await saveUnchanged(calls, onSaved);
        expect(executorOf(calls)).toMatchObject({ model: 'openai/gpt-5.1' });
    });

    it("keeps a LiteLLM default's model, which no list names", async () => {
        const calls = board(executorView('litellm', 'claude-code', 'gpt-5.1-on-proxy'));
        const onSaved = mount();
        await screen.findByText('Your tasks run on Mine.');
        expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('gpt-5.1-on-proxy');
        await saveUnchanged(calls, onSaved);
        expect(executorOf(calls)).toMatchObject({ agentType: 'claude-code', model: 'gpt-5.1-on-proxy' });
    });
});
