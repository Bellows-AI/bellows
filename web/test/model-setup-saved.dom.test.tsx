import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/api/useSession.js';
import { ModelSetup } from '../src/model-setup/ModelSetupForm.js';
import { renderApp, renderAt, stubFetch, type FetchCall } from './dom.js';
import { memberSession } from './fixtures.js';

/**
 * What is saved survives a save the member did not change: a saved model the list does not name stays as "Other…"
 * text and goes back in the PUT as it was; a legacy setup adopts a real executor with the `none` intent, the route
 * deciding the platform model or the key in view; a saved base or proxy URL pre-fills a new connection.
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
/** The adoption body: no connection, a real executor named for what it adopts, a request id the hook minted. */
const adopted = (name: string, agentType: string, model: string, scope = 'personal') => ({
    scope,
    requestId: expect.any(String),
    agentType,
    model,
    connection: { intent: 'none' },
    executor: { name },
});

function board(setup: Setup) {
    return stubFetch((call) => {
        if (call.url === '/api/auth/me') return memberSession({ platformModel: setup.platform === true });
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

const scopeView = (provider: string, agentType: string, model: string, keyNames: string[]) => ({
    provider,
    agentType,
    model,
    keyNames,
});
const putBody = (calls: FetchCall[]) => calls.find((c) => c.method === 'PUT')?.body;
const modelSelect = () => screen.getByLabelText('Model') as HTMLSelectElement;

async function saveUnchanged(calls: FetchCall[], onSaved: ReturnType<typeof vi.fn>) {
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    return putBody(calls);
}

describe('a saved model the list does not name', () => {
    it("survives a no-op Save on the org's key: Other… with the saved id, sent back as it was", async () => {
        const org = scopeView('openrouter', 'opencode', 'openrouter/mistralai/devstral', ['OPENROUTER_API_KEY']);
        const calls = board({ platform: false, org, personal: null, effective: 'org' });
        const onSaved = mount();
        await screen.findByText('Bellows AI already has a model.');
        expect(modelSelect().value).toBe('');
        expect((screen.getByLabelText('Model id') as HTMLInputElement).value).toBe('openrouter/mistralai/devstral');
        expect(await saveUnchanged(calls, onSaved)).toEqual(
            adopted('OpenRouter (organization key)', 'opencode', 'openrouter/mistralai/devstral')
        );
    });

    it('matches a listed model after normalization instead of replacing it', async () => {
        const org = scopeView('openrouter', 'opencode', 'openrouter/openai/gpt-5.1', ['OPENROUTER_API_KEY']);
        const calls = board({ platform: false, org, personal: null, effective: 'org' });
        const onSaved = mount();
        await screen.findByText('Bellows AI already has a model.');
        expect(modelSelect().value).toBe('openai/gpt-5.1');
        expect((await saveUnchanged(calls, onSaved)) as { model: string }).toMatchObject({
            model: 'openrouter/openai/gpt-5.1',
        });
    });

    it("keeps a LiteLLM default's model, which no list names", async () => {
        const org = scopeView('litellm', 'claude-code', 'gpt-5.1-on-proxy', ['ANTHROPIC_API_KEY']);
        const calls = board({ platform: false, org, personal: null, effective: 'org' });
        const onSaved = mount();
        await screen.findByText('Bellows AI already has a model.');
        expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('gpt-5.1-on-proxy');
        expect(await saveUnchanged(calls, onSaved)).toMatchObject({
            agentType: 'claude-code',
            model: 'gpt-5.1-on-proxy',
        });
    });

    it('keeps a custom platform model and the scope it was saved in', async () => {
        const personal = scopeView('platform', 'claude-code', 'house-model-v2', []);
        const calls = board({ platform: true, org: null, personal, effective: 'platform' });
        const onSaved = mount({ platformModel: true, role: 'admin' });
        await screen.findByText('This deployment provides a model.');
        expect((screen.getByRole('radio', { name: 'Only me' }) as HTMLInputElement).checked).toBe(true);
        expect(await saveUnchanged(calls, onSaved)).toEqual(adopted('Platform model', 'claude-code', 'house-model-v2'));
    });

    it("prefills the key form from the member's own key: its provider, agent and unlisted model", async () => {
        const personal = scopeView('openrouter', 'claude-code', 'anthropic/claude-next', ['OPENROUTER_API_KEY']);
        board({ platform: false, org: null, personal, effective: 'personal' });
        mount();
        await screen.findByRole('radiogroup', { name: 'Provider' });
        expect((screen.getByRole('radio', { name: /^OpenRouter/ }) as HTMLInputElement).checked).toBe(true);
        expect((screen.getByLabelText('Agent') as HTMLSelectElement).value).toBe('claude-code');
        expect((screen.getByLabelText('Model id') as HTMLInputElement).value).toBe('anthropic/claude-next');
    });
});

describe('the adoption with the platform model on and an org key', () => {
    const setup = {
        platform: true,
        org: scopeView('anthropic', '', '', ['ANTHROPIC_API_KEY']),
        personal: null,
        effective: 'org',
    };
    const expected = adopted('Anthropic (organization key)', 'claude-code', 'claude-sonnet-5-5');

    it('onboarding Continue sends the none intent: the route picks the platform model', async () => {
        const calls = board({ ...setup, org: { ...setup.org, agentType: null, model: null } });
        renderApp('/onboarding/model?returnTo=%2Ftasks');
        await screen.findByText('Bellows AI already has a model.');
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(putBody(calls)).toEqual(expected));
    });

    it('Settings → Model Save sends the same none intent', async () => {
        const calls = board({ ...setup, org: { ...setup.org, agentType: null, model: null } });
        renderApp('/settings/model');
        await screen.findByText('Bellows AI already has a model.');
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(putBody(calls)).toEqual(expected));
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
        const personal = { ...scopeView('anthropic', 'claude-code', 'claude-opus-5-5', ['ANTHROPIC_API_KEY']) };
        const calls = board({
            platform: false,
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
            model: 'claude-opus-5-5',
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

    it("prefills LiteLLM's proxy URL and sends it back with the saved model", async () => {
        const personal = scopeView('litellm', 'claude-code', 'proxy-model', ['ANTHROPIC_API_KEY']);
        const calls = board({
            platform: false,
            org: null,
            personal: { ...personal, baseUrl: 'https://llm.example.test' },
        });
        const onSaved = mount();
        expect(((await screen.findByLabelText('Proxy URL')) as HTMLInputElement).value).toBe(
            'https://llm.example.test'
        );
        const sent = await pasteAndSave(calls, onSaved, 'Virtual key', 'sk-virtual');
        expect(sent.put).toMatchObject({
            model: 'proxy-model',
            connection: { intent: 'create', provider: 'litellm', baseUrl: 'https://llm.example.test' },
        });
    });

    it('does not carry a base URL saved as a secret into a new connection: no value, no keep flag', async () => {
        const personal = scopeView('openai', 'opencode', 'openai/gpt-5.1', ['OPENAI_API_KEY']);
        const calls = board({ platform: false, org: null, personal: { ...personal, baseUrlSet: true } });
        const onSaved = mount();
        const sent = await pasteAndSave(calls, onSaved, 'API key', 'sk-proj-new');
        const connection = (sent.put as { connection: Record<string, unknown> }).connection;
        expect(connection).toMatchObject({ intent: 'create', provider: 'openai' });
        expect(connection).not.toHaveProperty('baseUrl');
        expect(JSON.stringify(sent.put)).not.toContain('keepBaseUrl');
    });
});
