import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXECUTOR_TYPES, isModelProvider, MODEL_PROVIDERS, PROVIDER_AGENTS, providerAvailable } from '@factory-ai/core';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSetupBody } from '../src/api/providerConnections.js';
import {
    type ModelSetupSave,
    type SelectedExecutorView,
    type UseModelSetup,
    useModelSetup,
} from '../src/api/useModelSetup.js';
import { savedModelChoice } from '../src/model-setup/AgentModelFields.js';
import { createBody, editBody, rotateBody } from '../src/model-setup/save-body.js';
import { SETUP_URL } from './model-setup-reads.js';

/**
 * Every `POST /api/provider-connections/setup` body the model setup sends is one the route accepts. The bodies are the
 * ones the hook actually puts on the wire (`save` maps a `ModelSetupSave` to the route's shape), captured at `fetch`.
 * Web imports no server code, so the route's rule (`parseSetup` in server/src/routes/provider-setup.ts) is mirrored here,
 * and the source lines it mirrors are pinned below: a change to the route's fields or its intents fails this file until
 * the mirror follows.
 */

const ROUTE = fileURLToPath(new URL('../../server/src/routes/provider-setup.ts', import.meta.url));
const FIELDS = ['scope', 'requestId', 'connection', 'executor', 'makeDefault'];
const EXECUTOR_FIELDS = ['id', 'name', 'agentType', 'model', 'expectedUpdatedAt'];
const KEY_SHAPE = /^[\x21-\x7e]+$/;

afterEach(() => {
    vi.unstubAllGlobals();
});

const validBase = (raw: unknown) => {
    if (typeof raw !== 'string') return false;
    try {
        const url = new URL(raw);
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    } catch {
        return false;
    }
};

const known = (fields: Record<string, unknown>, allowed: readonly string[]) =>
    Object.keys(fields).every((name) => allowed.includes(name));
const text = (value: unknown) => typeof value === 'string' && value !== '';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (value: unknown) => typeof value === 'string' && UUID.test(value);
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const EXECUTOR_ID = '22222222-2222-4222-8222-222222222222';
const REVISION = '2026-01-02T03:04:05.678Z';

/** The route's acceptance of a connection intent, mirrored. */
function connectionAccepted(
    connection: Record<string, unknown>,
    agentType: unknown,
    subscriptionAllowed: boolean
): boolean {
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
    if (!isModelProvider(provider) || !providerAvailable(provider, subscriptionAllowed)) return false;
    if (!(PROVIDER_AGENTS[provider] as readonly unknown[]).includes(agentType)) return false;
    if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return false;
    if (!text(name)) return false;
    if (baseUrl === undefined) return provider !== 'litellm';
    return provider !== 'subscription' && validBase(baseUrl);
}

/** The route's acceptance, mirrored: fields, request id, scope, the executor's agent and model, the connection intent. */
function routeAccepts(sent: ProviderSetupBody, subscriptionAllowed: boolean): boolean {
    if (!known(sent as unknown as Record<string, unknown>, FIELDS)) return false;
    if (sent.scope !== 'org' && sent.scope !== 'personal') return false;
    if (!text(sent.requestId)) return false;
    if (sent.makeDefault !== undefined && typeof sent.makeDefault !== 'boolean') return false;
    const { executor } = sent;
    if (!known(executor, EXECUTOR_FIELDS)) return false;
    if (!(EXECUTOR_TYPES as readonly unknown[]).includes(executor.agentType)) return false;
    if (typeof executor.model !== 'string' || !executor.model.trim()) return false;
    if (executor.id === undefined ? !text(executor.name) : !isId(executor.id)) return false;
    return connectionAccepted(
        sent.connection as unknown as Record<string, unknown>,
        executor.agentType,
        subscriptionAllowed
    );
}

