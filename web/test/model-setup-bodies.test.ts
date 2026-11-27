import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    type DeploymentMode,
    EXECUTOR_TYPES,
    isModelProvider,
    MODEL_PROVIDERS,
    PROVIDER_AGENTS,
    providerAvailable,
} from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import type { ModelSetupSave, SelectedExecutorView } from '../src/api/useModelSetup.js';
import { savedModelChoice } from '../src/model-setup/AgentModelFields.js';
import { adoptBody, createBody, editBody, rotateBody } from '../src/model-setup/save-body.js';

/**
 * Every `PUT /api/model-setup` body the model setup can build is one the route accepts. Web imports no server code, so
 * the route's rule (`parseSetup` in server/src/routes/model-setup-save.ts) is mirrored here, and the source lines it
 * mirrors are pinned below: a change to the route's fields or its intents fails this file until the mirror follows.
 */

const ROUTE = fileURLToPath(new URL('../../server/src/routes/model-setup-save.ts', import.meta.url));
const FIELDS = ['scope', 'requestId', 'agentType', 'model', 'connection', 'executor'];
const KEY_SHAPE = /^[\x21-\x7e]+$/;

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
function connectionAccepted(connection: Record<string, unknown>, agentType: unknown, mode: DeploymentMode): boolean {
    const { intent } = connection;
    if (intent === 'none') return known(connection, ['intent']);
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
    if (!isModelProvider(provider) || !providerAvailable(provider, mode)) return false;
    if (!(PROVIDER_AGENTS[provider] as readonly unknown[]).includes(agentType)) return false;
    if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return false;
    if (!text(name)) return false;
    if (baseUrl === undefined) return provider !== 'litellm';
    return provider !== 'subscription' && validBase(baseUrl);
}

/** The route's acceptance, mirrored: fields, request id, scope, agent, model, the connection intent and the executor. */
function routeAccepts(body: ModelSetupSave, mode: DeploymentMode): boolean {
    const sent: Record<string, unknown> = { ...body, requestId: 'a-request-id' };
    if (!known(sent, FIELDS)) return false;
    if (sent.scope !== 'org' && sent.scope !== 'personal') return false;
    if (!(EXECUTOR_TYPES as readonly unknown[]).includes(sent.agentType)) return false;
    if (typeof sent.model !== 'string' || !sent.model.trim()) return false;
    if (!connectionAccepted(body.connection as unknown as Record<string, unknown>, sent.agentType, mode)) return false;
    const { executor } = body;
    if (!known(executor, ['id', 'name', 'expectedUpdatedAt'])) return false;
    return executor.id !== undefined ? isId(executor.id) : text(executor.name);
}

describe('the route rule this file mirrors', () => {
    it('still reads the same fields and the same four connection intents', () => {
        const source = readFileSync(ROUTE, 'utf8');
        expect(source).toContain(`const FIELDS = new Set([${FIELDS.map((f) => `'${f}'`).join(', ')}]);`);
        for (const intent of ['none', 'reuse', 'rotate']) expect(source).toContain(`intent === '${intent}'`);
        expect(source).toContain(`intent !== 'create'`);
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
    it('every create body is accepted: with a base URL and without one', () => {
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
                    expect(routeAccepts(body, 'self-hosted'), JSON.stringify(body)).toBe(true);
                    expect(body.connection).toMatchObject({ intent: 'create', key: 'sk-x', name: 'Mine' });
                    expect(body.executor).toEqual({ name: 'Mine' });
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

    it('every adoption body is accepted, whatever it adopts', () => {
        for (const source of ['platform', ...MODEL_PROVIDERS] as const) {
            const agents = source === 'platform' ? EXECUTOR_TYPES : PROVIDER_AGENTS[source];
            for (const agentType of agents) {
                for (const scope of ['org', 'personal'] as const) {
                    const body = adoptBody({ scope, name: 'Adopted', source, agentType, model: 'some-model' });
                    expect(routeAccepts(body, 'self-hosted'), JSON.stringify(body)).toBe(true);
                    expect(body.connection).toEqual({ intent: 'none' });
                }
            }
        }
    });

    it('an edit names the executor by id and its connection by id, and carries no key', () => {
        const body = editBody({ selected: selected(), agentType: 'opencode', model: 'm' });
        expect(routeAccepts(body, 'self-hosted')).toBe(true);
        expect(body.connection).toEqual({ intent: 'reuse', id: CONNECTION_ID });
        expect(body.executor).toEqual({ id: EXECUTOR_ID, expectedUpdatedAt: REVISION });
        expect(JSON.stringify(body)).not.toContain('key');
        const none = editBody({ selected: selected({ connection: null }), agentType: 'claude-code', model: 'm' });
        expect(routeAccepts(none, 'self-hosted')).toBe(true);
        expect(none.connection).toEqual({ intent: 'none' });
    });

    it('a rotation names the connection and the executor by id, and sends the key alone', () => {
        const body = rotateBody({
            selected: selected(),
            connectionId: CONNECTION_ID,
            key: ' sk-new ',
            agentType: 'claude-code',
            model: 'claude-sonnet-5-5',
        });
        expect(routeAccepts(body, 'self-hosted')).toBe(true);
        expect(body.connection).toEqual({ intent: 'rotate', id: CONNECTION_ID, key: 'sk-new' });
        expect(body.executor).toEqual({ id: EXECUTOR_ID, expectedUpdatedAt: REVISION });
    });

    it('stores an OpenCode id the way core does, even on the platform model that keeps ids as given', () => {
        const body = adoptBody({
            scope: 'personal',
            name: 'n',
            source: 'openrouter',
            agentType: 'opencode',
            model: 'openai/gpt-5.1',
        });
        expect(body.model).toBe('openrouter/openai/gpt-5.1');
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
