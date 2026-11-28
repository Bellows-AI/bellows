import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    EXECUTOR_TYPES,
    isModelProvider,
    type ModelProvider,
    PROVIDER_AGENTS,
    providerAvailable,
} from '@factory-ai/core';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderSetupBody } from '../src/api/providerConnections.js';
import { renderApp } from './dom.js';
import { board, orgDefault, setupCalls } from './provider-fixtures.js';

/**
 * Every `POST /api/provider-connections/setup` body the Connect a provider step sends is one the route accepts. The
 * bodies are the ones the page puts on the wire for each provider. Web imports no server code, so the route's rule
 * (`parseSetup` in server/src/routes/provider-setup.ts) is mirrored here, and the source lines it mirrors are pinned
 * below: a change to the route's fields or its intents fails this file until the mirror follows.
 */

afterEach(() => {
    window.history.replaceState(null, '', '/');
});

// Vitest runs from the repository root; jsdom's `import.meta.url` is not a file URL.
const ROUTE = resolve(process.cwd(), 'server/src/routes/provider-setup.ts');
const FIELDS = ['scope', 'requestId', 'connection', 'executor', 'makeDefault'];
const EXECUTOR_FIELDS = ['id', 'name', 'agentType', 'model', 'expectedUpdatedAt'];
const KEY_SHAPE = /^[\x21-\x7e]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validBase = (raw: unknown) => {
    if (typeof raw !== 'string') return false;
    try {
        const url = new URL(raw);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    } catch {
        return false;
    }
};
const known = (fields: object, allowed: readonly string[]) =>
    Object.keys(fields).every((name) => allowed.includes(name));
const text = (value: unknown) => typeof value === 'string' && value !== '';
const isId = (value: unknown) => typeof value === 'string' && UUID.test(value);

/** The route's acceptance of a connection intent, mirrored. */
function connectionAccepted(connection: Record<string, unknown>, agentType: unknown): boolean {
    const { intent } = connection;
    if (intent === 'reuse') return known(connection, ['intent', 'id']) && isId(connection.id);
    if (intent === 'rotate') {
        return (
            known(connection, ['intent', 'id', 'key', 'baseUrl']) &&
            isId(connection.id) &&
            typeof connection.key === 'string' &&
            KEY_SHAPE.test(connection.key) &&
            (connection.baseUrl === undefined || validBase(connection.baseUrl))
        );
    }
    if (intent !== 'create' || !known(connection, ['intent', 'provider', 'key', 'baseUrl', 'name'])) return false;
    const { provider, key, name, baseUrl } = connection;
    if (!isModelProvider(provider) || !providerAvailable(provider, true)) return false;
    if (!(PROVIDER_AGENTS[provider] as readonly unknown[]).includes(agentType)) return false;
    if (typeof key !== 'string' || !KEY_SHAPE.test(key) || !text(name)) return false;
    if (baseUrl === undefined) return provider !== 'litellm' && provider !== 'openai-compatible';
    return provider !== 'subscription' && validBase(baseUrl);
}

/** The route's acceptance, mirrored: fields, request id, scope, the executor's agent and model, the connection intent. */
function routeAccepts(sent: ProviderSetupBody): boolean {
    if (!known(sent, FIELDS) || (sent.scope !== 'org' && sent.scope !== 'personal') || !text(sent.requestId))
        return false;
    if (sent.makeDefault !== undefined && typeof sent.makeDefault !== 'boolean') return false;
    const { executor } = sent;
    if (!known(executor, EXECUTOR_FIELDS)) return false;
    if (!(EXECUTOR_TYPES as readonly unknown[]).includes(executor.agentType)) return false;
    if (typeof executor.model !== 'string' || !executor.model.trim()) return false;
    if (executor.id === undefined ? !text(executor.name) : !isId(executor.id)) return false;
    return connectionAccepted(sent.connection as unknown as Record<string, unknown>, executor.agentType);
}

describe('the route rule this file mirrors', () => {
    it('still reads the same fields and the same three connection intents', () => {
        const source = readFileSync(ROUTE, 'utf8');
        expect(source).toContain(`const FIELDS = new Set([${FIELDS.map((f) => `'${f}'`).join(', ')}]);`);
        expect(source).toContain(
            `const EXECUTOR_FIELDS = new Set([${EXECUTOR_FIELDS.map((f) => `'${f}'`).join(', ')}]);`
        );
        for (const intent of ['reuse', 'rotate']) expect(source).toContain(`intent === '${intent}'`);
        expect(source).toContain(`intent !== 'create'`);
        expect(source).not.toContain(`intent === 'none'`);
    });
});

