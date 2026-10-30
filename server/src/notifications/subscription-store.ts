import type { Sql } from 'postgres';
import type { NotificationEvent, NotificationKind } from '@factory-ai/core';

/** What a write carries; the row's id and stamps are the store's. */
export interface SubscriptionFields {
    connectorKind: string;
    /** Non-secret JSON the registered connector's `validateConfig` returned. */
    connectorConfig: unknown;
    eventKinds: NotificationKind[];
    /** Empty = every repo. */
    repos: string[];
    /** Empty = every workflow. */
    workflows: string[];
    enabled: boolean;
}

export interface SubscriptionView extends SubscriptionFields {
    id: string;
    createdAt: string;
    updatedAt: string;
}

/** The `deliver()` target of a matching subscription, plus the row id. */
export interface SubscriptionTarget {
    id: string;
    kind: string;
    config: unknown;
}

export interface NotificationSubscriptionStore {
    list(): Promise<SubscriptionView[]>;
    create(fields: SubscriptionFields): Promise<SubscriptionView>;
    /** Full replacement; null when this org has no such row. */
    update(id: string, fields: SubscriptionFields): Promise<SubscriptionView | null>;
    /** False when this org has no such row. */
    remove(id: string): Promise<boolean>;
    /**
     * The enabled subscriptions of this org that want the event: kind listed, and each non-empty filter
     * containing the event's repo/workflow (a null never satisfies a filter). A failed read throws: it is
     * never "no subscribers".
     */
    matching(event: Pick<NotificationEvent, 'kind' | 'repo' | 'workflow'>): Promise<SubscriptionTarget[]>;
}

interface Row {
    id: string;
    connector_kind: string;
    connector_config: unknown;
    event_kinds: NotificationKind[];
    repos: string[];
    workflows: string[];
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
}

const toView = (row: Row): SubscriptionView => ({
    id: row.id,
    connectorKind: row.connector_kind,
    connectorConfig: row.connector_config,
    eventKinds: row.event_kinds,
    repos: row.repos,
    workflows: row.workflows,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
});

const COLUMNS = (sql: Sql) =>
    sql`id, connector_kind, connector_config, event_kinds, repos, workflows, enabled, created_at, updated_at`;

export function createNotificationSubscriptionStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
}): NotificationSubscriptionStore {
    const gate = async () => {
        if (ready) await ready;
    };
    return {
        async list() {
            await gate();
            const rows = await sql<Row[]>`
                select ${COLUMNS(sql)} from notification_subscription
                where org_id = ${orgId}
                order by created_at, id
            `;
            return rows.map(toView);
        },
        async create(f) {
            await gate();
            const [row] = await sql<Row[]>`
                insert into notification_subscription
                    (org_id, connector_kind, connector_config, event_kinds, repos, workflows, enabled)
                values (${orgId}, ${f.connectorKind}, ${sql.json(f.connectorConfig as never)}, ${f.eventKinds}::text[],
                        ${f.repos}::text[], ${f.workflows}::text[], ${f.enabled})
                returning ${COLUMNS(sql)}
            `;
            return toView(row!);
        },
        async update(id, f) {
            await gate();
            const [row] = await sql<Row[]>`
                update notification_subscription
                set connector_kind = ${f.connectorKind}, connector_config = ${sql.json(f.connectorConfig as never)},
                    event_kinds = ${f.eventKinds}::text[], repos = ${f.repos}::text[],
                    workflows = ${f.workflows}::text[], enabled = ${f.enabled}, updated_at = now()
                where org_id = ${orgId} and id = ${id}
                returning ${COLUMNS(sql)}
            `;
            return row ? toView(row) : null;
        },
        async remove(id) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                delete from notification_subscription where org_id = ${orgId} and id = ${id} returning id
            `;
            return rows.length > 0;
        },
        async matching(event) {
            await gate();
            const rows = await sql<{ id: string; connector_kind: string; connector_config: unknown }[]>`
                select id, connector_kind, connector_config from notification_subscription
                where org_id = ${orgId} and enabled
                  and ${event.kind}::text = any(event_kinds)
                  and (cardinality(repos) = 0 or ${event.repo}::text = any(repos))
                  and (cardinality(workflows) = 0 or ${event.workflow}::text = any(workflows))
                order by created_at, id
            `;
            return rows.map((r) => ({ id: r.id, kind: r.connector_kind, config: r.connector_config }));
        },
    };
}
