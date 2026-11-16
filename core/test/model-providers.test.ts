import { describe, expect, it } from 'vitest';
import { CLOUD, DEPLOYMENT_MODES, SELF_HOSTED } from '../src/deployment-mode.js';
import { CLAUDE_CODE, OPENCODE } from '../src/executors.js';
import {
    AGENT_PROVIDERS,
    claimCredentialEnv,
    currentProvider,
    inferProvider,
    isAgentProvider,
    isModelProvider,
    MODEL_CREDENTIAL_NAMES,
    MODEL_PROVIDERS,
    modelCredentialScope,
    normalizeModelId,
    OPENROUTER_ANTHROPIC_BASE_URL,
    openRouterClaudeWiring,
    PLATFORM_PROVIDER,
    PROVIDER_AGENTS,
    PROVIDER_BASE_URL_ENV,
    PROVIDER_ENV,
    providerAvailable,
    providerEnvNames,
    stackModelEnv,
} from '../src/model-providers.js';

describe('MODEL_PROVIDERS', () => {
    it('lists the providers a member can bring a key for, in display order', () => {
        expect(MODEL_PROVIDERS).toEqual(['anthropic', 'openrouter', 'openai', 'litellm', 'subscription']);
    });

    it('recognizes exactly the listed ids', () => {
        for (const id of MODEL_PROVIDERS) expect(isModelProvider(id)).toBe(true);
        for (const other of ['Anthropic', 'claude', '', null, 1, undefined]) expect(isModelProvider(other)).toBe(false);
    });
});

describe('provider env, agents and availability', () => {
    it('names the key each provider stores', () => {
        expect(PROVIDER_ENV).toEqual({
            anthropic: 'ANTHROPIC_API_KEY',
            openrouter: 'OPENROUTER_API_KEY',
            openai: 'OPENAI_API_KEY',
            litellm: 'ANTHROPIC_API_KEY',
            subscription: 'CLAUDE_CODE_OAUTH_TOKEN',
        });
    });

    it('names the base-URL variable each provider takes, none for a subscription', () => {
        expect(PROVIDER_BASE_URL_ENV).toEqual({
            anthropic: 'ANTHROPIC_BASE_URL',
            openrouter: 'OPENROUTER_BASE_URL',
            openai: 'OPENAI_BASE_URL',
            litellm: 'ANTHROPIC_BASE_URL',
            subscription: null,
        });
        expect(providerEnvNames('openrouter')).toEqual(['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL']);
        expect(providerEnvNames('subscription')).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    });

    it('allows each provider its agents, the first being the default', () => {
        expect(PROVIDER_AGENTS).toEqual({
            anthropic: [CLAUDE_CODE, OPENCODE],
            openrouter: [OPENCODE, CLAUDE_CODE],
            openai: [OPENCODE],
            litellm: [CLAUDE_CODE, OPENCODE],
            subscription: [CLAUDE_CODE],
        });
    });

    it('offers a subscription on a self-hosted board only', () => {
        expect(providerAvailable('subscription', SELF_HOSTED)).toBe(true);
        expect(providerAvailable('subscription', CLOUD)).toBe(false);
        for (const provider of ['anthropic', 'openrouter', 'openai', 'litellm'] as const) {
            for (const mode of DEPLOYMENT_MODES) expect(providerAvailable(provider, mode)).toBe(true);
        }
    });

    it('records the key providers plus the platform', () => {
        expect(AGENT_PROVIDERS).toEqual([...MODEL_PROVIDERS, PLATFORM_PROVIDER]);
        expect(PLATFORM_PROVIDER).toBe('platform');
        expect(isAgentProvider('platform')).toBe(true);
        expect(isAgentProvider('existing')).toBe(false);
    });
});

