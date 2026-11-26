import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE, EXECUTOR_TYPES, OPENCODE } from '../src/executors.js';
import {
    applyConnectionLayer,
    claimCredentialEnv,
    OPENROUTER_ANTHROPIC_BASE_URL,
    openRouterClaudeWiring,
    connectionOpenCodeProvider,
    hasModelKey,
    MODEL_PROVIDERS,
    modelFitsProvider,
    PROVIDER_AGENTS,
    providerSupportsAgent,
} from '../src/model-providers.js';
import { connectionModelRefusal, connectionSelectionRefusal } from '../src/provider-connections.js';

describe('providerSupportsAgent', () => {
    it('is exactly the PROVIDER_AGENTS matrix, for every provider and executor type', () => {
        for (const provider of MODEL_PROVIDERS) {
            for (const type of EXECUTOR_TYPES) {
                expect(providerSupportsAgent(provider, type)).toBe(PROVIDER_AGENTS[provider].includes(type));
            }
        }
    });

    it('pins the supported combinations', () => {
        expect(providerSupportsAgent('openai', OPENCODE)).toBe(true);
        expect(providerSupportsAgent('openai', CLAUDE_CODE)).toBe(false);
        expect(providerSupportsAgent('subscription', OPENCODE)).toBe(false);
        expect(providerSupportsAgent('subscription', CLAUDE_CODE)).toBe(true);
    });
});

describe('connectionSelectionRefusal', () => {
    const personal = { provider: 'anthropic', scope: 'personal', ownerId: 'alice' } as const;
    const org = { provider: 'anthropic', scope: 'org', ownerId: null } as const;

    it('accepts an org connection for an org executor and a personal one for its owner', () => {
        expect(connectionSelectionRefusal({ connection: org, owner: null, agentType: CLAUDE_CODE })).toBeNull();
        expect(connectionSelectionRefusal({ connection: org, owner: 'bob', agentType: CLAUDE_CODE })).toBeNull();
        expect(connectionSelectionRefusal({ connection: personal, owner: 'alice', agentType: OPENCODE })).toBeNull();
    });

    it('refuses a personal connection for an org executor, naming the scope', () => {
        expect(connectionSelectionRefusal({ connection: personal, owner: null, agentType: CLAUDE_CODE })?.reason).toBe(
            'scope'
        );
    });

    it("treats another member's connection as missing, and a missing one as missing", () => {
        expect(connectionSelectionRefusal({ connection: personal, owner: 'bob', agentType: CLAUDE_CODE })?.reason).toBe(
            'missing'
        );
        expect(connectionSelectionRefusal({ connection: null, owner: 'bob', agentType: CLAUDE_CODE })?.reason).toBe(
            'missing'
        );
    });

    it('refuses an unsupported provider and executor type', () => {
        const openai = { provider: 'openai', scope: 'org', ownerId: null } as const;
        expect(connectionSelectionRefusal({ connection: openai, owner: null, agentType: CLAUDE_CODE })?.reason).toBe(
            'incompatible'
        );
    });
});

describe('connectionModelRefusal', () => {
    it('refuses a known foreign OpenCode prefix and accepts the provider own or an unprefixed id', () => {
        expect(modelFitsProvider('openai', OPENCODE, 'anthropic/claude-sonnet')).toBe(false);
        expect(modelFitsProvider('openai', OPENCODE, 'openai/gpt-5')).toBe(true);
        expect(modelFitsProvider('openrouter', OPENCODE, 'openrouter/anthropic/claude-sonnet')).toBe(true);
        expect(modelFitsProvider('anthropic', CLAUDE_CODE, 'claude-sonnet-5-5')).toBe(true);
        expect(modelFitsProvider('anthropic', CLAUDE_CODE, 'openai/gpt-5')).toBe(false);
        expect(modelFitsProvider('openrouter', CLAUDE_CODE, 'anthropic/claude-sonnet')).toBe(true);
        expect(modelFitsProvider('litellm', OPENCODE, 'my-gateway-model')).toBe(true);
    });

    it('answers a sentence naming the provider, and nothing for an absent model', () => {
        expect(connectionModelRefusal('openai', OPENCODE, 'anthropic/x')?.reason).toBe('model');
        expect(connectionModelRefusal('openai', OPENCODE, undefined)).toBeNull();
    });
});

