import { CLAUDE_CODE, type ExecutorType, OPENCODE } from './executors.js';
import { PROVIDER_AGENTS } from './model-providers.js';

/**
 * The providers an executor profile's guided setup offers : the model-setup's key providers
 * a profile can carry its own credential for, plus the OpenAI-compatible custom endpoint, which is
 * an OpenCode provider block (`npm: @ai-sdk/openai-compatible`) rather than a stored env name. The
 * guided setup renders this list and `guidedExecutorConfig` generates the config from a pick, so a
 * new provider lands in both or neither.
 */
export const EXECUTOR_PROVIDERS = ['anthropic', 'openrouter', 'openai', 'litellm', 'openai-compatible'] as const;

export type ExecutorProvider = (typeof EXECUTOR_PROVIDERS)[number];

export const isExecutorProvider = (value: unknown): value is ExecutorProvider =>
    typeof value === 'string' && (EXECUTOR_PROVIDERS as readonly string[]).includes(value);

/** The agents each provider's credential runs, the first preselected — the model-setup's own answers, plus the custom endpoint. */
export const EXECUTOR_PROVIDER_AGENTS: Readonly<Record<ExecutorProvider, readonly ExecutorType[]>> = {
    anthropic: PROVIDER_AGENTS.anthropic,
    openrouter: PROVIDER_AGENTS.openrouter,
    openai: PROVIDER_AGENTS.openai,
    litellm: PROVIDER_AGENTS.litellm,
    // An OpenAI-wire endpoint runs on the agent that speaks the OpenAI-compatible SDK.
    'openai-compatible': [OPENCODE],
};

/** The opencode provider id each provider's block is written under; LiteLLM is reached as Anthropic. */
const OPENCODE_PROVIDER_ID: Readonly<Record<ExecutorProvider, string>> = {
    anthropic: 'anthropic',
    openrouter: 'openrouter',
    openai: 'openai',
    litellm: 'anthropic',
    'openai-compatible': 'custom',
};

/** The npm package an OpenAI-compatible endpoint's block loads: the generic OpenAI-wire SDK. */
export const OPENAI_COMPATIBLE_NPM = '@ai-sdk/openai-compatible';

/** The OpenCode model prefix each provider's model id carries; the custom endpoint takes its own id. */
const OPENCODE_PROVIDER_PREFIX: Readonly<Record<ExecutorProvider, string | null>> = {
    anthropic: 'anthropic',
    openrouter: 'openrouter',
    openai: 'openai',
    litellm: 'anthropic',
    'openai-compatible': null,
};

/** The env name each provider's key rides in a Claude Code settings `env`. */
const CLAUDE_KEY_ENV: Readonly<Record<ExecutorProvider, string>> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    litellm: 'ANTHROPIC_API_KEY',
    'openai-compatible': 'OPENAI_API_KEY',
};

/** The env name each provider's base URL rides in a Claude Code settings `env`, when one is set. */
const CLAUDE_BASE_ENV: Readonly<Record<ExecutorProvider, string | null>> = {
    anthropic: 'ANTHROPIC_BASE_URL',
    openrouter: null,
    openai: 'OPENAI_BASE_URL',
    litellm: 'ANTHROPIC_BASE_URL',
    'openai-compatible': null,
};

/** The opencode provider id a custom endpoint's block is keyed under: its host, slugified, else `custom`. */
export function customProviderId(baseUrl: string): string {
    let host = '';
    try {
        host = new URL(baseUrl).hostname;
    } catch {
        return 'custom';
    }
    const slug = host
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'custom';
}

/** The declared model entry opencode needs for an id no catalog carries (the lane's own shape). */
const customModelEntry = {
    name: '',
    tool_call: true,
    limit: { context: 200_000, output: 8192 },
};

export interface GuidedExecutorInput {
    provider: ExecutorProvider;
    agent: ExecutorType;
    /** The model id as the member typed it, without a provider prefix. */
    model: string;
    /**
     * The credential the profile carries: a pasted key, a `stored-credential:` marker kept from the
     * row, or the `{env:NAME}` reference the board resolves at claim. Empty: the config carries no
     * key, and the run uses the key connected in Settings → Model.
     */
    key: string;
    /** The endpoint's base URL, where the provider takes one. */
    baseUrl?: string | undefined;
}

/** The Claude Code half: the key and the base URL ride the settings' own `env`. */
function guidedClaudeConfig(provider: ExecutorProvider, model: string, key: string, baseUrl: string | undefined) {
    const env: Record<string, string> = {};
    if (key !== '') env[CLAUDE_KEY_ENV[provider]] = key;
    const baseEnv = CLAUDE_BASE_ENV[provider];
    if (baseEnv !== null && baseUrl !== undefined) env[baseEnv] = baseUrl;
    return { model, ...(Object.keys(env).length > 0 ? { env } : {}) };
}

/** The OpenAI-compatible half: one OpenCode provider block under the endpoint's slugified host.
 * An incomplete choice — no base URL typed yet — generates with what it has: the dialog's own
 * validation holds Save until the endpoint and the key are there. */
function guidedCompatibleConfig(model: string, key: string, baseUrl: string | undefined, modelId: string) {
    const id = customProviderId(baseUrl ?? '');
    return {
        model: modelId,
        provider: {
            [id]: {
                npm: OPENAI_COMPATIBLE_NPM,
                name: id,
                options: { baseURL: baseUrl ?? '', apiKey: key },
                models: { [model]: { ...customModelEntry, name: model } },
            },
        },
    };
}

/**
 * The config the guided executor setup generates. The key stands VERBATIM where the profile's
 * credential lives — the save seals a literal into the secret store, and a reference stays for the
 * claim to resolve — so an edit regenerates around what the row already holds.
 */
export function guidedExecutorConfig(input: GuidedExecutorInput): Record<string, unknown> {
    const { provider, agent, model, key } = input;
    const baseUrl = input.baseUrl?.trim() || undefined;
    const agents = EXECUTOR_PROVIDER_AGENTS[provider];
    if (!agents.includes(agent)) {
        throw new Error(`provider "${provider}" does not run ${agent}`);
    }
    if (agent === CLAUDE_CODE) return guidedClaudeConfig(provider, model, key, baseUrl);
    const prefix = OPENCODE_PROVIDER_PREFIX[provider];
    const modelId = prefix === null ? `${customProviderId(baseUrl ?? '')}/${model}` : `${prefix}/${model}`;
    // A custom endpoint IS its provider block: there is no built-in to fall back to, so the key
    // stands even when empty and the save refuses it.
    if (provider === 'openai-compatible') return guidedCompatibleConfig(model, key, baseUrl, modelId);
    const id = OPENCODE_PROVIDER_ID[provider];
    // Without a key the run uses the one connected in Settings → Model; a base URL still travels, so
    // a member's own gateway works on it (cloud refuses the redirect until a key of theirs stands
    // with it, as it would for a hand-written one).
    if (key === '')
        return baseUrl === undefined
            ? { model: modelId }
            : { model: modelId, provider: { [id]: { options: { baseURL: baseUrl } } } };
    const options: Record<string, string> = { apiKey: key };
    if (baseUrl !== undefined) options.baseURL = baseUrl;
    return { model: modelId, provider: { [id]: { options } } };
}
