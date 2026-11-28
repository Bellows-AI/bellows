import {
    CLAUDE_CODE,
    CLAUDE_CODE_OAUTH_TOKEN,
    ENV_SUBSTITUTION,
    type ExecutorType,
    isCredentialKey,
    isModelProvider,
    modelFitsProvider,
    type ModelProvider,
    normalizeModelId,
    OPENAI_COMPATIBLE_NPM,
    OPENCODE,
    PROVIDER_BASE_URL_ENV,
    PROVIDER_ENV,
    providerSupportsAgent,
    STORED_CREDENTIAL_PREFIX,
} from '@factory-ai/core';
import { credentialsIn, type StoredCredential } from './executor-credentials.js';

/**
 * The pure half of the executor provider migration (executor-provider-migration.ts): what a legacy executor becomes,
 * judged from its config and the NAMES of its scope's variables. No secret is read and nothing is written here.
 */

/** What a connection made here is named, before the dedup suffix. */
export const PROVIDER_NAME: Readonly<Record<ModelProvider, string>> = {
    anthropic: 'Anthropic',
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    litellm: 'LiteLLM',
    'openai-compatible': 'Custom endpoint',
    subscription: 'Claude subscription',
};

/** The key each provider's variable name stands for in a Claude Code `env`; LiteLLM is Anthropic's name with a host. */
const PROVIDER_OF_ENV_NAME: Readonly<Record<string, ModelProvider>> = {
    ANTHROPIC_API_KEY: 'anthropic',
    OPENROUTER_API_KEY: 'openrouter',
    OPENAI_API_KEY: 'openai',
    [CLAUDE_CODE_OAUTH_TOKEN]: 'subscription',
};

/** The OpenCode block ids whose provider is the id itself. */
const PROVIDER_OF_BLOCK_ID: Readonly<Record<string, ModelProvider>> = {
    anthropic: 'anthropic',
    openrouter: 'openrouter',
    openai: 'openai',
};

/** The providers a scope's variable names can point to; LiteLLM and the custom endpoint carry a host a name cannot. */
const SCOPE_PROVIDERS: readonly ModelProvider[] = ['anthropic', 'openrouter', 'openai', 'subscription'];

export interface LegacyRow {
    id: string;
    user_id: string | null;
    name: string;
    type: ExecutorType;
    config: unknown;
    secret_refs: StoredCredential[];
    created_by: string | null;
}

export interface EnvRow {
    user_id: string | null;
    name: string;
    value: string | null;
    is_secret: boolean;
    secret_ref: string | null;
    secret_version: string | null;
}

/** An answer that is not a confirmed value: the caller leaves the row alone. */
export class InconclusiveRead extends Error {}

/** Where a key comes from: a stored credential at a path, an environment variable, or a literal in the config. */
export type KeySource =
    | { kind: 'stored'; path: string[] }
    | { kind: 'variable'; name: string }
    | { kind: 'literal'; value: string };

export type Plan =
    | { kind: 'suspend'; reason: string }
    | {
          kind: 'convert';
          provider: ModelProvider;
          baseUrl: string | null;
          source: KeySource;
          /** The config the executor keeps. */
          config: Record<string, unknown>;
          /** The config paths whose stored credential the step consumed. */
          consumed: string[][];
      };

const suspend = (reason: string): Plan => ({ kind: 'suspend', reason });
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
export const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';
export const samePath = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);

/** The source of a key value found in a config at `path`. */
function sourceOf(value: string, path: string[]): KeySource {
    const reference = ENV_SUBSTITUTION.exec(value);
    if (reference) return { kind: 'variable', name: reference[1]! };
    if (value.startsWith(STORED_CREDENTIAL_PREFIX)) return { kind: 'stored', path };
    return { kind: 'literal', value };
}

/** One key the config wires: its provider, where it comes from and the config paths that carry it. */
interface Wiring {
    provider: ModelProvider;
    source: KeySource;
    baseUrl: string | null;
    /** The key's own path, then the endpoint's when the config carries one. */
    paths: string[][];
}

type Wirings = { wirings: Wiring[] } | { refusal: string };

/** A Claude Code `env`: every credential-shaped entry is a key the step must understand. */
function claudeWirings(env: Record<string, unknown>): Wirings {
    const wirings: Wiring[] = [];
    for (const [name, value] of Object.entries(env)) {
        if (!isCredentialKey(name) || !nonEmpty(value)) continue;
        const provider = PROVIDER_OF_ENV_NAME[name];
        if (!provider) return { refusal: `the config holds a key ${name} that no provider connection can take` };
        const host = env.ANTHROPIC_BASE_URL;
        const proxied = provider === 'anthropic' && nonEmpty(host);
        wirings.push({
            provider: proxied ? 'litellm' : provider,
            source: sourceOf(value, ['env', name]),
            baseUrl: proxied ? host : null,
            paths: proxied
                ? [
                      ['env', name],
                      ['env', 'ANTHROPIC_BASE_URL'],
                  ]
                : [['env', name]],
        });
    }
    return { wirings };
}