describe('applyConnectionLayer', () => {
    it('sets the key and a custom endpoint above the ambient scopes', () => {
        const { env } = applyConnectionLayer({ ANTHROPIC_API_KEY: 'ambient', OTHER: 'x' }, CLAUDE_CODE, {
            provider: 'litellm',
            key: 'conn-key',
            baseUrl: 'https://proxy.example',
        });
        expect(env).toEqual({ OTHER: 'x', ANTHROPIC_API_KEY: 'conn-key', ANTHROPIC_BASE_URL: 'https://proxy.example' });
    });

    it('drops an ambient custom endpoint when the connection uses the provider default', () => {
        const { env, blanks } = applyConnectionLayer(
            { ANTHROPIC_BASE_URL: 'https://ambient.example', ANTHROPIC_AUTH_TOKEN: 'amb' },
            CLAUDE_CODE,
            { provider: 'anthropic', key: 'conn-key', baseUrl: null }
        );
        expect(env).toEqual({ ANTHROPIC_API_KEY: 'conn-key' });
        // Driver-forwarded names the board cannot see are blanked, so the claim wins over RUNNER_ENV.
        expect(blanks).toEqual(
            expect.arrayContaining(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY'])
        );
        expect(blanks).not.toContain('ANTHROPIC_API_KEY');
    });

    it('removes every other Claude Code credential and routing selector', () => {
        const { env, blanks } = applyConnectionLayer(
            { OPENROUTER_API_KEY: 'or', CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_CODE_USE_BEDROCK: '1' },
            CLAUDE_CODE,
            { provider: 'openrouter', key: 'conn-key', baseUrl: null }
        );
        expect(env).toEqual({ OPENROUTER_API_KEY: 'conn-key' });
        expect(blanks).toEqual(
            expect.arrayContaining(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL'])
        );
    });

    it("for OpenCode only replaces the provider's own key and endpoint, leaving other providers", () => {
        const { env, blanks } = applyConnectionLayer(
            { OPENAI_BASE_URL: 'https://ambient.example', OPENAI_API_KEY: 'amb', ANTHROPIC_API_KEY: 'other' },
            OPENCODE,
            { provider: 'openai', key: 'conn-key', baseUrl: null }
        );
        expect(env).toEqual({ ANTHROPIC_API_KEY: 'other', OPENAI_API_KEY: 'conn-key' });
        expect(blanks).toEqual(['OPENAI_BASE_URL']);
    });

    it('never mutates its input', () => {
        const input = { ANTHROPIC_BASE_URL: 'x' };
        applyConnectionLayer(input, CLAUDE_CODE, { provider: 'anthropic', key: 'k', baseUrl: null });
        expect(input).toEqual({ ANTHROPIC_BASE_URL: 'x' });
    });
});

describe('connectionOpenCodeProvider', () => {
    it('renders a provider block referencing the key by env name, only for a custom endpoint', () => {
        expect(connectionOpenCodeProvider('openai', null)).toBeNull();
        expect(connectionOpenCodeProvider('openai', 'https://gw.example/v1')).toEqual({
            provider: { openai: { options: { baseURL: 'https://gw.example/v1', apiKey: '{env:OPENAI_API_KEY}' } } },
        });
        expect(connectionOpenCodeProvider('litellm', 'https://gw.example')).toEqual({
            provider: { anthropic: { options: { baseURL: 'https://gw.example', apiKey: '{env:ANTHROPIC_API_KEY}' } } },
        });
    });
});

describe('hasModelKey with a connection', () => {
    it('counts a compatible connection as the model key', () => {
        expect(hasModelKey([], {}, CLAUDE_CODE, 'anthropic')).toBe(true);
        expect(hasModelKey([], {}, OPENCODE, 'openai')).toBe(true);
    });

    it('does not count an incompatible connection or a null one', () => {
        expect(hasModelKey([], {}, CLAUDE_CODE, 'openai')).toBe(false);
        expect(hasModelKey([], {}, OPENCODE, null)).toBe(false);
    });

    it('lets a pasted Claude Code settings env clear the connection key', () => {
        expect(hasModelKey([], { env: { ANTHROPIC_API_KEY: '' } }, CLAUDE_CODE, 'anthropic')).toBe(false);
    });
});

describe('OpenRouter wiring on a selected connection endpoint', () => {
    it('routes Claude Code to the connection endpoint, deriving the Anthropic path from an OpenAI-style /v1 base', () => {
        const env = { OPENROUTER_API_KEY: 'k' };
        expect(openRouterClaudeWiring(env, CLAUDE_CODE, 'https://gw.example/api/v1/')).toMatchObject({
            ANTHROPIC_BASE_URL: 'https://gw.example/api',
            ANTHROPIC_AUTH_TOKEN: 'k',
        });
        expect(openRouterClaudeWiring(env, CLAUDE_CODE, 'https://gw.example/or')).toMatchObject({
            ANTHROPIC_BASE_URL: 'https://gw.example/or',
        });
        expect(openRouterClaudeWiring(env, CLAUDE_CODE, null)).toMatchObject({
            ANTHROPIC_BASE_URL: OPENROUTER_ANTHROPIC_BASE_URL,
        });
    });

    it('stays off beneath a deliberate Anthropic choice, whatever the connection endpoint', () => {
        expect(
            openRouterClaudeWiring(
                { OPENROUTER_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://mine' },
                CLAUDE_CODE,
                'https://gw.example'
            )
        ).toBeNull();
    });

    it('is carried by claimCredentialEnv for both deployment modes', () => {
        for (const mode of ['cloud', 'self-hosted'] as const) {
            expect(
                claimCredentialEnv({ OPENROUTER_API_KEY: 'k' }, CLAUDE_CODE, mode, 'https://gw.example/v1')
            ).toMatchObject({
                ANTHROPIC_BASE_URL: 'https://gw.example',
            });
        }
    });
});

describe('hasModelKey judges the env the connection layer leaves', () => {
    it('does not count an ambient key the connection replaces when the settings clear the connection key', () => {
        const config = { env: { ANTHROPIC_API_KEY: '' } };
        expect(hasModelKey(['OPENROUTER_API_KEY'], config, CLAUDE_CODE, 'anthropic')).toBe(false);
        // Without a connection the ambient OpenRouter key is a model key, as before.
        expect(hasModelKey(['OPENROUTER_API_KEY'], config, CLAUDE_CODE, null)).toBe(true);
    });

    it('agrees with the claim layer on the names left', () => {
        const names = ['OPENROUTER_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
        const { env } = applyConnectionLayer(Object.fromEntries(names.map((n) => [n, 'x'])), CLAUDE_CODE, {
            provider: 'anthropic',
            key: 'k',
            baseUrl: null,
        });
        expect(Object.keys(env)).toEqual(['ANTHROPIC_API_KEY']);
        expect(hasModelKey(names, { env: { ANTHROPIC_API_KEY: '' } }, CLAUDE_CODE, 'anthropic')).toBe(false);
    });
});