describe('the bodies the Connect a provider step sends', () => {
    /** Picks the provider, fills what it needs, waits for ✓ and presses Create and continue. */
    async function send(provider: ModelProvider, extra: { baseUrl?: string } = {}): Promise<ProviderSetupBody> {
        const user = userEvent.setup();
        const calls = board({ session: { subscriptionToken: true } });
        const { unmount } = renderApp('/onboarding/provider?returnTo=%2F');
        const label = {
            anthropic: /^Anthropic/,
            openrouter: /^OpenRouter/,
            openai: /^OpenAI(?!-compatible)/,
            litellm: /^LiteLLM/,
            'openai-compatible': /^OpenAI-compatible/,
            subscription: /^Claude subscription/,
        }[provider];
        await user.click(await screen.findByRole('radio', { name: label }));
        if (extra.baseUrl !== undefined) {
            if (provider === 'litellm' || provider === 'openai-compatible') {
                fireEvent.change(screen.getByLabelText(/^(Proxy|Endpoint) URL$/), { target: { value: extra.baseUrl } });
            } else {
                await user.click(screen.getByText('Advanced'));
                fireEvent.change(screen.getByLabelText(/^Base URL/), { target: { value: extra.baseUrl } });
            }
        }
        const key = screen.getAllByLabelText(/^(API key|Virtual key|Setup token)$/)[0] as HTMLElement;
        fireEvent.change(key, { target: { value: ' sk-wire-key ' } });
        await waitFor(() => expect(screen.getByRole('status', { name: 'Key check' }).textContent).toContain('✓'));
        await user.click(screen.getByRole('button', { name: 'Create and continue' }));
        await waitFor(() => expect(setupCalls(calls)).toHaveLength(1));
        unmount();
        return setupCalls(calls)[0]?.body as ProviderSetupBody;
    }

    it.each([
        ['anthropic', {}],
        ['anthropic', { baseUrl: ' https://gateway.example.test ' }],
        ['openrouter', {}],
        ['openai', {}],
        ['litellm', { baseUrl: 'https://proxy.example.test' }],
        ['openai-compatible', { baseUrl: 'https://models.example.test/v1' }],
        ['subscription', {}],
    ] as const)('a %s create body is accepted (%j)', async (provider, extra) => {
        const sent = await send(provider, extra);
        expect(routeAccepts(sent), JSON.stringify(sent)).toBe(true);
        expect(sent.connection).toMatchObject({ intent: 'create', provider, key: 'sk-wire-key' });
        expect(sent.makeDefault).toBe(true);
        if (provider === 'subscription') expect(sent.connection).not.toHaveProperty('baseUrl');
    });

    it('a rotation names the connection and the executor by id and sends the key alone', async () => {
        const user = userEvent.setup();
        const set = orgDefault();
        const calls = board({ workspace: set.workspace, connections: { connections: set.connections } });
        renderApp('/onboarding/provider?returnTo=%2F');
        await user.click(await screen.findByRole('button', { name: 'Replace the key' }));
        fireEvent.change(await screen.findByLabelText('API key'), { target: { value: 'sk-ant-api03-rotated' } });
        await waitFor(() => expect(screen.getByRole('status', { name: 'Key check' }).textContent).toContain('✓'));
        await user.click(screen.getByRole('button', { name: 'Replace key' }));
        await waitFor(() => expect(setupCalls(calls)).toHaveLength(1));
        const sent = setupCalls(calls)[0]?.body as ProviderSetupBody;
        // The ids of the fixture are not UUIDs: only the shape the route reads is pinned here.
        expect(sent.connection).toEqual({ intent: 'rotate', id: 'connection-org', key: 'sk-ant-api03-rotated' });
        expect(sent.executor).toMatchObject({
            id: 'executor-org',
            agentType: 'claude-code',
            model: 'claude-sonnet-5-5',
        });
        expect(sent).not.toHaveProperty('makeDefault');
    });
});