describe('inferProvider', () => {
    it('reads the provider from the names a scope holds, a base URL beside an Anthropic key being LiteLLM', () => {
        expect(inferProvider([])).toBeNull();
        expect(inferProvider(['GITHUB_TOKEN'])).toBeNull();
        expect(inferProvider(['ANTHROPIC_API_KEY'])).toBe('anthropic');
        expect(inferProvider(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'])).toBe('litellm');
        expect(inferProvider(['OPENROUTER_API_KEY'])).toBe('openrouter');
        expect(inferProvider(['OPENAI_API_KEY'])).toBe('openai');
        expect(inferProvider(['CLAUDE_CODE_OAUTH_TOKEN'])).toBe('subscription');
    });
});

describe('currentProvider', () => {
    it('trusts the recorded provider only while its credential names are in the scope', () => {
        expect(currentProvider(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'], 'anthropic')).toBe('anthropic');
        expect(currentProvider(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'], 'litellm')).toBe('litellm');
        expect(currentProvider(['ANTHROPIC_API_KEY'], 'litellm')).toBe('anthropic');
        // The key was replaced by hand: the names win over the record.
        expect(currentProvider(['OPENAI_API_KEY'], 'anthropic')).toBe('openai');
        expect(currentProvider([], 'anthropic')).toBeNull();
        expect(currentProvider(['OPENROUTER_API_KEY'], 'platform')).toBe('openrouter');
        expect(currentProvider(['OPENROUTER_API_KEY'], undefined)).toBe('openrouter');
    });

    it('infers in provider order when nothing is recorded', () => {
        expect(currentProvider(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], undefined)).toBe('anthropic');
        expect(currentProvider(['OPENAI_API_KEY', 'OPENROUTER_API_KEY'], undefined)).toBe('openrouter');
        expect(currentProvider(['CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'], undefined)).toBe('openai');
    });
});

describe('model credentials come from one scope', () => {
    it('names every provider key, base URL and Anthropic token', () => {
        expect([...MODEL_CREDENTIAL_NAMES].sort()).toEqual(
            [
                'ANTHROPIC_API_KEY',
                'ANTHROPIC_AUTH_TOKEN',
                'ANTHROPIC_BASE_URL',
                'CLAUDE_CODE_OAUTH_TOKEN',
                'OPENAI_API_KEY',
                'OPENAI_BASE_URL',
                'OPENROUTER_API_KEY',
                'OPENROUTER_BASE_URL',
            ].sort()
        );
    });

    it('the highest scope naming any model credential owns them', () => {
        expect(modelCredentialScope([['ANTHROPIC_API_KEY'], ['OPENROUTER_API_KEY'], []])).toBe(1);
        expect(modelCredentialScope([['ANTHROPIC_API_KEY'], ['OTHER'], ['OPENAI_BASE_URL']])).toBe(2);
        expect(modelCredentialScope([['OTHER'], [], []])).toBe(-1);
    });

    it('drops a lower scope’s model credentials and stacks the rest, the higher scope winning', () => {
        expect(
            stackModelEnv([
                { ANTHROPIC_API_KEY: 'org', ANTHROPIC_BASE_URL: 'https://org.example.test', SHARED: 'org', A: 'a' },
                { OPENROUTER_API_KEY: 'mine', SHARED: 'mine' },
                {},
            ])
        ).toEqual({ A: 'a', SHARED: 'mine', OPENROUTER_API_KEY: 'mine' });
        expect(stackModelEnv([{ ANTHROPIC_API_KEY: 'org' }, { OTHER: 'x' }, {}])).toEqual({
            ANTHROPIC_API_KEY: 'org',
            OTHER: 'x',
        });
        expect(stackModelEnv([{}, { OPENROUTER_API_KEY: 'mine' }, { ANTHROPIC_API_KEY: 'repo' }])).toEqual({
            ANTHROPIC_API_KEY: 'repo',
        });
    });
});

describe('normalizeModelId', () => {
    it('prefixes an OpenCode model with the provider that serves it, once', () => {
        expect(normalizeModelId('anthropic', OPENCODE, 'claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4-5');
        expect(normalizeModelId('anthropic', OPENCODE, 'anthropic/claude-sonnet-4-5')).toBe(
            'anthropic/claude-sonnet-4-5'
        );
        expect(normalizeModelId('openrouter', OPENCODE, 'anthropic/claude-sonnet-4.5')).toBe(
            'openrouter/anthropic/claude-sonnet-4.5'
        );
        expect(normalizeModelId('openai', OPENCODE, 'gpt-5')).toBe('openai/gpt-5');
        expect(normalizeModelId('litellm', OPENCODE, 'claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4-5');
    });

    it('keeps a Claude Code model as given, an OpenRouter `anthropic/<model>` included', () => {
        expect(normalizeModelId('anthropic', CLAUDE_CODE, 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
        expect(normalizeModelId('openrouter', CLAUDE_CODE, 'anthropic/claude-sonnet-4.5')).toBe(
            'anthropic/claude-sonnet-4.5'
        );
        expect(normalizeModelId('platform', OPENCODE, 'big-pickle')).toBe('big-pickle');
    });
});

describe('openRouterClaudeWiring', () => {
    const KEY = 'sk-or-test-value';

    it('points Claude Code at OpenRouter with the member key and blanks the platform Anthropic key', () => {
        expect(openRouterClaudeWiring({ OPENROUTER_API_KEY: KEY, OTHER: 'x' }, CLAUDE_CODE)).toEqual({
            ANTHROPIC_BASE_URL: OPENROUTER_ANTHROPIC_BASE_URL,
            ANTHROPIC_AUTH_TOKEN: KEY,
            ANTHROPIC_API_KEY: '',
        });
        expect(OPENROUTER_ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    });

    it('wires nothing for opencode, without an OpenRouter key, or when the env already names an Anthropic credential or host', () => {
        expect(openRouterClaudeWiring({ OPENROUTER_API_KEY: KEY }, OPENCODE)).toBeNull();
        expect(openRouterClaudeWiring({}, CLAUDE_CODE)).toBeNull();
        expect(openRouterClaudeWiring({ OPENROUTER_API_KEY: '' }, CLAUDE_CODE)).toBeNull();
        for (const name of [
            'ANTHROPIC_API_KEY',
            'CLAUDE_CODE_OAUTH_TOKEN',
            'ANTHROPIC_AUTH_TOKEN',
            'ANTHROPIC_BASE_URL',
        ]) {
            expect(openRouterClaudeWiring({ OPENROUTER_API_KEY: KEY, [name]: 'member-value' }, CLAUDE_CODE)).toBeNull();
        }
    });
});

describe('claimCredentialEnv', () => {
    const bearer = { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_AUTH_TOKEN: 't' };

    it('wires OpenRouter for Claude Code, its platform key blank, in both modes', () => {
        for (const mode of DEPLOYMENT_MODES) {
            expect(claimCredentialEnv({ OPENROUTER_API_KEY: 'k' }, CLAUDE_CODE, mode)).toEqual(
                openRouterClaudeWiring({ OPENROUTER_API_KEY: 'k' }, CLAUDE_CODE)
            );
            expect(claimCredentialEnv({ OPENROUTER_API_KEY: 'k' }, OPENCODE, mode)).toEqual({});
        }
    });

    it('in cloud, blanks the platform key beside any other member redirect without the member key', () => {
        expect(claimCredentialEnv(bearer, CLAUDE_CODE, CLOUD)).toEqual({ ANTHROPIC_API_KEY: '' });
        expect(claimCredentialEnv(bearer, OPENCODE, CLOUD)).toEqual({ ANTHROPIC_API_KEY: '' });
        expect(claimCredentialEnv({ ...bearer, ANTHROPIC_API_KEY: 'member' }, CLAUDE_CODE, CLOUD)).toEqual({});
    });

    it('self-hosted keeps a member redirect beside the platform key: nothing is blanked', () => {
        expect(claimCredentialEnv(bearer, CLAUDE_CODE, SELF_HOSTED)).toEqual({});
        expect(claimCredentialEnv({ OPENAI_BASE_URL: 'https://proxy.example.test' }, OPENCODE, SELF_HOSTED)).toEqual(
            {}
        );
    });
});
