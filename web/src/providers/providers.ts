import {
    CLAUDE_CODE,
    ERROR_CODES,
    type ExecutorType,
    MODEL_PROVIDERS,
    type ModelProvider,
    OPENCODE,
    PROVIDER_AGENTS,
    providerAvailable,
    providerRequiresBaseUrl,
} from '@factory-ai/core';

/**
 * The provider step's rules (docs/api.md, `POST /api/provider-connections/setup`, `POST /api/provider-connections/verify`): what each
 * provider card says, which provider a pasted key names, the agents and models each offers, how the key check's answer
 * reads, and why Save waits. The agents and env names are core's (`model-providers.ts`); the copy is the UI's.
 */

export interface ProviderMeta {
    label: string;
    /** The card's second line. */
    sub: string;
    /** A short tag beside the name, where the provider has a limit worth naming. */
    tag?: string;
    keyLabel: string;
    placeholder: string;
    /** Where to get a key: the link text, and its address when it has one. */
    keyLink: { text: string; href: string | null };
    /** Why the preselected agent is the one preselected. */
    agentHelp: string;
    /** What the check line says while it runs. */
    checking: string;
}

export const PROVIDER_META: Readonly<Record<ModelProvider, ProviderMeta>> = {
    anthropic: {
        label: 'Anthropic',
        sub: 'Claude models, billed by Anthropic. Key starts with sk-ant-',
        keyLabel: 'API key',
        placeholder: 'sk-ant-api03-…',
        keyLink: { text: 'console.anthropic.com → API keys', href: 'https://console.anthropic.com/settings/keys' },
        agentHelp: 'Recommended for Anthropic keys.',
        checking: 'Checking with Anthropic…',
    },
    openrouter: {
        label: 'OpenRouter',
        sub: 'Any model through one key and one bill. Key starts with sk-or-',
        keyLabel: 'API key',
        placeholder: 'sk-or-v1-…',
        keyLink: { text: 'openrouter.ai → Keys', href: 'https://openrouter.ai/settings/keys' },
        agentHelp: 'Recommended for OpenRouter: any model, native provider.',
        checking: 'Checking with OpenRouter…',
    },
    openai: {
        label: 'OpenAI',
        sub: 'GPT models, billed by OpenAI. Key starts with sk-proj-',
        keyLabel: 'API key',
        placeholder: 'sk-proj-…',
        keyLink: { text: 'platform.openai.com → API keys', href: 'https://platform.openai.com/api-keys' },
        agentHelp: 'OpenAI keys run on OpenCode.',
        checking: 'Checking with OpenAI…',
    },
    litellm: {
        label: 'LiteLLM',
        sub: 'Your own LiteLLM proxy: its URL and a virtual key. Any model it serves, via Claude Code.',
        tag: 'self-hosted',
        keyLabel: 'Virtual key',
        placeholder: 'sk-… (virtual key)',
        keyLink: { text: 'your LiteLLM admin UI → Virtual keys', href: null },
        agentHelp: 'Claude Code runs every model the proxy serves, through its Anthropic route.',
        checking: 'Checking with your proxy…',
    },
    'openai-compatible': {
        label: 'OpenAI-compatible (custom endpoint)',
        sub: 'Your own endpoint that speaks the OpenAI wire format: its URL and a key. Any model it serves, via OpenCode.',
        tag: 'self-hosted',
        keyLabel: 'API key',
        placeholder: 'sk-… (the endpoint’s key)',
        keyLink: { text: 'your endpoint’s admin console → API keys', href: null },
        agentHelp: 'Custom endpoints run on OpenCode.',
        checking: 'Checking with your endpoint…',
    },
    subscription: {
        label: 'Claude subscription',
        sub: 'Pro / Max plan token from claude setup-token. Starts with sk-ant-oat01-',
        keyLabel: 'Setup token',
        placeholder: 'sk-ant-oat01-…',
        keyLink: { text: 'run claude setup-token on your machine', href: null },
        agentHelp: 'Subscription tokens run Claude Code only.',
        checking: 'Checking with Anthropic…',
    },
};

/** The cards this org is offered, in core's order: no subscription card unless the org may use one. */
export const providerChoices = (subscriptionAllowed: boolean): ModelProvider[] =>
    MODEL_PROVIDERS.filter((provider) => providerAvailable(provider, subscriptionAllowed));

const SUBSCRIPTION_PREFIX = 'sk-ant-oat';
const OPENAI_PREFIX = /^sk-(proj|svcacct|admin)-/;

/**
 * The provider a pasted key names by its prefix, else the current choice. A LiteLLM virtual key may look like an
 * OpenAI key, so that prefix moves nothing while LiteLLM is chosen; an org refused subscriptions never switches to one.
 */
export function detectProvider(key: string, current: ModelProvider, subscriptionAllowed: boolean): ModelProvider {
    if (key.startsWith(SUBSCRIPTION_PREFIX)) return subscriptionAllowed ? 'subscription' : current;
    if (key.startsWith('sk-ant-')) return 'anthropic';
    if (key.startsWith('sk-or-')) return 'openrouter';
    if (OPENAI_PREFIX.test(key) && current !== 'litellm') return 'openai';
    return current;
}

/** A key this org is refused before any check: a subscription token where subscriptions are not allowed. */
export const keyRefusal = (key: string, subscriptionAllowed: boolean): string | null =>
    !subscriptionAllowed && key.startsWith(SUBSCRIPTION_PREFIX)
        ? 'This is a Claude subscription token. This deployment accepts API keys only — create one at console.anthropic.com.'
        : null;

