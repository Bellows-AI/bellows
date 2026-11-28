import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE, OPENCODE } from '../src/executors.js';
import {
    EXECUTOR_PROVIDER_AGENTS,
    EXECUTOR_PROVIDERS,
    guidedExecutorConfig,
    isExecutorProvider,
    type ExecutorProvider,
} from '../src/executor-providers.js';
import { customProviderId } from '../src/openai-compatible.js';
import { missingProviderSecretMessage, resolveProviderReferences } from '../src/model-providers.js';

/**
 * The executor guided setup's provider catalog and the config it generates : one list the
 * dialog's picker renders and the config generator reads, so a new provider lands in both or neither.
 * The generated JSON is what the member sees under Advanced and what the claim carries to the runner.
 */

describe('the executor provider catalog', () => {
    it('offers the provider-step providers a profile can carry, plus the OpenAI-compatible endpoint', () => {
        expect(EXECUTOR_PROVIDERS).toEqual(['anthropic', 'openrouter', 'openai', 'litellm', 'openai-compatible']);
    });

    it('narrows a wire value', () => {
        expect(isExecutorProvider('openai-compatible')).toBe(true);
        expect(isExecutorProvider('subscription')).toBe(false);
        expect(isExecutorProvider('nope')).toBe(false);
    });

    it('runs each provider on the agents its key works with, the first preselected', () => {
        expect(EXECUTOR_PROVIDER_AGENTS.anthropic).toEqual([CLAUDE_CODE, OPENCODE]);
        expect(EXECUTOR_PROVIDER_AGENTS.openrouter).toEqual([OPENCODE, CLAUDE_CODE]);
        expect(EXECUTOR_PROVIDER_AGENTS.openai).toEqual([OPENCODE]);
        expect(EXECUTOR_PROVIDER_AGENTS.litellm).toEqual([CLAUDE_CODE, OPENCODE]);
        // A custom endpoint is an OpenAI-wire provider: Claude Code speaks none.
        expect(EXECUTOR_PROVIDER_AGENTS['openai-compatible']).toEqual([OPENCODE]);
    });
});

describe('customProviderId', () => {
    it('slugs the endpoint host, dropping scheme, port and path', () => {
        expect(customProviderId('https://vllm.internal:8000/v1')).toBe('vllm-internal');
        expect(customProviderId('http://LitteLLM_2.example/v1')).toBe('littellm-2-example');
    });

    it('falls back to a stable id for a host nothing can be read from', () => {
        expect(customProviderId('not-a-url')).toBe('custom');
        expect(customProviderId('')).toBe('custom');
    });
});

describe('guidedExecutorConfig', () => {
    const KEY = 'sk-ant-api03-member-key';
    const REF = '{env:GATEWAY_KEY}';

    it('writes a Claude Code key and optional base URL into the settings env', () => {
        expect(guidedExecutorConfig({ provider: 'anthropic', agent: CLAUDE_CODE, model: 'sonnet', key: KEY })).toEqual({
            model: 'sonnet',
            env: { ANTHROPIC_API_KEY: KEY },
        });
        expect(
            guidedExecutorConfig({
                provider: 'litellm',
                agent: CLAUDE_CODE,
                model: 'sonnet',
                key: KEY,
                baseUrl: 'https://proxy.example/v1',
            })
        ).toEqual({
            model: 'sonnet',
            env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'https://proxy.example/v1' },
        });
        // OpenRouter rides Claude Code's env too: the claim wiring turns the key into the route.
        expect(guidedExecutorConfig({ provider: 'openrouter', agent: CLAUDE_CODE, model: 'sonnet', key: KEY })).toEqual(
            {
                model: 'sonnet',
                env: { OPENROUTER_API_KEY: KEY },
            }
        );
    });

    it('leaves a Claude Code config without a key at the model alone', () => {
        expect(guidedExecutorConfig({ provider: 'anthropic', agent: CLAUDE_CODE, model: 'sonnet', key: '' })).toEqual({
            model: 'sonnet',
        });
    });

    it('keeps an OpenCode built-in base URL even without a key, so a gateway on the connected key works', () => {
        expect(
            guidedExecutorConfig({
                provider: 'anthropic',
                agent: OPENCODE,
                model: 'sonnet',
                key: '',
                baseUrl: 'https://gw.internal/v1',
            })
        ).toEqual({
            model: 'anthropic/sonnet',
            provider: { anthropic: { options: { baseURL: 'https://gw.internal/v1' } } },
        });
        expect(guidedExecutorConfig({ provider: 'anthropic', agent: OPENCODE, model: 'sonnet', key: '' })).toEqual({
            model: 'anthropic/sonnet',
        });
    });

    it('writes an OpenCode key under the built-in provider id, and the model as provider/model', () => {
        expect(
            guidedExecutorConfig({ provider: 'anthropic', agent: OPENCODE, model: 'claude-sonnet-5-5', key: KEY })
        ).toEqual({
            model: 'anthropic/claude-sonnet-5-5',
            provider: { anthropic: { options: { apiKey: KEY } } },
        });
        expect(guidedExecutorConfig({ provider: 'openai', agent: OPENCODE, model: 'gpt-5.1', key: KEY })).toEqual({
            model: 'openai/gpt-5.1',
            provider: { openai: { options: { apiKey: KEY } } },
        });
        // LiteLLM is reached as Anthropic, at the proxy's URL.
        expect(
            guidedExecutorConfig({
                provider: 'litellm',
                agent: OPENCODE,
                model: 'sonnet',
                key: KEY,
                baseUrl: 'https://proxy.example/v1',
            })
        ).toEqual({
            model: 'anthropic/sonnet',
            provider: { anthropic: { options: { apiKey: KEY, baseURL: 'https://proxy.example/v1' } } },
        });
    });

    it('generates the OpenCode provider block for an OpenAI-compatible endpoint, key or secret reference', () => {
        const literal = guidedExecutorConfig({
            provider: 'openai-compatible',
            agent: OPENCODE,
            model: 'llama-3',
            key: KEY,
            baseUrl: 'https://vllm.internal:8000/v1',
        }) as {
            model: string;
            provider: Record<
                string,
                { npm: string; name: string; options: Record<string, string>; models: Record<string, object> }
            >;
        };
        expect(literal.model).toBe('vllm-internal/llama-3');
        const block = literal.provider['vllm-internal']!;
        expect(block.npm).toBe('@ai-sdk/openai-compatible');
        expect(block.options).toEqual({ baseURL: 'https://vllm.internal:8000/v1', apiKey: KEY });
        expect(block.models['llama-3']).toBeTypeOf('object');

        const reference = guidedExecutorConfig({
            provider: 'openai-compatible',
            agent: OPENCODE,
            model: 'llama-3',
            key: REF,
            baseUrl: 'https://vllm.internal:8000/v1',
        }) as typeof literal;
        expect(reference.provider['vllm-internal']!.options.apiKey).toBe(REF);
    });

    it('keeps a stored credential marker exactly where the key stands, so an edit regenerates around it', () => {
        const marker = 'stored-credential:abc';
        const config = guidedExecutorConfig({
            provider: 'openai-compatible',
            agent: OPENCODE,
            model: 'llama-3',
            key: marker,
            baseUrl: 'https://vllm.internal:8000/v1',
        }) as { provider: Record<string, { options: { apiKey: string } }> };
        expect(config.provider['vllm-internal']!.options.apiKey).toBe(marker);
    });

    it('every provider × agent pair the catalog offers generates a config, and no other does', () => {
        for (const [provider, agents] of Object.entries(EXECUTOR_PROVIDER_AGENTS) as [
            ExecutorProvider,
            readonly string[],
        ][]) {
            for (const agent of agents) {
                const config = guidedExecutorConfig({
                    provider,
                    agent: agent as 'claude-code',
                    model: 'm',
                    key: KEY,
                    baseUrl:
                        provider === 'litellm' || provider === 'openai-compatible'
                            ? 'https://gw.example/v1'
                            : undefined,
                });
                expect(config).toBeTypeOf('object');
                expect((config as { model: string }).model).toBeTypeOf('string');
            }
        }
        expect(() =>
            guidedExecutorConfig({ provider: 'openai-compatible', agent: CLAUDE_CODE, model: 'm', key: KEY })
        ).toThrow();
    });
});