/** The provider an OpenCode block stands for, or the refusal: an endpoint block needs its baseURL. */
function blockProvider(id: string, block: Record<string, unknown>, host: string | null): ModelProvider | string {
    if (block.npm !== OPENAI_COMPATIBLE_NPM) {
        return PROVIDER_OF_BLOCK_ID[id] ?? `the provider block ${id} names no provider a connection can take`;
    }
    return host === null ? `the endpoint block ${id} names no baseURL` : 'openai-compatible';
}

/** An OpenCode `provider` map: each block with an `options.apiKey` is a key. */
function openCodeWirings(providers: Record<string, unknown>): Wirings {
    const wirings: Wiring[] = [];
    for (const [id, block] of Object.entries(providers)) {
        const options = isRecord(block) ? block.options : undefined;
        if (!isRecord(block) || !isRecord(options) || !nonEmpty(options.apiKey)) continue;
        const keyPath = ['provider', id, 'options', 'apiKey'];
        const host = nonEmpty(options.baseURL) ? options.baseURL : null;
        const provider = blockProvider(id, block, host);
        if (!isModelProvider(provider)) return { refusal: provider };
        wirings.push({
            provider,
            source: sourceOf(options.apiKey, keyPath),
            baseUrl: host,
            paths: host === null ? [keyPath] : [keyPath, ['provider', id, 'options', 'baseURL']],
        });
    }
    return { wirings };
}

/** `config` without the values at `paths`, and without the objects that leave empty. */
function without(config: Record<string, unknown>, paths: readonly string[][]) {
    const out = structuredClone(config);
    for (const path of paths) {
        const trail: Record<string, unknown>[] = [out];
        for (const key of path.slice(0, -1)) {
            const next = trail[trail.length - 1]![key];
            if (!isRecord(next)) break;
            trail.push(next);
        }
        delete trail[trail.length - 1]![path[path.length - 1]!];
        for (let depth = trail.length - 1; depth > 0 && Object.keys(trail[depth]!).length === 0; depth -= 1) {
            delete trail[depth - 1]![path[depth - 1]!];
        }
    }
    if (isRecord(out.provider) && Object.keys(out.provider).length === 0) delete out.provider;
    return out;
}

/** The variables of one scope the step reads: the names present, in the order the claim stacks them. */
export interface ScopeVars {
    /** Stacked scopes, nearest first: a personal executor's own variables, then the organization's. */
    layers: {
        kind: 'workspace' | 'org';
        userId: string | null;
        rows: Map<string, EnvRow>;
        /** Plain variables set to the empty string: absent as a key, an explicit "default endpoint" as an endpoint. */
        blanks: Set<string>;
    }[];
}

export const varsFor = (all: readonly EnvRow[], owner: string | null): ScopeVars => {
    const layer = (kind: 'workspace' | 'org', userId: string | null) => ({
        kind,
        userId,
        rows: new Map(
            all
                .filter((row) => row.user_id === userId && (row.is_secret || nonEmpty(row.value)))
                .map((row) => [row.name, row])
        ),
        blanks: new Set(
            all.filter((row) => row.user_id === userId && !row.is_secret && row.value === '').map((row) => row.name)
        ),
    });
    return { layers: owner === null ? [layer('org', null)] : [layer('workspace', owner), layer('org', null)] };
};

/** Whether the scope sets the plain variable to the empty string, and nothing nearer sets it. */
export const isBlankVar = (vars: ScopeVars, name: string): boolean =>
    !findVar(vars, name) && vars.layers.some((layer) => layer.blanks.has(name));

export const findVar = (vars: ScopeVars, name: string) => {
    for (const layer of vars.layers) {
        const row = layer.rows.get(name);
        if (row) return { layer, row };
    }
};

const scopeName = (owner: string | null) => (owner === null ? 'the organization' : 'the member');

/** The provider a model id's prefix names for OpenCode, when it names one. */
const providerOfModel = (type: ExecutorType, model: unknown): ModelProvider | undefined => {
    if (type !== OPENCODE || !nonEmpty(model) || !model.includes('/')) return undefined;
    return PROVIDER_OF_BLOCK_ID[model.slice(0, model.indexOf('/'))];
};

type Converted = Extract<Plan, { kind: 'convert' }>;

