import {
    CLAUDE_CODE_OAUTH_TOKEN,
    CLOUD,
    type DeploymentMode,
    ENV_SUBSTITUTION,
    platformCredentialBlanks,
    PROVIDER_API_KEY,
    PROVIDER_BASE_URL,
} from './deployment-mode.js';
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
 * The provider a scope's names point to, in provider order: an Anthropic key (LiteLLM when an Anthropic base URL is
 * beside it), then OpenRouter, OpenAI, a subscription token. Null when no provider key is present.
 */
export function inferProvider(names: readonly string[]): ModelProvider | null {
    const has = new Set(names);
    if (has.has('ANTHROPIC_API_KEY')) return has.has('ANTHROPIC_BASE_URL') ? 'litellm' : 'anthropic';
    if (has.has('OPENROUTER_API_KEY')) return 'openrouter';
    if (has.has('OPENAI_API_KEY')) return 'openai';
    if (has.has(CLAUDE_CODE_OAUTH_TOKEN)) return 'subscription';
    return null;
}

/** The names a provider's setup cannot run without: its key, and LiteLLM's required base URL. */
const requiredNames = (provider: ModelProvider): string[] =>
    provider === 'litellm' ? providerEnvNames(provider) : [PROVIDER_ENV[provider]];

/**
 * The key provider a scope holds now: the recorded one while its credential names are all in the scope (it tells
 * Anthropic behind a base URL from LiteLLM), else the one the names point to. A key replaced by hand outranks the
 * record.
 */
export function currentProvider(
    names: readonly string[],
    recorded: AgentProvider | null | undefined
): ModelProvider | null {
    const has = new Set(names);
    if (isModelProvider(recorded) && requiredNames(recorded).every((name) => has.has(name))) return recorded;
    return inferProvider(names);
}

/**
 * The names Claude Code reads for its model: its keys and token, where it sends them, and the OpenRouter key its
 * claim wiring turns into a bearer token. One scope owns all of them for a Claude Code run.
 */
export const CLAUDE_CODE_CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    CLAUDE_CODE_OAUTH_TOKEN,
    'OPENROUTER_API_KEY',
]);

/** The index of the highest scope (lowest first) naming any of Claude Code's model names; -1 when none does. */
export function claudeCodeCredentialScope(scopes: readonly (readonly string[])[]): number {
    for (let i = scopes.length - 1; i >= 0; i -= 1) {
        if (scopes[i]?.some((name) => CLAUDE_CODE_CREDENTIAL_NAMES.has(name))) return i;
    }
    return -1;
}

/**
 * A Claude Code run's env: scope envs stacked lowest first, a higher scope winning a name, except that Claude Code's
 * model names come from one scope, the highest naming any of them. A lower scope's values of those names are dropped,
 * so an org Anthropic key neither rides along with a member's OpenRouter key nor turns its wiring off. Every other
 * name, another provider's key included, stacks as usual; an OpenCode run stacks plainly.
 */
