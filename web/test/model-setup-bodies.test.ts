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
import { savedModelChoice } from '../src/model-setup/AgentModelFields.js';
import { agentOnlyBody, agentOnlyProvider, keyBody } from '../src/model-setup/save-body.js';

/**
 * Every `PUT /api/model-setup` body the model setup can build is one the route accepts. Web imports no server code, so
 * the route's rule (`parseSave` in server/src/routes/model-setup.ts) is mirrored here, and the source lines it mirrors
 * are pinned below: a change to the route's fields or its agent-only choice fails this file until the mirror follows.
 */

const ROUTE = fileURLToPath(new URL('../../server/src/routes/model-setup.ts', import.meta.url));
const FIELDS = ['scope', 'provider', 'key', 'baseUrl', 'agentType', 'model'];
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

/** The route's acceptance, mirrored: fields, scope, agent, model, then the keyed or agent-only variant. */
function routeAccepts(body: Record<string, unknown>, platform: boolean, mode: DeploymentMode): boolean {
    if (Object.keys(body).some((name) => !FIELDS.includes(name))) return false;
    if (body.scope !== 'org' && body.scope !== 'personal') return false;
    if (!(EXECUTOR_TYPES as readonly unknown[]).includes(body.agentType)) return false;
    if (typeof body.model !== 'string' || !body.model.trim()) return false;
    const { provider } = body;
    if (isModelProvider(provider)) {
        if (!providerAvailable(provider, mode)) return false;
        if (!(PROVIDER_AGENTS[provider] as readonly unknown[]).includes(body.agentType)) return false;
        if (typeof body.key !== 'string' || !KEY_SHAPE.test(body.key)) return false;
        if (body.baseUrl === undefined) return provider !== 'litellm';
        return provider !== 'subscription' && validBase(body.baseUrl);
    }
    return provider === (platform ? 'platform' : 'existing') && body.key === undefined && body.baseUrl === undefined;
}

describe('the route rule this file mirrors', () => {
    it('still reads the same fields and picks the agent-only variant by the platform flag', () => {
        const source = readFileSync(ROUTE, 'utf8');
        expect(source).toContain(`const FIELDS = new Set([${FIELDS.map((f) => `'${f}'`).join(', ')}]);`);
        expect(source).toContain('const agentOnly = config.platformModelProvided ? PLATFORM_PROVIDER : EXISTING;');
    });
});

describe('the bodies the model setup sends', () => {
    it('picks the agent-only variant exactly as the route does', () => {
        expect(agentOnlyProvider(true)).toBe('platform');
        expect(agentOnlyProvider(false)).toBe('existing');
    });

    it('every agent-only body is accepted, banner and flag in every combination', () => {
        for (const platform of [true, false]) {
            for (const source of ['platform', ...MODEL_PROVIDERS] as const) {
                const agents = source === 'platform' ? EXECUTOR_TYPES : PROVIDER_AGENTS[source];
                for (const agentType of agents) {
                    for (const scope of ['org', 'personal'] as const) {
                        const body = agentOnlyBody({ platform, scope, source, agentType, model: 'some-model' });
                        expect(routeAccepts(body, platform, 'self-hosted'), JSON.stringify(body)).toBe(true);
                    }
                }
            }
        }
    });

    it('every key body is accepted, with and without a base URL', () => {
        for (const provider of MODEL_PROVIDERS) {
            for (const agentType of PROVIDER_AGENTS[provider]) {
                for (const baseUrl of ['', ' https://gateway.example.test ']) {
                    if (provider === 'litellm' && !baseUrl) continue; // Save waits for the proxy URL.
                    const body = keyBody({
                        scope: 'personal',
                        provider,
                        key: ' sk-x ',
                        baseUrl,
                        agentType,
                        model: 'm',
                    });
                    expect(routeAccepts(body, false, 'self-hosted'), JSON.stringify(body)).toBe(true);
                }
            }
        }
    });

    it('stores an OpenCode id the way core does, even on the platform variant that keeps ids as given', () => {
        const body = agentOnlyBody({
            platform: true,
            scope: 'personal',
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
