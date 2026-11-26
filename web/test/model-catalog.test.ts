import {
    connectionModelRefusal,
    EXECUTOR_TYPES,
    MODEL_PROVIDERS,
    normalizeModelId,
    providerSupportsAgent,
} from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { catalogModels, modelCatalogOf, normalizedChoices } from '../src/workspace/model-catalog.js';

/**
 * What a connection's model list offers is exactly what the server accepts: every id passes the same
 * `normalizeModelId` rule the model setup applies, and the shared `connectionModelRefusal` the save runs.
 */

const connection = (provider: (typeof MODEL_PROVIDERS)[number]) => ({ name: 'Key', provider });

describe('the model catalog normalizes ids for the executor agent', () => {
    it('prefixes an OpenCode + OpenAI live list with the provider id', () => {
        const catalog = modelCatalogOf(connection('openai'), 'opencode', {
            state: 'listed',
            models: ['gpt-5.1', 'openai/gpt-5-mini'],
        });
        expect(catalogModels(catalog)).toEqual(['openai/gpt-5.1', 'openai/gpt-5-mini']);
    });

    it('prefixes an OpenCode + OpenRouter curated fallback, never offering a foreign anthropic/ id', () => {
        const catalog = modelCatalogOf(connection('openrouter'), 'opencode', { state: 'failed', message: 'down' });
        const offered = catalogModels(catalog);
        expect(offered.length).toBeGreaterThan(0);
        expect(offered.every((id) => id.startsWith('openrouter/'))).toBe(true);
        expect(offered).toContain('openrouter/anthropic/claude-sonnet-5.5');
    });

    it('keeps a Claude Code list as the provider gave it', () => {
        const catalog = modelCatalogOf(connection('anthropic'), 'claude-code', {
            state: 'listed',
            models: ['claude-x'],
        });
        expect(catalogModels(catalog)).toEqual(['claude-x']);
    });

    it('normalizedChoices is the single rule, idempotent, and leaves Default empty', () => {
        expect(normalizedChoices('openai', 'opencode', '')).toBe('');
        expect(normalizedChoices('openai', 'opencode', 'gpt-5.1')).toBe('openai/gpt-5.1');
        expect(normalizedChoices('openai', 'opencode', 'openai/gpt-5.1')).toBe('openai/gpt-5.1');
        expect(normalizedChoices('openai', 'opencode', 'gpt-5.1')).toBe(
            normalizeModelId('openai', 'opencode', 'gpt-5.1')
        );
    });

    it('every id offered, for every provider, agent and read state, passes the server save validation', () => {
        const reads = [
            { state: 'listed' as const, models: ['gpt-5.1', 'anthropic/claude-x', 'claude-y'] },
            { state: 'unsupported' as const },
            { state: 'failed' as const, message: 'down' },
        ];
        for (const provider of MODEL_PROVIDERS) {
            for (const agent of EXECUTOR_TYPES) {
                if (!providerSupportsAgent(provider, agent)) continue;
                for (const read of reads) {
                    // A subscription has no discovery: the server answers `unsupported`, never a list.
                    if (provider === 'subscription' && read.state === 'listed') continue;
                    const offered = catalogModels(modelCatalogOf(connection(provider), agent, read));
                    for (const id of offered) {
                        // OpenCode: the id's prefix must be the provider's own; Claude Code's list is the provider's.
                        const refusal = connectionModelRefusal(provider, agent, id);
                        expect(refusal, `${provider}/${agent}/${read.state}: ${id}`).toBeNull();
                    }
                }
            }
        }
    });
});
