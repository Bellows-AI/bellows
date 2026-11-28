import {
    CLAUDE_CODE,
    ENV_SUBSTITUTION,
    EXECUTOR_PROVIDER_AGENTS,
    EXECUTOR_PROVIDERS,
    type ExecutorProvider,
    type ExecutorType,
    ENV_NAME,
    guidedExecutorConfig,
    OPENAI_COMPATIBLE_NPM,
} from '@factory-ai/core';
import type { ProviderMeta } from '../providers/providers.js';
import { PROVIDER_META } from '../providers/providers.js';

/**
 * The guided provider step: the provider, its key and base URL, and the model the
 * generated configuration carries — the same shape onboarding's Connect a provider picks, saved into
 * the profile's configuration instead of the environment. The key is whatever the row holds or the
 * member typed, verbatim: a literal the save seals into the secret store, a `stored-credential:`
 * marker kept from the row, or the `{env:NAME}` reference the claim resolves from the member's
 * scopes.
 */
export type GuidedKey = { kind: 'none' } | { kind: 'key'; value: string } | { kind: 'reference'; name: string };

export interface GuidedChoice {
    provider: ExecutorProvider;
    key: GuidedKey;
    /** The provider's base URL, required for LiteLLM's proxy and the OpenAI-compatible endpoint. */
    baseUrl: string;
    /** The model id as the member typed it, without a provider prefix. */
    model: string;
}

/** The providers the guided step offers an agent, catalog order. */
export const guidedProvidersFor = (agent: ExecutorType): ExecutorProvider[] =>
    EXECUTOR_PROVIDERS.filter((provider) => EXECUTOR_PROVIDER_AGENTS[provider].includes(agent));

/**
 * The guided step's provider copy: the provider step's cards' own words for the four shared providers
 * (one source, no drift), plus the OpenAI-compatible endpoint the guided setup adds. The type is the
 * provider step's, so KeyField takes either catalog's entry.
 */
export const EXECUTOR_PROVIDER_META: Record<ExecutorProvider, ProviderMeta> = {
    ...PROVIDER_META,
    'openai-compatible': {
        label: 'OpenAI-compatible',
        sub: 'Your own endpoint that speaks the OpenAI wire format: vLLM, LiteLLM, Ollama, a gateway.',
        tag: 'custom endpoint',
        keyLabel: 'API key',
        placeholder: 'the endpoint’s own key',
        keyLink: { text: 'your endpoint’s admin UI', href: null },
        agentHelp: 'OpenAI-compatible endpoints run on OpenCode.',
        checking: 'Checking with your endpoint…',
    },
};

/** The key string a guided choice generates with: the reference spelled opencode's way, or the value. */
export const guidedKeyOf = (key: GuidedKey): string =>
    key.kind === 'reference' ? `{env:${key.name.trim()}}` : key.kind === 'key' ? key.value : '';

/** Whether a value is exactly the `{env:NAME}` reference the board resolves at claim. */
export const isEnvReference = (value: unknown): value is string =>
    typeof value === 'string' && ENV_SUBSTITUTION.test(value);

/** The Claude Code half of the detection: the key and base URL the settings env carries. */
function guidedFromClaudeConfig(config: Record<string, unknown>, model: string): GuidedChoice | null {
    const env = config.env;
    if (!isRecordValue(env)) return null;
    const names = Object.keys(env);
    // A base URL beside the Anthropic key is LiteLLM's proxy, as the guided flow picks it.
    const provider = names.includes('ANTHROPIC_API_KEY')
        ? names.includes('ANTHROPIC_BASE_URL')
            ? 'litellm'
            : 'anthropic'
        : names.includes('OPENROUTER_API_KEY')
          ? 'openrouter'
          : null;
    if (provider === null) return null;
    const keyName = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
    const base = provider === 'litellm' ? env.ANTHROPIC_BASE_URL : undefined;
    return {
        provider,
        key: keySetting(env[keyName]),
        baseUrl: typeof base === 'string' ? base : '',
        model: stripModelPrefix(provider, model),
    };
}