describe('resolveProviderReferences', () => {
    const endpoint = {
        provider: {
            'vllm-internal': {
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: 'https://vllm.internal/v1', apiKey: '{env:GATEWAY_KEY}' },
                models: { 'llama-3': {} },
            },
        },
        model: 'vllm-internal/llama-3',
    };

    it('replaces a custom provider key that names an env value with the value itself', () => {
        const { config, missing } = resolveProviderReferences(endpoint, { GATEWAY_KEY: 'sk-org-secret' });
        expect(missing).toEqual([]);
        expect((config as typeof endpoint).provider['vllm-internal'].options).toEqual({
            baseURL: 'https://vllm.internal/v1',
            apiKey: 'sk-org-secret',
        });
    });

    it('stacks like the claim does: a higher scope wins the name', () => {
        // One env, already stacked by the caller — the same map `stackEnv` produced.
        const { config } = resolveProviderReferences(endpoint, { GATEWAY_KEY: 'repo-value' });
        expect((config as typeof endpoint).provider['vllm-internal'].options.apiKey).toBe('repo-value');
    });

    it('reports a name no scope holds, and leaves the config for the refusal', () => {
        const { missing } = resolveProviderReferences(endpoint, { OTHER: 'x' });
        expect(missing).toEqual(['GATEWAY_KEY']);
        const { missing: withNone } = resolveProviderReferences(endpoint, undefined);
        expect(withNone).toEqual(['GATEWAY_KEY']);
    });

    it('treats an empty value as unresolved, and leaves everything but a baseURL provider alone', () => {
        const { missing, config } = resolveProviderReferences(endpoint, { GATEWAY_KEY: '' });
        expect(missing).toEqual(['GATEWAY_KEY']);
        expect(config).toEqual(endpoint);

        const builtin = {
            provider: { anthropic: { options: { apiKey: '{env:MY_KEY}' } } },
            model: 'anthropic/sonnet',
        };
        const untouched = resolveProviderReferences(builtin, {});
        expect(untouched.config).toEqual(builtin);
        expect(untouched.missing).toEqual([]);
    });

    it('walks arrays and several providers, naming each missing secret once', () => {
        const two = {
            provider: {
                a: { options: { baseURL: 'https://a.example/v1', apiKey: '{env:FIRST}' } },
                b: { options: { baseURL: 'https://b.example/v1', apiKey: '{env:SECOND}' } },
                c: { options: { baseURL: 'https://c.example/v1', apiKey: '{env:FIRST}' } },
            },
        };
        const { missing } = resolveProviderReferences(two, { FIRST: 'f' });
        expect(missing).toEqual(['SECOND']);
    });
});

describe('missingProviderSecretMessage', () => {
    it('names the missing secret and never reads like the redirect refusal', () => {
        const message = missingProviderSecretMessage(['GATEWAY_KEY']);
        expect(message).toContain('GATEWAY_KEY');
        expect(message).toContain('Settings');
        const two = missingProviderSecretMessage(['A', 'B']);
        expect(two).toContain('A');
        expect(two).toContain('B');
    });
});
