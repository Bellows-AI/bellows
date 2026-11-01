import { randomUUID } from 'node:crypto';
import type { NotificationEvent, NotificationKind, SendResult } from '@factory-ai/core';
import { untilAborted } from '../db/env-secrets.js';
import { type ConnectorRegistry, deliver } from './connector.js';

/** One absolute deadline for the credential read and the send together; there are no retries. */
export const TEST_SEND_TIMEOUT_MS = 10_000;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** What `NotificationSubscriptionStore.testTarget` reads: the row's target and its credential, null when unconfirmed. */
export interface TestTarget {
    kind: string;
    config: unknown;
    eventKinds: NotificationKind[];
    credential: string | null;
}

/** A made-up event of `kind` that links to the settings page of the scope under test; nothing in it is a credential. */
export function testNotificationEvent({
    orgId,
    kind,
    publicUrl,
    settingsPath,
    now,
}: {
    orgId: string;
    kind: NotificationKind;
    publicUrl: string;
    settingsPath: string;
    now: Date;
}): NotificationEvent {
    return {
        id: randomUUID(),
        kind,
        orgId,
        jobId: NIL_UUID,
        threadId: NIL_UUID,
        repo: null,
        workflow: null,
        title: 'Test notification from Factory: this channel is subscribed.',
        reason: null,
        prUrl: null,
        link: new URL(settingsPath, publicUrl).toString(),
        questionId: null,
        questions: null,
        action: null,
        actor: null,
        author: null,
        occurredAt: now.toISOString(),
    };
}

/**
 * Sends one test event through the connector, writing nothing. Null when the row does not exist; an unconfirmed
 * credential is the same retryable answer the delivery loop gives, never a verdict on the row. A throwing read
 * propagates. `signal` bounds the read and the send alike.
 */
export async function sendTestNotification({
    connectors,
    readTarget,
    orgId,
    publicUrl,
    settingsPath,
    now = () => new Date(),
    signal,
}: {
    connectors: ConnectorRegistry;
    readTarget: (signal: AbortSignal) => Promise<TestTarget | null>;
    orgId: string;
    publicUrl: string;
    settingsPath: string;
    now?: () => Date;
    signal: AbortSignal;
}): Promise<SendResult | null> {
    const read = await untilAborted(readTarget(signal), signal);
    if (read.lost) return { status: 'retryable', reason: 'aborted' };
    const target = read.value;
    if (!target) return null;
    if (target.credential === null) return { status: 'retryable', reason: 'credential-unavailable' };
    // 103_notification_subscription.sql checks cardinality(event_kinds) > 0.
    const event = testNotificationEvent({ orgId, kind: target.eventKinds[0]!, publicUrl, settingsPath, now: now() });
    return deliver(
        connectors,
        { kind: target.kind, config: target.config, credential: target.credential },
        event,
        signal
    );
}
