/**
 * What a managed-connection call can come to when it is not a value. Every reason is a member of a
 * closed list: no free text and no provider body, so an outcome is safe to log, store and hand to an
 * agent. `isClosedOutcome` is the runtime check the tests and any later serializer rely on.
 */
export const OUTCOME_REASONS = {
    integration_required: ['missing', 'reconnect', 'insufficient_scopes'],
    unavailable: [
        'credential-rejected',
        'redirect-refused',
        'refresh-in-progress',
        'secret-unavailable',
        'transport',
        'timeout',
        'aborted',
        'upstream-error',
        'unexpected-status',
        'response-too-large',
        'malformed-response',
    ],
    forbidden: [
        'binding-ceiling-exceeded',
        'principal-mismatch',
        'service-principal-unsupported',
        'provider-denied',
        'destination-refused',
    ],
} as const;

export type IntegrationRequiredReason = (typeof OUTCOME_REASONS.integration_required)[number];
export type UnavailableReason = (typeof OUTCOME_REASONS.unavailable)[number];
export type ForbiddenReason = (typeof OUTCOME_REASONS.forbidden)[number];

export type IntegrationOutcome =
    | {
          outcome: 'integration_required';
          reason: IntegrationRequiredReason;
          provider: string;
          missingScopes?: readonly string[];
      }
    | { outcome: 'unavailable'; reason: UnavailableReason; retryable: true }
    | { outcome: 'rate_limited'; retryAfterMs?: number }
    | { outcome: 'forbidden'; reason: ForbiddenReason }
    | { outcome: 'outcome_unknown'; operation: string };

const KEYS: Record<string, readonly string[]> = {
    integration_required: ['outcome', 'reason', 'provider', 'missingScopes'],
    unavailable: ['outcome', 'reason', 'retryable'],
    rate_limited: ['outcome', 'retryAfterMs'],
    forbidden: ['outcome', 'reason'],
    outcome_unknown: ['outcome', 'operation'],
};

const inList = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);

/** True only for a member of the union whose reason is in its closed list and which carries no other field. */
export const isClosedOutcome = (value: unknown): value is IntegrationOutcome => {
    if (typeof value !== 'object' || value === null) return false;
    const o = value as Record<string, unknown>;
    const kind = o.outcome;
    if (typeof kind !== 'string' || !(kind in KEYS)) return false;
    if (!Object.keys(o).every((k) => KEYS[kind]?.includes(k))) return false;
    switch (kind) {
        case 'integration_required':
            return (
                inList(OUTCOME_REASONS.integration_required, o.reason) &&
                typeof o.provider === 'string' &&
                (o.missingScopes === undefined ||
                    (Array.isArray(o.missingScopes) && o.missingScopes.every((s) => typeof s === 'string')))
            );
        case 'unavailable':
            return inList(OUTCOME_REASONS.unavailable, o.reason) && o.retryable === true;
        case 'forbidden':
            return inList(OUTCOME_REASONS.forbidden, o.reason);
        case 'rate_limited':
            return o.retryAfterMs === undefined || typeof o.retryAfterMs === 'number';
        default:
            return typeof o.operation === 'string';
    }
};
