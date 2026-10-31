import { isSendResult, type NotificationEvent, type SendResult } from '@factory-ai/core';

export type ConfigCheck<C> = { ok: true; config: C } | { ok: false; problems: string[] };

/**
 * One delivery channel. `kind` is the channel kind (`'fake'`, later a chat service), not a
 * `NotificationKind`. The config and the credential are separate arguments so neither rides the event; the
 * credential is the secret half (a webhook URL, a token), the config is non-secret and shown to every member.
 */
export interface NotificationConnector<C = unknown> {
    readonly kind: string;
    validateConfig(raw: unknown): ConfigCheck<C>;
    /** The credential's check and normalized form. A refusal's problems must never contain the input. */
    validateCredential(raw: unknown): ConfigCheck<string>;
    send(event: NotificationEvent, config: C, credential: string, signal: AbortSignal): Promise<SendResult>;
}

export type ConnectorRegistry = ReadonlyMap<string, NotificationConnector>;

/** A duplicate or empty kind is a programmer error at boot, so it throws. */
export function createConnectorRegistry(connectors: readonly NotificationConnector[]): ConnectorRegistry {
    const registry = new Map<string, NotificationConnector>();
    for (const connector of connectors) {
        if (connector.kind === '') throw new Error('notification connector kind must not be empty');
        if (registry.has(connector.kind)) throw new Error(`duplicate notification connector kind: ${connector.kind}`);
        registry.set(connector.kind, connector);
    }
    return registry;
}

const retryable = (reason: 'aborted' | 'unknown-kind' | 'connector-threw' | 'malformed-result'): SendResult => ({
    status: 'retryable',
    reason,
});

/**
 * The one seam the outbox calls. Never throws: a missing kind, a throwing or malformed connector and an
 * abort are retryable; only a refused config or credential or a well-formed connector verdict is permanent.
 * Delivery is at-least-once: `aborted` mid-send may already have been delivered. The caller's signal bounds the call
 * even for a connector that ignores it; the deadline itself belongs to the caller.
 */
export async function deliver(
    registry: ConnectorRegistry,
    target: { kind: string; config: unknown; credential: string },
    event: NotificationEvent,
    signal: AbortSignal
): Promise<SendResult> {
    const connector = registry.get(target.kind);
    if (!connector) return retryable('unknown-kind');
    let check: ConfigCheck<unknown>;
    try {
        check = connector.validateConfig(target.config);
    } catch {
        return retryable('connector-threw');
    }
    if (!check.ok) return { status: 'permanent', reason: 'config-invalid' };
    let credentialCheck: ConfigCheck<string>;
    try {
        credentialCheck = connector.validateCredential(target.credential);
    } catch {
        return retryable('connector-threw');
    }
    if (!credentialCheck.ok) return { status: 'permanent', reason: 'config-invalid' };
    if (signal.aborted) return retryable('aborted');

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<SendResult>((resolve) => {
        onAbort = () => resolve(retryable('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const sent = (async () => connector.send(event, check.config, credentialCheck.config, signal))().then(
            (value): SendResult => (isSendResult(value) ? value : retryable('malformed-result')),
            (): SendResult => retryable(signal.aborted ? 'aborted' : 'connector-threw')
        );
        return await Promise.race([sent, aborted]);
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
    }
}
