import { CLAUDE_CODE_OAUTH_TOKEN } from './deployment-mode.js';
import { CLAUDE_CODE } from './executors.js';

/**
 * The model providers a member can bring a key for (docs/api.md, `POST /api/model-setup/verify`). `subscription` is a
 * Claude subscription token, which Bellows Cloud refuses.
 */
export const MODEL_PROVIDERS = ['anthropic', 'openrouter', 'openai', 'litellm', 'subscription'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const isModelProvider = (value: unknown): value is ModelProvider =>
    typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value);

/** Where Claude Code reaches OpenRouter's Anthropic-compatible API (it appends `/v1/messages`). */
export const OPENROUTER_ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';

/** Names whose presence means the member already chose how Claude Code authenticates or where it sends. */
const ANTHROPIC_CHOICE = ['ANTHROPIC_API_KEY', CLAUDE_CODE_OAUTH_TOKEN, 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * The env a Claude Code claim gains when the member brought only an OpenRouter key: the base URL, the
 * key as the bearer token, and an empty `ANTHROPIC_API_KEY` so the platform's own key cannot follow it
 * to OpenRouter. Null when the agent is not Claude Code, there is no OpenRouter key, or the effective
 * env already names any Anthropic credential or host.
 */
export function openRouterClaudeWiring(
    env: Readonly<Record<string, unknown>>,
    agentType: string
): Record<string, string> | null {
    const key = env.OPENROUTER_API_KEY;
    if (agentType !== CLAUDE_CODE || !nonEmpty(key)) return null;
    if (ANTHROPIC_CHOICE.some((name) => nonEmpty(env[name]))) return null;
    return { ANTHROPIC_BASE_URL: OPENROUTER_ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' };
}
