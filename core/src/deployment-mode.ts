import { CLAUDE_CODE } from './executors.js';

/**
 * Where this board runs (`DEPLOYMENT_MODE`): a self-hosted installation, or Bellows Cloud. Set by
 * the operator in the server environment only; no client can name it.
 */
export const SELF_HOSTED = 'self-hosted';
export const CLOUD = 'cloud';
export const DEPLOYMENT_MODES = [SELF_HOSTED, CLOUD] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

/** A Claude subscription OAuth token: a Claude.ai credential Bellows Cloud never collects. */
export const CLAUDE_CODE_OAUTH_TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';

/** The one refusal every cloud entry point answers — names only, never a value. */
export const CLOUD_CREDENTIAL_MESSAGE =
    'CLAUDE_CODE_OAUTH_TOKEN cannot be configured in Bellows Cloud. Use a customer-owned API key (ANTHROPIC_API_KEY) instead.';

function keyAtAnyDepth(value: unknown, key: string): boolean {
    if (Array.isArray(value)) return value.some((item) => keyAtAnyDepth(item, key));
    if (typeof value !== 'object' || value === null) return false;
    return Object.entries(value).some(([name, inner]) => name === key || keyAtAnyDepth(inner, key));
}

/**
 * The credential cloud mode refuses, if `env` names it or `config` carries it as a key at any depth;
 * null otherwise. One predicate for every entry point: the executor and env routes, and the claim.
 */
export function forbiddenCredentialIn(env: Record<string, string> | undefined, config?: unknown): string | null {
    if (env !== undefined && Object.hasOwn(env, CLAUDE_CODE_OAUTH_TOKEN)) return CLAUDE_CODE_OAUTH_TOKEN;
    return keyAtAnyDepth(config, CLAUDE_CODE_OAUTH_TOKEN) ? CLAUDE_CODE_OAUTH_TOKEN : null;
}

/**
 * A credential-shaped key in executor settings: a provider key or token in env spelling
 * (`ANTHROPIC_API_KEY`) or JSON spelling (opencode's `apiKey`). Its string value lives in the secret
 * store; the settings row keeps a reference (docs/workspace.md).
 */
const CREDENTIAL_KEY = /(?:api_?key|auth_?token|access_?token|secret_?access_?key|password)$/i;

export function isCredentialKey(key: string): boolean {
    return CREDENTIAL_KEY.test(key);
}

/**
 * What a stored credential reads as wherever its value used to be: this prefix and the opaque
 * reference. Sent back unchanged on a save, it keeps the stored value.
 */
export const STORED_CREDENTIAL_PREFIX = 'stored-credential:';

/**
 * Each env name that redirects where a provider credential is sent, mapped to the member keys any one
 * of which replaces the platform's own (the driver's passthrough; a claim's name wins over it).
 */
export const CREDENTIAL_REDIRECTS: Readonly<Record<string, readonly string[]>> = {
    ANTHROPIC_BASE_URL: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    OPENAI_BASE_URL: ['OPENAI_API_KEY'],
};

/** opencode's per-provider redirect, answered only by a literal `apiKey` beside it. */
const PROVIDER_BASE_URL = 'baseURL';
const PROVIDER_API_KEY = 'apiKey';
/** opencode substitutes these from the runner's env or files, which hold the platform credential. */
const SUBSTITUTION = /\{(?:env|file):/;

const REDIRECT_PHRASE = 'would send the deployment model credential to another host';

/** The refusal for a redirect with no member key: names keys only, never a value. */
export function credentialRedirectMessage(key: string): string {
    const memberKeys = CREDENTIAL_REDIRECTS[key] ?? [PROVIDER_API_KEY];
    return `${key} ${REDIRECT_PHRASE}: set your own ${memberKeys.join(' or ')} with it, or remove it.`;
}

export function isCredentialRedirectMessage(message: string): boolean {
    return message.includes(REDIRECT_PHRASE);
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first object at any depth whose `baseURL` has no literal `apiKey` beside it. */
function providerRedirectIn(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(providerRedirectIn);
    if (!isObject(value)) return false;
    const key = value[PROVIDER_API_KEY];
    if (nonEmpty(value[PROVIDER_BASE_URL]) && !(nonEmpty(key) && !SUBSTITUTION.test(key))) return true;
    return Object.values(value).some(providerRedirectIn);
}

/**
 * The platform keys a claim must carry EMPTY: for each redirect set in the effective env, its first
 * member key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) when the member did not set it. The driver forwards
 * its own key under that name unless the claim names it, and the claim's name wins even when empty, so
 * the deployment's key never follows a member's redirect — answered by another member key or, on a
 * self-hosted board, by none.
 */
export function platformCredentialBlanks(env: Readonly<Record<string, unknown>>): Record<string, string> {
    const blanks: Record<string, string> = {};
    for (const [redirect, [platformKey]] of Object.entries(CREDENTIAL_REDIRECTS)) {
        if (platformKey !== undefined && nonEmpty(env[redirect]) && !nonEmpty(env[platformKey])) {
            blanks[platformKey] = '';
        }
    }
    return blanks;
}

/**
 * The redirect key that would send the platform credential to another host, or null. Decided on the
 * EFFECTIVE env — member env with a claude-code config's `env` applied last, as the claim merges them
 * — so a key saved in one place and its redirect in another are judged together. One predicate for the
 * executor and env routes and the claim.
 */
export function redirectsPlatformCredential(
    env: Record<string, string> | undefined,
    config?: unknown,
    type?: string
): string | null {
    const configEnv = type === CLAUDE_CODE && isObject(config) && isObject(config.env) ? config.env : {};
    const effective: Record<string, unknown> = { ...env, ...configEnv };
    for (const [redirect, memberKeys] of Object.entries(CREDENTIAL_REDIRECTS)) {
        if (nonEmpty(effective[redirect]) && !memberKeys.some((key) => nonEmpty(effective[key]))) return redirect;
    }
    return providerRedirectIn(config) ? PROVIDER_BASE_URL : null;
}
