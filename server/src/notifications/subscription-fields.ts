import { ERROR_CODES, NOTIFICATION_KINDS, type NotificationKind } from '@factory-ai/core';
import { repoReason } from '../routes/helpers.js';
import type { ConnectorRegistry, NotificationConnector } from './connector.js';
import type { SubscriptionFields } from './subscription-store.js';

type Refusal = { ok: false; code: string; message: string; problems?: string[] };

export type ParsedSubscription = { ok: true; fields: SubscriptionFields } | Refusal;

const KEYS = new Set(['connectorKind', 'connectorConfig', 'eventKinds', 'repos', 'workflows', 'enabled']);

const refuse = (message: string, code: string = ERROR_CODES.BAD_BODY): Refusal => ({
    ok: false,
    code,
    message,
});

/** An array of distinct strings that each pass `reason`, or the message that refuses it. */
function stringList(
    name: string,
    value: unknown,
    reason: (item: string) => string | null
): { ok: true; value: string[] } | { ok: false; message: string } {
    if (!Array.isArray(value)) return { ok: false, message: `${name} must be an array` };
    for (const item of value) {
        if (typeof item !== 'string') return { ok: false, message: `${name} must hold strings` };
        const why = reason(item);
        if (why) return { ok: false, message: `${name}: "${item}": ${why}` };
    }
    return { ok: true, value: [...new Set(value as string[])] };
}

const isNotificationKind = (value: string): value is NotificationKind =>
    (NOTIFICATION_KINDS as readonly string[]).includes(value);

/** A well-formed `{ ok: false, problems: string[] }` answer's problems, else undefined. */
function problemsOf(check: Record<string, unknown>): string[] | undefined {
    const { problems } = check;
    return Array.isArray(problems) && problems.every((p) => typeof p === 'string') ? (problems as string[]) : undefined;
}

/**
 * The connector's verdict on a config, or the refusal. A throw or an answer that is not exactly
 * `{ ok: true, config }` / `{ ok: false, ... }` refuses the write; `problems` only when well-formed.
 */
function checkConfig(connector: NotificationConnector, raw: unknown): { ok: true; config: unknown } | Refusal {
    const unchecked = () => refuse('the connector could not check the config', ERROR_CODES.BAD_CONNECTOR_CONFIG);
    let check: unknown;
    try {
        check = connector.validateConfig(raw);
    } catch {
        return unchecked();
    }
    if (!check || typeof check !== 'object') return unchecked();
    const verdict = check as Record<string, unknown>;
    if (verdict.ok === true) return { ok: true, config: verdict.config };
    if (verdict.ok !== false) return unchecked();
    const problems = problemsOf(verdict);
    return {
        ok: false,
        code: ERROR_CODES.BAD_CONNECTOR_CONFIG,
        message: 'the connector refused the config',
        ...(problems ? { problems } : {}),
    };
}

/**
 * A subscription write's body against the registered connectors. Pure: the stored config is what the
 * connector's own `validateConfig` returned, so a row always holds a value `deliver` will accept. A
 * connector that throws or answers malformed refuses the write (nothing is persisted).
 */
export function parseSubscriptionFields(raw: unknown, registry: ConnectorRegistry): ParsedSubscription {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('body must be an object');
    const o = raw as Record<string, unknown>;
    const unknown = Object.keys(o).find((key) => !KEYS.has(key));
    if (unknown !== undefined) return refuse(`unknown field "${unknown}"`);

    if (typeof o.enabled !== 'boolean') return refuse('enabled must be a boolean');

    const kinds = stringList('eventKinds', o.eventKinds, (k) =>
        isNotificationKind(k) ? null : `not one of ${NOTIFICATION_KINDS.join(', ')}`
    );
    if (!kinds.ok) return refuse(kinds.message);
    if (kinds.value.length === 0) return refuse('eventKinds must not be empty');

    const repos = stringList('repos', o.repos ?? [], repoReason);
    if (!repos.ok) return refuse(repos.message);
    const workflows = stringList('workflows', o.workflows ?? [], (w) => (w === '' ? 'workflow is empty' : null));
    if (!workflows.ok) return refuse(workflows.message);

    if (typeof o.connectorKind !== 'string' || o.connectorKind === '') {
        return refuse('connectorKind must be a non-empty string');
    }
    const connector = registry.get(o.connectorKind);
    if (!connector) return refuse(`no connector of kind "${o.connectorKind}"`, ERROR_CODES.UNKNOWN_CONNECTOR);

    const checked = checkConfig(connector, o.connectorConfig);
    if (!checked.ok) return checked;

    return {
        ok: true,
        fields: {
            connectorKind: o.connectorKind,
            connectorConfig: checked.config,
            eventKinds: kinds.value as NotificationKind[],
            repos: repos.value,
            workflows: workflows.value,
            enabled: o.enabled,
        },
    };
}
