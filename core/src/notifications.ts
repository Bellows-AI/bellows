import { taskTitleFromCommand } from './task-title.js';

export const NOTIFICATION_KINDS = ['task.ready', 'task.blocked', 'task.question'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** A `notification_event` row, as the columns read in camelCase; the command is the raw one. */
export interface NotificationEventRow {
    id: string;
    kind: NotificationKind;
    orgId: string;
    jobId: string;
    rootJobId: string;
    repo: string | null;
    workflow: string | null;
    command: string;
    reason: string | null;
    prUrl: string | null;
    occurredAt: string;
}

/** What a delivery stage sends: the row with its title derived and a link to the thread. */
export interface NotificationEvent {
    id: string;
    kind: NotificationKind;
    orgId: string;
    jobId: string;
    threadId: string;
    repo: string | null;
    workflow: string | null;
    title: string;
    reason: string | null;
    prUrl: string | null;
    link: string;
    occurredAt: string;
}

export function notificationEventOf(row: NotificationEventRow, publicUrl: string): NotificationEvent {
    return {
        id: row.id,
        kind: row.kind,
        orgId: row.orgId,
        jobId: row.jobId,
        threadId: row.rootJobId,
        repo: row.repo,
        workflow: row.workflow,
        title: taskTitleFromCommand(row.command),
        reason: row.reason,
        prUrl: row.prUrl,
        link: new URL(`/tasks/${row.rootJobId}`, publicUrl).toString(),
        occurredAt: row.occurredAt,
    };
}

export const SEND_RETRYABLE_REASONS = [
    'transport',
    'rate-limited',
    'upstream-error',
    'aborted',
    'unknown-kind',
    'connector-threw',
    'malformed-result',
] as const;
export type SendRetryableReason = (typeof SEND_RETRYABLE_REASONS)[number];

export const SEND_PERMANENT_REASONS = ['config-invalid', 'destination-refused', 'payload-refused'] as const;
export type SendPermanentReason = (typeof SEND_PERMANENT_REASONS)[number];

/** What one send attempt came to. Closed reasons only, no free text, so a result is safe to log and store. */
export type SendResult =
    | { status: 'delivered'; externalId?: string }
    | { status: 'retryable'; reason: SendRetryableReason; retryAfterMs?: number }
    | { status: 'permanent'; reason: SendPermanentReason };

const SEND_KEYS: Record<string, readonly string[]> = {
    delivered: ['status', 'externalId'],
    retryable: ['status', 'reason', 'retryAfterMs'],
    permanent: ['status', 'reason'],
};

/** True only for a well-formed SendResult: known status, closed reason for that status, no other field. */
export function isSendResult(value: unknown): value is SendResult {
    if (typeof value !== 'object' || value === null) return false;
    const o = value as Record<string, unknown>;
    const status = o.status;
    if (typeof status !== 'string' || !Object.hasOwn(SEND_KEYS, status)) return false;
    if (!Object.keys(o).every((k) => SEND_KEYS[status]!.includes(k))) return false;
    if (status === 'delivered')
        return o.externalId === undefined || (typeof o.externalId === 'string' && o.externalId !== '');
    const reasons: readonly unknown[] = status === 'retryable' ? SEND_RETRYABLE_REASONS : SEND_PERMANENT_REASONS;
    if (!reasons.includes(o.reason)) return false;
    return (
        o.retryAfterMs === undefined ||
        (typeof o.retryAfterMs === 'number' && Number.isFinite(o.retryAfterMs) && o.retryAfterMs >= 0)
    );
}
