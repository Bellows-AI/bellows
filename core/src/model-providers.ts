/**
 * The model providers a member can bring a key for (docs/api.md, `POST /api/model-setup/verify`). `subscription` is a
 * Claude subscription token, which Bellows Cloud refuses.
 */
export const MODEL_PROVIDERS = ['anthropic', 'openrouter', 'openai', 'litellm', 'subscription'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const isModelProvider = (value: unknown): value is ModelProvider =>
    typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value);
