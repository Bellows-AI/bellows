import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE, OPENCODE } from '../src/executors.js';
import {
    claimCredentialEnv,
    isModelProvider,
    MODEL_PROVIDERS,
    OPENROUTER_ANTHROPIC_BASE_URL,
    openRouterClaudeWiring,
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
    it('is the OpenRouter wiring when it applies, and the platform-key blank for any other member redirect', () => {
        expect(claimCredentialEnv({ OPENROUTER_API_KEY: 'k' }, CLAUDE_CODE)).toEqual(
            openRouterClaudeWiring({ OPENROUTER_API_KEY: 'k' }, CLAUDE_CODE)
        );
        const bearer = { ANTHROPIC_BASE_URL: 'https://gateway.example.test', ANTHROPIC_AUTH_TOKEN: 't' };
        expect(claimCredentialEnv(bearer, CLAUDE_CODE)).toEqual({ ANTHROPIC_API_KEY: '' });
        expect(claimCredentialEnv(bearer, OPENCODE)).toEqual({ ANTHROPIC_API_KEY: '' });
        expect(claimCredentialEnv({ ...bearer, ANTHROPIC_API_KEY: 'member' }, CLAUDE_CODE)).toEqual({});
        expect(claimCredentialEnv({ OPENROUTER_API_KEY: 'k' }, OPENCODE)).toEqual({});
    });
});
