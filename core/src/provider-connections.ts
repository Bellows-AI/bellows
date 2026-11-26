import type { ExecutorType } from './executors.js';
import { type ModelProvider, modelFitsProvider, providerSupportsAgent } from './model-providers.js';

/**
 * Provider connections (docs/api.md): a model-provider credential as a first-class, named row an
 * executor profile can reference. This file is the shared contract — safe metadata, the per-scope
 * cap and the discovery answer — that the routes, the store and the later slices read.
 */

/** Whose rows a list answers: the organization's (`org`) or the member's own (`personal`). */
export type ProviderConnectionScope = 'org' | 'personal';

/**
 * Safe metadata: never a credential and never a secret reference. The base URL is a plain column
 * (the same rule as the env base URL today), so it travels; the key never does.
 */
export interface ProviderConnectionMeta {
    readonly id: string;
    readonly name: string;
    readonly provider: ModelProvider;
    readonly scope: ProviderConnectionScope;
    /** The plain endpoint the connection reaches, or null when the provider needs none. */
    readonly baseUrl: string | null;
    /** Whether a key is sealed for the connection; the key itself never travels. */
    readonly hasKey: boolean;
}

/** A bound on one scope's list (a ceiling, not a policy), enforced by the store under the write. */
export const MAX_PROVIDER_CONNECTIONS_PER_SCOPE = 20;

/**
 * What model discovery on a stored connection answers: a provider catalog (`listed`, possibly
 * empty), a provider with no catalog to list (`unsupported`, carrying the credit read OpenRouter's
 * verification yields), or a failed check (`failed` — an upstream or credential outcome, never an
 * authoritative empty list; a board-side outage is a thrown 503, not a state).
 */
export type ProviderConnectionModels =
    | { readonly state: 'listed'; readonly models: readonly string[] }
    | {
          readonly state: 'unsupported';
          readonly creditUsd?: number;
          readonly budget?: { readonly limitUsd: number; readonly usedUsd: number };
      }
    | { readonly state: 'failed'; readonly code: string; readonly message: string };

/** Why a selection of a connection by an executor is refused. */
export type ConnectionRefusalReason = 'missing' | 'scope' | 'incompatible' | 'model';

export interface ConnectionSelectionRefusal {
    readonly reason: ConnectionRefusalReason;
    readonly message: string;
}

/** The connection a selection names, as the shared rules read it: provider, scope and the personal owner. */
export interface SelectedConnection {
    readonly provider: ModelProvider;
    readonly scope: ProviderConnectionScope;
    readonly ownerId: string | null;
}

/**
 * The one rule save, preflight and claim share (docs/workspace.md): whether an executor may use a connection. `owner` is the
 * profile's owner — a member's id, or null for an organization profile. An organization profile uses organization
 * connections only; a personal one its owner's own or the organization's; another member's row is not visible at all,
 * so it reads as missing. Visibility alone is not enough: the provider must run the executor's type.
 */
export function connectionSelectionRefusal(input: {
    connection: SelectedConnection | null;
    owner: string | null;
    agentType: ExecutorType;
}): ConnectionSelectionRefusal | null {
    const { connection, owner, agentType } = input;
    if (connection === null || (connection.scope === 'personal' && owner !== null && connection.ownerId !== owner)) {
        return { reason: 'missing', message: 'The provider connection does not exist or is not available to you.' };
    }
    if (connection.scope === 'personal' && owner === null) {
        return {
            reason: 'scope',
            message: 'An organization executor can only use an organization provider connection.',
        };
    }
    if (!providerSupportsAgent(connection.provider, agentType)) {
        return {
            reason: 'incompatible',
            message: `A ${connection.provider} connection cannot run a ${agentType} executor.`,
        };
    }
    return null;
}

/**
 * The model transition rule: a model the board knows belongs to another provider is refused when the connection
 * changes, leaving the member to reselect. Local prefix knowledge only — a discovery failure never invalidates one.
 */
export function connectionModelRefusal(
    provider: ModelProvider,
    agentType: ExecutorType,
    model: unknown
): ConnectionSelectionRefusal | null {
    if (typeof model !== 'string' || model === '' || modelFitsProvider(provider, agentType, model)) return null;
    return {
        reason: 'model',
        message: `The model "${model}" does not belong to a ${provider} connection; choose a model for it.`,
    };
}
