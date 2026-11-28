import { describe, expect, it } from 'vitest';
import { generatedExecutorName, modelFamily } from '../src/providers/executor-name.js';
import {
    agentLock,
    checkLine,
    detectProvider,
    keyRefusal,
    modelOptions,
    providerChoices,
    providerAgents,
    connectionReason,
} from '../src/providers/providers.js';

/**
 * The provider step's pure rules: which provider a pasted key names, which agents and models each provider offers, what
 * the key check's answer reads as, why the connection waits, and the generated executor name.
 */

describe('provider detection from the key prefix', () => {
    it('reads a subscription token, an Anthropic, an OpenRouter and an OpenAI key', () => {
        expect(detectProvider('sk-ant-oat01-abc', 'anthropic', true)).toBe('subscription');
        expect(detectProvider('sk-ant-api03-abc', 'openrouter', true)).toBe('anthropic');
        expect(detectProvider('sk-or-v1-abc', 'anthropic', true)).toBe('openrouter');
        for (const key of ['sk-proj-abc', 'sk-svcacct-abc', 'sk-admin-abc']) {
            expect(detectProvider(key, 'anthropic', true)).toBe('openai');
        }
    });

    it('keeps LiteLLM for an OpenAI-shaped virtual key, and the choice for a key with no known prefix', () => {
        expect(detectProvider('sk-proj-abc', 'litellm', true)).toBe('litellm');
        expect(detectProvider('sk-plain', 'openrouter', true)).toBe('openrouter');
    });

    it('never switches to a subscription where it is refused: the token is refused with the sentence instead', () => {
        expect(detectProvider('sk-ant-oat01-abc', 'anthropic', false)).toBe('anthropic');
        expect(keyRefusal('sk-ant-oat01-abc', false)).toContain(
            'This is a Claude subscription token. This deployment accepts API keys only'
        );
        expect(keyRefusal('sk-ant-api03-abc', false)).toBeNull();
    });

    it('switches to a subscription and refuses nothing where the org may use one', () => {
        expect(detectProvider('sk-ant-oat01-abc', 'anthropic', true)).toBe('subscription');
        expect(keyRefusal('sk-ant-oat01-abc', true)).toBeNull();
    });

    it('offers the subscription card only where the org may use one', () => {
        expect(providerChoices(true)).toContain('subscription');
        expect(providerChoices(false)).not.toContain('subscription');
        expect(providerChoices(false)).toEqual(['anthropic', 'openrouter', 'openai', 'litellm', 'openai-compatible']);
    });
});

describe('agents and models per provider', () => {
    it('preselects OpenCode on OpenRouter and keeps Claude Code selectable, with anthropic/ ids', () => {
        expect(providerAgents('openrouter')).toEqual(['opencode', 'claude-code']);
        const claude = modelOptions('openrouter', 'claude-code', undefined);
        expect(claude.length).toBeGreaterThan(0);
        for (const id of claude) expect(id.startsWith('anthropic/')).toBe(true);
    });

    it('locks OpenAI to OpenCode with the Codex note, and a subscription to Claude Code', () => {
        expect(providerAgents('openai')).toEqual(['opencode']);
        expect(agentLock('openai')).toContain('OpenAI keys run on OpenCode');
        expect(agentLock('openai')).toContain('Codex');
        expect(providerAgents('subscription')).toEqual(['claude-code']);
        expect(agentLock('subscription')).toContain('Claude Code only');
        expect(agentLock('anthropic')).toBeNull();
    });

    it("lists the check's models when it returned some, else the curated list", () => {
        expect(modelOptions('anthropic', 'claude-code', ['claude-x', 'claude-y'])).toEqual(['claude-x', 'claude-y']);
        expect(modelOptions('anthropic', 'claude-code', undefined)[0]).toBe('claude-sonnet-5-5');
        expect(modelOptions('anthropic', 'claude-code', [])[0]).toBe('claude-sonnet-5-5');
        // Claude Code on OpenRouter runs Anthropic models only.
        expect(modelOptions('openrouter', 'claude-code', ['openai/gpt-5.1', 'anthropic/claude-z'])).toEqual([
            'anthropic/claude-z',
        ]);
    });
});

describe("the key check's answer", () => {
    it('reads ok as ✓, no credit as ▲ and a refusal as ✕ with the server sentence', () => {
        expect(checkLine('anthropic', { ok: true, models: ['a', 'b'] })).toEqual({
            kind: 'ok',
            text: 'Key works · 2 models available',
        });
        expect(checkLine('openrouter', { ok: true, creditUsd: 18.4 }).text).toBe('Key works · $18.40 credit left');
        expect(checkLine('litellm', { ok: true, models: ['m'], budget: { limitUsd: 200, usedUsd: 41 } }).text).toBe(
            'Proxy answered · 1 model on this key · budget $200.00, $41.00 used'
        );
        const credit = checkLine('openrouter', { ok: false, code: 'NO_CREDIT', message: 'No credit left' });
        expect(credit.kind).toBe('warn');
        expect(credit.text).toContain('No credit left');
        expect(
            checkLine('anthropic', { ok: false, code: 'INVALID_KEY', message: 'Anthropic refused this key' })
        ).toEqual({ kind: 'bad', text: 'Anthropic refused this key' });
    });
});

describe('why the connection waits', () => {
    const base = { provider: 'anthropic' as const, key: 'sk-ant-x', baseUrl: '', name: 'Anthropic' };

    it('names the missing step, and nothing once the key checked out', () => {
        expect(connectionReason({ ...base, key: '', check: 'idle' })).toBe('Paste a key to continue.');
        expect(connectionReason({ ...base, check: 'wait' })).toBe('Checking the key…');
        expect(connectionReason({ ...base, check: 'bad' })).toBe('Fix the key to continue.');
        expect(connectionReason({ ...base, check: 'error' })).toBe('The key could not be checked. Try again.');
        expect(connectionReason({ ...base, provider: 'litellm', check: 'idle' })).toBe(
            'Enter the proxy URL to continue.'
        );
        expect(connectionReason({ ...base, provider: 'openai-compatible', check: 'idle' })).toBe(
            'Enter the endpoint URL to continue.'
        );
        expect(connectionReason({ ...base, name: ' ', check: 'ok' })).toBe('Give the connection a name.');
        expect(connectionReason({ ...base, check: 'ok' })).toBeNull();
        expect(connectionReason({ ...base, check: 'warn' })).toBeNull();
    });
});

describe('the generated executor name', () => {
    it('reads the model family out of a model id, with or without a provider prefix', () => {
        expect(modelFamily('claude-sonnet-5-5')).toBe('Sonnet');
        expect(modelFamily('anthropic/claude-opus-5.5')).toBe('Opus');
        expect(modelFamily('claude-haiku-5-5')).toBe('Haiku');
        expect(modelFamily('openai/gpt-5.1')).toBe('GPT-5.1');
        expect(modelFamily('openai/gpt-5.1-codex')).toBe('GPT-5.1 Codex');
        expect(modelFamily('moonshotai/kimi-k2')).toBe('Kimi');
        expect(modelFamily('acme/house-model-7')).toBe('house-model-7');
        expect(modelFamily('')).toBe('');
    });

    it('is "<Agent> · <Model family>", the agent alone without a model', () => {
        expect(generatedExecutorName('claude-code', 'claude-sonnet-5-5')).toBe('Claude Code · Sonnet');
        expect(generatedExecutorName('opencode', 'openai/gpt-5.1')).toBe('OpenCode · GPT-5.1');
        expect(generatedExecutorName('opencode', '')).toBe('OpenCode');
    });
});
