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
        link: new URL(`/tasks/${row.rootJobId}`, publicUrl).toString(),
        occurredAt: row.occurredAt,
    };
}
