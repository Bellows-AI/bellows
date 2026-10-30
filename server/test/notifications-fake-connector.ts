import type { NotificationEvent } from '@factory-ai/core';
import type { NotificationConnector } from '../src/notifications/connector.js';

export interface FakeConfig {
    target: string;
}

export type FakeScript = (event: NotificationEvent, config: FakeConfig, signal: AbortSignal) => Promise<unknown>;

/** A connector of channel `kind` that records every send and answers from `script`. */
export function fakeConnector(
    kind: string,
    script?: FakeScript
): NotificationConnector<FakeConfig> & { sent: Array<{ event: NotificationEvent; config: FakeConfig }> } {
    const sent: Array<{ event: NotificationEvent; config: FakeConfig }> = [];
    return {
        kind,
        sent,
        validateConfig(raw) {
            const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
            const keys = Object.keys(o);
            if (keys.length === 1 && typeof o.target === 'string' && o.target !== '') {
                return { ok: true, config: { target: o.target } };
            }
            return { ok: false, problems: ['target must be a non-empty string'] };
        },
        async send(event, config, signal) {
            sent.push({ event, config });
            if (script) return (await script(event, config, signal)) as never;
            return { status: 'delivered', externalId: `${kind}-${event.id}` };
        },
    };
}
