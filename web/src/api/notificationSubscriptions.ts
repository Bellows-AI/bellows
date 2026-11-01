import {
    isSendResult,
    JSON_HEADERS,
    NOTIFICATION_KINDS,
    type NotificationKind,
    type SendResult,
} from '@factory-ai/core';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/**
 * The notification subscriptions' client half, for both scopes: the organization's rows
 * (`/api/org/…`, members read and admins write) and the caller's own (`/api/workspace/…`). The
 * webhook credential only ever goes up (`SubscriptionInput.credential`); no response carries one,
 * so no type here has a field for it. A list or a test verdict that does not parse is an error,
 * never an empty list and never a sent notification.
 */

export type SubscriptionScope = 'org' | 'workspace';

const BASE: Record<SubscriptionScope, string> = {
    org: '/api/org/notification-subscriptions',
    workspace: '/api/workspace/notification-subscriptions',
};

/** One stored subscription, as the list answers it. */
export interface SubscriptionView {
    id: string;
    connectorKind: string;
    connectorConfig: unknown;
    eventKinds: NotificationKind[];
    /** Empty = every repo. */
    repos: string[];
    /** Empty = every workflow. */
    workflows: string[];
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

/** A write's body. `credential` is write-only: absent on an update keeps the stored one. */
export interface SubscriptionInput {
    connectorKind: string;
    connectorConfig: unknown;
    credential?: string;
    eventKinds: NotificationKind[];
    repos: string[];
    workflows: string[];
    enabled: boolean;
}

export const EVENT_KIND_LABELS: Record<NotificationKind, string> = {
    'task.ready': 'Task ready',
    'task.blocked': 'Task blocked',
    'task.question': 'Task has a question',
    'task.admin_action': 'Admin action on a task',
};

const CHANNEL_LABELS: Record<string, string> = { discord: 'Discord' };
/** A channel kind as a person reads it; a kind the SPA has no name for reads as sent. */
export const channelLabel = (kind: string): string => CHANNEL_LABELS[kind] ?? kind;

const SESSION_EXPIRED = 'Your session expired';

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

const isSubscriptionView = (row: unknown): row is SubscriptionView => {
    if (typeof row !== 'object' || row === null) return false;
    const view = row as SubscriptionView;
    return (
        typeof view.id === 'string' &&
        typeof view.connectorKind === 'string' &&
        Array.isArray(view.eventKinds) &&
        view.eventKinds.every((kind) => (NOTIFICATION_KINDS as readonly unknown[]).includes(kind)) &&
        isStringArray(view.repos) &&
        isStringArray(view.workflows) &&
        typeof view.enabled === 'boolean' &&
        typeof view.createdAt === 'string' &&
        typeof view.updatedAt === 'string'
    );
};

/**
 * A failed response's one sentence: the route's message, with the connector's `problems` joined
 * on (a 400 for a refused webhook URL names what was wrong), else the caller's fallback and the status.
 */
async function refusalMessage(response: Response, verb: string): Promise<string> {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; problems?: unknown };
    const error = typeof body.error === 'string' ? body.error : `${verb} (${response.status})`;
    return isStringArray(body.problems) && body.problems.length > 0 ? `${error}: ${body.problems.join('; ')}` : error;
}

/** Fetches; a 401 is broadcast and answered as the session sentence, any other failure as its refusal sentence. */
async function call(
    url: string,
    init: RequestInit | undefined,
    verb: string
): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
    try {
        const response = await fetch(url, init);
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false, error: SESSION_EXPIRED };
        }
        if (!response.ok) return { ok: false, error: await refusalMessage(response, verb) };
        return { ok: true, response };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

/** The scope's rows and the channel kinds this board can send through, or the refusal's message. */
export const listSubscriptions = async (
    scope: SubscriptionScope
): Promise<
    { ok: true; subscriptions: SubscriptionView[]; connectorKinds: string[] } | { ok: false; error: string }