/** What the hook puts on the wire for `body`: its one setup request, or null when it sent none. */
async function wire(body: ModelSetupSave): Promise<{ sent: ProviderSetupBody | null; result: unknown }> {
    let hook: UseModelSetup | undefined;
    renderToString(
        createElement(() => {
            hook = useModelSetup();
            return null;
        })
    );
    const bodies: ProviderSetupBody[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        expect(url).toBe(SETUP_URL);
        bodies.push(JSON.parse(init.body as string) as ProviderSetupBody);
        const saved = { scope: body.scope, executorId: EXECUTOR_ID, executorName: 'n', connectionId: null };
        return new Response(JSON.stringify({ ...saved, connectionName: null, replayed: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    });
    const result = await hook?.save(body);
    return { sent: bodies[0] ?? null, result };
}

/** The wire body of `body`, which must exist. */
async function sentBody(body: ModelSetupSave): Promise<ProviderSetupBody> {
    const { sent } = await wire(body);
    if (sent === null) throw new Error('the hook sent no setup request');
    return sent;
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

const selected = (over: Partial<SelectedExecutorView> = {}): SelectedExecutorView => ({
    scope: 'personal',
    executorId: EXECUTOR_ID,
    name: 'Anthropic',
    agentType: 'claude-code',
    model: 'claude-sonnet-5-5',
    suspended: false,
    updatedAt: REVISION,
    connection: { id: CONNECTION_ID, name: 'Anthropic', provider: 'anthropic', scope: 'personal', baseUrl: null },
    ...over,
});

describe('the bodies the model setup sends', () => {
    it('every create body is accepted: with a base URL and without one', async () => {
        for (const provider of MODEL_PROVIDERS) {
            for (const agentType of PROVIDER_AGENTS[provider]) {
                for (const baseUrl of ['', ' https://gateway.example.test ']) {
                    if (provider === 'litellm' && !baseUrl) continue; // Save waits for the proxy URL.
                    const body = createBody({
                        scope: 'personal',
                        provider,
                        key: ' sk-x ',
                        baseUrl,
                        name: ' Mine ',
                        agentType,
                        model: 'm',
                    });
                    const sent = await sentBody(body);
                    expect(routeAccepts(sent, true), JSON.stringify(sent)).toBe(true);
                    expect(sent.connection).toMatchObject({ intent: 'create', key: 'sk-x', name: 'Mine' });
                    expect(sent.executor).toEqual({ name: 'Mine', agentType, model: 'm' });
                    expect(sent.makeDefault).toBe(true);
                }
            }
        }
    });

    it('sends a base URL only where the provider takes one', () => {
        const common = { scope: 'personal', key: 'k', name: 'n', agentType: 'claude-code', model: 'm' } as const;
        expect(
            createBody({ ...common, provider: 'subscription', baseUrl: 'https://g.example.test' }).connection
        ).not.toHaveProperty('baseUrl');
        expect(createBody({ ...common, provider: 'anthropic', baseUrl: '' }).connection).not.toHaveProperty('baseUrl');
        expect(
            createBody({ ...common, provider: 'anthropic', baseUrl: ' https://g.example.test ' }).connection
        ).toMatchObject({
            baseUrl: 'https://g.example.test',
        });
    });

    it('an edit names the executor by id and its connection by id, and carries no key', async () => {
        const sent = await sentBody(
            editBody({ selected: selected(), connectionId: CONNECTION_ID, agentType: 'opencode', model: 'm' })
        );
        expect(routeAccepts(sent, true)).toBe(true);
        expect(sent.connection).toEqual({ intent: 'reuse', id: CONNECTION_ID });
        expect(sent.executor).toEqual({
            id: EXECUTOR_ID,
            agentType: 'opencode',
            model: 'm',
            expectedUpdatedAt: REVISION,
        });
        expect(JSON.stringify(sent)).not.toContain('key');
    });

    it('an edit read without a revision sends none, which the route tolerates', async () => {
        const sent = await sentBody(
            editBody({
                selected: selected({ updatedAt: '' }),
                connectionId: CONNECTION_ID,
                agentType: 'claude-code',
                model: 'm',
            })
        );
        expect(routeAccepts(sent, true)).toBe(true);
        expect(sent.executor).not.toHaveProperty('expectedUpdatedAt');
    });

    it('a rotation names the connection and the executor by id, and sends the key alone', async () => {
        const sent = await sentBody(
            rotateBody({
                selected: selected(),
                connectionId: CONNECTION_ID,
                key: ' sk-new ',
                agentType: 'claude-code',
                model: 'claude-sonnet-5-5',
            })
        );
        expect(routeAccepts(sent, true)).toBe(true);
        expect(sent.connection).toEqual({ intent: 'rotate', id: CONNECTION_ID, key: 'sk-new' });
        expect(sent.executor).toEqual({
            id: EXECUTOR_ID,
            agentType: 'claude-code',
            model: 'claude-sonnet-5-5',
            expectedUpdatedAt: REVISION,
        });
    });
});

describe('where a saved model lands', () => {
    it('on the option it names after normalization, else on Other… with the saved id', () => {
        expect(savedModelChoice('openrouter', 'opencode', ['openai/gpt-5.1'], 'openrouter/openai/gpt-5.1')).toEqual({
            option: 'openai/gpt-5.1',
        });
        expect(savedModelChoice('anthropic', 'claude-code', ['claude-sonnet-5-5'], 'claude-sonnet-5-5')).toEqual({
            option: 'claude-sonnet-5-5',
        });
        expect(savedModelChoice('openrouter', 'opencode', ['openai/gpt-5.1'], 'openrouter/x/y')).toEqual({
            free: 'openrouter/x/y',
        });
        expect(savedModelChoice('litellm', 'claude-code', [], 'proxy-model')).toEqual({ free: 'proxy-model' });
    });
});
