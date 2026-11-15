import { describe, expect, it } from 'vitest';
import { isModelProvider, MODEL_PROVIDERS } from '../src/model-providers.js';

describe('MODEL_PROVIDERS', () => {
    it('lists the providers a member can bring a key for, in display order', () => {
        expect(MODEL_PROVIDERS).toEqual(['anthropic', 'openrouter', 'openai', 'litellm', 'subscription']);
    });

    it('recognizes exactly the listed ids', () => {
        for (const id of MODEL_PROVIDERS) expect(isModelProvider(id)).toBe(true);
        for (const other of ['Anthropic', 'claude', '', null, 1, undefined]) expect(isModelProvider(other)).toBe(false);
    });
});