> => {
    const got = await call(BASE[scope], undefined, 'Could not load the notifications');
    if (!got.ok) return got;
    try {
        const body = (await got.response.json()) as { subscriptions?: unknown; connectorKinds?: unknown };
        const { subscriptions, connectorKinds } = body;
        if (
            !Array.isArray(subscriptions) ||
            !subscriptions.every(isSubscriptionView) ||
            !isStringArray(connectorKinds)
        ) {
            return { ok: false, error: 'Could not load the notifications: unexpected response shape.' };
        }
        return { ok: true, subscriptions, connectorKinds };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
};

const write = async (url: string, init: RequestInit, verb: string): Promise<string | null> => {
    const done = await call(url, init, verb);
    return done.ok ? null : done.error;
};

const jsonBody = (method: 'POST' | 'PUT', input: SubscriptionInput): RequestInit => ({
    method,
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
});

/** Returns the refusal's message, or null when the subscription is saved. */
export const createSubscription = (scope: SubscriptionScope, input: SubscriptionInput): Promise<string | null> =>
    write(BASE[scope], jsonBody('POST', input), 'Could not save the notification');

/** A full replacement; returns the refusal's message, or null when saved. */
export const updateSubscription = (
    scope: SubscriptionScope,
    id: string,
    input: SubscriptionInput
): Promise<string | null> =>
    write(`${BASE[scope]}/${encodeURIComponent(id)}`, jsonBody('PUT', input), 'Could not save the notification');

/** Returns the refusal's message, or null when the subscription is deleted. */
export const deleteSubscription = (scope: SubscriptionScope, id: string): Promise<string | null> =>
    write(`${BASE[scope]}/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Could not delete the notification');

/** Sends one test notification through the row's channel; the verdict, or the refusal's message. */
export const sendTestNotification = async (
    scope: SubscriptionScope,
    id: string
): Promise<{ ok: true; result: SendResult } | { ok: false; error: string }> => {
    const got = await call(
        `${BASE[scope]}/${encodeURIComponent(id)}/test`,
        { method: 'POST' },
        'Could not send the test notification'
    );
    if (!got.ok) return got;
    try {
        const { result } = (await got.response.json()) as { result?: unknown };
        if (!isSendResult(result)) {
            return { ok: false, error: 'Could not send the test notification: unexpected response.' };
        }
        return { ok: true, result };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
};

const SECOND_MS = 1000;

const RETRYABLE_MESSAGES: Record<Extract<SendResult, { status: 'retryable' }>['reason'], string> = {
    transport: 'The board could not reach the channel. Check the network and try again.',
    'rate-limited': 'The channel is rate limiting the board. Try again shortly.',
    'upstream-error': 'The channel reported an error of its own. Try again shortly.',
    aborted: 'The channel did not answer in time, so the test may or may not arrive. Try again shortly.',
    'unknown-kind': 'This board has no sender for this channel kind.',
    'connector-threw': 'The channel sender failed before sending. Try again, and tell an operator if it repeats.',
    'malformed-result': 'The channel sender answered something the board could not read. Try again shortly.',
    'credential-unavailable': 'The stored webhook could not be read right now. Try again shortly.',
};

const PERMANENT_MESSAGES: Record<Extract<SendResult, { status: 'permanent' }>['reason'], string> = {
    'config-invalid': 'The channel settings are no longer valid. Edit the notification and save it again.',
    'destination-refused': 'The channel refused the test notification. Check that the webhook still exists.',
    'payload-refused': 'The channel refused the message itself. Tell an operator.',
};

/** One sentence for a test verdict: delivered, or the closed reason it was not and what to do. */
export function testResultMessage(result: SendResult): string {
    if (result.status === 'delivered') return 'Test notification delivered.';
    if (result.status === 'permanent') return PERMANENT_MESSAGES[result.reason];
    const wait =
        result.reason === 'rate-limited' && result.retryAfterMs !== undefined
            ? ` Retry in about ${Math.ceil(result.retryAfterMs / SECOND_MS)} s.`
            : '';
    return RETRYABLE_MESSAGES[result.reason] + wait;
}
