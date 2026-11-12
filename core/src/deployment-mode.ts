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
