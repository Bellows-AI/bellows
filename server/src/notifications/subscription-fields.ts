import { ERROR_CODES, NOTIFICATION_KINDS, type NotificationKind } from '@factory-ai/core';
import { repoReason } from '../routes/helpers.js';
import type { ConnectorRegistry, NotificationConnector } from './connector.js';
import type { SubscriptionFields } from './subscription-store.js';

type Refusal = { ok: false; code: string; message: string; problems?: string[] };

/** `credential` is the write-only secret half, kept out of `fields` so no store path can echo it; null = keep. */
export type ParsedSubscription = { ok: true; fields: SubscriptionFields; credential: string | null } | Refusal;

const KEYS = new Set(['connectorKind', 'connectorConfig', 'credential', 'eventKinds', 'repos', 'workflows', 'enabled']);

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
 * The connector's verdict on a config or a credential, or the refusal. A throw or an answer that is not exactly
 * `{ ok: true, config }` / `{ ok: false, ... }` refuses the write; `problems` only when well-formed. The refusal
 * never carries the input, so a credential cannot leak through it.
 */
function checkWith(what: 'config' | 'credential', verdictOf: () => unknown): { ok: true; config: unknown } | Refusal {
    const unchecked = () => refuse(`the connector could not check the ${what}`, ERROR_CODES.BAD_CONNECTOR_CONFIG);
    let check: unknown;
    try {
        check = verdictOf();
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
        message: `the connector refused the ${what}`,
        ...(problems ? { problems } : {}),
    };
}

/** The credential's normalized form, null when absent and optional; absent and required is a BAD_BODY. */
function checkCredential(
    connector: NotificationConnector,
    raw: unknown,
    required: boolean
): { ok: true; value: string | null } | Refusal {
    if (raw === undefined || raw === null)
        return required ? refuse('credential is required') : { ok: true, value: null };
    const verdict = checkWith('credential', () => connector.validateCredential(raw));
    if (!verdict.ok) return verdict;
    if (typeof verdict.config !== 'string') {
        return refuse('the connector could not check the credential', ERROR_CODES.BAD_CONNECTOR_CONFIG);
    }
    return { ok: true, value: verdict.config };
}

/**
 * A subscription write's body against the registered connectors. Pure: the stored config and credential are what
 * the connector's own `validateConfig` / `validateCredential` returned, so a row always holds a value `deliver`
 * will accept. A connector that throws or answers malformed refuses the write (nothing is persisted).
 */
export function parseSubscriptionFields(
    raw: unknown,
    registry: ConnectorRegistry,
    { credentialRequired }: { credentialRequired: boolean }
): ParsedSubscription {
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

    const checked = checkWith('config', () => connector.validateConfig(o.connectorConfig));
    if (!checked.ok) return checked;

    const credential = checkCredential(connector, o.credential, credentialRequired);
    if (!credential.ok) return credential;

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
        credential: credential.value,
    };
}
