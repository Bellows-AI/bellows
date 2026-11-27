import { describe, expect, it } from 'vitest';
import {
    agentLock,
    checkLine,
    detectProvider,
    keyRefusal,
    modelOptions,
    providerChoices,
    providerAgents,
    saveReason,
} from '../src/model-setup/providers.js';

/**
 * The model step's pure rules: which provider a pasted key names, which agents and models each provider offers, what
 * the key check's answer reads as, and why Save waits.
 */

describe('provider detection from the key prefix', () => {
    it('reads a subscription token, an Anthropic, an OpenRouter and an OpenAI key', () => {
        expect(detectProvider('sk-ant-oat01-abc', 'anthropic', 'self-hosted')).toBe('subscription');
        expect(detectProvider('sk-ant-api03-abc', 'openrouter', 'self-hosted')).toBe('anthropic');
        expect(detectProvider('sk-or-v1-abc', 'anthropic', 'self-hosted')).toBe('openrouter');
        for (const key of ['sk-proj-abc', 'sk-svcacct-abc', 'sk-admin-abc']) {
            expect(detectProvider(key, 'anthropic', 'self-hosted')).toBe('openai');
        }
    });

    it('keeps LiteLLM for an OpenAI-shaped virtual key, and the choice for a key with no known prefix', () => {
        expect(detectProvider('sk-proj-abc', 'litellm', 'self-hosted')).toBe('litellm');
        expect(detectProvider('sk-plain', 'openrouter', 'self-hosted')).toBe('openrouter');
    });

    it('never switches to a subscription in cloud: the token is refused with the sentence instead', () => {
        expect(detectProvider('sk-ant-oat01-abc', 'anthropic', 'cloud')).toBe('anthropic');
        expect(keyRefusal('sk-ant-oat01-abc', 'cloud')).toContain(
            'This is a Claude subscription token. This deployment accepts API keys only'
        );
        expect(keyRefusal('sk-ant-oat01-abc', 'self-hosted')).toBeNull();
        expect(keyRefusal('sk-ant-api03-abc', 'cloud')).toBeNull();
    });

    it('offers the subscription card only self-hosted', () => {
        expect(providerChoices('self-hosted')).toContain('subscription');
        expect(providerChoices('cloud')).not.toContain('subscription');
        expect(providerChoices('cloud')).toEqual(['anthropic', 'openrouter', 'openai', 'litellm']);
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
        expect(modelOptions('platform', 'claude-code', undefined)[0]).toBe('claude-sonnet-5-5');
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

describe('why Save waits', () => {
    const base = { provider: 'anthropic' as const, key: 'sk-ant-x', baseUrl: '', model: 'm' };

    it('names the missing step, and nothing once the key checked out', () => {
        expect(saveReason({ ...base, key: '', check: 'idle' })).toBe('Paste a key to continue.');
        expect(saveReason({ ...base, check: 'wait' })).toBe('Checking the key…');
        expect(saveReason({ ...base, check: 'bad' })).toBe('Fix the key to continue.');
        expect(saveReason({ ...base, check: 'error' })).toBe('The key could not be checked. Try again.');
        expect(saveReason({ ...base, provider: 'litellm', check: 'idle' })).toBe('Enter the proxy URL to continue.');
        expect(saveReason({ ...base, model: ' ', check: 'ok' })).toBe('Choose a model to continue.');
        expect(saveReason({ ...base, check: 'ok' })).toBeNull();
        expect(saveReason({ ...base, check: 'warn' })).toBeNull();
    });
});
