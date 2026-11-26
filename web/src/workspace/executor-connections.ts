import {
    connectionModelRefusal,
    connectionSelectionRefusal,
    ENV_SUBSTITUTION,
    type ExecutorScope,
    type ExecutorType,
    isCredentialKey,
    ORG_SCOPE,
    type ProviderConnectionMeta,
    STORED_CREDENTIAL_PREFIX,
} from '@factory-ai/core';

/**
 * The executor editor's connection rules, pure (docs/workspace.md): which connections an executor may select, the
 * precedence of its own configuration over one, and when a model must be chosen again. The selection rules are core's
 * shared `connectionSelectionRefusal` and `connectionModelRefusal` — the server runs the same ones, so nothing here
 * decides what is allowed; it only lets the dialog say so before Save.
 */

/** Where the pasted configuration names an endpoint: a base URL at any depth. */
const ENDPOINT_KEY = /base_?url$/i;

/**
 * Whether a configuration carries its own credential, `{env:NAME}` reference or endpoint — what the claim keeps above a
 * selected connection's (docs/workspace.md). Judged from the keys and the shape of the values, and the answer is a
 * boolean: the notice built on it never repeats a value.
 */
export function configOverridesConnection(config: unknown): boolean {
    if (Array.isArray(config)) return config.some(configOverridesConnection);
    if (typeof config !== 'object' || config === null) return false;
    return Object.entries(config).some(([key, value]) => {
        if (typeof value === 'string') {
            if (value === '') return false;
            return (
                ENV_SUBSTITUTION.test(value) ||
                value.startsWith(STORED_CREDENTIAL_PREFIX) ||
                isCredentialKey(key) ||
                ENDPOINT_KEY.test(key)
            );
        }
        return configOverridesConnection(value);
    });
}

/** The connections a dialog may offer, with the scope the executor belongs to (an organization profile uses the organization's alone). */
export interface ConnectionChoices {
    connections: readonly ProviderConnectionMeta[];
    scope: ExecutorScope;
}

/** The stand-in owner the shared selection rule compares the member's own connections against. */
const SELF = 'self';

/** Why the shared selection rule refuses `connection` for an executor of this scope and agent, or null when it is offered. */
export function connectionRefusal(
    connection: ProviderConnectionMeta,
    scope: ExecutorScope,
    agent: ExecutorType
): string | null {
    return (
        connectionSelectionRefusal({
            connection: {
                provider: connection.provider,
                scope: connection.scope,
                ownerId: connection.scope === 'personal' ? SELF : null,
            },
            owner: scope === ORG_SCOPE ? null : SELF,
            agentType: agent,
        })?.message ?? null
    );
}

/** The connections the select offers for this agent, and the ones it leaves out with the shared rule's reason. */
export function connectionOptions(
    choices: ConnectionChoices,
    agent: ExecutorType
): { offered: ProviderConnectionMeta[]; unavailable: { connection: ProviderConnectionMeta; reason: string }[] } {
    const offered: ProviderConnectionMeta[] = [];
    const unavailable: { connection: ProviderConnectionMeta; reason: string }[] = [];
    for (const connection of choices.connections) {
        const reason = connectionRefusal(connection, choices.scope, agent);
        if (reason === null) offered.push(connection);
        else unavailable.push({ connection, reason });
    }
    return { offered, unavailable };
}

/** The selected connection's own rule beside the select: it must still be one this agent and scope may use. */
export function selectedConnectionError(
    draft: { providerConnectionId: string; type: ExecutorType },
    choices: ConnectionChoices
): string | null {
    if (draft.providerConnectionId === '') return null;
    const connection = choices.connections.find((row) => row.id === draft.providerConnectionId);
    // A selection the visible list does not hold (removed, or not visible to this member) is the server's to judge.
    if (connection === undefined) return null;
    return connectionRefusal(connection, choices.scope, draft.type);
}

/**
 * The model transition rule (the shared `connectionModelRefusal`): a model the board knows belongs to another provider
 * is dropped when the connection or the agent changes, leaving the member to reselect. Local knowledge only — a failed
 * listing never invalidates a model.
 */
export function modelNeedsReselection(
    connection: ProviderConnectionMeta | undefined,
    agent: ExecutorType,
    config: Record<string, unknown>
): string | null {
    if (connection === undefined) return null;
    const { model } = config;
    if (typeof model !== 'string' || model === '') return null;
    return connectionModelRefusal(connection.provider, agent, model) === null ? null : model;
}
