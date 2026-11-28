import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/api/useSession.js';
import { ModelSetup } from '../src/model-setup/ModelSetupForm.js';
import { renderAt, stubFetch, type FetchCall } from './dom.js';
import { memberSession } from './fixtures.js';

/**
 * What is saved survives a save the member did not change: a default executor's model the list does not name stays as
 * "Other…" text and goes back in the PUT as it was, on its own connection; a saved base or proxy URL pre-fills a new
 * connection.
 */

afterEach(() => {
    window.history.replaceState(null, '', '/');
});

type Setup = Record<string, unknown>;
const SAVED = {
    saved: true,
    scope: 'personal',
    executorId: 'executor-1',
    executorName: 'Adopted',
    connectionId: null,
    connectionName: null,
    replayed: false,
};
/** The edit body: the selected executor by id on its own connection, a request id the hook minted. */
const edited = (agentType: string, model: string) => ({
    scope: 'personal',
    requestId: expect.any(String),
    agentType,
    model,
    connection: { intent: 'reuse', id: 'connection-1' },
    executor: { id: 'executor-1', expectedUpdatedAt: UPDATED_AT },
});

function board(setup: Setup) {
    return stubFetch((call) => {
        if (call.url === '/api/auth/me') return memberSession();
        if (call.url === '/api/model-setup' && call.method === 'GET') return setup;
        if (call.url === '/api/model-setup' && call.method === 'PUT') return SAVED;
        if (call.url === '/api/onboarding/setup') return { status: 204 };
        if (call.url === '/api/model-setup/verify') return { ok: true };
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

const UPDATED_AT = '2026-01-02T03:04:05.678Z';
const scopeView = (provider: string, keyNames: string[]) => ({ provider, keyNames });
/** A personal default executor on a connection of `provider`, running `agentType` and `model`. */
const executorOn = (provider: string, agentType: string, model: string) => ({
    org: null,
    personal: null,
    effective: 'executor',
    selected: {
        scope: 'personal',
        executorId: 'executor-1',
        name: 'Mine',
        agentType,
        model,
        suspended: false,
        updatedAt: UPDATED_AT,
        connection: { id: 'connection-1', name: 'Mine', provider, scope: 'personal', baseUrl: null },
    },
});
const putBody = (calls: FetchCall[]) => calls.find((c) => c.method === 'PUT')?.body;
const modelSelect = () => screen.getByLabelText('Model') as HTMLSelectElement;

async function saveUnchanged(calls: FetchCall[], onSaved: ReturnType<typeof vi.fn>) {
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    return putBody(calls);
}

describe('a saved model the list does not name', () => {
    it('survives a no-op Save on the default executor: Other… with the saved id, sent back as it was', async () => {
        const calls = board(executorOn('openrouter', 'opencode', 'openrouter/mistralai/devstral'));
        const onSaved = mount();
        await screen.findByText('Your tasks run on Mine.');
        expect(modelSelect().value).toBe('');
        expect((screen.getByLabelText('Model id') as HTMLInputElement).value).toBe('openrouter/mistralai/devstral');
        expect(await saveUnchanged(calls, onSaved)).toEqual(edited('opencode', 'openrouter/mistralai/devstral'));
    });

    it('matches a listed model after normalization instead of replacing it', async () => {
        const calls = board(executorOn('openrouter', 'opencode', 'openrouter/openai/gpt-5.1'));
        const onSaved = mount();
        await screen.findByText('Your tasks run on Mine.');
        expect(modelSelect().value).toBe('openai/gpt-5.1');
        expect((await saveUnchanged(calls, onSaved)) as { model: string }).toMatchObject({
            model: 'openrouter/openai/gpt-5.1',
        });
    });

    it("keeps a LiteLLM default's model, which no list names", async () => {
        const calls = board(executorOn('litellm', 'claude-code', 'gpt-5.1-on-proxy'));
        const onSaved = mount();
        await screen.findByText('Your tasks run on Mine.');
        expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('gpt-5.1-on-proxy');
        expect(await saveUnchanged(calls, onSaved)).toMatchObject({
            agentType: 'claude-code',
            model: 'gpt-5.1-on-proxy',
        });
    });

    it("prefills the key form with the provider of the member's own key", async () => {
        const personal = scopeView('openrouter', ['OPENROUTER_API_KEY']);
        board({ org: null, personal, effective: 'personal' });
        mount();
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect((screen.getByRole('radio', { name: /^OpenRouter/ }) as HTMLInputElement).checked).toBe(true);
    });
});

describe('a saved base or proxy URL', () => {
    /** Pastes a key, waits for the check, saves unchanged; answers the PUT body and the check's body. */
    async function pasteAndSave(calls: FetchCall[], onSaved: ReturnType<typeof vi.fn>, label: string, key: string) {
        fireEvent.change(await screen.findByLabelText(label), { target: { value: key } });
        const save = screen.getByRole('button', { name: 'Save' });
        await waitFor(() => expect(save.getAttribute('aria-disabled')).toBeNull());
        fireEvent.click(save);
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        return { put: putBody(calls), verify: calls.find((c) => c.url === '/api/model-setup/verify')?.body };
    }

    it('prefills the Advanced base URL and sends it back on a Save that leaves it', async () => {
        const personal = scopeView('anthropic', ['ANTHROPIC_API_KEY']);
        const calls = board({
            org: null,
            personal: { ...personal, baseUrl: 'https://gw.example.test' },
        });
        const onSaved = mount();
        expect(((await screen.findByLabelText(/^Base URL/)) as HTMLInputElement).value).toBe('https://gw.example.test');
        const sent = await pasteAndSave(calls, onSaved, 'API key', 'sk-ant-api03-new');
        expect(sent.verify).toMatchObject({ baseUrl: 'https://gw.example.test' });
        expect(sent.put).toEqual({
            scope: 'personal',
            requestId: expect.any(String),
            agentType: 'claude-code',
            model: 'claude-sonnet-5-5',
            connection: {
                intent: 'create',
                provider: 'anthropic',
                key: 'sk-ant-api03-new',
                baseUrl: 'https://gw.example.test',
                name: 'Anthropic',
            },
            executor: { name: 'Anthropic' },
        });
    });

    it("prefills LiteLLM's proxy URL and sends it back with the typed model", async () => {
        const personal = scopeView('litellm', ['ANTHROPIC_API_KEY']);
        const calls = board({
            org: null,
            personal: { ...personal, baseUrl: 'https://llm.example.test' },
        });
        const onSaved = mount();
        expect(((await screen.findByLabelText('Proxy URL')) as HTMLInputElement).value).toBe(
            'https://llm.example.test'
        );
        fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'proxy-model' } });
        const sent = await pasteAndSave(calls, onSaved, 'Virtual key', 'sk-virtual');
        expect(sent.put).toMatchObject({
            model: 'proxy-model',
            connection: { intent: 'create', provider: 'litellm', baseUrl: 'https://llm.example.test' },
        });
    });

    it('does not carry a base URL saved as a secret into a new connection: no value, no keep flag', async () => {
        const personal = scopeView('openai', ['OPENAI_API_KEY']);
        const calls = board({ org: null, personal: { ...personal, baseUrlSet: true } });
        const onSaved = mount();
        const sent = await pasteAndSave(calls, onSaved, 'API key', 'sk-proj-new');
        const connection = (sent.put as { connection: Record<string, unknown> }).connection;
        expect(connection).toMatchObject({ intent: 'create', provider: 'openai' });
        expect(connection).not.toHaveProperty('baseUrl');
        expect(JSON.stringify(sent.put)).not.toContain('keepBaseUrl');
    });
});
