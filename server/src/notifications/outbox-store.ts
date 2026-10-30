import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { NotificationEventRow, NotificationKind, SendResult } from '@factory-ai/core';
import { backoffAt, MAX_FAILURES, RETRY_CAP_MS } from '../db/outbox-backoff.js';

/**
 * One org's notification outbox (104; docs/notifications.md): the (event, subscription) rows the job.status
 * trigger fanned out, leased, settled one at a time and released. A lease carries a token, and a settle or
 * release applies only while its token still stands, so a replica whose lease lapsed changes nothing. Every
 * time is the injected `now`, never the database's: the trigger leaves `next_attempt_at` null, meaning due now.
 */

export interface OutboxKey {
    eventId: string;
    subscriptionId: string;
}

/** One row to send: the event as stored and the subscription's target as read live at lease time. */
export interface OutboxItem extends OutboxKey {
    target: { kind: string; config: unknown };
    event: NotificationEventRow;
}

export interface OutboxLease {
    token: string;
    items: OutboxItem[];
}

export interface NotificationOutboxStore {
    /**
     * Leases up to `limit` due rows. Rows whose subscription is now disabled are parked as
     * `subscription-disabled` and never sent, so `items` may be empty while the lease is not null. Null only
     * when nothing was due. A failed read throws: it is never "nothing due".
     */
    lease(limit: number, leaseMs: number): Promise<OutboxLease | null>;
    /** Records one send's verdict; applies only while `token` still holds the row. */
    settle(token: string, key: OutboxKey, result: SendResult): Promise<void>;
    /** Frees every row still under `token` without counting an attempt. */
    release(token: string): Promise<void>;
}

interface LeasedRow {
    event_id: string;
    subscription_id: string;
    connector_kind: string;
    connector_config: unknown;
    kind: NotificationKind;
    job_id: string;
    root_job_id: string;
    repo: string | null;
    workflow: string | null;
    command: string;
    reason: string | null;
    occurred_at: Date;
}

export function createNotificationOutboxStore({
    sql,
    orgId,
    ready,
    now = () => new Date(),
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
    now?: (() => Date) | undefined;
}): NotificationOutboxStore {
    const gate = async () => {
        if (ready) await ready;
    };
    return {
        async lease(limit, leaseMs) {
            await gate();
            const at = now();
            const until = new Date(at.getTime() + leaseMs);
            const token = randomUUID();
            return sql.begin(async (tx): Promise<OutboxLease | null> => {
                const leased = await tx`
                    with due as (
                        select event_id, subscription_id from notification_outbox
                        where org_id = ${orgId} and delivered_at is null and parked_at is null
                          and (next_attempt_at is null or next_attempt_at <= ${at}::timestamptz)
                          and (claimed_until is null or claimed_until <= ${at}::timestamptz)
                        order by next_attempt_at nulls first, event_id, subscription_id
                        limit ${limit}
                        for update skip locked
                    )
                    update notification_outbox o
                    set claim_token = ${token}::uuid, claimed_until = ${until}::timestamptz
                    from due
                    where o.org_id = ${orgId} and o.event_id = due.event_id and o.subscription_id = due.subscription_id
                    returning o.event_id
                `;
                if (leased.length === 0) return null;
                await tx`
                    update notification_outbox o
                    set parked_at = ${at}::timestamptz, last_error = 'subscription-disabled',
                        claim_token = null, claimed_until = null
                    from notification_subscription s
                    where o.org_id = ${orgId} and o.claim_token = ${token}::uuid
                      and s.org_id = o.org_id and s.id = o.subscription_id and not s.enabled
                `;
                const found = await tx<LeasedRow[]>`
                    select o.event_id, o.subscription_id, s.connector_kind, s.connector_config,
                           e.kind, e.job_id, e.root_job_id, e.repo, e.workflow, e.command, e.reason, e.occurred_at
                    from notification_outbox o
                    join notification_event e on e.org_id = o.org_id and e.id = o.event_id
                    join notification_subscription s on s.org_id = o.org_id and s.id = o.subscription_id
                    where o.org_id = ${orgId} and o.claim_token = ${token}::uuid
                    order by o.event_id, o.subscription_id
                `;
                return {
                    token,
                    items: found.map((r) => ({
                        eventId: r.event_id,
                        subscriptionId: r.subscription_id,
                        target: { kind: r.connector_kind, config: r.connector_config },
                        event: {
                            id: r.event_id,
                            kind: r.kind,
                            orgId,
                            jobId: r.job_id,
                            rootJobId: r.root_job_id,
                            repo: r.repo,
                            workflow: r.workflow,
                            command: r.command,
                            reason: r.reason,
                            occurredAt: r.occurred_at.toISOString(),
                        },
                    })),
                };
            });
        },

        async settle(token, { eventId, subscriptionId }, result) {
            await gate();
            const at = now();
            const mine = sql`
                org_id = ${orgId} and event_id = ${eventId} and subscription_id = ${subscriptionId}
                and claim_token = ${token}::uuid
            `;
            if (result.status === 'delivered') {
                await sql`
                    update notification_outbox
                    set delivered_at = ${at}::timestamptz, last_error = null, claim_token = null, claimed_until = null
                    where ${mine}
                `;
            } else if (result.status === 'retryable') {
                const honoured = new Date(at.getTime() + Math.min(result.retryAfterMs ?? 0, RETRY_CAP_MS));
                await sql`
                    update notification_outbox
                    set attempts = least(attempts + 1, ${MAX_FAILURES}),
                        next_attempt_at = greatest(${backoffAt(sql, at, 'attempts')}, ${honoured}::timestamptz),
                        last_error = ${result.reason}, claim_token = null, claimed_until = null
                    where ${mine}
                `;
            } else {
                await sql`
                    update notification_outbox
                    set attempts = least(attempts + 1, ${MAX_FAILURES}), parked_at = ${at}::timestamptz,
                        last_error = ${result.reason}, claim_token = null, claimed_until = null
                    where ${mine}
                `;
            }
        },

        async release(token) {
            await gate();
            await sql`
                update notification_outbox set claim_token = null, claimed_until = null
                where org_id = ${orgId} and claim_token = ${token}::uuid
            `;
        },
    };
}