/** The agents a provider's key runs, the preselected one first. */
export const providerAgents = (provider: ModelProvider): readonly ExecutorType[] => PROVIDER_AGENTS[provider];

/** Why the agent is fixed, for a provider with one agent; null when the member chooses. */
export function agentLock(provider: ModelProvider): string | null {
    if (provider === 'openai') {
        return 'Claude Code needs Claude models — OpenAI keys run on OpenCode. Codex is not supported yet.';
    }
    if (provider === 'openai-compatible')
        return 'Claude Code needs Claude models — a custom endpoint runs on OpenCode.';
    if (provider === 'subscription') return 'A subscription token works with Claude Code only.';
    return null;
}

const ANTHROPIC_CLAUDE = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];
const OPENROUTER_CLAUDE = ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5'];

/** The suggestions offered before a check lists the key's own models; the first is preselected. */
const CURATED: Readonly<Record<ModelProvider, Readonly<Record<ExecutorType, readonly string[]>>>> = {
    anthropic: {
        [CLAUDE_CODE]: ANTHROPIC_CLAUDE,
        [OPENCODE]: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5'],
    },
    openrouter: {
        [CLAUDE_CODE]: OPENROUTER_CLAUDE,
        [OPENCODE]: [...OPENROUTER_CLAUDE, 'openai/gpt-5.1', 'google/gemini-3-pro', 'moonshotai/kimi-k2'],
    },
    openai: { [CLAUDE_CODE]: [], [OPENCODE]: ['openai/gpt-5.1', 'openai/gpt-5.1-codex', 'openai/gpt-5-mini'] },
    litellm: { [CLAUDE_CODE]: [], [OPENCODE]: [] },
    'openai-compatible': { [CLAUDE_CODE]: [], [OPENCODE]: [] },
    subscription: { [CLAUDE_CODE]: ['claude-sonnet-5-5', 'claude-opus-5-5'], [OPENCODE]: [] },
};

/**
 * The models offered for a source and agent: the ones the key check returned, else the curated list. Claude Code on
 * OpenRouter runs Anthropic models only, so the check's list is cut to those.
 */
export function modelOptions(source: ModelProvider, agent: ExecutorType, checked: readonly string[] | undefined) {
    const fromCheck = (checked ?? []).filter(
        (id) => source !== 'openrouter' || agent !== CLAUDE_CODE || id.startsWith('anthropic/')
    );
    return fromCheck.length > 0 ? fromCheck : [...CURATED[source][agent]];
}

/** What `POST /api/provider-connections/verify` answers (server/src/provider-keys/verify.ts), copied: web imports no server. */
export type VerifyAnswer =
    | { ok: true; models?: string[]; creditUsd?: number; budget?: { limitUsd: number; usedUsd: number } }
    | { ok: false; code: string; message: string };

/** The check line's state: idle (nothing to check), wait, ✓ ok, ▲ warn, ✕ bad, or error (the check could not run). */
export type CheckKind = 'idle' | 'wait' | 'ok' | 'warn' | 'bad' | 'error';

const usd = (value: number) => `$${value.toFixed(2)}`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The ✓ line's facts: the models, the credit and the budget the check returned. */
function okFacts(provider: ModelProvider, answer: Extract<VerifyAnswer, { ok: true }>): string[] {
    const facts: string[] = [];
    if (answer.models?.length) {
        facts.push(
            provider === 'litellm'
                ? `${plural(answer.models.length, 'model')} on this key`
                : `${plural(answer.models.length, 'model')} available`
        );
    }
    if (answer.creditUsd !== undefined) facts.push(`${usd(answer.creditUsd)} credit left`);
    if (answer.budget) facts.push(`budget ${usd(answer.budget.limitUsd)}, ${usd(answer.budget.usedUsd)} used`);
    return facts;
}

/** How the check's answer reads: ✓ with what it found, ▲ when the key works without credit, ✕ with the reason. */
export function checkLine(provider: ModelProvider, answer: VerifyAnswer): { kind: CheckKind; text: string } {
    if (!answer.ok) {
        return answer.code === ERROR_CODES.NO_CREDIT
            ? { kind: 'warn', text: `${answer.message} Tasks will fail until you top up.` }
            : { kind: 'bad', text: answer.message };
    }
    const lead =
        provider === 'litellm'
            ? 'Proxy answered'
            : provider === 'openai-compatible'
              ? 'Endpoint answered'
              : provider === 'subscription'
                ? 'Token works'
                : 'Key works';
    return { kind: 'ok', text: [lead, ...okFacts(provider, answer)].join(' · ') };
}

/** Why a key cannot be used yet, or null once it has passed its check (✓ or ▲). */
export function keyReason(key: string, check: CheckKind): string | null {
    if (!key.trim()) return 'Paste a key to continue.';
    const waiting: Partial<Record<CheckKind, string>> = {
        idle: 'Paste a key to continue.',
        wait: 'Checking the key…',
        bad: 'Fix the key to continue.',
        error: 'The key could not be checked. Try again.',
    };
    return waiting[check] ?? null;
}

/** Why the connection cannot be created yet, or null when it may: a base URL where one is required, a checked key, a name. */
export function connectionReason(input: {
    provider: ModelProvider;
    key: string;
    baseUrl: string;
    name: string;
    check: CheckKind;
}): string | null {
    if (providerRequiresBaseUrl(input.provider) && !input.baseUrl.trim()) {
        return input.provider === 'litellm'
            ? 'Enter the proxy URL to continue.'
            : 'Enter the endpoint URL to continue.';
    }
    return keyReason(input.key, input.check) ?? (input.name.trim() ? null : 'Give the connection a name.');
}
