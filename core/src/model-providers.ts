import { CLAUDE_CODE_OAUTH_TOKEN, CLOUD, type DeploymentMode, platformCredentialBlanks } from './deployment-mode.js';
import { CLAUDE_CODE, type ExecutorType, OPENCODE } from './executors.js';

/**
 * The model providers a member can bring a key for (docs/api.md, `POST /api/model-setup/verify`). `subscription` is a
 * Claude subscription token, which Bellows Cloud refuses.
 */
export const MODEL_PROVIDERS = ['anthropic', 'openrouter', 'openai', 'litellm', 'subscription'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const isModelProvider = (value: unknown): value is ModelProvider =>
    typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value);

/** The model the deployment's operator supplies (`PLATFORM_MODEL_PROVIDED`): an agent default with no member key. */
export const PLATFORM_PROVIDER = 'platform';

/** What an agent default records as its source (158_agent_default_provider.sql): a key provider or the platform. */
export const AGENT_PROVIDERS = [...MODEL_PROVIDERS, PLATFORM_PROVIDER] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const isAgentProvider = (value: unknown): value is AgentProvider =>
    typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value);

/** The secret each provider's key is stored under. LiteLLM is a proxy Claude Code reaches as Anthropic. */
export const PROVIDER_ENV: Readonly<Record<ModelProvider, string>> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    litellm: 'ANTHROPIC_API_KEY',
    subscription: CLAUDE_CODE_OAUTH_TOKEN,
};

/** The plain variable a provider's base URL is stored under; LiteLLM requires one, a subscription takes none. */
export const PROVIDER_BASE_URL_ENV: Readonly<Record<ModelProvider, string | null>> = {
    anthropic: 'ANTHROPIC_BASE_URL',
    openrouter: 'OPENROUTER_BASE_URL',
    openai: 'OPENAI_BASE_URL',
    litellm: 'ANTHROPIC_BASE_URL',
    subscription: null,
};

/** The agents each provider's key can run, the first being the default. */
export const PROVIDER_AGENTS: Readonly<Record<ModelProvider, readonly ExecutorType[]>> = {
    anthropic: [CLAUDE_CODE, OPENCODE],
    openrouter: [OPENCODE, CLAUDE_CODE],
    openai: [OPENCODE],
    litellm: [CLAUDE_CODE, OPENCODE],
    subscription: [CLAUDE_CODE],
};

/** Every name a provider's setup writes: its key, then its base URL where it has one. */
export const providerEnvNames = (provider: ModelProvider): string[] => {
    const base = PROVIDER_BASE_URL_ENV[provider];
    return base === null ? [PROVIDER_ENV[provider]] : [PROVIDER_ENV[provider], base];
};

/** Bellows Cloud refuses a Claude subscription token; every other provider is offered in both modes. */
export const providerAvailable = (provider: ModelProvider, mode: DeploymentMode): boolean =>
    provider !== 'subscription' || mode !== CLOUD;

/**
 * The provider a scope's names point to, for a scope saved before its provider was recorded. An Anthropic key beside
 * an Anthropic base URL reads as LiteLLM; null when no provider key is present.
 */
export function inferProvider(names: readonly string[]): ModelProvider | null {
    const has = new Set(names);
    if (has.has(CLAUDE_CODE_OAUTH_TOKEN)) return 'subscription';
    if (has.has('ANTHROPIC_API_KEY')) return has.has('ANTHROPIC_BASE_URL') ? 'litellm' : 'anthropic';
    if (has.has('OPENROUTER_API_KEY')) return 'openrouter';
    if (has.has('OPENAI_API_KEY')) return 'openai';
    return null;
}

/** OpenCode's provider id for the models each key reaches; LiteLLM is reached as Anthropic. */
const OPENCODE_PREFIX: Readonly<Record<ModelProvider, string | null>> = {
    anthropic: 'anthropic',
    openrouter: 'openrouter',
    openai: 'openai',
    litellm: 'anthropic',
    subscription: null,
};

/**
 * The model id an agent default stores: OpenCode names a model `<provider>/<model>`, so a bare or foreign id gains the
 * provider's prefix once. Claude Code's id, and any id on the platform's model, is kept as given.
 */
export function normalizeModelId(provider: AgentProvider, agentType: ExecutorType, model: string): string {
    if (agentType !== OPENCODE || provider === PLATFORM_PROVIDER) return model;
    const prefix = OPENCODE_PREFIX[provider];
    if (prefix === null || model.startsWith(`${prefix}/`)) return model;
    return `${prefix}/${model}`;
}

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
