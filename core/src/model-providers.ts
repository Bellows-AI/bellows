import { CLAUDE_CODE_OAUTH_TOKEN, CLOUD, type DeploymentMode, platformCredentialBlanks } from './deployment-mode.js';
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

/** Claude Code's route to OpenRouter on the member's key alone, before the platform-key blank. */
function openRouterRoute(env: Readonly<Record<string, unknown>>, agentType: string): Record<string, string> | null {
    const key = env.OPENROUTER_API_KEY;
    if (agentType !== CLAUDE_CODE || !nonEmpty(key)) return null;
    if (ANTHROPIC_CHOICE.some((name) => nonEmpty(env[name]))) return null;
    return { ANTHROPIC_BASE_URL: OPENROUTER_ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: key };
}

/**
 * The env a Claude Code claim gains when the member brought only an OpenRouter key: the base URL, the
 * key as the bearer token, and an empty `ANTHROPIC_API_KEY` (`platformCredentialBlanks`) so the
 * platform's own key cannot follow it to OpenRouter — in either mode. Null when the agent is not Claude
 * Code, there is no OpenRouter key, or the effective env already names any Anthropic credential or host.
 */
export function openRouterClaudeWiring(
    env: Readonly<Record<string, unknown>>,
    agentType: string
): Record<string, string> | null {
    const route = openRouterRoute(env, agentType);
    return route === null ? null : { ...route, ...platformCredentialBlanks({ ...env, ...route }) };
}

/**
 * What a claim adds over the member's effective env: the OpenRouter wiring when it applies, in both
 * modes; otherwise, in cloud mode only, the platform-key blank beside every member redirect, where the
 * redirect rule (`redirectsPlatformCredential`) applies. A self-hosted board keeps the platform key
 * beside a member redirect: an operator's proxy URL in org env may rely on the key in `RUNNER_ENV`.
 */
export function claimCredentialEnv(
    env: Readonly<Record<string, unknown>>,
    agentType: string,
    mode: DeploymentMode
): Record<string, string> {
    return openRouterClaudeWiring(env, agentType) ?? (mode === CLOUD ? platformCredentialBlanks(env) : {});
}