export function stackClaudeCodeEnv(scopes: readonly Readonly<Record<string, string>>[]): Record<string, string> {
    const owner = claudeCodeCredentialScope(scopes.map((scope) => Object.keys(scope)));
    const stacked: Record<string, string> = {};
    scopes.forEach((scope, index) => {
        for (const [name, value] of Object.entries(scope)) {
            if (index < owner && CLAUDE_CODE_CREDENTIAL_NAMES.has(name)) continue;
            stacked[name] = value;
        }
    });
    return stacked;
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

/** What a task with no model credential is refused with (`NO_MODEL`), at create, in preflight and at claim. */
export const NO_MODEL_MESSAGE =
    'Connect a model in Settings → Model, or ask an admin to connect one for the organization.';

/** A task must bring its own model credential in cloud mode, unless the operator supplies the model. */
export const modelKeyRequired = (mode: DeploymentMode, platformModelProvided: boolean): boolean =>
    mode === CLOUD && !platformModelProvided;

/** The env names each agent can run its model on. Claude Code's OpenRouter key works through its claim wiring. */
const MODEL_KEYS: Readonly<Record<ExecutorType, readonly string[]>> = {
    [CLAUDE_CODE]: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', CLAUDE_CODE_OAUTH_TOKEN, 'OPENROUTER_API_KEY'],
    [OPENCODE]: ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether an OpenCode provider `apiKey` gives the run a key: a non-empty literal, or `{env:NAME}` with `NAME` among the
 * names the run gets. `{file:…}` (the board cannot see the file) and any other option do not count.
 */
function providerKeyPresent(value: unknown, names: ReadonlySet<string>): boolean {
    if (!nonEmpty(value)) return false;
    const substituted = ENV_SUBSTITUTION.exec(value);
    if (substituted) return names.has(substituted[1] as string);
    return !/\{(?:env|file):/.test(value);
}

/**
 * Whether a task's agent has a model credential the run will actually have, judged on the names its env carries (names
 * only at create; the non-empty names at claim) and its executor profile's config. Claude Code: its settings' `env`
 * applies over the env, a non-empty value adding the name and an empty one removing it. OpenCode: a key name in the
 * env, or a provider `options.apiKey` (`providerKeyPresent`).
 */
export function hasModelKey(names: readonly string[], config: unknown, agentType: ExecutorType): boolean {
    const present = new Set(names);
    const settings = isRecord(config) ? config : {};
    if (agentType === CLAUDE_CODE && isRecord(settings.env)) {
        for (const [name, value] of Object.entries(settings.env)) {
            if (nonEmpty(value)) present.add(name);
            else present.delete(name);
        }
    }
    if (MODEL_KEYS[agentType].some((name) => present.has(name))) return true;
    if (agentType !== OPENCODE || !isRecord(settings.provider)) return false;
    return Object.values(settings.provider).some(
        (provider) =>
            isRecord(provider) && isRecord(provider.options) && providerKeyPresent(provider.options.apiKey, present)
    );
}

/**
 * A custom provider key that names a secret instead of carrying one (BEL-603): exactly `{env:NAME}`
 * beside a `baseURL`. The board resolves it at claim from the member's own scopes — the env the
 * claim already merged — and writes the value into the rendered provider config, so opencode never
 * substitutes it itself: a raw `{env:…}` would read the runner's whole environment, the deployment
 * credential included. Anything the scopes do not hold is unresolved and refuses the task.
 */
export function resolveProviderReferences(
    config: Record<string, unknown>,
    env: Readonly<Record<string, string>> | undefined
): { config: Record<string, unknown>; missing: string[] } {
    const missing = new Set<string>();
    /** One object step: a baseURL provider's `{env:NAME}` apiKey is where a reference can stand. */
    const step = (value: Record<string, unknown>): unknown => {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value)) out[key] = walk(inner);
        const apiKey = out[PROVIDER_API_KEY];
        if (nonEmpty(out[PROVIDER_BASE_URL]) && typeof apiKey === 'string') {
            const reference = ENV_SUBSTITUTION.exec(apiKey);
            if (reference) {
                const name = reference[1] as string;
                const value = env?.[name];
                if (nonEmpty(value)) out[PROVIDER_API_KEY] = value;
                else missing.add(name);
            }
        }
        return out;
    };
    const walk = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(walk);
        return isRecord(value) ? step(value) : value;
    };
    return { config: walk(config) as Record<string, unknown>, missing: [...missing] };
}

/** The sentence an unresolved provider reference fails the task with, naming every missing secret. */
export function missingProviderSecretMessage(names: readonly string[]): string {
    const list = names.join(', ');
    return (
        `The executor's provider key {env:${list}} names no secret this task carries. ` +
        `Add ${list} under Settings → Environment — organization, workspace, or repository scope — and start a new task.`
    );
}
