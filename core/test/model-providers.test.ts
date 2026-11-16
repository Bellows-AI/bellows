import { describe, expect, it } from 'vitest';
import { CLOUD, DEPLOYMENT_MODES, SELF_HOSTED } from '../src/deployment-mode.js';
import { CLAUDE_CODE, OPENCODE } from '../src/executors.js';
import {
    AGENT_PROVIDERS,
    CLAUDE_CODE_CREDENTIAL_NAMES,
    claimCredentialEnv,
    claudeCodeCredentialScope,
    currentProvider,
    hasModelKey,
    inferProvider,
    isAgentProvider,
    isModelProvider,
    MODEL_PROVIDERS,
    modelKeyRequired,
    NO_MODEL_MESSAGE,
    normalizeModelId,
    OPENROUTER_ANTHROPIC_BASE_URL,
    openRouterClaudeWiring,
    PLATFORM_PROVIDER,
    PROVIDER_AGENTS,
    PROVIDER_BASE_URL_ENV,
    PROVIDER_ENV,
    providerAvailable,
    providerEnvNames,
    stackClaudeCodeEnv,
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

describe('Claude Code takes its model credentials from one scope', () => {
    it('names what Claude Code reads for its model, and nothing another agent reads', () => {
        expect([...CLAUDE_CODE_CREDENTIAL_NAMES].sort()).toEqual(
            [
                'ANTHROPIC_API_KEY',
                'ANTHROPIC_AUTH_TOKEN',
                'ANTHROPIC_BASE_URL',
                'CLAUDE_CODE_OAUTH_TOKEN',
                'OPENROUTER_API_KEY',
            ].sort()
        );
    });

    it('the highest scope naming any of them owns them; another provider’s key is no trigger', () => {
        expect(claudeCodeCredentialScope([['ANTHROPIC_API_KEY'], ['OPENROUTER_API_KEY'], []])).toBe(1);
        expect(claudeCodeCredentialScope([['ANTHROPIC_API_KEY'], ['OTHER'], ['OPENAI_API_KEY']])).toBe(0);
        expect(claudeCodeCredentialScope([['OTHER'], [], ['OPENAI_BASE_URL']])).toBe(-1);
    });

    it('drops a lower scope’s Claude Code names and stacks the rest, the higher scope winning', () => {
        expect(
            stackClaudeCodeEnv([
                { ANTHROPIC_API_KEY: 'org', ANTHROPIC_BASE_URL: 'https://org.example.test', SHARED: 'org', A: 'a' },
                { OPENROUTER_API_KEY: 'mine', SHARED: 'mine' },
                {},
            ])
        ).toEqual({ A: 'a', SHARED: 'mine', OPENROUTER_API_KEY: 'mine' });
        expect(stackClaudeCodeEnv([{ ANTHROPIC_API_KEY: 'org' }, {}, { OPENAI_API_KEY: 'repo' }])).toEqual({
            ANTHROPIC_API_KEY: 'org',
            OPENAI_API_KEY: 'repo',
        });
        expect(stackClaudeCodeEnv([{}, { OPENROUTER_API_KEY: 'mine' }, { ANTHROPIC_API_KEY: 'repo' }])).toEqual({
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

describe('hasModelKey', () => {
    it('Claude Code runs on an Anthropic key or token, a subscription token, or an OpenRouter key (its claim wiring)', () => {
        for (const name of [
            'ANTHROPIC_API_KEY',
            'ANTHROPIC_AUTH_TOKEN',
            'CLAUDE_CODE_OAUTH_TOKEN',
            'OPENROUTER_API_KEY',
        ]) {
            expect(hasModelKey([name], null, CLAUDE_CODE)).toBe(true);
        }
        expect(hasModelKey(['OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', 'GITHUB_TOKEN'], null, CLAUDE_CODE)).toBe(false);
        expect(hasModelKey([], {}, CLAUDE_CODE)).toBe(false);
    });

    it('OpenCode runs on an Anthropic, OpenRouter or OpenAI key, and on nothing else', () => {
        for (const name of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']) {
            expect(hasModelKey([name], null, OPENCODE)).toBe(true);
        }
        expect(hasModelKey(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'], null, OPENCODE)).toBe(false);
    });

    it('counts a credential the executor profile holds: a Claude Code `env` key, an OpenCode provider `apiKey`', () => {
        expect(hasModelKey([], { env: { ANTHROPIC_API_KEY: 'stored-credential:r' } }, CLAUDE_CODE)).toBe(true);
        expect(hasModelKey([], { env: { ANTHROPIC_API_KEY: '' } }, CLAUDE_CODE)).toBe(false);
        expect(hasModelKey([], { env: { SOME_ACCESS_TOKEN: 'x' } }, CLAUDE_CODE)).toBe(false);
        const provider = { provider: { anthropic: { options: { apiKey: 'stored-credential:r' } } } };
        expect(hasModelKey([], provider, OPENCODE)).toBe(true);
        expect(hasModelKey([], provider, CLAUDE_CODE)).toBe(false);
        expect(hasModelKey([], { provider: { anthropic: { options: { apiKey: '' } } } }, OPENCODE)).toBe(false);
    });

    it('is required in cloud only, and not when the platform supplies the model', () => {
        expect(modelKeyRequired(CLOUD, false)).toBe(true);
        expect(modelKeyRequired(CLOUD, true)).toBe(false);
        expect(modelKeyRequired(SELF_HOSTED, false)).toBe(false);
        expect(NO_MODEL_MESSAGE).toBe(
            'Connect a model in Settings → Model, or ask an admin to connect one for the organization.'
        );
    });
});