/** Why `provider` cannot run this executor, or null. */
function providerRefusal(row: LegacyRow, provider: ModelProvider): string | null {
    const model = (row.config as Record<string, unknown>).model;
    if (!providerSupportsAgent(provider, row.type))
        return `${PROVIDER_NAME[provider]} cannot run a ${row.type} executor`;
    if (!modelFitsProvider(provider, row.type, nonEmpty(model) ? model : '')) {
        return `the model ${String(model)} does not belong to ${PROVIDER_NAME[provider]}`;
    }
    return null;
}

/** The wirings the config carries, or the refusal: stray keys and several keys are not guessed between. */
function configWirings(row: LegacyRow, config: Record<string, unknown>): { wiring?: Wiring } | { refusal: string } {
    let found: Wirings = { wirings: [] };
    if (row.type === CLAUDE_CODE && isRecord(config.env)) found = claudeWirings(config.env);
    if (row.type !== CLAUDE_CODE && isRecord(config.provider)) found = openCodeWirings(config.provider);
    if ('refusal' in found) return found;
    const stray = credentialsIn(config).find(
        ({ path }) => !found.wirings.some((w) => w.paths.some((p) => samePath(p, path)))
    );
    if (stray) return { refusal: `the config holds a key at ${stray.path.join('.')} that no provider takes` };
    if (found.wirings.length > 1) return { refusal: 'the config wires several provider keys; choose one connection' };
    return found.wirings[0] ? { wiring: found.wirings[0] } : {};
}

/**
 * The conversion a config's own wiring decides: only its key and endpoint leave the config. A custom endpoint's
 * model id moves to the `custom` prefix the connection's generated block declares; the rest of the block stays.
 */
function convertWiring(row: LegacyRow, config: Record<string, unknown>, wiring: Wiring): Converted {
    const { provider, baseUrl, source } = wiring;
    const kept = without(config, wiring.paths);
    const model = config.model;
    if (provider === 'openai-compatible' && nonEmpty(model)) {
        const blockId = wiring.paths[0]![1]!;
        kept.model = normalizeModelId(
            provider,
            row.type,
            model.startsWith(`${blockId}/`) ? model.slice(blockId.length + 1) : model
        );
    }
    return {
        kind: 'convert',
        provider,
        baseUrl,
        source,
        config: kept,
        consumed: source.kind === 'stored' ? [source.path] : [],
    };
}

/** The conversion the model's provider prefix or the scope's provider names decide; several candidates or none suspend. */
function convertFromScope(row: LegacyRow, config: Record<string, unknown>, vars: ScopeVars): Plan {
    const named = providerOfModel(row.type, config.model);
    const candidates = named
        ? [named]
        : SCOPE_PROVIDERS.filter((p) => findVar(vars, PROVIDER_ENV[p]) && !providerRefusal(row, p));
    if (candidates.length === 0) {
        const names = SCOPE_PROVIDERS.map((p) => PROVIDER_ENV[p]).join(', ');
        return suspend(`${scopeName(row.user_id)} scope holds no provider key (${names}) this executor can use`);
    }
    if (candidates.length > 1) {
        const names = candidates.map((p) => PROVIDER_ENV[p]).join(', ');
        return suspend(`the scope holds keys for several providers (${names}); choose a connection`);
    }
    const only = candidates[0]!;
    const hostName = PROVIDER_BASE_URL_ENV[only];
    const hostVar = hostName === null ? undefined : findVar(vars, hostName);
    const baseUrl = hostVar ? (hostVar.row.is_secret ? `{env:${hostName}}` : hostVar.row.value) : null;
    const provider = only === 'anthropic' && nonEmpty(baseUrl) ? 'litellm' : only;
    return {
        kind: 'convert',
        provider,
        baseUrl,
        source: { kind: 'variable', name: PROVIDER_ENV[only] },
        config,
        consumed: [],
    };
}

/**
 * What the executor becomes, judged from its config alone and its scope's variable NAMES (no secret is read here):
 * the config's own wiring first, then the model's provider prefix, then the scope's provider names. Several
 * candidates or none is a confirmed ambiguity, suspended with its reason, never `inferProvider`'s fixed priority.
 */
export function planExecutor(row: LegacyRow, all: readonly EnvRow[]): Plan {
    if (!isRecord(row.config)) return suspend('the executor config is not a JSON object');
    const found = configWirings(row, row.config);
    if ('refusal' in found) return suspend(found.refusal);
    const plan = found.wiring
        ? convertWiring(row, row.config, found.wiring)
        : convertFromScope(row, row.config, varsFor(all, row.user_id));
    if (plan.kind === 'suspend') return plan;
    const refusal = providerRefusal(row, plan.provider);
    return refusal ? suspend(refusal) : plan;
}