/** The OpenCode half: the one provider block's id, its npm and its options name the pick. */
function guidedFromOpencodeConfig(config: Record<string, unknown>, model: string): GuidedChoice | null {
    const provider = config.provider;
    if (!isRecordValue(provider)) return null;
    const entries = Object.entries(provider);
    if (entries.length !== 1) return null;
    const [id, block] = entries[0]!;
    if (!isRecordValue(block) || !isRecordValue(block.options)) return null;
    const options = block.options;
    const baseUrl = typeof options.baseURL === 'string' ? options.baseURL : '';
    if (typeof options.apiKey !== 'string') return null;
    if (block.npm === OPENAI_COMPATIBLE_NPM) {
        return {
            provider: 'openai-compatible',
            key: keySetting(options.apiKey),
            baseUrl,
            model: model.startsWith(`${id}/`) ? model.slice(id.length + 1) : model,
        };
    }
    const known = id === 'anthropic' || id === 'openrouter' || id === 'openai' ? id : null;
    if (known === null) return null;
    // A block under the Anthropic id with a base URL is LiteLLM's proxy; a plain Anthropic block is not.
    const providerId = known === 'anthropic' && baseUrl !== '' ? 'litellm' : known;
    return {
        provider: providerId,
        key: keySetting(options.apiKey),
        baseUrl,
        model: stripModelPrefix(providerId, model),
    };
}

/** The guided choice a configuration was generated from, or null when it is not one. */
export function guidedFromConfig(type: ExecutorType, config: Record<string, unknown>): GuidedChoice | null {
    if (typeof config.model !== 'string') return null;
    return type === CLAUDE_CODE
        ? guidedFromClaudeConfig(config, config.model)
        : guidedFromOpencodeConfig(config, config.model);
}

/** The key setting a stored value reads as: a reference, or the value itself (a marker or a draft literal). */
const keySetting = (value: unknown): GuidedKey => {
    if (typeof value !== 'string' || value === '') return { kind: 'none' };
    if (isEnvReference(value)) return { kind: 'reference', name: value.slice('{env:'.length, -1) };
    return { kind: 'key', value };
};

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** The model id the member typed, once the generated prefix is off. LiteLLM's OpenCode id reads `anthropic/`. */
function stripModelPrefix(provider: ExecutorProvider, model: string): string {
    const prefix = provider === 'litellm' ? 'anthropic/' : `${provider}/`;
    return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

/** The configuration a guided choice generates: the guided fields own the whole configuration. */
export function applyGuidedChoice(type: ExecutorType, choice: GuidedChoice): Record<string, unknown> {
    return guidedExecutorConfig({
        provider: choice.provider,
        agent: type,
        model: choice.model,
        key: guidedKeyOf(choice.key),
        baseUrl: choice.baseUrl,
    });
}

/** The guided fields' own error, beside the field it belongs to; null when the choice may save. */
export function guidedChoiceError(choice: GuidedChoice): string | null {
    if (!choice.model.trim()) return 'Enter a model identifier to continue.';
    if (choice.provider === 'openai-compatible') {
        if (!choice.baseUrl.trim()) return 'Enter the endpoint base URL to continue.';
        if (choice.key.kind === 'none') return 'Paste a key or name a secret to continue.';
        if (choice.key.kind === 'reference' && !ENV_NAME.test(choice.key.name.trim())) {
            return 'Enter the name of the secret to use.';
        }
    }
    if (choice.provider === 'litellm' && !choice.baseUrl.trim()) return 'Enter the proxy URL to continue.';
    return null;
}

/**
 * The guided step's copy, beside the provider catalog it names: the dialog and the e2e specs assert
 * the same strings (workspace/executors.ts's contract, applied to this step).
 */
export const GUIDED_COPY = {
    /** The collapsed entry a guided pick starts from. */
    PROVIDER_STEP_LABEL: 'Connect a provider',
    PROVIDER_STEP_HELP:
        'Pick a provider to give this executor its own key, endpoint and model — the same guided setup Connect a provider runs. The configuration below is replaced by what you pick; without a provider the key connected in Settings → Model runs the task.',
    REMOVE_PROVIDER_LABEL: 'Remove provider settings',
    KEY_SOURCE_LABEL: 'Key',
    KEY_PASTE_LABEL: 'Paste a key',
    KEY_REFERENCE_LABEL: 'Use a secret by name',
    KEY_REFERENCE_HELP:
        'The name of a variable under Settings → Environment — organization, workspace, or repository scope. Bellows writes its value into the configuration when a task starts, so rotating the secret needs no edit here.',
    KEY_KEEP_NOTE:
        'A saved key shows as stored-credential:… — leave it as it is to keep the key, or paste a new one to replace it.',
    KEY_CONNECTED_NOTE: 'Leave empty to run on the key connected in Settings → Model.',
    NO_CHECK_NOTE: 'The endpoint is not checked here; a task on this executor reaches it when one starts.',
};
